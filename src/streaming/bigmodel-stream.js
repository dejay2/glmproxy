/**
 * BigModel Real-Time Streaming with Hybrid Tool Handling
 *
 * Same as GLM streaming but uses BigModel endpoint URL.
 * Shares most logic with glm-stream.js for consistency.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { getCanonicalToolName, shouldHandleInternally } from '../tools/definitions.js';
import { callMcpTool } from '../tools/mcp-client.js';
import { findMcpForTool } from '../mcp/triggers.js';
import { callMcpTool as callCustomMcpTool } from '../mcp/lifecycle.js';

// Upstream API timeout (default 120 seconds for streaming, configurable via UPSTREAM_TIMEOUT env var)
const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT, 10) || 120000;

// Tags used for reasoning content extraction from text when model doesn't use native thinking
const REASONING_OPEN_TAG = '<reasoning_content>';
const REASONING_CLOSE_TAG = '</reasoning_content>';

/**
 * Reasoning Tag Parser State Machine
 *
 * Handles streaming text that may contain <reasoning_content>...</reasoning_content> tags,
 * separating thinking content from regular text content.
 */
class ReasoningTagParser {
  constructor() {
    this.buffer = '';
    this.inReasoning = false;
    this.pendingOutput = [];
  }

  processChunk(text) {
    this.buffer += text;
    this.pendingOutput = [];

    while (this.buffer.length > 0) {
      if (this.inReasoning) {
        const closeIdx = this.buffer.indexOf(REASONING_CLOSE_TAG);
        if (closeIdx !== -1) {
          const reasoningContent = this.buffer.substring(0, closeIdx);
          if (reasoningContent) {
            this.pendingOutput.push({ type: 'thinking', content: reasoningContent });
          }
          this.buffer = this.buffer.substring(closeIdx + REASONING_CLOSE_TAG.length);
          this.inReasoning = false;
        } else {
          const partialClose = this.findPartialTag(this.buffer, REASONING_CLOSE_TAG);
          if (partialClose > 0) {
            const safeContent = this.buffer.substring(0, this.buffer.length - partialClose);
            if (safeContent) {
              this.pendingOutput.push({ type: 'thinking', content: safeContent });
            }
            this.buffer = this.buffer.substring(this.buffer.length - partialClose);
          } else {
            this.pendingOutput.push({ type: 'thinking', content: this.buffer });
            this.buffer = '';
          }
          break;
        }
      } else {
        const openIdx = this.buffer.indexOf(REASONING_OPEN_TAG);
        if (openIdx !== -1) {
          const textContent = this.buffer.substring(0, openIdx);
          if (textContent) {
            this.pendingOutput.push({ type: 'text', content: textContent });
          }
          this.buffer = this.buffer.substring(openIdx + REASONING_OPEN_TAG.length);
          this.inReasoning = true;
        } else {
          const partialOpen = this.findPartialTag(this.buffer, REASONING_OPEN_TAG);
          if (partialOpen > 0) {
            const safeContent = this.buffer.substring(0, this.buffer.length - partialOpen);
            if (safeContent) {
              this.pendingOutput.push({ type: 'text', content: safeContent });
            }
            this.buffer = this.buffer.substring(this.buffer.length - partialOpen);
          } else {
            this.pendingOutput.push({ type: 'text', content: this.buffer });
            this.buffer = '';
          }
          break;
        }
      }
    }
    return this.pendingOutput;
  }

  findPartialTag(text, tag) {
    for (let len = Math.min(text.length, tag.length - 1); len > 0; len--) {
      if (text.substring(text.length - len) === tag.substring(0, len)) {
        return len;
      }
    }
    return 0;
  }

  flush() {
    const output = [];
    if (this.buffer) {
      output.push({
        type: this.inReasoning ? 'thinking' : 'text',
        content: this.buffer
      });
      this.buffer = '';
    }
    return output;
  }
}

/**
 * Generate a unique message ID
 * @returns {string} message ID
 */
function generateMessageId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `msg_${timestamp}_${random}`;
}

/**
 * Generate a unique tool use ID
 * @returns {string} tool use ID
 */
function generateToolUseId() {
  const random = Math.random().toString(36).substring(2, 12);
  return `toolu_${random}`;
}

/**
 * Send SSE event to client
 * @param {http.ServerResponse} res - HTTP response object
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
function sendEvent(res, event, data) {
  const eventStr = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(eventStr);
}

/**
 * Stream response from BigModel API with hybrid tool handling
 *
 * @param {http.ServerResponse} res - HTTP response object
 * @param {Object} glmRequest - GLM format request (will be modified to enable streaming)
 * @param {string} originalModel - Original model name from client request
 * @param {Object} options - Additional options
 * @param {Array} options.conversationHistory - Full conversation for tool loop continuation
 * @returns {Promise<{usage: Object, thinkingContent: string, textContent: string}>}
 */
