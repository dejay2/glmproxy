/**
 * Anthropic Streaming Handler
 *
 * Handles SSE streaming from Z.ai's Anthropic-compatible endpoint.
 * Since the endpoint already returns Anthropic format, this is mostly passthrough
 * with filtering for internal tool_use blocks and tool execution handling.
 *
 * Also handles reasoning content extraction from <reasoning_content> tags in
 * text streams when thinking mode is enabled via prompt injection.
 */

import config from '../config.js';
import logger from '../utils/logger.js';

// Tags used for reasoning content extraction
const REASONING_OPEN_TAG = '<reasoning_content>';
const REASONING_CLOSE_TAG = '</reasoning_content>';
import { getCanonicalToolName, shouldHandleInternally } from '../tools/definitions.js';
import { findMcpForTool } from '../mcp/triggers.js';
import { callMcpTool } from '../tools/mcp-client.js';
import { callMcpTool as callCustomMcpTool } from '../mcp/lifecycle.js';

// Valid Anthropic content block types that Claude Code accepts
const VALID_CONTENT_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'thinking']);

// Z.ai server-side tool types that we should track but not forward
const SERVER_TOOL_TYPES = new Set(['server_tool_use', 'server_tool_result']);

// Upstream API timeout (default 120 seconds for streaming, configurable via UPSTREAM_TIMEOUT env var)
// Streaming uses a longer timeout since responses can take time to generate
const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT, 10) || 120000;

/**
 * Reasoning Tag Parser State Machine
 *
 * Handles streaming text that may contain <reasoning_content>...</reasoning_content> tags,
 * emitting appropriate thinking_delta or text_delta events.
 */
class ReasoningTagParser {
  constructor() {
    this.buffer = '';           // Accumulated text waiting to be processed
    this.inReasoning = false;   // Whether we're inside reasoning tags
    this.pendingOutput = [];    // Queue of { type: 'thinking'|'text', content: string }
  }

  /**
   * Process incoming text chunk and extract reasoning/text segments.
   *
   * @param {string} text - Incoming text chunk
   * @returns {Array<{type: string, content: string}>} Array of segments to emit
   */
  processChunk(text) {
    this.buffer += text;
    this.pendingOutput = [];

    // Process buffer, extracting complete segments
    while (this.buffer.length > 0) {
      if (this.inReasoning) {
        // Look for closing tag
        const closeIdx = this.buffer.indexOf(REASONING_CLOSE_TAG);
        if (closeIdx !== -1) {
          // Found closing tag - emit reasoning content before it
          const reasoningContent = this.buffer.substring(0, closeIdx);
          if (reasoningContent) {
            this.pendingOutput.push({ type: 'thinking', content: reasoningContent });
          }
          this.buffer = this.buffer.substring(closeIdx + REASONING_CLOSE_TAG.length);
          this.inReasoning = false;
        } else {
          // No closing tag yet - check if we might have partial tag at end
          const partialClose = this.findPartialTag(this.buffer, REASONING_CLOSE_TAG);
          if (partialClose > 0) {
            // Keep potential partial tag in buffer, emit the rest as reasoning
            const safeContent = this.buffer.substring(0, this.buffer.length - partialClose);
            if (safeContent) {
              this.pendingOutput.push({ type: 'thinking', content: safeContent });
            }
            this.buffer = this.buffer.substring(this.buffer.length - partialClose);
          } else {
            // No partial tag - emit all as reasoning
            this.pendingOutput.push({ type: 'thinking', content: this.buffer });
            this.buffer = '';
          }
          break; // Need more data
        }
      } else {
        // Look for opening tag
        const openIdx = this.buffer.indexOf(REASONING_OPEN_TAG);
        if (openIdx !== -1) {
          // Found opening tag - emit text content before it
          const textContent = this.buffer.substring(0, openIdx);
          if (textContent) {
            this.pendingOutput.push({ type: 'text', content: textContent });
          }
          this.buffer = this.buffer.substring(openIdx + REASONING_OPEN_TAG.length);
          this.inReasoning = true;
        } else {
          // No opening tag yet - check if we might have partial tag at end
          const partialOpen = this.findPartialTag(this.buffer, REASONING_OPEN_TAG);
          if (partialOpen > 0) {
            // Keep potential partial tag in buffer, emit the rest as text
            const safeContent = this.buffer.substring(0, this.buffer.length - partialOpen);
            if (safeContent) {
              this.pendingOutput.push({ type: 'text', content: safeContent });
            }
            this.buffer = this.buffer.substring(this.buffer.length - partialOpen);
          } else {
            // No partial tag - emit all as text
            this.pendingOutput.push({ type: 'text', content: this.buffer });
            this.buffer = '';
          }
          break; // Need more data
        }
      }
    }

    return this.pendingOutput;
  }

