/**
 * Anthropic Response Cleaner
 *
 * Cleans responses from Z.ai's Anthropic-compatible endpoint.
 * This is a lightweight processor that:
 * - Converts GLM-style reasoning_content to Anthropic thinking blocks
 * - Extracts reasoning from <reasoning_content> tags in text
 * - Filters out internal tool_use blocks (web_search, web_reader) when webSearch is enabled
 * - Filters out custom MCP tool_use blocks
 * - Sanitizes non-standard content block types (e.g., Z.ai server-side tool blocks)
 * - Adjusts stop_reason if only internal tools were called
 */

import config from '../config.js';
import { shouldHandleInternally } from '../tools/definitions.js';
import { findMcpForTool } from '../mcp/triggers.js';
import { extractReasoning } from '../reasoning/injector.js';
import logger from '../utils/logger.js';

// Valid Anthropic content block types that Claude Code accepts
const VALID_CONTENT_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'thinking']);

/**
 * Check if a tool should be handled internally (built-in or custom MCP)
 * @param {string} toolName - Tool name
 * @returns {boolean} True if handled internally
 */
function isInternalTool(toolName) {
  // Check built-in tools
  if (shouldHandleInternally(toolName)) {
    return true;
  }
  // Check custom MCP tools
  return findMcpForTool(toolName) !== null;
}

/**
 * Clean an Anthropic response by filtering out internal tool usage
 * and converting GLM-style reasoning to Anthropic thinking blocks.
 *
 * @param {Object} anthropicResponse - Response from Z.ai Anthropic endpoint
 * @returns {Object} Cleaned response with internal tools filtered out
 */
export function cleanAnthropicResponse(anthropicResponse) {
  if (!anthropicResponse || anthropicResponse.type === 'error') {
    return anthropicResponse;
  }

  let content = anthropicResponse.content || [];
  const processedContent = [];

  // Check for GLM-style reasoning_content at message level
  // Z.ai's Anthropic endpoint may return reasoning this way
  if (anthropicResponse.reasoning_content) {
    processedContent.push({
      type: 'thinking',
      thinking: anthropicResponse.reasoning_content,
    });
    logger.debug('anthropic-response', 'Added reasoning_content as thinking block', {
      reasoningLength: anthropicResponse.reasoning_content.length,
    });
  }

  // Separate content blocks by type, filtering out non-standard types
  const internalToolBlocks = [];
  const clientToolBlocks = [];
  const otherBlocks = [];
  const skippedBlocks = [];

  for (const block of content) {
    // Filter out non-standard content block types (e.g., Z.ai server-side tool blocks)
    if (!VALID_CONTENT_TYPES.has(block.type)) {
      logger.warn('anthropic-response', 'Filtering non-standard content block type', {
        type: block.type,
        blockKeys: Object.keys(block),
      });
      skippedBlocks.push(block);

      // Try to convert server_tool_use to text representation
      if (block.type === 'server_tool_use' || block.type === 'server_tool_result') {
        const toolName = block.name || block.tool_name || 'unknown_tool';
        const toolContent = block.content || block.result || block.output || '';
        if (toolContent) {
          otherBlocks.push({
            type: 'text',
            text: `[${toolName} result]: ${typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent)}`,
          });
        }
      }
      continue;
    }

    if (block.type === 'tool_use') {
      // Only treat as internal if webSearch is enabled AND it's our tool,
      // OR if it's a custom MCP tool
      if (isInternalTool(block.name)) {
        internalToolBlocks.push(block);
      } else {
        clientToolBlocks.push(block);
      }
    } else if (block.type === 'text') {
      // Check for <reasoning_content> tags in text blocks
      const extracted = extractReasoning(block.text);

      if (extracted.reasoning && !anthropicResponse.reasoning_content) {
        // Only add if we didn't already get reasoning_content at message level
        processedContent.push({
          type: 'thinking',
          thinking: extracted.reasoning,
        });
        logger.info('anthropic-response', 'Extracted reasoning from text tags', {
          reasoningLength: extracted.reasoning.length,
        });
      }

      // Add cleaned text block
      if (extracted.content) {
        otherBlocks.push({
          type: 'text',
          text: extracted.content,
        });
      }
    } else {
      otherBlocks.push(block);
    }
  }

  logger.debug('anthropic-response', 'Content block analysis', {
    totalBlocks: content.length,
    internalTools: internalToolBlocks.length,
    clientTools: clientToolBlocks.length,
    otherBlocks: otherBlocks.length,
    skippedBlocks: skippedBlocks.length,
    skippedTypes: skippedBlocks.map(b => b.type),
    hasReasoningContent: !!anthropicResponse.reasoning_content,
  });

  // Build cleaned content (thinking first, then other blocks, then client tools)
  const cleanedContent = [...processedContent, ...otherBlocks, ...clientToolBlocks];

  // Determine stop_reason
  let stopReason = anthropicResponse.stop_reason;

  // If original stop_reason was tool_use but we filtered out all tool blocks,
  // change it to end_turn
  if (stopReason === 'tool_use' && clientToolBlocks.length === 0) {
    stopReason = 'end_turn';
    logger.debug('anthropic-response', 'Adjusted stop_reason from tool_use to end_turn (internal tools only)');
  }

  // Build cleaned response
  const cleanedResponse = {
    ...anthropicResponse,
    content: cleanedContent,
    stop_reason: stopReason,
  };

  // Remove reasoning_content from the response (it's now in content blocks)
  delete cleanedResponse.reasoning_content;

  logger.info('anthropic-response', 'Cleaned response', {
    originalBlockCount: content.length,
    cleanedBlockCount: cleanedContent.length,
    hasThinking: processedContent.length > 0,
    stopReason: cleanedResponse.stop_reason,
    contentTypes: cleanedContent.map(b => b.type),
  });

  return cleanedResponse;
}

/**
 * Check if a response has internal tool calls that need execution.
 * Includes built-in tools when webSearch is enabled AND custom MCP tools.
 *
 * @param {Object} anthropicResponse - Response from Z.ai Anthropic endpoint
 * @returns {Array} Array of internal tool_use blocks
 */
export function getInternalToolCalls(anthropicResponse) {
  if (!anthropicResponse || !anthropicResponse.content) {
    return [];
  }

  // Return tools that should be handled internally
  return anthropicResponse.content.filter(
    (block) => block.type === 'tool_use' && isInternalTool(block.name)
  );
}

/**
 * Check if a response has client tool calls.
 * Client tools are those NOT handled internally.
 *
 * @param {Object} anthropicResponse - Response from Z.ai Anthropic endpoint
 * @returns {Array} Array of client tool_use blocks
 */
export function getClientToolCalls(anthropicResponse) {
  if (!anthropicResponse || !anthropicResponse.content) {
    return [];
  }

  // Return tools that should NOT be handled internally
  return anthropicResponse.content.filter(
    (block) => block.type === 'tool_use' && !isInternalTool(block.name)
  );
}

/**
 * Check if response requires internal tool execution.
 *
 * @param {Object} anthropicResponse - Response from Z.ai Anthropic endpoint
 * @returns {boolean} True if response has internal tools to execute
 */
export function hasInternalToolCalls(anthropicResponse) {
  return getInternalToolCalls(anthropicResponse).length > 0;
}

export default {
  cleanAnthropicResponse,
  getInternalToolCalls,
  getClientToolCalls,
  hasInternalToolCalls,
};
