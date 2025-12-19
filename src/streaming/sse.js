/**
 * Streaming Response Handler
 *
 * Provides SSE (Server-Sent Events) streaming for Anthropic Messages API responses.
 * Simulates streaming by chunking a complete response.
 */

import logger from '../utils/logger.js';

/**
 * Send SSE event with explicit flush
 * @param {http.ServerResponse} res - HTTP response object
 * @param {string} event - Event name
 * @param {Object} data - Event data
 * @returns {Promise<void>}
 */
function sendEvent(res, event, data) {
  return new Promise((resolve) => {
    const eventStr = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    // Write and wait for drain if buffer is full
    const canContinue = res.write(eventStr);

    if (!canContinue) {
      // Wait for drain event before continuing
      res.once('drain', resolve);
    } else {
      // Use setImmediate to ensure the event loop has a chance to flush
      setImmediate(resolve);
    }
  });
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
 * Stream an Anthropic response using SSE format
 *
 * Breaks down a complete response into streaming events matching
 * Anthropic's streaming format.
 *
 * @param {http.ServerResponse} res - HTTP response object
 * @param {Object} anthropicResponse - Complete Anthropic response
 * @param {Object} options - Streaming options
 * @param {number} options.chunkSize - Characters per text chunk (default: 20)
 * @param {number} options.chunkDelay - Delay between chunks in ms (default: 0)
 */
export async function streamResponse(res, anthropicResponse, options = {}) {
  const { chunkSize = 20, chunkDelay = 0 } = options;

  logger.debug('streaming', 'Starting SSE stream', {
    contentBlocks: anthropicResponse.content?.length,
    chunkSize,
    chunkDelay,
  });

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // SECURITY: No CORS headers needed - frontend served from same origin
    // For external access, restrict to localhost origins only
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Disable Nagle's algorithm for immediate sending
  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  // Flush headers immediately
  res.flushHeaders();

  // Send message_start event
  const messageStart = {
    type: 'message_start',
    message: {
      id: anthropicResponse.id || generateMessageId(),
      type: 'message',
      role: 'assistant',
      content: [],
      model: anthropicResponse.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: anthropicResponse.usage?.input_tokens || 0,
        output_tokens: 0,
      },
    },
  };
  await sendEvent(res, 'message_start', messageStart);

  // Stream each content block
  let blockIndex = 0;
  for (const block of anthropicResponse.content || []) {
    await streamContentBlock(res, block, blockIndex, { chunkSize, chunkDelay });
    blockIndex++;
  }

  // Send message_delta with final stop_reason and usage
  const messageDelta = {
    type: 'message_delta',
    delta: {
      stop_reason: anthropicResponse.stop_reason || 'end_turn',
      stop_sequence: null,
    },
    usage: {
      output_tokens: anthropicResponse.usage?.output_tokens || 0,
    },
  };
  await sendEvent(res, 'message_delta', messageDelta);

  // Send message_stop
  await sendEvent(res, 'message_stop', { type: 'message_stop' });

  logger.debug('streaming', 'SSE stream completed', {
    blocksStreamed: blockIndex,
  });

  res.end();
}

/**
 * Stream a single content block
 * @param {http.ServerResponse} res - HTTP response object
 * @param {Object} block - Content block
 * @param {number} index - Block index
 * @param {Object} options - Streaming options
 */
async function streamContentBlock(res, block, index, options) {
  const { chunkSize, chunkDelay } = options;

  // Send content_block_start
  let startBlock;
  switch (block.type) {
    case 'text':
      startBlock = { type: 'text', text: '' };
      break;
    case 'thinking':
      startBlock = { type: 'thinking', thinking: '' };
      break;
    case 'tool_use':
      startBlock = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: {},
      };
      break;
    default:
      startBlock = block;
  }

  await sendEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: startBlock,
  });

  // Stream content based on block type
  if (block.type === 'text' && block.text) {
    await streamText(res, block.text, index, 'text_delta', 'text', { chunkSize, chunkDelay });
  } else if (block.type === 'thinking' && block.thinking) {
    await streamText(res, block.thinking, index, 'thinking_delta', 'thinking', {
      chunkSize,
      chunkDelay,
    });
  } else if (block.type === 'tool_use') {
    // Stream tool input as JSON
    const inputJson = JSON.stringify(block.input);
    await streamText(res, inputJson, index, 'input_json_delta', 'partial_json', {
      chunkSize,
      chunkDelay,
    });
  }

  // Send content_block_stop
  await sendEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index,
  });
}

/**
 * Stream text content in chunks
 * @param {http.ServerResponse} res - HTTP response object
 * @param {string} text - Text to stream
 * @param {number} index - Block index
 * @param {string} deltaType - Delta event type
 * @param {string} deltaField - Field name in delta object
 * @param {Object} options - Streaming options
 */
async function streamText(res, text, index, deltaType, deltaField, options) {
  const { chunkSize, chunkDelay } = options;

  let position = 0;
  while (position < text.length) {
    const chunk = text.substring(position, position + chunkSize);
    position += chunkSize;

    const delta = {
      type: deltaType,
      [deltaField]: chunk,
    };

    await sendEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta,
    });

    if (chunkDelay > 0) {
      await sleep(chunkDelay);
    }
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a request wants streaming
 * @param {Object} request - Anthropic request object
 * @returns {boolean} true if streaming is requested
 */
export function isStreamingRequest(request) {
  return request.stream === true;
}

/**
 * Check if a response can be streamed
 * (Only non-tool responses can be streamed)
 * @param {Object} response - Anthropic response object
 * @returns {boolean} true if response can be streamed
 */
export function canStreamResponse(response) {
  // Don't stream tool_use responses - client needs to handle tools
  return response.stop_reason !== 'tool_use';
}

export default {
  streamResponse,
  isStreamingRequest,
  canStreamResponse,
};