export async function streamFromBigModel(res, glmRequest, originalModel, options = {}) {
  const messageId = generateMessageId();
  const conversationHistory = options.conversationHistory || [...glmRequest.messages];
  const maxToolIterations = config.toolExecution?.maxIterations || 10;
  let toolIteration = 0;

  logger.info('bigmodel-stream', 'Starting real-time stream from BigModel', {
    model: glmRequest.model,
    hasTools: !!(glmRequest.tools?.length),
  });

  // Set SSE headers only on first call
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (res.socket) {
      res.socket.setNoDelay(true);
    }
    res.flushHeaders();

    // Send message_start
    sendEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // Enable streaming in request
  const streamingRequest = { ...glmRequest, stream: true, messages: conversationHistory };

  try {
    const result = await streamBigModelWithToolDetection(res, streamingRequest);

    // Check if we need to handle internal tools
    if (result.internalToolCalls && result.internalToolCalls.length > 0) {
      toolIteration++;

      if (toolIteration > maxToolIterations) {
        logger.warn('bigmodel-stream', 'Max tool iterations reached', { toolIteration });
        sendFinalEvents(res, result.usage, 'end_turn');
        return { usage: result.usage, thinkingContent: result.thinkingContent, textContent: result.textContent };
      }

      logger.info('bigmodel-stream', 'Executing internal tools during stream', {
        tools: result.internalToolCalls.map(tc => tc.name),
        iteration: toolIteration,
      });

      // Execute internal tools
      const toolResults = await executeInternalTools(result.internalToolCalls);

      // Build assistant message with tool calls for history
      const assistantMessage = {
        role: 'assistant',
        content: result.textContent || null,
        tool_calls: result.internalToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };

      // Add assistant message to history
      conversationHistory.push(assistantMessage);

      // Add tool results to history
      for (let i = 0; i < result.internalToolCalls.length; i++) {
        conversationHistory.push({
          role: 'tool',
          tool_call_id: result.internalToolCalls[i].id,
          content: toolResults[i],
        });
      }

      // Continue streaming with tool results
      return await streamFromBigModel(res, glmRequest, originalModel, { conversationHistory });
    }

    // Check if we have client tools to return (ends the stream)
    if (result.clientToolCalls && result.clientToolCalls.length > 0) {
      logger.info('bigmodel-stream', 'Returning client tools', {
        tools: result.clientToolCalls.map(tc => tc.name),
      });

      // Stream each client tool as a content block
      for (const toolCall of result.clientToolCalls) {
        const toolIndex = result.currentBlockIndex++;

        sendEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: {},
          },
        });

        // Stream the input JSON
        const inputJson = JSON.stringify(toolCall.arguments);
        sendEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: toolIndex,
          delta: { type: 'input_json_delta', partial_json: inputJson },
        });

        sendEvent(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: toolIndex,
        });
      }

      sendFinalEvents(res, result.usage, 'tool_use');
      return { usage: result.usage, thinkingContent: result.thinkingContent, textContent: result.textContent };
    }

    // No tools - normal completion
    sendFinalEvents(res, result.usage, result.stopReason || 'end_turn');
    return { usage: result.usage, thinkingContent: result.thinkingContent, textContent: result.textContent };
  } catch (error) {
    logger.error('bigmodel-stream', 'Streaming error', { error: error.message });
    sendEvent(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: error.message },
    });
    res.end();
    return { usage: {}, thinkingContent: '', textContent: '' };
  }
}

/**
 * Stream from BigModel and detect tool calls
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} streamingRequest - Request with stream: true
 * @returns {Promise<Object>} Result with content and tool calls
 */
