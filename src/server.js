/**
 * HTTP Proxy Server
 *
 * Receives Anthropic Messages API requests, transforms to GLM format,
 * calls Z.ai API, and returns Anthropic format responses.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { validateConfig, getConfigSummary, updateConfig } from './config.js';
import { transformRequest } from './transformers/request.js';
import { transformResponse } from './transformers/response.js';
import { prepareAnthropicRequest } from './transformers/anthropic-request.js';
import { executeWithTools } from './tools/executor.js';
import { executeWithToolsAnthropic } from './tools/anthropic-executor.js';
import { validateRequest } from './middleware/validate.js';
import { isStreamingRequest } from './streaming/sse.js';
import { streamFromGLM } from './streaming/glm-stream.js';
import { streamFromAnthropic } from './streaming/anthropic-stream.js';
import { streamFromBigModel } from './streaming/bigmodel-stream.js';
import { detectImages } from './routing/model-router.js';
import { processMessagesForVideos, extractWorkingDirectory } from './utils/video-detector.js';
import logger from './utils/logger.js';
import {
  ProxyError,
  InvalidRequestError,
  GlmApiError,
  ContextLimitError,
  toAnthropicError,
  getErrorStatus,
  isContextLimitError,
} from './utils/errors.js';
import {
  initRegistry,
  getAllMcps,
  getMcp,
  getMcpSafe,
  addMcp,
  updateMcp,
  removeMcp,
  enableMcp,
  disableMcp,
} from './mcp/registry.js';
import { shutdownAllMcps, shutdownMcp, getMcpTools } from './mcp/lifecycle.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

// Server start time for uptime calculation
let serverStartTime = null;

// Server instance for graceful shutdown
let serverInstance = null;

// Track if shutdown is in progress
let isShuttingDown = false;

// Upstream API timeout (default 60 seconds, configurable via UPSTREAM_TIMEOUT env var)
const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT, 10) || 60000;

// Traffic monitoring: SSE clients connected to /v1/traffic
const trafficClients = new Set();

/**
 * Determine which endpoint to use based on config and request
 * @param {boolean} hasImagesInCurrentMessage - Whether the current message has images
 * @returns {string} Endpoint to use: 'anthropic', 'openai', or 'bigmodel'
 */
function determineEndpoint(hasImagesInCurrentMessage) {
  // Vision requests always go through OpenAI path
  if (hasImagesInCurrentMessage) {
    return 'openai';
  }

  const mode = config.endpoint.mode;

  // Direct mode selection
  if (mode === 'anthropic' || mode === 'openai' || mode === 'bigmodel') {
    return mode;
  }

  // Legacy fallback: check useAnthropic flag
  return config.endpoint.useAnthropic ? 'anthropic' : 'openai';
}

/**
 * Broadcast traffic event to all connected clients
 * @param {Object} event - Traffic event
 */
function broadcastTrafficEvent(event) {
  if (trafficClients.size === 0) return;

  const eventData = JSON.stringify(event);
  const sseMessage = `data: ${eventData}\n\n`;

  trafficClients.forEach((client) => {
    try {
      client.write(sseMessage);
    } catch (error) {
      logger.debug('traffic', 'Failed to send to client, removing', { error: error.message });
      trafficClients.delete(client);
    }
  });
}

/**
 * Get MIME type for file extension
 * @param {string} filePath - File path
 * @returns {string} MIME type
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Serve static file
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @param {string} filePath - File path to serve
 */
