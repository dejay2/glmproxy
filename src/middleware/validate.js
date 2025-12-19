/**
 * Request Validation Middleware
 *
 * Validates incoming Anthropic Messages API requests before processing.
 * Throws InvalidRequestError for malformed requests.
 */

import { InvalidRequestError } from '../utils/errors.js';

/**
 * Validate an Anthropic Messages API request
 * @param {Object} body - Parsed request body
 * @throws {InvalidRequestError} If validation fails
 * @returns {boolean} true if valid
 */
export function validateRequest(body) {
  // Check that body is an object
  if (!body || typeof body !== 'object') {
    throw new InvalidRequestError('Request body must be a JSON object');
  }

  // Validate messages array
  if (!body.messages) {
    throw new InvalidRequestError('messages is required');
  }

  if (!Array.isArray(body.messages)) {
    throw new InvalidRequestError('messages must be an array');
  }

  if (body.messages.length === 0) {
    throw new InvalidRequestError('messages array cannot be empty');
  }

  // Validate each message
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    validateMessage(msg, i);
  }

  // Validate max_tokens if provided
  if (body.max_tokens !== undefined) {
    if (typeof body.max_tokens !== 'number') {
      throw new InvalidRequestError('max_tokens must be a number');
    }
    if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
      throw new InvalidRequestError('max_tokens must be a positive integer');
    }
  }

  // Validate temperature if provided
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number') {
      throw new InvalidRequestError('temperature must be a number');
    }
    if (body.temperature < 0 || body.temperature > 2) {
      throw new InvalidRequestError('temperature must be between 0 and 2');
    }
  }

  // Validate tools if provided
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      throw new InvalidRequestError('tools must be an array');
    }
    for (let i = 0; i < body.tools.length; i++) {
      validateTool(body.tools[i], i);
    }
  }

  // Validate system prompt if provided
  if (body.system !== undefined && typeof body.system !== 'string') {
    // System can also be an array of content blocks in newer API versions
    if (!Array.isArray(body.system)) {
      throw new InvalidRequestError('system must be a string or array');
    }
  }

  return true;
}

/**
 * Validate a single message object
 * @param {Object} msg - Message object
 * @param {number} index - Index in messages array
 * @throws {InvalidRequestError} If validation fails
 */
function validateMessage(msg, index) {
  if (!msg || typeof msg !== 'object') {
    throw new InvalidRequestError(`messages[${index}] must be an object`);
  }

  // Validate role
  if (!msg.role) {
    throw new InvalidRequestError(`messages[${index}].role is required`);
  }

  const validRoles = ['user', 'assistant'];
  if (!validRoles.includes(msg.role)) {
    throw new InvalidRequestError(
      `messages[${index}].role must be one of: ${validRoles.join(', ')}`
    );
  }

  // Validate content
  if (msg.content === undefined) {
    throw new InvalidRequestError(`messages[${index}].content is required`);
  }

  // Content can be a string or an array of content blocks
  if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
    throw new InvalidRequestError(
      `messages[${index}].content must be a string or array`
    );
  }

  // If content is an array, validate each block
  if (Array.isArray(msg.content)) {
    for (let j = 0; j < msg.content.length; j++) {
      validateContentBlock(msg.content[j], index, j);
    }
  }
}

/**
 * Validate a content block
 * @param {Object} block - Content block
 * @param {number} msgIndex - Message index
 * @param {number} blockIndex - Block index within message
 * @throws {InvalidRequestError} If validation fails
 */
function validateContentBlock(block, msgIndex, blockIndex) {
  if (!block || typeof block !== 'object') {
    throw new InvalidRequestError(
      `messages[${msgIndex}].content[${blockIndex}] must be an object`
    );
  }

  if (!block.type) {
    throw new InvalidRequestError(
      `messages[${msgIndex}].content[${blockIndex}].type is required`
    );
  }

  const validTypes = ['text', 'image', 'video', 'tool_use', 'tool_result', 'thinking'];
  if (!validTypes.includes(block.type)) {
    throw new InvalidRequestError(
      `messages[${msgIndex}].content[${blockIndex}].type must be one of: ${validTypes.join(', ')}`
    );
  }

  // Type-specific validation
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].text must be a string`
        );
      }
      break;

    case 'thinking':
      // Thinking blocks have a 'thinking' field with the reasoning text
      if (typeof block.thinking !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].thinking must be a string`
        );
      }
      break;

    case 'image':
      if (!block.source || typeof block.source !== 'object') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source is required for image blocks`
        );
      }
      if (block.source.type !== 'base64' && block.source.type !== 'url') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source.type must be "base64" or "url"`
        );
      }
      if (block.source.type === 'base64' && typeof block.source.data !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source.data must be a string`
        );
      }
      if (block.source.type === 'url' && typeof block.source.url !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source.url must be a string`
        );
      }
      break;

    case 'video':
      if (!block.source || typeof block.source !== 'object') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source is required for video blocks`
        );
      }
      if (block.source.type !== 'base64' && block.source.type !== 'url') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source.type must be "base64" or "url"`
        );
      }
      if (block.source.type === 'base64' && typeof block.source.data !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source.data must be a string`
        );
      }
      if (block.source.type === 'url' && typeof block.source.url !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].source.url must be a string`
        );
      }
      break;

    case 'tool_use':
      if (typeof block.id !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].id is required for tool_use blocks`
        );
      }
      if (typeof block.name !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].name is required for tool_use blocks`
        );
      }
      break;

    case 'tool_result':
      if (typeof block.tool_use_id !== 'string') {
        throw new InvalidRequestError(
          `messages[${msgIndex}].content[${blockIndex}].tool_use_id is required for tool_result blocks`
        );
      }
      break;
  }
}

/**
 * Validate a tool definition
 * Accepts multiple schema formats from different clients (Anthropic, OpenAI, etc.)
 * @param {Object} tool - Tool definition
 * @param {number} index - Index in tools array
 * @throws {InvalidRequestError} If validation fails
 */
function validateTool(tool, index) {
  if (!tool || typeof tool !== 'object') {
    throw new InvalidRequestError(`tools[${index}] must be an object`);
  }

  if (typeof tool.name !== 'string' || !tool.name) {
    throw new InvalidRequestError(`tools[${index}].name is required and must be a string`);
  }

  // Description is recommended but not required
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw new InvalidRequestError(`tools[${index}].description must be a string`);
  }

  // Accept multiple schema formats:
  // - Anthropic: input_schema
  // - OpenAI: parameters
  // - Some clients may omit schema entirely
  const hasInputSchema = tool.input_schema && typeof tool.input_schema === 'object';
  const hasParameters = tool.parameters && typeof tool.parameters === 'object';

  // At least one schema format should be present, but don't require it
  // Some simple tools may not need parameters
  if (tool.input_schema !== undefined && !hasInputSchema) {
    throw new InvalidRequestError(`tools[${index}].input_schema must be an object if provided`);
  }

  if (tool.parameters !== undefined && !hasParameters) {
    throw new InvalidRequestError(`tools[${index}].parameters must be an object if provided`);
  }
}

export default {
  validateRequest,
};