async function streamBigModelWithToolDetection(res, streamingRequest) {
  let response;
  let totalBytesReceived = 0;
  let lastValidChunk = '';

  // Log the request details for debugging tool_choice issues
  if (streamingRequest.tools?.length > 0) {
    logger.debug('bigmodel-stream', 'Request with tools', {
      toolCount: streamingRequest.tools.length,
      toolNames: streamingRequest.tools.map(t => t.function?.name),
      toolChoice: streamingRequest.tool_choice,
    });
  }

  try {
    response = await fetch(config.bigModelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.zaiApiKey}`,
      },
      body: JSON.stringify(streamingRequest),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      logger.error('bigmodel-stream', 'Upstream API timeout', {
        timeout: UPSTREAM_TIMEOUT,
      });
      throw new Error(`Upstream API did not respond within ${UPSTREAM_TIMEOUT / 1000} seconds`);
    }
    logger.error('bigmodel-stream', 'Upstream API network error', {
      error: error.message,
    });
    throw new Error(`Upstream API network error: ${error.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('bigmodel-stream', 'BigModel API error', {
      status: response.status,
      body: errorText.substring(0, 500),
    });
    throw new Error(`BigModel API error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Always enable thinking since reasoning prompt is always injected
  const thinkingEnabled = true;

  let thinkingBlockStarted = false;
  let textBlockStarted = false;
  let thinkingBlockIndex = -1;
  let textBlockIndex = -1;
  let currentBlockIndex = 0;

  let thinkingContent = '';
  let textContent = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = 'end_turn';

  const toolCallAccumulators = new Map();

  // Reasoning tag parser for extracting <reasoning_content> from text when native thinking isn't used
  const reasoningParser = thinkingEnabled ? new ReasoningTagParser() : null;
  let parsedThinkingBlockStarted = false;
  let parsedThinkingBlockIndex = -1;

  // Helper to start a parsed thinking block
  const startParsedThinkingBlock = () => {
    if (!parsedThinkingBlockStarted) {
      parsedThinkingBlockStarted = true;
      parsedThinkingBlockIndex = currentBlockIndex++;
      sendEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: parsedThinkingBlockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
    }
  };

  // Helper to close parsed thinking block
  const closeParsedThinkingBlock = () => {
    if (parsedThinkingBlockStarted && !thinkingBlockStarted) {
      sendEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: parsedThinkingBlockIndex,
      });
      parsedThinkingBlockStarted = false;
    }
  };

  while (true) {
    let readResult;
    try {
      readResult = await reader.read();
    } catch (readError) {
      logger.error('bigmodel-stream', 'Stream read error', {
        error: readError.message,
        bytesReceived: totalBytesReceived,
        lastValidChunk: lastValidChunk?.substring(0, 100),
      });

      sendEvent(res, 'error', {
        type: 'error',
        error: {
          type: 'stream_error',
          message: 'Stream read failed - response may be incomplete',
          bytes_received: totalBytesReceived,
        },
      });
      break;
    }

    const { done, value } = readResult;
    if (done) break;

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
        const choice = event.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        // Handle reasoning_content (thinking)
        if (delta.reasoning_content && thinkingEnabled) {
          if (!thinkingBlockStarted) {
            thinkingBlockStarted = true;
            thinkingBlockIndex = currentBlockIndex++;
            sendEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index: thinkingBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            });
          }
          thinkingContent += delta.reasoning_content;
          sendEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: thinkingBlockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          });
        }

        // Handle content (text)
        if (delta.content) {
          // If thinking is enabled and we got native reasoning, close it before text
          if (thinkingBlockStarted && !textBlockStarted) {
            sendEvent(res, 'content_block_stop', {
              type: 'content_block_stop',
              index: thinkingBlockIndex,
            });
          }

          // If thinking is enabled but no native reasoning, parse text for <reasoning_content> tags
          if (thinkingEnabled && reasoningParser && !thinkingBlockStarted) {
            const segments = reasoningParser.processChunk(delta.content);
            for (const segment of segments) {
              if (segment.content) {
                if (segment.type === 'thinking') {
                  // Emit as thinking
                  startParsedThinkingBlock();
                  thinkingContent += segment.content;
                  sendEvent(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: parsedThinkingBlockIndex,
                    delta: { type: 'thinking_delta', thinking: segment.content },
                  });
                } else {
                  // Emit as text - close thinking first if needed
                  closeParsedThinkingBlock();
                  if (!textBlockStarted) {
                    textBlockStarted = true;
                    textBlockIndex = currentBlockIndex++;
                    sendEvent(res, 'content_block_start', {
                      type: 'content_block_start',
                      index: textBlockIndex,
                      content_block: { type: 'text', text: '' },
                    });
                  }
                  textContent += segment.content;
                  sendEvent(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: textBlockIndex,
                    delta: { type: 'text_delta', text: segment.content },
                  });
                }
              }
            }
          } else {
            // No tag parsing needed - just emit text normally
            if (!textBlockStarted) {
              textBlockStarted = true;
              textBlockIndex = currentBlockIndex++;
              sendEvent(res, 'content_block_start', {
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: { type: 'text', text: '' },
              });
            }
            textContent += delta.content;
            sendEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            });
          }
        }

        // Handle tool_calls (modern OpenAI format)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const tcIndex = tc.index ?? 0;

            if (!toolCallAccumulators.has(tcIndex)) {
              toolCallAccumulators.set(tcIndex, {
                id: tc.id || generateToolUseId(),
                name: tc.function?.name || '',
                arguments: '',
              });
            }

            const acc = toolCallAccumulators.get(tcIndex);
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }

        // Handle function_call (older OpenAI format, some APIs still use this)
        if (delta.function_call) {
          if (!toolCallAccumulators.has(0)) {
            toolCallAccumulators.set(0, {
              id: generateToolUseId(),
              name: delta.function_call.name || '',
              arguments: '',
            });
          }

          const acc = toolCallAccumulators.get(0);
          if (delta.function_call.name) acc.name = delta.function_call.name;
          if (delta.function_call.arguments) acc.arguments += delta.function_call.arguments;
        }

        // Debug log delta keys when we have tools but no tool calls yet
        if (streamingRequest.tools?.length > 0 && toolCallAccumulators.size === 0) {
          const deltaKeys = Object.keys(delta);
          if (deltaKeys.length > 0 && !deltaKeys.every(k => ['content', 'reasoning_content', 'role'].includes(k))) {
            logger.debug('bigmodel-stream', 'Delta keys (looking for tool calls)', { deltaKeys });
          }
        }

        // Handle finish_reason
        if (choice.finish_reason) {
          if (choice.finish_reason === 'tool_calls') {
            stopReason = 'tool_use';
          } else {
            stopReason = choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason;
          }
        }

        // Handle usage
        if (event.usage) {
          usage = {
            input_tokens: event.usage.prompt_tokens || 0,
            output_tokens: event.usage.completion_tokens || 0,
          };
        }
      } catch (parseError) {
        logger.warn('bigmodel-stream', 'Failed to parse SSE event', {
          error: parseError.message,
          data: data?.substring(0, 200),
          bytesReceived: totalBytesReceived,
        });
      }
    }

    if (lines.length > 0) {
      lastValidChunk = lines[lines.length - 1];
    }
  }

  // Flush any remaining content from the reasoning parser
  if (reasoningParser) {
    const remainingSegments = reasoningParser.flush();
    for (const segment of remainingSegments) {
      if (segment.content) {
        if (segment.type === 'thinking') {
          startParsedThinkingBlock();
          thinkingContent += segment.content;
          sendEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: parsedThinkingBlockIndex,
            delta: { type: 'thinking_delta', thinking: segment.content },
          });
        } else {
          closeParsedThinkingBlock();
          if (!textBlockStarted) {
            textBlockStarted = true;
            textBlockIndex = currentBlockIndex++;
            sendEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index: textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          textContent += segment.content;
          sendEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: segment.content },
          });
        }
      }
    }
  }

  // Close any open parsed thinking block
  closeParsedThinkingBlock();

  // Close any open text block
  if (textBlockStarted) {
    sendEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: textBlockIndex,
    });
  } else if (thinkingBlockStarted) {
    sendEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: thinkingBlockIndex,
    });
  }

  // Parse accumulated tool calls
  const allToolCalls = [];
  for (const [, acc] of toolCallAccumulators) {
    try {
      const parsedArgs = acc.arguments ? JSON.parse(acc.arguments) : {};
      allToolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      });
    } catch (e) {
      logger.warn('bigmodel-stream', 'Failed to parse tool arguments', {
        name: acc.name,
        arguments: acc.arguments,
        error: e.message,
      });
    }
  }

  const internalToolCalls = allToolCalls.filter(tc => shouldHandleInternally(tc.name));
  const clientToolCalls = allToolCalls.filter(tc => !shouldHandleInternally(tc.name));

  logger.info('bigmodel-stream', 'Stream chunk completed', {
    thinkingLength: thinkingContent.length,
    textLength: textContent.length,
    internalTools: internalToolCalls.length,
    clientTools: clientToolCalls.length,
    usage,
  });

  return {
    thinkingContent,
    textContent,
    internalToolCalls,
    clientToolCalls,
    usage,
    stopReason,
    currentBlockIndex,
  };
}

/**
 * Execute internal tools via MCP
 * @param {Array} toolCalls - Array of {id, name, arguments}
 * @returns {Promise<Array<string>>} Tool results
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
        logger.info('bigmodel-stream', 'Routing to custom MCP', {
          mcpId: mcpInfo.mcpId,
          tool: tc.name,
        });
        result = await callCustomMcpTool(mcpInfo.mcpId, tc.name, tc.arguments);
      } else if (canonicalName === 'web_search') {
        const mcpUrl = config.mcp.search.url;
        const mcpToolName = config.mcp.search.toolName;
        const query = tc.arguments.query || tc.arguments.search_query || tc.arguments.q || '';
        result = await callMcpTool(mcpUrl, mcpToolName, { search_query: query }, config);
      } else if (canonicalName === 'web_reader') {
        const mcpUrl = config.mcp.reader.url;
        const mcpToolName = config.mcp.reader.toolName;
        const url = tc.arguments.url || tc.arguments.href || tc.arguments.link || '';
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
    results.push(result);
  }

  return results;
}

/**
 * Send final message events and end stream
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} usage - Token usage
 * @param {string} stopReason - Stop reason
 */
function sendFinalEvents(res, usage, stopReason) {
  sendEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });

  sendEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

export default { streamFromBigModel };