  /**
   * Check if the end of text might be a partial tag.
   * Returns the length of the potential partial match (0 if none).
   *
   * @param {string} text - Text to check
   * @param {string} tag - Tag to look for
   * @returns {number} Length of potential partial match at end
   */
  findPartialTag(text, tag) {
    // Check if end of text matches start of tag
    for (let len = Math.min(text.length, tag.length - 1); len > 0; len--) {
      const textEnd = text.substring(text.length - len);
      const tagStart = tag.substring(0, len);
      if (textEnd === tagStart) {
        return len;
      }
    }
    return 0;
  }

  /**
   * Flush any remaining buffered content at end of stream.
   *
   * @returns {Array<{type: string, content: string}>} Remaining segments
   */
  flush() {
    const output = [];
    if (this.buffer) {
      // Emit remaining buffer as whatever mode we're in
      // (partial tags become literal text if stream ends)
      output.push({
        type: this.inReasoning ? 'thinking' : 'text',
        content: this.buffer
      });
      this.buffer = '';
    }
    return output;
  }

  /**
   * Check if currently inside reasoning tags.
   * @returns {boolean}
   */
  isInReasoning() {
    return this.inReasoning;
  }
}

/**
 * Stream response from Z.ai Anthropic endpoint with tool handling.
 *
 * @param {http.ServerResponse} res - HTTP response object
 * @param {Object} anthropicRequest - Prepared Anthropic request (with stream: true)
 * @param {Object} options - Additional options
 * @param {Array} options.conversationHistory - Full conversation for tool loop
 * @param {Object} options.streamState - State to persist across recursive calls
 * @returns {Promise<{usage: Object, fullContent: Array}>}
 */