async function serveStaticFile(req, res, filePath) {
  try {
    const content = await fs.readFile(filePath);
    const mimeType = getMimeType(filePath);

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(content);

    logger.debug('static', `Served: ${filePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const notFoundError = new InvalidRequestError(`File not found: ${req.url}`);
      notFoundError.type = 'not_found_error';
      notFoundError.status = 404;
      sendError(res, notFoundError);
    } else {
      logger.errorWithStack('static', 'Failed to serve file', error);
      sendError(res, new ProxyError('Failed to serve file', 'api_error', 500));
    }
  }
}

/**
 * Read request body as string with size limit
 * @param {http.IncomingMessage} req - HTTP request
 * @returns {Promise<string>} request body
 */
function readBody(req) {
  // 50MB limit for API requests (supports base64-encoded images and videos)
  const MAX_BODY_SIZE = 50 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      // Enforce body size limit to prevent memory exhaustion DoS
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        const error = new InvalidRequestError(
          `Request body too large (max ${MAX_BODY_SIZE} bytes)`
        );
        error.type = 'invalid_request_error';
        error.status = 413;
        reject(error);
        return;
      }

      data += chunk;
    });

    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 * @param {http.ServerResponse} res - HTTP response
 * @param {number} status - HTTP status code
 * @param {Object} data - Response data
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Send error response in Anthropic format
 * @param {http.ServerResponse} res - HTTP response
 * @param {Error} error - Error object
 */
function sendError(res, error) {
  const status = getErrorStatus(error);
  const errorResponse = toAnthropicError(error);
  logger.errorWithStack('server', 'Request failed', error);
  sendJson(res, status, errorResponse);
}

/**
 * Call Z.ai GLM API
 * @param {Object} glmRequest - GLM format request
 * @returns {Promise<Object>} GLM response
 */
async function callGLMApi(glmRequest) {
  const startTime = Date.now();

  // Debug: log the full request being sent
  logger.info('glm', 'Sending request to GLM', {
    requestPreview: JSON.stringify(glmRequest).substring(0, 1500),
  });

  logger.glmCall(glmRequest.model, glmRequest.messages?.length, !!glmRequest.tools?.length);

  let response;
  try {
    response = await fetch(config.zaiBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.zaiApiKey}`,
      },
      body: JSON.stringify(glmRequest),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (error) {
    // Handle timeout and abort errors
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      logger.error('glm', 'GLM API timeout', {
        timeout: UPSTREAM_TIMEOUT,
        elapsed: Date.now() - startTime,
      });
      const timeoutError = new GlmApiError(
        `Upstream API did not respond within ${UPSTREAM_TIMEOUT / 1000} seconds`,
        504,
        'timeout'
      );
      timeoutError.type = 'timeout';
      throw timeoutError;
    }
    // Re-throw other errors (network issues, etc.)
    logger.error('glm', 'GLM API network error', {
      error: error.message,
      elapsed: Date.now() - startTime,
    });
    throw new GlmApiError(`GLM API network error: ${error.message}`, 502, error.message);
  }

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('glm', 'GLM API error', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.substring(0, 500),
    });

    // Check if this is a context window limit error
    const fullErrorMessage = `${response.status} ${response.statusText} ${errorText}`;
    if (isContextLimitError(fullErrorMessage)) {
      throw new ContextLimitError(`The model has reached its context window limit. Please compact the conversation to continue.`);
    }

    throw new GlmApiError(
      `GLM API error: ${response.status} ${response.statusText}`,
      response.status,
      errorText
    );
  }

  const data = await response.json();

  // Debug: log raw GLM response
  logger.info('glm', 'Raw GLM response', {
    responsePreview: JSON.stringify(data).substring(0, 1000),
  });

  logger.glmResponse(
    data.model,
    data.choices?.[0]?.finish_reason,
    durationMs,
    data.usage
  );

  return data;
}

/**
 * Call Z.ai Anthropic-compatible API
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Promise<Object>} Anthropic format response
 */
async function callAnthropicApi(anthropicRequest) {
  const startTime = Date.now();

  logger.info('anthropic-api', 'Sending request to Anthropic endpoint', {
    requestPreview: JSON.stringify(anthropicRequest).substring(0, 1500),
  });

  logger.glmCall(anthropicRequest.model, anthropicRequest.messages?.length, !!anthropicRequest.tools?.length);

  let response;
  try {
    response = await fetch(config.zaiAnthropicUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.zaiApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicRequest),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (error) {
    // Handle timeout and abort errors
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      logger.error('anthropic-api', 'Anthropic API timeout', {
        timeout: UPSTREAM_TIMEOUT,
        elapsed: Date.now() - startTime,
      });
      const timeoutError = new GlmApiError(
        `Upstream API did not respond within ${UPSTREAM_TIMEOUT / 1000} seconds`,
        504,
        'timeout'
      );
      timeoutError.type = 'timeout';
      throw timeoutError;
    }
    // Re-throw other errors (network issues, etc.)
    logger.error('anthropic-api', 'Anthropic API network error', {
      error: error.message,
      elapsed: Date.now() - startTime,
    });
    throw new GlmApiError(`Anthropic API network error: ${error.message}`, 502, error.message);
  }

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('anthropic-api', 'Anthropic API error', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.substring(0, 500),
    });

    // Check if this is a context window limit error
    const fullErrorMessage = `${response.status} ${response.statusText} ${errorText}`;
    if (isContextLimitError(fullErrorMessage)) {
      throw new ContextLimitError(`The model has reached its context window limit. Please compact the conversation to continue.`);
    }

    throw new GlmApiError(
      `Anthropic API error: ${response.status} ${response.statusText}`,
      response.status,
      errorText
    );
  }

  const data = await response.json();

  logger.info('anthropic-api', 'Raw Anthropic response', {
    responsePreview: JSON.stringify(data).substring(0, 1000),
  });

  logger.glmResponse(
    data.model,
    data.stop_reason,
    durationMs,
    data.usage
  );

  return data;
}

/**
 * Handle GET /v1/traffic endpoint (SSE traffic monitoring)
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
function handleTrafficSSE(req, res) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial connection event
  const connectionEvent = {
    id: `conn-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: 'connection',
    data: { message: 'Traffic monitor connected' },
  };
  res.write(`data: ${JSON.stringify(connectionEvent)}\n\n`);

  // Add client to set
  trafficClients.add(res);
  logger.info('traffic', 'Client connected to traffic monitor', { totalClients: trafficClients.size });

  // Handle client disconnect
  req.on('close', () => {
    trafficClients.delete(res);
    logger.info('traffic', 'Client disconnected from traffic monitor', { totalClients: trafficClients.size });
  });
}

/**
 * Summarize conversation messages
 * @param {Array} messages - Messages to summarize
 * @param {string} model - Model to use for summarization
 * @param {string} endpoint - Endpoint to use ('anthropic', 'openai', 'bigmodel')
 * @returns {Promise<string>} Summary of the conversation
 */
