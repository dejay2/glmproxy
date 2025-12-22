/**
 * Response Transformer: OpenAI Chat Completions (GLM) -> Anthropic Messages API
 */

import { createContentArray } from './messages.js';
import { extractReasoning } from '../reasoning/injector.js';
import { isOurTool } from '../tools/definitions.js';
import logger from '../utils/logger.js';

/**
 * Generate a unique message ID
 * @returns {string} message ID in Anthropic format
 */
function generateMessageId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `msg_${timestamp}_${random}`;
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 * @param {string} finishReason - OpenAI finish reason
 * @param {boolean} hasToolCalls - Whether response contains tool calls
 * @returns {string} Anthropic stop reason
 */
function mapStopReason(finishReason, hasToolCalls = false) {
  // If there are tool calls, always return tool_use
  if (hasToolCalls) {
    return 'tool_use';
  }

  const mapping = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'end_turn',
    function_call: 'tool_use',
  };

  return mapping[finishReason] || 'end_turn';
}

/**
 * Transform OpenAI/GLM response to Anthropic Messages API format
 * @param {Object} glmResponse - OpenAI/GLM format response
 * @param {string} requestedModel - Original model from request (for reference)
 * @returns {Object} Anthropic format response
 */
export function transformResponse(glmResponse, requestedModel) {
  logger.debug('Transforming response from GLM to Anthropic format');

  // Handle missing or empty response
  if (!glmResponse || !glmResponse.choices || glmResponse.choices.length === 0) {
    logger.warn('Empty or invalid GLM response');
    return createErrorResponse('Empty response from upstream API');
  }

  const choice = glmResponse.choices[0];
  const message = choice.message;

  // Build content array
  const content = [];

  // Check for native reasoning_content field (GLM-4.7 thinking mode)
  if (message.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: message.reasoning_content,
    });
    logger.debug('Added native reasoning_content to response', {
      reasoningLength: message.reasoning_content.length,
    });
  }

  // Handle text content - also extract reasoning from tags if present
  let textContent = message.content || '';
  const extracted = extractReasoning(textContent);

  // Add extracted reasoning if we don't already have native reasoning_content
  if (extracted.reasoning && !message.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: extracted.reasoning,
    });
    logger.debug('Added extracted reasoning from content tags', {
      reasoningLength: extracted.reasoning.length,
    });
  }

  // Use cleaned content (with reasoning tags removed)
  textContent = extracted.content;

  // Add text content if any remains after extraction
  if (textContent) {
    content.push({
      type: 'text',
      text: textContent,
    });
  }

  // Handle tool calls - convert OpenAI tool_calls to Anthropic tool_use blocks
  // Only include client tools (our internal tools are handled by the executor)
  const toolCalls = message.tool_calls || [];
  const clientToolCalls = toolCalls.filter((tc) => !isOurTool(tc.function?.name));

  for (const toolCall of clientToolCalls) {
    let input = {};
    try {
      input = JSON.parse(toolCall.function.arguments);
    } catch (parseError) {
      logger.warn('Failed to parse tool call arguments', {
        toolName: toolCall.function.name,
        arguments: toolCall.function.arguments,
        error: parseError.message,
      });
    }

    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input,
    });

    logger.debug('Added tool_use block', {
      id: toolCall.id,
      name: toolCall.function.name,
    });
  }

  // Determine stop reason
  const hasClientToolCalls = clientToolCalls.length > 0;
  const stopReason = mapStopReason(choice.finish_reason, hasClientToolCalls);

  // Build Anthropic response
  const anthropicResponse = {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: glmResponse.model || 'glm-4.7-enhanced',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: glmResponse.usage?.prompt_tokens || 0,
      output_tokens: glmResponse.usage?.completion_tokens || 0,
    },
  };

  // Count blocks for logging
  const thinkingBlocks = content.filter((block) => block.type === 'thinking').length;
  const toolUseBlocks = content.filter((block) => block.type === 'tool_use').length;

  logger.debug('Transformed response', {
    messageId: anthropicResponse.id,
    stopReason: anthropicResponse.stop_reason,
    contentBlocks: content.length,
    hasThinking: thinkingBlocks > 0,
    thinkingBlocks,
    toolUseBlocks,
  });

  return anthropicResponse;
}

/**
 * Create an Anthropic error response
 * @param {string} message - Error message
 * @param {string} type - Error type
 * @returns {Object} Anthropic error response
 */
export function createErrorResponse(message, type = 'api_error') {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  };
}

export default transformResponse;