export async function streamFromAnthropic(res, anthropicRequest, options = {}) {
  const conversationHistory = options.conversationHistory || [...(anthropicRequest.messages || [])];
  const maxToolIterations = config.toolExecution?.maxIterations || 10;
  let toolIteration = options.toolIteration || 0;

  // Initialize or reuse stream state across recursive calls
  const streamState = options.streamState || {
    messageStartSent: false,
    currentBlockIndex: 0,
  };

  logger.debug('anthropic-stream', 'Starting stream from Anthropic endpoint', {
    model: anthropicRequest.model,
    thinkingEnabled: !!anthropicRequest.thinking,
    hasTools: !!(anthropicRequest.tools?.length),
    iteration: toolIteration,
  });

  // Set SSE headers only on first call
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // SECURITY: No CORS headers needed - frontend served from same origin
      'X-Accel-Buffering': 'no',
    });

    if (res.socket) {
      res.socket.setNoDelay(true);
    }
    res.flushHeaders();
  }

  try {
    const result = await streamAnthropicWithToolDetection(res, anthropicRequest, conversationHistory, streamState);

    // Check if we need to handle internal tools
    if (result.internalToolCalls && result.internalToolCalls.length > 0) {
      toolIteration++;

      if (toolIteration > maxToolIterations) {
        logger.warn('anthropic-stream', 'Max tool iterations reached', { toolIteration });
        sendFinalEvents(res, result.usage, 'end_turn');
        return { usage: result.usage, fullContent: result.fullContent };
      }

      logger.debug('anthropic-stream', 'Executing internal tools during stream', {
        tools: result.internalToolCalls.map((tc) => tc.name),
        iteration: toolIteration,
      });

      // Execute internal tools
      const toolResults = await executeInternalTools(result.internalToolCalls);

      // Add assistant message to history
      conversationHistory.push({
        role: 'assistant',
        content: result.fullContent,
      });

      // Add tool results
      conversationHistory.push({
        role: 'user',
        content: toolResults,
      });

      // Continue streaming with tool results (propagate the return value)
      return await streamFromAnthropic(res, anthropicRequest, {
        conversationHistory,
        toolIteration,
        streamState,
      });
    }

    // Check for client tools (streaming ends, client handles them)
    if (result.clientToolCalls && result.clientToolCalls.length > 0) {
      logger.debug('anthropic-stream', 'Client tools detected, ending stream', {
        tools: result.clientToolCalls.map((tc) => tc.name),
      });
      // Client tool events already streamed by passthrough
      sendFinalEvents(res, result.usage, 'tool_use');
      return { usage: result.usage, fullContent: result.fullContent };
    }

    // Normal completion
    sendFinalEvents(res, result.usage, result.stopReason || 'end_turn');
    return { usage: result.usage, fullContent: result.fullContent };
  } catch (error) {
    logger.error('anthropic-stream', 'Streaming error', { error: error.message });
    sendErrorEvent(res, error.message);
    res.end();
    return { usage: {}, fullContent: [] };
  }
}

/**
 * Stream from Anthropic API with tool detection and passthrough.
 *
 * @param {http.ServerResponse} res - HTTP response object
 * @param {Object} anthropicRequest - Anthropic request with stream: true
 * @param {Array} conversationHistory - Current conversation history
 * @param {Object} streamState - Persistent state across recursive calls
 * @returns {Promise<Object>} Result with content and tool calls
 */