async function summarizeConversation(messages, model, endpoint) {
  // Create a structured summary prompt based on Anthropic SDK's approach
  const conversationText = messages.map(m => {
    const role = m.role;
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map(block => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool_use') return `[Tool use: ${block.name}]`;
        if (block.type === 'tool_result') return `[Tool result for ${block.tool_use_id}]`;
        if (block.type === 'image') return '[Image]';
        return '[Content block]';
      }).join('\n');
    }
    return `${role}: ${content}`;
  }).join('\n\n');

  const summaryPrompt = {
    model,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `You have been working on a task but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:

1. Task Overview
   - The user's core request and success criteria
   - Any clarifications or constraints they specified

2. Current State
   - What has been completed so far
   - Files created, modified, or analyzed (with paths if relevant)
   - Key outputs or artifacts produced

3. Important Discoveries
   - Technical constraints or requirements uncovered
   - Decisions made and their rationale
   - Errors encountered and how they were resolved
   - What approaches were tried that didn't work (and why)

4. Next Steps
   - Specific actions needed to complete the task
   - Any blockers or open questions to resolve
   - Priority order if multiple steps remain

5. Context to Preserve
   - User preferences or style requirements
   - Domain-specific details that aren't obvious
   - Any promises made to the user

Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.

Wrap your summary in <summary></summary> tags.

Conversation history:
${conversationText}`,
      },
    ],
  };

  logger.info('compact', 'Requesting conversation summary', {
    messageCount: messages.length,
    endpoint,
  });

  try {
    let summaryResponse;
    if (endpoint === 'anthropic') {
      const preparedRequest = prepareAnthropicRequest(summaryPrompt);
      summaryResponse = await callAnthropicApi({ ...preparedRequest.request, stream: false });
    } else if (endpoint === 'bigmodel') {
      const glmRequest = await transformRequest(summaryPrompt);
      summaryResponse = await callBigModelApi(glmRequest.request);
    } else {
      // OpenAI endpoint (default)
      const glmRequest = await transformRequest(summaryPrompt);
      summaryResponse = await callGLMApi(glmRequest.request);
    }

    // Extract summary text from response
    let summaryText = '';
    if (summaryResponse.content) {
      const textBlock = summaryResponse.content.find(block => block.type === 'text');
      if (textBlock) {
        summaryText = textBlock.text;
      }
    } else if (summaryResponse.choices?.[0]?.message?.content) {
      summaryText = summaryResponse.choices[0].message.content;
    }

    logger.info('compact', 'Conversation summary completed', {
      summaryLength: summaryText.length,
    });

    return summaryText;
  } catch (error) {
    logger.error('compact', 'Failed to generate summary, using fallback', { error: error.message });
    // Fallback: create a basic summary wrapper
    return `<summary>Previous conversation contained ${messages.length} messages. Summary generation failed, but the conversation was compacted to continue.</summary>`;
  }
}

