/**
 * Anthropic Tool Executor
 *
 * Handles the internal tool execution loop for native Anthropic format.
 * When Z.ai's Anthropic endpoint returns tool_use blocks for web_search/web_reader,
 * we execute them via MCP and continue the conversation until complete.
 * Also handles custom MCP tools.
 */

import { callMcpTool } from './mcp-client.js';
import { isOurTool, getCanonicalToolName } from './definitions.js';
import { getInternalToolCalls, getClientToolCalls, cleanAnthropicResponse } from '../transformers/anthropic-response.js';
import { findMcpForTool } from '../mcp/triggers.js';
import { callMcpTool as callCustomMcpTool } from '../mcp/lifecycle.js';
import logger from '../utils/logger.js';
import { ToolExecutionError } from '../utils/errors.js';

/**
 * Execute request with internal tool handling loop for Anthropic format.
 *
 * This function:
 * 1. Calls Z.ai Anthropic endpoint
 * 2. If response contains internal tool_use blocks -> executes them via MCP
 * 3. Adds assistant message and tool_result blocks to conversation
 * 4. Continues until no internal tools or only client tools remain
 *
 * @param {Object} anthropicRequest - The prepared Anthropic format request
 * @param {Function} callApiFn - Function to call Z.ai Anthropic API
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Final Anthropic response (cleaned)
 */
export async function executeWithToolsAnthropic(anthropicRequest, callApiFn, config) {
  let iteration = 0;
  let consecutiveInternalCalls = 0;
  const maxIterations = config.toolExecution?.maxIterations || 15;
  const maxConsecutiveInternal = config.toolExecution?.maxConsecutiveInternal || 10;

  // Work with a copy of messages
  let messages = [...(anthropicRequest.messages || [])];

  logger.debug('anthropic-executor', 'Starting Anthropic tool execution loop', {
    maxIterations,
    maxConsecutiveInternal,
    initialMessageCount: messages.length,
  });

  while (iteration < maxIterations) {
    iteration++;
    logger.toolLoopIteration(iteration, maxIterations, messages.length);

    // Call Z.ai Anthropic API with current messages
    const response = await callApiFn({ ...anthropicRequest, messages });

    // Check for errors
    if (response.type === 'error') {
      logger.error('anthropic-executor', 'API returned error', { error: response.error });
      return response;
    }

    // Get internal and client tool calls
    const internalTools = getInternalToolCalls(response);
    const clientTools = getClientToolCalls(response);

    logger.debug('anthropic-executor', 'Response analyzed', {
      iteration,
      stopReason: response.stop_reason,
      internalTools: internalTools.length,
      clientTools: clientTools.length,
    });

    // No internal tool calls - we're done
    if (internalTools.length === 0) {
      logger.info('anthropic-executor', 'Completed - no internal tool calls', {
        iterations: iteration,
        finalMessageCount: messages.length,
        hasClientTools: clientTools.length > 0,
      });
      return cleanAnthropicResponse(response);
    }

    // Check for consecutive internal-only calls
    if (clientTools.length === 0) {
      consecutiveInternalCalls++;
      if (consecutiveInternalCalls > maxConsecutiveInternal) {
        logger.warn('anthropic-executor', 'Max consecutive internal calls reached', {
          consecutiveInternalCalls,
          maxAllowed: maxConsecutiveInternal,
        });

        // Execute pending tools and make final call without tools
        const toolResults = await executeInternalToolsAnthropic(internalTools, config);

        // Add assistant message to history
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        // Add tool results
        messages.push({
          role: 'user',
          content: toolResults,
        });

        // Make final call without tools
        logger.info('anthropic-executor', 'Forcing final response without tools');
        const finalResponse = await callApiFn({
          ...anthropicRequest,
          messages,
          tools: undefined,
        });

        return cleanAnthropicResponse(finalResponse);
      }
    } else {
      consecutiveInternalCalls = 0;
    }

    // Execute internal tools
    logger.info('anthropic-executor', 'Executing internal tools', {
      tools: internalTools.map((t) => t.name),
    });

    const toolResults = await executeInternalToolsAnthropic(internalTools, config);

    // Add assistant message to history (full response including tool_use blocks)
    messages.push({
      role: 'assistant',
      content: response.content,
    });

    // Add tool results as user message with tool_result blocks
    messages.push({
      role: 'user',
      content: toolResults,
    });

    logger.debug('anthropic-executor', 'Tool results added to conversation', {
      toolResultCount: toolResults.length,
      newMessageCount: messages.length,
    });

    // If there are also client tools, return partial response for client to handle
    if (clientTools.length > 0) {
      logger.info('anthropic-executor', 'Returning partial response with client tools', {
        clientTools: clientTools.map((t) => t.name),
      });

      // Return cleaned response (internal tools filtered, client tools remain)
      return cleanAnthropicResponse(response);
    }

    // Continue loop - need to process tool results
  }

  // Max iterations exceeded
  logger.error('anthropic-executor', 'Max iterations exceeded', {
    maxIterations,
    messageCount: messages.length,
  });

  throw new ToolExecutionError(
    `Tool execution loop exceeded ${maxIterations} iterations`,
    maxIterations
  );
}

/**
 * Execute internal tools and return tool_result blocks.
 *
 * @param {Array} toolUseBlocks - Array of tool_use content blocks
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} Array of tool_result content blocks
 */
async function executeInternalToolsAnthropic(toolUseBlocks, config) {
  const results = [];

  for (const toolUse of toolUseBlocks) {
    const { id, name, input } = toolUse;
    const startTime = Date.now();
    let resultContent;
    let isError = false;

    try {
      resultContent = await executeToolAnthropic(name, input, config);
      isError = resultContent.startsWith('Error:');
    } catch (error) {
      resultContent = `Error executing ${name}: ${error.message}`;
      isError = true;
    }

    const durationMs = Date.now() - startTime;
    logger.tool(name, durationMs, !isError);

    results.push({
      type: 'tool_result',
      tool_use_id: id,
      content: resultContent,
      is_error: isError,
    });
  }

  return results;
}

/**
 * Execute a single tool via MCP.
 * Also routes custom MCP tools to their respective MCPs.
 *
 * @param {string} name - Tool name
 * @param {Object} input - Tool input
 * @param {Object} config - Configuration object
 * @returns {Promise<string>} Tool result string
 */
async function executeToolAnthropic(name, input, config) {
  const canonicalName = getCanonicalToolName(name);

  logger.debug('anthropic-executor', `Executing ${canonicalName}`, {
    originalName: name,
    input,
  });

  // Check if this is a custom MCP tool first
  const mcpInfo = findMcpForTool(name);
  if (mcpInfo) {
    logger.info('anthropic-executor', 'Routing to custom MCP', {
      mcpId: mcpInfo.mcpId,
      tool: name,
    });
    return callCustomMcpTool(mcpInfo.mcpId, name, input);
  }

  if (canonicalName === 'web_search') {
    const mcpUrl = config.mcp.search.url;
    const mcpToolName = config.mcp.search.toolName;
    const query = input.query || input.search_query || input.q || '';
    return callMcpTool(mcpUrl, mcpToolName, { search_query: query }, config);
  } else if (canonicalName === 'web_reader') {
    const mcpUrl = config.mcp.reader.url;
    const mcpToolName = config.mcp.reader.toolName;
    const url = input.url || input.href || input.link || '';
    return callMcpTool(mcpUrl, mcpToolName, { url }, config);
  } else {
    logger.warn('anthropic-executor', 'Unknown internal tool', { name, canonicalName });
    return `Error: Unknown tool ${name}`;
  }
}

export default {
  executeWithToolsAnthropic,
};