async function streamAnthropicWithToolDetection(res, anthropicRequest, conversationHistory, streamState) {
  let response;
  let totalBytesReceived = 0;
  let lastValidChunk = '';

  try {
    response = await fetch(config.zaiAnthropicUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.zaiApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        ...anthropicRequest,
        messages: conversationHistory,
        stream: true,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (error) {
    // Handle timeout and abort errors
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      logger.error('anthropic-stream', 'Upstream API timeout', {
        timeout: UPSTREAM_TIMEOUT,
      });
      throw new Error(`Upstream API did not respond within ${UPSTREAM_TIMEOUT / 1000} seconds`);
    }
    logger.error('anthropic-stream', 'Upstream API network error', {
      error: error.message,
    });
    throw new Error(`Upstream API network error: ${error.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('anthropic-stream', 'Anthropic API error', {
      status: response.status,
      body: errorText.substring(0, 500),
    });
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Track content
  const fullContent = [];
  const internalToolCalls = [];
  const clientToolCalls = [];
  let currentToolUse = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = 'end_turn';
  let nativeThinkingBlockActive = false; // Track if a native thinking block is being received
  let hadNativeThinking = false; // Track if we ever received a native thinking block

  // Accumulate content for stats (like GLM stream does)
  let thinkingContent = '';
  let textContent = '';

  // Track thinking block state (for GLM-style reasoning_content and parsed <reasoning_content> tags)
  let thinkingBlockStarted = false;
  let thinkingBlockIndex = -1;
  let textBlockStarted = false;
  let textBlockIndex = -1;
  let parsedThinkingBlockStarted = false; // For <reasoning_content> tag parsed thinking

  // Use persistent state from streamState to avoid duplicate events across recursive calls
  // These are modified by reference so changes persist

  // Reasoning tag parser for extracting <reasoning_content> from text_delta streams
  // Used when thinking is enabled via prompt injection (Anthropic-native path)
  const reasoningParser = new ReasoningTagParser();
  const thinkingEnabled = config.thinking?.enabled || anthropicRequest.thinking?.type === 'enabled';

  // Helper to ensure message_start is sent
  const ensureMessageStart = () => {
    if (!streamState.messageStartSent) {
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: anthropicRequest.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`);
      streamState.messageStartSent = true;
    }
  };

  // Helper to start a text block
  const startTextBlock = () => {
    if (!textBlockStarted) {
      ensureMessageStart();
      textBlockStarted = true;
      textBlockIndex = streamState.currentBlockIndex++;
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: textBlockIndex,
        content_block: { type: 'text', text: '' },
      })}\n\n`);
    }
  };

  // Helper to start a thinking block (for parsed <reasoning_content> tags)
  const startParsedThinkingBlock = () => {
    if (!parsedThinkingBlockStarted) {
      ensureMessageStart();
      parsedThinkingBlockStarted = true;
      thinkingBlockStarted = true;
      thinkingBlockIndex = streamState.currentBlockIndex++;
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: thinkingBlockIndex,
        content_block: { type: 'thinking', thinking: '' },
      })}\n\n`);
    }
  };

  // Helper to close parsed thinking block when transitioning to text
  const closeParsedThinkingBlock = () => {
    if (parsedThinkingBlockStarted) {
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: thinkingBlockIndex,
      })}\n\n`);
      parsedThinkingBlockStarted = false;
    }
  };

  // Helper to emit thinking delta (for parsed <reasoning_content> content)
  const emitThinkingDelta = (content) => {
    startParsedThinkingBlock();
    thinkingContent += content; // Accumulate for stats
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: thinkingBlockIndex,
      delta: { type: 'thinking_delta', thinking: content },
    })}\n\n`);
  };

  // Helper to emit text delta
  const emitTextDelta = (content) => {
    // Close thinking block if transitioning from thinking to text
    closeParsedThinkingBlock();
    startTextBlock();
    textContent += content; // Accumulate for stats
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: textBlockIndex,
      delta: { type: 'text_delta', text: content },
    })}\n\n`);
  };

  while (true) {
    let readResult;
    try {
      readResult = await reader.read();
    } catch (readError) {
      // Stream read failed - report error with context
      logger.error('anthropic-stream', 'Stream read error', {
        error: readError.message,
        bytesReceived: totalBytesReceived,
        lastValidChunk: lastValidChunk?.substring(0, 100),
      });

      // Send error event to client so they know the stream failed
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: {
          type: 'stream_error',
          message: 'Stream read failed - response may be incomplete',
          bytes_received: totalBytesReceived,
        },
      })}\n\n`);
      break;
    }

    const { done, value } = readResult;
    if (done) break;

    // Track bytes received for error reporting
    totalBytesReceived += value.length;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim() || !line.startsWith('data: ')) continue;

      const data = line.substring(6);
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        const eventType = event.type;

        // Check for OpenAI/GLM style streaming format (choices array with delta)
        // Z.ai's Anthropic endpoint may use this hybrid format
        if (event.choices && event.choices[0]?.delta) {
          const delta = event.choices[0].delta;
          const finishReason = event.choices[0].finish_reason;

          // Handle reasoning_content (GLM thinking mode)
          if (delta.reasoning_content) {
            thinkingContent += delta.reasoning_content; // Accumulate for stats
            if (!thinkingBlockStarted) {
              thinkingBlockStarted = true;
              thinkingBlockIndex = streamState.currentBlockIndex++;

              // Send message_start if not sent
              if (!streamState.messageStartSent) {
                res.write(`event: message_start\ndata: ${JSON.stringify({
                  type: 'message_start',
                  message: {
                    id: `msg_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: anthropicRequest.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                })}\n\n`);
                streamState.messageStartSent = true;
              }

              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: thinkingBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              })}\n\n`);
            }

            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: thinkingBlockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            })}\n\n`);
          }

          // Handle content (text)
          if (delta.content) {
            textContent += delta.content; // Accumulate for stats
            // Close thinking block if switching to text
            if (thinkingBlockStarted && !textBlockStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: thinkingBlockIndex,
              })}\n\n`);
            }

            if (!textBlockStarted) {
              textBlockStarted = true;
              textBlockIndex = streamState.currentBlockIndex++;

              // Send message_start if not sent
              if (!streamState.messageStartSent) {
                res.write(`event: message_start\ndata: ${JSON.stringify({
                  type: 'message_start',
                  message: {
                    id: `msg_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: anthropicRequest.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                })}\n\n`);
                streamState.messageStartSent = true;
              }

              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: { type: 'text', text: '' },
              })}\n\n`);
            }

            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            })}\n\n`);
          }

          // Handle finish_reason
          if (finishReason) {
            if (finishReason === 'tool_calls') {
              stopReason = 'tool_use';
            } else {
              stopReason = finishReason === 'stop' ? 'end_turn' : finishReason;
            }

            // Close any open blocks
            if (textBlockStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: textBlockIndex,
              })}\n\n`);
            } else if (thinkingBlockStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: thinkingBlockIndex,
              })}\n\n`);
            }
          }

          // Handle usage
          if (event.usage) {
            usage = {
              input_tokens: event.usage.prompt_tokens || 0,
              output_tokens: event.usage.completion_tokens || 0,
            };
          }

          continue; // Skip the Anthropic format handling below
        }

        // Handle Anthropic-native event types
        switch (eventType) {
          case 'message_start':
            // Forward message_start to client
            if (!streamState.messageStartSent) {
              res.write(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`);
              streamState.messageStartSent = true;
            }
            break;

          case 'content_block_start':
            const block = event.content_block;

            // Handle Z.ai server-side tool blocks (analyze_image, etc.)
            // These are internal to Z.ai and should not be forwarded to Claude Code
            if (SERVER_TOOL_TYPES.has(block.type)) {
              logger.debug('anthropic-stream', 'Skipping Z.ai server tool block', {
                type: block.type,
                name: block.name,
                index: event.index,
              });
              // Track that we're skipping this block so we ignore its deltas and stop
              streamState.skippingBlockIndex = event.index;
              // Also track server tool for result capture
              if (block.type === 'server_tool_use') {
                streamState.serverToolInProgress = {
                  name: block.name,
                  index: event.index,
                };
              }
              break;
            }

            // Filter out other non-standard content block types
            if (!VALID_CONTENT_TYPES.has(block.type)) {
              logger.warn('anthropic-stream', 'Skipping unknown content block type', {
                type: block.type,
                blockKeys: Object.keys(block),
                index: event.index,
              });
              // Track that we're skipping this block so we ignore its deltas and stop
              streamState.skippingBlockIndex = event.index;
              break;
            }

            if (block.type === 'thinking') {
              // Native thinking block from Z.ai - forward as-is
              nativeThinkingBlockActive = true;
              hadNativeThinking = true;
              res.write(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`);
            } else if (block.type === 'tool_use') {
              // Start tracking tool use
              currentToolUse = {
                id: block.id,
                name: block.name,
                input: '',
                index: event.index,
              };

              // Only forward if it's a client tool (not handled internally)
              if (!shouldHandleInternally(block.name)) {
                res.write(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`);
              }
            } else if (block.type === 'text' && thinkingEnabled) {
              // When thinking is enabled, don't forward text block start directly
              // We'll create our own thinking/text blocks as we parse the content
            } else {
              // Forward other block types (text when not parsing, thinking)
              if (streamState.afterServerTool && block.type === 'text') {
                logger.info('anthropic-stream', 'Text block starting after server tool', {
                  index: event.index,
                });
              }
              res.write(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`);
            }
            break;

          case 'content_block_delta':
            // Skip deltas for non-standard block types we're filtering out
            if (streamState.skippingBlockIndex === event.index) {
              // Log skipped server tool deltas for debugging
              if (streamState.serverToolInProgress) {
                const deltaType = event.delta?.type;
                if (deltaType === 'input_json_delta') {
                  // Accumulate server tool input for logging
                  streamState.serverToolInput = (streamState.serverToolInput || '') + (event.delta.partial_json || '');
                }
                logger.debug('anthropic-stream', 'Skipping server tool delta', {
                  toolName: streamState.serverToolInProgress.name,
                  deltaType: deltaType,
                });
              }
              break;
            }

            const delta = event.delta;

            if (delta.type === 'input_json_delta' && currentToolUse) {
              // Accumulate tool input
              currentToolUse.input += delta.partial_json || '';

              // Only forward if it's a client tool (not handled internally)
              if (!shouldHandleInternally(currentToolUse.name)) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`);
              }
            } else if (delta.type === 'text_delta' && thinkingEnabled) {
              // When thinking is enabled, parse text for <reasoning_content> tags
              // Emit thinking content as thinking_delta, text content as text_delta
              // This allows Claude Code to show "Thinking..." indicator
              const text = delta.text || '';
              const segments = reasoningParser.processChunk(text);

              // Emit content based on segment type - thinking as thinking_delta, text as text_delta
              for (const segment of segments) {
                if (segment.content) {
                  if (segment.type === 'thinking') {
                    emitThinkingDelta(segment.content);
                  } else {
                    emitTextDelta(segment.content);
                  }
                }
              }
            } else if (delta.type === 'thinking_delta') {
              // Native thinking delta from Z.ai - forward as-is and accumulate for stats
              if (delta.thinking) {
                thinkingContent += delta.thinking;
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`);
            } else {
              // Forward other deltas (text_delta without parsing)
              // Log text content for debugging truncation issues
              if (delta.type === 'text_delta' && delta.text) {
                textContent += delta.text; // Accumulate for stats
                logger.debug('anthropic-stream', 'Forwarding text_delta', {
                  length: delta.text.length,
                  preview: delta.text.substring(0, 100),
                });
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`);
            }
            break;

          case 'content_block_stop':
            // Skip stop events for non-standard block types we're filtering out
            if (streamState.skippingBlockIndex === event.index) {
              // Log server tool completion
              if (streamState.serverToolInProgress) {
                logger.info('anthropic-stream', 'Server tool completed (filtered)', {
                  toolName: streamState.serverToolInProgress.name,
                  inputLength: streamState.serverToolInput?.length || 0,
                });
                // Mark that we just finished a server tool - next text blocks are the actual response
                streamState.afterServerTool = true;
                // Clear server tool state
                streamState.serverToolInProgress = undefined;
                streamState.serverToolInput = undefined;
              }
              streamState.skippingBlockIndex = undefined;
              break;
            }

            if (currentToolUse) {
              // Parse and categorize tool call
              try {
                const parsedInput = currentToolUse.input ? JSON.parse(currentToolUse.input) : {};
                const toolCall = {
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: parsedInput,
                };

                // Add to full content
                fullContent.push({
                  type: 'tool_use',
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: parsedInput,
                });

                if (shouldHandleInternally(currentToolUse.name)) {
                  internalToolCalls.push(toolCall);
                } else {
                  clientToolCalls.push(toolCall);
                  // Forward stop event for client tools
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`);
                }
              } catch (e) {
                logger.warn('anthropic-stream', 'Failed to parse tool input', {
                  name: currentToolUse.name,
                  input: currentToolUse.input,
                });
              }
              currentToolUse = null;
            } else if (nativeThinkingBlockActive) {
              // Native thinking block stop - forward as-is
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`);
              nativeThinkingBlockActive = false;
            } else if (thinkingEnabled) {
              // When thinking is enabled, flush parser buffer and close our managed blocks
              const remainingSegments = reasoningParser.flush();
              for (const segment of remainingSegments) {
                // Emit remaining content based on segment type
                if (segment.content) {
                  if (segment.type === 'thinking') {
                    emitThinkingDelta(segment.content);
                  } else {
                    emitTextDelta(segment.content);
                  }
                }
              }

              // Close any open parsed thinking block first
              closeParsedThinkingBlock();

              // Close any open text blocks we created
              if (textBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textBlockIndex,
                })}\n\n`);
              }
            } else {
              // Forward stop for non-tool blocks when not parsing
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`);
            }
            break;

          case 'message_delta':
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              usage = {
                input_tokens: event.usage.input_tokens || usage.input_tokens,
                output_tokens: event.usage.output_tokens || usage.output_tokens,
              };
            }
            // Don't forward message_delta yet - we'll send our own after tool handling
            break;

          case 'message_stop':
            // Don't forward message_stop yet - we'll send our own after tool handling
            break;

          default:
            // Forward unknown events
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (parseError) {
        // Log parse errors with context for debugging
        logger.warn('anthropic-stream', 'Failed to parse SSE event', {
          error: parseError.message,
          data: data?.substring(0, 200),
          bytesReceived: totalBytesReceived,
        });
      }
    }

    // Track last valid chunk for error context
    if (lines.length > 0) {
      lastValidChunk = lines[lines.length - 1];
    }
  }

  logger.debug('anthropic-stream', 'Stream chunk completed', {
    thinkingLength: thinkingContent.length,
    textLength: textContent.length,
    internalTools: internalToolCalls.length,
    clientTools: clientToolCalls.length,
    stopReason,
    usage,
  });

  return {
    fullContent,
    thinkingContent,
    textContent,
    internalToolCalls,
    clientToolCalls,
    usage,
    stopReason,
  };
}