/**
 * Handle POST /v1/messages endpoint with auto-compact retry
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
async function handleMessages(req, res) {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Read and parse request body
  const body = await readBody(req);
  let anthropicRequest;

  try {
    anthropicRequest = JSON.parse(body);
  } catch (parseError) {
    throw new InvalidRequestError('Invalid JSON in request body');
  }

  // Broadcast request event
  broadcastTrafficEvent({
    id: requestId,
    timestamp: new Date().toISOString(),
    type: 'request',
    data: {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': req.headers['content-type'],
        'x-api-key': req.headers['x-api-key'] ? '[REDACTED]' : undefined,
      },
      body: anthropicRequest,
    },
  });

  // Extract working directory from system prompt (Claude Code includes this)
  const workingDir = extractWorkingDirectory(anthropicRequest.system);
  if (workingDir) {
    logger.debug('request', 'Working directory from system prompt', { workingDir });
  }

  // Process messages for video file references (e.g., @video.mp4 or /path/to/video.mp4)
  // This converts file path references to proper video content blocks
  if (anthropicRequest.messages && Array.isArray(anthropicRequest.messages)) {
    anthropicRequest.messages = await processMessagesForVideos(anthropicRequest.messages, workingDir);
  }

  // Validate request structure
  validateRequest(anthropicRequest);

  logger.request(req, anthropicRequest.messages?.length);

  // Log message content for debugging
  const messages = anthropicRequest.messages || [];
  messages.forEach((msg, i) => {
    const content = msg.content;
    if (typeof content === 'string') {
      logger.debug('request', `Message ${i} [${msg.role}]`, {
        contentType: 'string',
        preview: content.substring(0, 100)
      });
    } else if (Array.isArray(content)) {
      const types = content.map(b => b.type);
      logger.debug('request', `Message ${i} [${msg.role}]`, {
        contentTypes: types,
        blockCount: content.length
      });
    }
  });

  logger.debug('request', 'Request details', {
    model: anthropicRequest.model,
    hasClientTools: !!(anthropicRequest.tools?.length),
    hasSystem: !!anthropicRequest.system,
    stream: anthropicRequest.stream,
    endpointMode: config.endpoint.mode,
  });

  // Log thinking parameter from client for debugging
  if (anthropicRequest.thinking) {
    logger.debug('request', 'Client sent thinking parameter (ignored)', {
      thinkingType: anthropicRequest.thinking.type,
    });
  }

  // Validate API key is configured
  const validation = validateConfig();
  if (!validation.isValid) {
    logger.error('config', 'Configuration error', { errors: validation.errors });
    throw new ProxyError(validation.errors.join('; '), 'api_error', 500);
  }

  // Check which endpoint to use
  // Vision requests (glm-4.6v) always use OpenAI path to avoid Z.ai's server_tool_use interception
  // Only check the LAST message for images - previous images in history don't require vision model
  const lastMessage = messages.length > 0 ? [messages[messages.length - 1]] : [];
  const hasImagesInCurrentMessage = detectImages(lastMessage);

  // Determine endpoint based on mode and vision
  const endpoint = determineEndpoint(hasImagesInCurrentMessage);

  logger.info('routing', 'Request routing', {
    endpoint,
    hasImages: hasImagesInCurrentMessage,
    mode: config.endpoint.mode,
  });

  // Try the request with auto-compact retry on context limit errors
  // Only retry for non-streaming requests (streaming can't be retried mid-stream)
  const wantsStreaming = isStreamingRequest(anthropicRequest);

  try {
    if (endpoint === 'anthropic') {
      await handleAnthropicPath(res, anthropicRequest, startTime, requestId);
    } else if (endpoint === 'bigmodel') {
      await handleBigModelPath(res, anthropicRequest, startTime, requestId);
    } else {
      // 'openai' or default
      await handleOpenAIPath(res, anthropicRequest, startTime, requestId);
    }
  } catch (error) {
    // Auto-compact on context limit errors (only for non-streaming)
    if (error instanceof ContextLimitError && !wantsStreaming && messages.length > 1) {
      logger.info('compact', 'Auto-compact triggered by context limit error', {
        messageCount: messages.length,
        endpoint,
      });

      try {
        // Generate summary of conversation
        const summary = await summarizeConversation(messages, anthropicRequest.model, endpoint);

        // Create compacted request with summary as assistant message
        // This mimics the Anthropic SDK's client-side compaction approach
        const compactedRequest = { ...anthropicRequest };

        // Replace entire message history with a single assistant message containing the summary
        compactedRequest.messages = [
          {
            role: 'assistant',
            content: summary,
          },
        ];

        logger.info('compact', 'Retrying request with compacted conversation', {
          originalMessageCount: messages.length,
          newMessageCount: compactedRequest.messages.length,
          summaryLength: summary.length,
        });

        // Update the request for the next attempt
        anthropicRequest = compactedRequest;

        // Retry the request
        if (endpoint === 'anthropic') {
          await handleAnthropicPath(res, anthropicRequest, startTime, requestId);
        } else if (endpoint === 'bigmodel') {
          await handleBigModelPath(res, anthropicRequest, startTime, requestId);
        } else {
          await handleOpenAIPath(res, anthropicRequest, startTime, requestId);
        }

        logger.info('compact', 'Auto-compact retry successful');
        return;
      } catch (retryError) {
        logger.error('compact', 'Auto-compact retry failed', {
          error: retryError.message,
        });
        // Fall through to send the retry error
        error = retryError;
      }
    }

    // Broadcast error event
    broadcastTrafficEvent({
      id: `${requestId}-error`,
      timestamp: new Date().toISOString(),
      type: 'error',
      data: {
        requestId,
        error: {
          type: error.type || 'unknown_error',
          message: error.message,
          status: getErrorStatus(error),
        },
      },
    });
    sendError(res, error);
  }
}

/**
 * Handle request via OpenAI-compatible endpoint (original path)
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} anthropicRequest - Original Anthropic request
 * @param {number} startTime - Request start time
 * @param {string} requestId - Unique request ID
 */
