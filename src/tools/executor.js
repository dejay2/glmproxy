/**
 * Tool Executor
 *
 * Handles the internal tool execution loop. When GLM calls web_search,
 * we execute it via the Z.ai MCP server and continue the conversation
 * until GLM produces a final response (or calls only client-defined tools).
 *
 * Key behaviors:
 * - Executes web_search/web_reader internally via MCP (only when webSearch is enabled)
 * - Executes custom MCP tools when triggered
 * - Returns client tools (Glob, Grep, Read, etc.) for client to handle
 * - Limits consecutive internal tool calls to prevent infinite loops
 */

import { callMcpTool } from './mcp-client.js';
import { isOurTool, getCanonicalToolName, shouldHandleInternally } from './definitions.js';
import { isClaudeTool } from './triggers.js';
import { findMcpForTool } from '../mcp/triggers.js';
import { callMcpTool as callCustomMcpTool } from '../mcp/lifecycle.js';
import logger from '../utils/logger.js';
import { ToolExecutionError } from '../utils/errors.js';

/**
 * Execute request with internal tool handling loop.
 *
 * This function:
 * 1. Sends request to GLM with injected tools
 * 2. If GLM returns tool_calls for our tools -> executes them via MCP
 * 3. Appends assistant message and tool results to conversation
 * 4. Continues until GLM returns without tool calls (or only client tools)
 * 5. Limits consecutive internal-only calls to prevent infinite loops
 *
 * @param {Object} glmRequest - The GLM format request
 * @param {Function} callGlmFn - Function to call GLM API
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Final GLM response
 */
export async function executeWithTools(glmRequest, callGlmFn, config) {
  let iteration = 0;
  let consecutiveInternalCalls = 0;
  const maxIterations = config.toolExecution.maxIterations;
  const maxConsecutiveInternal = config.toolExecution.maxConsecutiveInternal || 10;

  // Work with a copy of messages to avoid mutating the original
  let messages = [...glmRequest.messages];

  logger.debug('toolloop', 'Starting tool execution loop', {
    maxIterations,
    maxConsecutiveInternal,
    initialMessageCount: messages.length,
  });

  while (iteration < maxIterations) {
    iteration++;
    logger.toolLoopIteration(iteration, maxIterations, messages.length);

    // Call GLM with current messages
    const response = await callGlmFn({ ...glmRequest, messages });

    // Get the assistant message
    const assistantMessage = response.choices?.[0]?.message;
    if (!assistantMessage) {
      logger.warn('toolloop', 'No assistant message in GLM response');
      return response;
    }

    const toolCalls = assistantMessage.tool_calls || [];

    logger.debug('toolloop', 'GLM response analyzed', {
      iteration,
      hasContent: !!assistantMessage.content,
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map((tc) => tc.function?.name),
    });

    // No tool calls - we're done
    if (toolCalls.length === 0) {
      logger.info('toolloop', 'Completed - no more tool calls', {
        iterations: iteration,
        finalMessageCount: messages.length,
      });
      return response;
    }

    // Separate our tools from client tools
    // Only handle as internal when webSearch is enabled in config OR it's a custom MCP tool
    const ourCalls = toolCalls.filter((tc) => {
      const name = tc.function?.name;
      // Check if it's a built-in web tool
      if (shouldHandleInternally(name, config)) {
        return true;
      }
      // Check if it's a custom MCP tool
      const mcpInfo = findMcpForTool(name);
      return mcpInfo !== null;
    });
    const clientCalls = toolCalls.filter((tc) => {
      const name = tc.function?.name;
      if (shouldHandleInternally(name, config)) {
        return false;
      }
      const mcpInfo = findMcpForTool(name);
      return mcpInfo === null;
    });

    logger.debug('toolloop', 'Tool calls categorized', {
      internalTools: ourCalls.map((tc) => tc.function?.name),
      clientTools: clientCalls.map((tc) => tc.function?.name),
    });

    // Only client tools - return for client to handle
    if (ourCalls.length === 0) {
      consecutiveInternalCalls = 0; // Reset counter
      logger.info('toolloop', 'Completed - returning client tools', {
        iterations: iteration,
        clientTools: clientCalls.map((tc) => tc.function?.name),
      });
      return response;
    }

    // Check for consecutive internal-only calls (prevents infinite loops)
    if (clientCalls.length === 0) {
      consecutiveInternalCalls++;
      if (consecutiveInternalCalls > maxConsecutiveInternal) {
        logger.warn('toolloop', 'Max consecutive internal calls reached, forcing final response', {
          consecutiveInternalCalls,
          maxAllowed: maxConsecutiveInternal,
        });

        // Execute the pending tool calls first so we have all the data
        const settled = await Promise.allSettled(ourCalls.map((tc) => executeMcpToolWithTiming(tc, config)));
        const results = settled.map(r => r.status === 'fulfilled' ? r.value : `Error: ${r.reason?.message || 'Tool execution failed'}`);

        // Add assistant message with tool calls to history
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || null,
          tool_calls: ourCalls,
        });

        // Add tool results to history
        for (let i = 0; i < ourCalls.length; i++) {
          messages.push({
            role: 'tool',
            tool_call_id: ourCalls[i].id,
            content: results[i],
          });
        }

        // Make ONE more call WITHOUT tools to force a final text response
        logger.info('toolloop', 'Forcing final response without tools');
        const finalResponse = await callGlmFn({
          ...glmRequest,
          messages,
          tools: undefined,  // No tools = must give text response
          tool_choice: undefined,
        });

        return finalResponse;
      }
    } else {
      consecutiveInternalCalls = 0; // Reset when there are client tools too
    }

    // Execute our tools with timing
    logger.info('toolloop', 'Executing internal tools', {
      tools: ourCalls.map((tc) => tc.function?.name),
    });

    const settled = await Promise.allSettled(ourCalls.map((tc) => executeMcpToolWithTiming(tc, config)));
    const results = settled.map(r => r.status === 'fulfilled' ? r.value : `Error: ${r.reason?.message || 'Tool execution failed'}`);

    // Build assistant message for conversation history
    // Include content and our tool calls (not client tools for now)
    const assistantHistoryMessage = {
      role: 'assistant',
      content: assistantMessage.content || null,
      tool_calls: ourCalls,
    };

    messages.push(assistantHistoryMessage);

    // Add tool results
    for (let i = 0; i < ourCalls.length; i++) {
      messages.push({
        role: 'tool',
        tool_call_id: ourCalls[i].id,
        content: results[i],
      });
    }

    logger.debug('toolloop', 'Tool results added to conversation', {
      toolResultCount: results.length,
      newMessageCount: messages.length,
    });

    // If there are also client calls, we need to return a partial response
    // so the client can handle their tools
    if (clientCalls.length > 0) {
      logger.info('toolloop', 'Returning partial response with client tools', {
        clientTools: clientCalls.map((tc) => tc.function?.name),
      });

      // Return response with only client tool calls
      return {
        ...response,
        choices: [
          {
            ...response.choices[0],
            message: {
              ...assistantMessage,
              tool_calls: clientCalls,
            },
          },
        ],
      };
    }

    // Continue the loop - GLM needs to process our tool results
  }

  // Max iterations exceeded
  logger.error('toolloop', 'Max iterations exceeded', {
    maxIterations,
    messageCount: messages.length,
  });

  throw new ToolExecutionError(
    `Tool execution loop exceeded ${maxIterations} iterations`,
    maxIterations
  );
}

