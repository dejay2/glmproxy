/**
 * MCP Client
 *
 * Client for calling MCP (Model Context Protocol) servers via JSON-RPC 2.0.
 * Handles initialization and tool calls for web search.
 */

import logger from '../utils/logger.js';

// Cache for initialized sessions - stores session IDs
const initializedSessions = new Map();

/**
 * Parse SSE response and extract JSON data.
 * MCP returns SSE format: id:1\nevent:message\ndata:{...}
 *
 * @param {string} sseText - Raw SSE response text
 * @returns {Object} Parsed JSON data
 */
function parseSseResponse(sseText) {
  const lines = sseText.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const jsonStr = line.slice(5).trim();
      if (jsonStr) {
        return JSON.parse(jsonStr);
      }
    }
  }
  throw new Error('No data found in SSE response');
}

/**
 * Initialize MCP connection and get session ID.
 *
 * @param {string} url - MCP server endpoint URL
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Session ID or null if failed
 */
async function ensureInitialized(url, config) {
  if (initializedSessions.has(url)) {
    return initializedSessions.get(url);
  }

  logger.debug('mcp', 'Initializing MCP connection', { url });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.zaiApiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'glm-proxy',
            version: '1.0.0',
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('mcp', 'MCP initialization failed', {
        status: response.status,
        body: errorText.substring(0, 500),
      });
      return null;
    }

    // Get session ID from response headers
    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) {
      logger.error('mcp', 'No mcp-session-id in response headers');
      return null;
    }

    const responseText = await response.text();
    const data = parseSseResponse(responseText);

    // Check for error in response
    if (data.error) {
      logger.error('mcp', 'MCP initialization returned error', {
        url,
        error: data.error,
      });
      return null;
    }

    logger.info('mcp', 'MCP initialized', {
      url,
      sessionId,
      serverInfo: data.result?.serverInfo,
    });

    initializedSessions.set(url, sessionId);
    return sessionId;
  } catch (error) {
    logger.error('mcp', 'MCP initialization error', { url, error: error.message });
    return null;
  }
}

/**
 * Call an MCP tool via JSON-RPC 2.0.
 *
 * @param {string} url - MCP server endpoint URL
 * @param {string} toolName - Name of the tool in MCP (e.g., 'webSearchPrime')
 * @param {Object} args - Arguments to pass to the tool
 * @param {Object} config - Configuration object
 * @returns {Promise<string>} Formatted result string
 */
export async function callMcpTool(url, toolName, args, config) {
  const requestId = Date.now();

  // Ensure connection is initialized and get session ID
  const sessionId = await ensureInitialized(url, config);
  if (!sessionId) {
    return 'Error: Failed to initialize MCP connection';
  }

  logger.debug('mcp', 'Calling MCP tool', { url, toolName, args, requestId, sessionId });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.zaiApiKey}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
      signal: AbortSignal.timeout(config.toolExecution.timeout),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('mcp', 'MCP HTTP error', {
        status: response.status,
        statusText: response.statusText,
        body: errorText.substring(0, 500),
      });
      return `Error: MCP request failed with status ${response.status}`;
    }

    const responseText = await response.text();
    const data = parseSseResponse(responseText);

    logger.info('mcp', 'MCP tool response', {
      toolName,
      result: JSON.stringify(data.result).substring(0, 500),
    });

    // Handle JSON-RPC error
    if (data.error) {
      logger.warn('mcp', 'MCP tool error', { toolName, error: data.error });
      return `Error: ${data.error.message || JSON.stringify(data.error)}`;
    }

    // Format the result
    return formatMcpResult(data.result, toolName);
  } catch (error) {
    logger.error('mcp', 'MCP call failed', { toolName, error: error.message });

    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `Error: Tool execution timed out after ${config.toolExecution.timeout}ms`;
    }

    return `Error executing ${toolName}: ${error.message}`;
  }
}

/**
 * Format MCP result for readability.
 *
 * @param {any} result - Raw MCP result
 * @param {string} toolName - Name of the tool
 * @returns {string} Formatted result string
 */
export function formatMcpResult(result, toolName) {
  if (!result) {
    return 'No results found.';
  }

  // Handle MCP content array format
  const content = result.content || result;

  // Handle array of results
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return 'No results found.';
    }

    return content
      .map((item, index) => {
        // Text content block
        if (item.type === 'text' && item.text) {
          return item.text;
        }

        // Search result object
        if (typeof item === 'object') {
          const title = item.title || item.name || 'Untitled';
          const url = item.url || item.link || '';
          const snippet = item.snippet || item.content || item.description || '';

          let formatted = `[${index + 1}] ${title}`;
          if (url) {
            formatted += `\nURL: ${url}`;
          }
          if (snippet) {
            formatted += `\n${snippet}`;
          }
          return formatted;
        }

        return String(item);
      })
      .join('\n\n');
  }

  // Handle object result
  if (typeof content === 'object') {
    if (content.text) {
      return content.text;
    }
    return JSON.stringify(content, null, 2);
  }

  return String(content);
}

/**
 * Clear initialized sessions (useful for testing or reconnection).
 */
export function clearSessions() {
  initializedSessions.clear();
}

export default {
  callMcpTool,
  formatMcpResult,
  clearSessions,
};