async function handleOpenAIPath(res, anthropicRequest, startTime, requestId) {
  // Transform request to GLM format (async for MCP tool injection)
  const { request: glmRequest, injections } = await transformRequest(anthropicRequest);

  // Broadcast proxy injection event if any injections were made
  if (injections.length > 0) {
    broadcastTrafficEvent({
      id: `${requestId}-proxy-injection`,
      timestamp: new Date().toISOString(),
      type: 'proxy_injection',
      data: {
        requestId,
        injections,
      },
    });
  }

  // Check if we should use real-time streaming from GLM
  const wantsStreaming = isStreamingRequest(anthropicRequest);

  if (wantsStreaming) {
    logger.info('streaming', 'Using real-time GLM streaming with tool support', {
      model: glmRequest.model,
      hasClientTools: !!(anthropicRequest.tools?.length),
    });
    const streamResult = await streamFromGLM(res, glmRequest, anthropicRequest.model);

    // Broadcast response event for stats tracking
    const durationMs = Date.now() - startTime;
    broadcastTrafficEvent({
      id: `${requestId}-response`,
      timestamp: new Date().toISOString(),
      type: 'response',
      data: {
        requestId,
        statusCode: 200,
        durationMs,
        endpoint: 'openai',
        messageCount: anthropicRequest.messages?.length || 0, // For session detection
        body: {
          usage: streamResult?.usage || {},
          content: [
            ...(streamResult?.thinkingContent ? [{ type: 'thinking', thinking: streamResult.thinkingContent }] : []),
            { type: 'text', text: streamResult?.textContent || '' },
          ],
        },
      },
    });
    return;
  }

  // Non-streaming path: execute with tool loop
  const glmResponse = await executeWithTools(glmRequest, callGLMApi, config);

  // Transform response to Anthropic format
  const anthropicResponse = transformResponse(glmResponse, anthropicRequest.model);

  const durationMs = Date.now() - startTime;

  // Broadcast response event
  broadcastTrafficEvent({
    id: `${requestId}-response`,
    timestamp: new Date().toISOString(),
    type: 'response',
    data: {
      requestId,
      statusCode: 200,
      durationMs,
      endpoint: 'openai',
      messageCount: anthropicRequest.messages?.length || 0, // For session detection
      body: anthropicResponse,
    },
  });

  logger.response(200, anthropicResponse.stop_reason, durationMs);
  logger.debug('response', 'Response details', {
    messageId: anthropicResponse.id,
    inputTokens: anthropicResponse.usage?.input_tokens,
    outputTokens: anthropicResponse.usage?.output_tokens,
    contentBlocks: anthropicResponse.content?.length,
  });
  sendJson(res, 200, anthropicResponse);
}

/**
 * Handle request via Anthropic-compatible endpoint (native path)
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} anthropicRequest - Original Anthropic request
 * @param {number} startTime - Request start time
 * @param {string} requestId - Unique request ID
 */
async function handleAnthropicPath(res, anthropicRequest, startTime, requestId) {
  // Prepare request for Anthropic endpoint (add tools, thinking) - async for MCP tool injection
  const { request: preparedRequest, injections } = await prepareAnthropicRequest(anthropicRequest);

  // Broadcast proxy injection event if any injections were made
  if (injections.length > 0) {
    broadcastTrafficEvent({
      id: `${requestId}-proxy-injection`,
      timestamp: new Date().toISOString(),
      type: 'proxy_injection',
      data: {
        requestId,
        injections,
      },
    });
  }

  // Check if we should use streaming
  const wantsStreaming = isStreamingRequest(anthropicRequest);

  if (wantsStreaming) {
    logger.info('streaming', 'Using Anthropic endpoint streaming with tool support', {
      model: preparedRequest.model,
      hasThinking: !!preparedRequest.thinking,
      hasClientTools: !!(anthropicRequest.tools?.length),
    });
    const streamResult = await streamFromAnthropic(res, { ...preparedRequest, stream: true });

    // Broadcast response event for stats tracking
    const durationMs = Date.now() - startTime;
    broadcastTrafficEvent({
      id: `${requestId}-response`,
      timestamp: new Date().toISOString(),
      type: 'response',
      data: {
        requestId,
        statusCode: 200,
        durationMs,
        endpoint: 'anthropic',
        messageCount: anthropicRequest.messages?.length || 0, // For session detection
        body: {
          usage: streamResult?.usage || {},
          content: [
            ...(streamResult?.thinkingContent ? [{ type: 'thinking', thinking: streamResult.thinkingContent }] : []),
            { type: 'text', text: streamResult?.textContent || '' },
          ],
        },
      },
    });
    return;
  }

  // Non-streaming path: execute with tool loop
  const anthropicResponse = await executeWithToolsAnthropic(preparedRequest, callAnthropicApi, config);

  const durationMs = Date.now() - startTime;

  // Broadcast response event
  broadcastTrafficEvent({
    id: `${requestId}-response`,
    timestamp: new Date().toISOString(),
    type: 'response',
    data: {
      requestId,
      statusCode: 200,
      durationMs,
      endpoint: 'anthropic',
      messageCount: anthropicRequest.messages?.length || 0, // For session detection
      body: anthropicResponse,
    },
  });

  logger.response(200, anthropicResponse.stop_reason, durationMs);
  logger.debug('response', 'Response details', {
    messageId: anthropicResponse.id,
    inputTokens: anthropicResponse.usage?.input_tokens,
    outputTokens: anthropicResponse.usage?.output_tokens,
    contentBlocks: anthropicResponse.content?.length,
  });
  sendJson(res, 200, anthropicResponse);
}

/**
 * Call BigModel API (OpenAI-compatible endpoint)
 * @param {Object} glmRequest - GLM format request (OpenAI-compatible)
 * @returns {Promise<Object>} GLM response
 */