/**
 * Execute a single tool call via the appropriate MCP server with timing.
 *
 * @param {Object} toolCall - The tool call from GLM response
 * @param {Object} config - Configuration object
 * @returns {Promise<string>} Tool result string
 */
async function executeMcpToolWithTiming(toolCall, config) {
  const { name, arguments: argsString } = toolCall.function;
  const startTime = Date.now();
  let success = false;

  try {
    const result = await executeTool(toolCall, config);
    success = !result.startsWith('Error:');
    return result;
  } finally {
    const durationMs = Date.now() - startTime;
    logger.tool(name, durationMs, success);
  }
}

/**
 * Execute a single tool call via the appropriate API.
 * Handles tool name aliases (e.g., WebSearch -> web_search).
 * Also routes custom MCP tools to their respective MCPs.
 *
 * @param {Object} toolCall - The tool call from GLM response
 * @param {Object} config - Configuration object
 * @returns {Promise<string>} Tool result string
 */
async function executeTool(toolCall, config) {
  const { name: originalName, arguments: argsString } = toolCall.function;

  // Get canonical tool name (handles aliases like WebSearch -> web_search)
  const name = getCanonicalToolName(originalName);

  let args;
  try {
    args = JSON.parse(argsString);
  } catch (parseError) {
    logger.error('tool', 'Failed to parse tool arguments', {
      toolName: originalName,
      canonicalName: name,
      arguments: argsString,
      error: parseError.message,
    });
    return `Error: Invalid JSON in tool arguments: ${parseError.message}`;
  }

  logger.debug('tool', `Executing ${name}`, {
    originalName,
    canonicalName: name,
    args,
  });

  // Check if this is a custom MCP tool first
  const mcpInfo = findMcpForTool(originalName);
  if (mcpInfo) {
    logger.info('tool', 'Routing to custom MCP', {
      mcpId: mcpInfo.mcpId,
      tool: originalName,
    });
    return callCustomMcpTool(mcpInfo.mcpId, originalName, args);
  }

  if (name === 'web_search') {
    // Execute via MCP - MCP expects 'search_query' not 'query'
    const mcpUrl = config.mcp.search.url;
    const mcpToolName = config.mcp.search.toolName;
    // Handle different argument formats from different clients
    const query = args.query || args.search_query || args.q || '';
    return callMcpTool(mcpUrl, mcpToolName, { search_query: query }, config);
  } else if (name === 'web_reader') {
    // Execute via MCP web reader
    const mcpUrl = config.mcp.reader.url;
    const mcpToolName = config.mcp.reader.toolName;
    // Handle different argument formats from different clients
    const url = args.url || args.href || args.link || '';
    return callMcpTool(mcpUrl, mcpToolName, { url }, config);
  } else {
    logger.warn('tool', 'Unknown internal tool called', { originalName, name });
    return `Error: Unknown tool ${originalName}`;
  }
}

export default {
  executeWithTools,
};