/**
 * Execute internal tools via MCP.
 *
 * @param {Array} toolCalls - Array of {id, name, input}
 * @returns {Promise<Array>} Array of tool_result blocks
 */
async function executeInternalTools(toolCalls) {
  const results = [];

  for (const tc of toolCalls) {
    const canonicalName = getCanonicalToolName(tc.name);
    const startTime = Date.now();
    let result;
    let isError = false;

    try {
      // Check if this is a custom MCP tool first
      const mcpInfo = findMcpForTool(tc.name);
      if (mcpInfo) {
        logger.info('anthropic-stream', 'Routing to custom MCP', {
          mcpId: mcpInfo.mcpId,
          tool: tc.name,
        });
        result = await callCustomMcpTool(mcpInfo.mcpId, tc.name, tc.input);
      } else if (canonicalName === 'web_search') {
        const mcpUrl = config.mcp.search.url;
        const mcpToolName = config.mcp.search.toolName;
        const query = tc.input.query || tc.input.search_query || tc.input.q || '';
        result = await callMcpTool(mcpUrl, mcpToolName, { search_query: query }, config);
      } else if (canonicalName === 'web_reader') {
        const mcpUrl = config.mcp.reader.url;
        const mcpToolName = config.mcp.reader.toolName;
        const url = tc.input.url || tc.input.href || tc.input.link || '';
        result = await callMcpTool(mcpUrl, mcpToolName, { url }, config);
      } else {
        result = `Error: Unknown internal tool ${tc.name}`;
        isError = true;
      }
    } catch (error) {
      result = `Error executing ${tc.name}: ${error.message}`;
      isError = true;
    }

    const durationMs = Date.now() - startTime;
    logger.tool(tc.name, durationMs, !isError);

    results.push({
      type: 'tool_result',
      tool_use_id: tc.id,
      content: result,
      is_error: isError,
    });
  }

  return results;
}

/**
 * Send final message events and end stream.
 *
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} usage - Token usage
 * @param {string} stopReason - Stop reason
 */
function sendFinalEvents(res, usage, stopReason) {
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens || 0 },
  })}\n\n`);

  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  res.end();
}

/**
 * Send error event.
 *
 * @param {http.ServerResponse} res - HTTP response
 * @param {string} message - Error message
 */
function sendErrorEvent(res, message) {
  res.write(`event: error\ndata: ${JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message },
  })}\n\n`);
}

export default { streamFromAnthropic };