async function callBigModelApi(glmRequest) {
  const startTime = Date.now();

  logger.info('bigmodel', 'Sending request to BigModel', {
    requestPreview: JSON.stringify(glmRequest).substring(0, 1500),
  });

  logger.glmCall(glmRequest.model, glmRequest.messages?.length, !!glmRequest.tools?.length);

  let response;
  try {
    response = await fetch(config.bigModelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.zaiApiKey}`,
      },
      body: JSON.stringify(glmRequest),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (error) {
    // Handle timeout and abort errors
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      logger.error('bigmodel', 'BigModel API timeout', {
        timeout: UPSTREAM_TIMEOUT,
        elapsed: Date.now() - startTime,
      });
      const timeoutError = new GlmApiError(
        `Upstream API did not respond within ${UPSTREAM_TIMEOUT / 1000} seconds`,
        504,
        'timeout'
      );
      timeoutError.type = 'timeout';
      throw timeoutError;
    }
    // Re-throw other errors (network issues, etc.)
    logger.error('bigmodel', 'BigModel API network error', {
      error: error.message,
      elapsed: Date.now() - startTime,
    });
    throw new GlmApiError(`BigModel API network error: ${error.message}`, 502, error.message);
  }

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('bigmodel', 'BigModel API error', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.substring(0, 500),
    });

    // Check if this is a context window limit error
    const fullErrorMessage = `${response.status} ${response.statusText} ${errorText}`;
    if (isContextLimitError(fullErrorMessage)) {
      throw new ContextLimitError(`The model has reached its context window limit. Please compact the conversation to continue.`);
    }

    throw new GlmApiError(
      `BigModel API error: ${response.status} ${response.statusText}`,
      response.status,
      errorText
    );
  }

  const data = await response.json();

  logger.info('bigmodel', 'Raw BigModel response', {
    responsePreview: JSON.stringify(data).substring(0, 1000),
  });

  logger.glmResponse(
    data.model,
    data.choices?.[0]?.finish_reason,
    durationMs,
    data.usage
  );

  return data;
}

/**
 * Handle request via BigModel endpoint
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} anthropicRequest - Original Anthropic request
 * @param {number} startTime - Request start time
 * @param {string} requestId - Unique request ID
 */
async function handleBigModelPath(res, anthropicRequest, startTime, requestId) {
  // Transform request to GLM format (async for MCP tool injection)
  const { request: glmRequest, injections } = await transformRequest(anthropicRequest);

  // Broadcast proxy injection event if any injections were made
  if (injections.length > 0) {
    broadcastTrafficEvent({
      id: `${requestId}-proxy-injection`,
      timestamp: new Date().toISOString(),
      type: 'proxy_injection',
      data: {
        requestId,
        injections,
      },
    });
  }

  // Check if we should use real-time streaming
  const wantsStreaming = isStreamingRequest(anthropicRequest);

  if (wantsStreaming) {
    logger.info('streaming', 'Using real-time BigModel streaming with tool support', {
      model: glmRequest.model,
      hasClientTools: !!(anthropicRequest.tools?.length),
    });
    // Use the same streaming function but with BigModel URL
    const streamResult = await streamFromBigModel(res, glmRequest, anthropicRequest.model);

    // Broadcast response event for stats tracking
    const durationMs = Date.now() - startTime;
    broadcastTrafficEvent({
      id: `${requestId}-response`,
      timestamp: new Date().toISOString(),
      type: 'response',
      data: {
        requestId,
        statusCode: 200,
        durationMs,
        endpoint: 'bigmodel',
        messageCount: anthropicRequest.messages?.length || 0, // For session detection
        body: {
          usage: streamResult?.usage || {},
          content: [
            ...(streamResult?.thinkingContent ? [{ type: 'thinking', thinking: streamResult.thinkingContent }] : []),
            { type: 'text', text: streamResult?.textContent || '' },
          ],
        },
      },
    });
    return;
  }

  // Non-streaming path: execute with tool loop
  const glmResponse = await executeWithTools(glmRequest, callBigModelApi, config);

  // Transform response to Anthropic format
  const anthropicResponse = transformResponse(glmResponse, anthropicRequest.model);

  const durationMs = Date.now() - startTime;

  // Broadcast response event
  broadcastTrafficEvent({
    id: `${requestId}-response`,
    timestamp: new Date().toISOString(),
    type: 'response',
    data: {
      requestId,
      statusCode: 200,
      durationMs,
      endpoint: 'bigmodel',
      messageCount: anthropicRequest.messages?.length || 0, // For session detection
      body: anthropicResponse,
    },
  });

  logger.response(200, anthropicResponse.stop_reason, durationMs);
  logger.debug('response', 'Response details', {
    messageId: anthropicResponse.id,
    inputTokens: anthropicResponse.usage?.input_tokens,
    outputTokens: anthropicResponse.usage?.output_tokens,
    contentBlocks: anthropicResponse.content?.length,
  });
  sendJson(res, 200, anthropicResponse);
}

/**
 * Handle GET /health endpoint
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
function handleHealth(req, res) {
  const validation = validateConfig();
  const uptimeSeconds = serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0;

  const healthResponse = {
    status: validation.isValid ? 'ok' : 'degraded',
    version: config.version,
    uptime: uptimeSeconds,
    config: {
      toolsEnabled: true,
      streamingEnabled: config.streaming.enabled,
      endpointMode: config.endpoint.mode,
      models: [config.models.text, config.models.vision],
    },
    validation: {
      isValid: validation.isValid,
      errors: validation.errors,
    },
  };

  sendJson(res, 200, healthResponse);
}

/**
 * Handle GET /config endpoint (detailed configuration)
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
function handleConfigGet(req, res) {
  sendJson(res, 200, getConfigSummary());
}

/**
 * Handle POST /config endpoint (update runtime configuration)
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
async function handleConfigPost(req, res) {
  try {
    const body = await readBody(req);
    let updates;

    try {
      updates = JSON.parse(body);
    } catch (parseError) {
      throw new InvalidRequestError('Invalid JSON in request body');
    }

    logger.info('config', 'Updating runtime configuration', { updates });
    const newConfig = updateConfig(updates);
    logger.info('config', 'Configuration updated', { config: newConfig });

    sendJson(res, 200, {
      success: true,
      config: newConfig,
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Handle CORS preflight requests
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
function handleOptions(req, res) {
  // SECURITY: Restrict CORS to localhost origins only for this localhost-only tool
  // Frontend is served from same origin, so CORS not strictly needed
  const origin = req.headers.origin;
  const allowedOrigins = [
    'http://127.0.0.1:4567',
    'http://localhost:4567',
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ];

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, Anthropic-Version',
    'Access-Control-Max-Age': '86400',
  };

  // Only set Access-Control-Allow-Origin if request is from an allowed origin
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  res.writeHead(204, headers);
  res.end();
}

/**
 * Main request handler
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 */
async function handleRequest(req, res) {
  const { method, url } = req;

  // Parse URL to extract pathname (ignoring query parameters like ?beta=true)
  const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  logger.debug('request', `${method} ${pathname}`);

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    handleOptions(req, res);
    return;
  }

  // Serve dashboard at root
  if (method === 'GET' && pathname === '/') {
    await serveStaticFile(req, res, path.join(publicDir, 'index.html'));
    return;
  }

  // Serve static files from /dashboard/*
  if (method === 'GET' && pathname.startsWith('/dashboard/')) {
    // SECURITY: Prevent path traversal attacks
    // Extract the requested file path and normalize it
    const requestedPath = pathname.replace('/dashboard/', '');

    // Normalize the path to remove '..' and other traversal attempts
    const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');

    // Resolve to absolute path
    const absolutePath = path.resolve(publicDir, normalizedPath);

    // CRITICAL: Verify the resolved path is within the allowed public directory
    // This prevents access to files outside /public via '../' sequences
    if (!absolutePath.startsWith(path.resolve(publicDir))) {
      const forbiddenError = new InvalidRequestError('Access denied: Path traversal attempt detected');
      forbiddenError.type = 'invalid_request_error';
      forbiddenError.status = 403;
      logger.warn('security', 'Path traversal attempt blocked', {
        requested: pathname,
        normalized: normalizedPath,
        resolved: absolutePath,
      });
      sendError(res, forbiddenError);
      return;
    }

    // Additional security: block access to hidden files (starting with .)
    if (path.basename(absolutePath).startsWith('.')) {
      const forbiddenError = new InvalidRequestError('Access denied: Hidden files not accessible');
      forbiddenError.type = 'invalid_request_error';
      forbiddenError.status = 403;
      sendError(res, forbiddenError);
      return;
    }

    await serveStaticFile(req, res, absolutePath);
    return;
  }

  // Route requests
  if (method === 'GET' && pathname === '/health') {
    handleHealth(req, res);
    return;
  }

  if (method === 'GET' && pathname === '/config') {
    handleConfigGet(req, res);
    return;
  }

  if (method === 'POST' && pathname === '/config') {
    await handleConfigPost(req, res);
    return;
  }

  if (method === 'POST' && pathname === '/v1/messages') {
    await handleMessages(req, res);
    return;
  }

  if (method === 'GET' && pathname === '/v1/traffic') {
    handleTrafficSSE(req, res);
    return;
  }

  // Stub endpoint for token counting (Claude Code uses this)
  if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
    // Return a stub response - we don't actually count tokens
    sendJson(res, 200, {
      input_tokens: 0,
    });
    return;
  }

  // Stub endpoint for event logging (Claude Code telemetry)
  if (method === 'POST' && pathname === '/api/event_logging/batch') {
    // Accept but ignore telemetry events
    sendJson(res, 200, { success: true });
    return;
  }

  // MCP Registry endpoints
  if (pathname === '/v1/mcp' || pathname.startsWith('/v1/mcp/')) {
    await handleMcpEndpoints(req, res, method, pathname);
    return;
  }

  // 404 for unknown routes
  const notFoundError = new InvalidRequestError(`Not found: ${method} ${pathname}`);
  notFoundError.type = 'not_found_error';
  notFoundError.status = 404;
  sendError(res, notFoundError);
}

/**
 * Handle MCP Registry API endpoints
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @param {string} method - HTTP method
 * @param {string} pathname - URL pathname
 */
async function handleMcpEndpoints(req, res, method, pathname) {
  try {
    // GET /v1/mcp - List all MCPs
    if (method === 'GET' && pathname === '/v1/mcp') {
      const mcps = getAllMcps();
      sendJson(res, 200, { mcps });
      return;
    }

    // POST /v1/mcp - Add new MCP
    if (method === 'POST' && pathname === '/v1/mcp') {
      const body = await readBody(req);
      let mcpConfig;
      try {
        mcpConfig = JSON.parse(body);
      } catch (e) {
        throw new InvalidRequestError('Invalid JSON in request body');
      }

      const mcp = addMcp(mcpConfig);
      sendJson(res, 201, { mcp });
      return;
    }

    // Extract MCP ID from path for /v1/mcp/:id routes
    const mcpIdMatch = pathname.match(/^\/v1\/mcp\/([^/]+)(?:\/(.+))?$/);
    if (!mcpIdMatch) {
      throw new InvalidRequestError(`Invalid MCP endpoint: ${pathname}`);
    }

    const mcpId = decodeURIComponent(mcpIdMatch[1]);
    const subPath = mcpIdMatch[2]; // e.g., 'enable', 'disable', 'tools'

    // GET /v1/mcp/:id - Get single MCP
    if (method === 'GET' && !subPath) {
      const mcp = getMcpSafe(mcpId);
      if (!mcp) {
        const error = new InvalidRequestError(`MCP '${mcpId}' not found`);
        error.status = 404;
        throw error;
      }
      sendJson(res, 200, { mcp });
      return;
    }

    // PATCH /v1/mcp/:id - Update MCP
    if (method === 'PATCH' && !subPath) {
      const body = await readBody(req);
      let updates;
      try {
        updates = JSON.parse(body);
      } catch (e) {
        throw new InvalidRequestError('Invalid JSON in request body');
      }

      // If config changed, shutdown existing client
      const existingMcp = getMcp(mcpId);
      if (existingMcp && existingMcp.initialized) {
        await shutdownMcp(mcpId);
      }

      const mcp = updateMcp(mcpId, updates);
      sendJson(res, 200, { mcp });
      return;
    }

    // DELETE /v1/mcp/:id - Remove MCP
    if (method === 'DELETE' && !subPath) {
      // Shutdown client first
      const existingMcp = getMcp(mcpId);
      if (existingMcp && existingMcp.initialized) {
        await shutdownMcp(mcpId);
      }

      removeMcp(mcpId);
      sendJson(res, 200, { success: true });
      return;
    }

    // POST /v1/mcp/:id/enable - Enable MCP
    if (method === 'POST' && subPath === 'enable') {
      const mcp = enableMcp(mcpId);
      sendJson(res, 200, { mcp });
      return;
    }

    // POST /v1/mcp/:id/disable - Disable MCP
    if (method === 'POST' && subPath === 'disable') {
      // Shutdown client first
      await shutdownMcp(mcpId);
      const mcp = disableMcp(mcpId);
      sendJson(res, 200, { mcp });
      return;
    }

    // GET /v1/mcp/:id/tools - Get discovered tools
    if (method === 'GET' && subPath === 'tools') {
      const tools = await getMcpTools(mcpId);
      sendJson(res, 200, { tools });
      return;
    }

    // Unknown sub-path
    throw new InvalidRequestError(`Unknown MCP endpoint: ${method} ${pathname}`);
  } catch (error) {
    logger.error('mcp-api', 'MCP API error', {
      method,
      pathname,
      error: error.message,
    });
    sendError(res, error);
  }
}

/**
 * Graceful shutdown handler
 * @param {string} signal - Signal received
 */
async function shutdown(signal) {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.serverShutdown(signal);

  // Shutdown all MCP clients
  try {
    await shutdownAllMcps();
  } catch (error) {
    logger.error('server', 'Error shutting down MCPs', { error: error.message });
  }

  // Close all SSE traffic clients
  trafficClients.forEach((client) => {
    try {
      client.end();
    } catch (e) {
      // Ignore errors closing clients
    }
  });
  trafficClients.clear();

  if (serverInstance) {
    serverInstance.close(() => {
      logger.info('server', 'Server closed');
      process.exit(0);
    });

    // Force exit after 3 seconds (reduced from 10)
    setTimeout(() => {
      logger.warn('server', 'Forcing shutdown after timeout');
      process.exit(1);
    }, 3000);
  } else {
    process.exit(0);
  }
}

/**
 * Create and configure HTTP server
 * @returns {http.Server} configured HTTP server
 */
export function createServer() {
  return http.createServer(handleRequest);
}

/**
 * Start the HTTP server
 * @returns {Promise<http.Server>} running server instance
 */
export function startServer() {
  // Initialize MCP registry with defaults
  initRegistry();

  return new Promise((resolve, reject) => {
    const server = createServer();
    serverInstance = server;

    server.on('error', (error) => {
      logger.errorWithStack('server', 'Server error', error);
      reject(error);
    });

    server.listen(config.port, config.host, () => {
      serverStartTime = Date.now();
      logger.serverStart(config.host, config.port);
      logger.info('server', 'Endpoints available', {
        dashboard: `http://${config.host}:${config.port}/`,
        messages: `POST http://${config.host}:${config.port}/v1/messages`,
        health: `GET http://${config.host}:${config.port}/health`,
        config: `GET http://${config.host}:${config.port}/config`,
      });

      const validation = validateConfig();
      if (!validation.isValid) {
        logger.warn('config', 'Configuration warnings', { errors: validation.errors });
      }

      resolve(server);
    });
  });
}

// Register shutdown handlers once at module load
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default { createServer, startServer };
