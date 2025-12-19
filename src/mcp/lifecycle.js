/**
 * MCP Lifecycle Manager
 *
 * Handles lazy initialization, shutdown, and health checks for MCPs.
 * MCPs are only spawned when triggered by user messages.
 */

import { getMcp, getEnabledMcps, updateMcpState } from './registry.js';
import { LocalMcpClient } from './local-client.js';
import logger from '../utils/logger.js';

/**
 * Ensure an MCP is initialized and ready
 * @param {string} mcpId - MCP ID
 * @returns {Promise<Object>} MCP with initialized client
 */
export async function ensureInitialized(mcpId) {
  const mcp = getMcp(mcpId);
  if (!mcp) {
    throw new Error(`MCP '${mcpId}' not found`);
  }

  if (!mcp.enabled) {
    throw new Error(`MCP '${mcpId}' is disabled`);
  }

  // Already initialized
  if (mcp.initialized && mcp.client?.isReady()) {
    return mcp;
  }

  logger.info('mcp-lifecycle', 'Initializing MCP', { id: mcpId });

  // Create client if needed
  if (!mcp.client) {
    mcp.client = new LocalMcpClient(mcp);
    updateMcpState(mcpId, { client: mcp.client });
  }

  try {
    // Spawn and initialize
    await mcp.client.spawn();
    await mcp.client.initialize();

    // Discover tools
    const tools = await mcp.client.listTools();

    // Update registry state
    updateMcpState(mcpId, {
      initialized: true,
      tools,
    });

    logger.info('mcp-lifecycle', 'MCP ready', {
      id: mcpId,
      toolCount: tools.length,
    });

    return mcp;
  } catch (error) {
    logger.error('mcp-lifecycle', 'Failed to initialize MCP', {
      id: mcpId,
      error: error.message,
    });

    // Clean up on failure
    if (mcp.client) {
      mcp.client.shutdown();
    }
    updateMcpState(mcpId, {
      initialized: false,
      tools: [],
      client: null,
    });

    throw error;
  }
}

/**
 * Shutdown an MCP
 * @param {string} mcpId - MCP ID
 */
export async function shutdownMcp(mcpId) {
  const mcp = getMcp(mcpId);
  if (!mcp) {
    return;
  }

  if (mcp.client) {
    logger.info('mcp-lifecycle', 'Shutting down MCP', { id: mcpId });
    mcp.client.shutdown();
  }

  updateMcpState(mcpId, {
    initialized: false,
    tools: [],
    client: null,
  });
}

/**
 * Shutdown all MCPs
 */
export async function shutdownAllMcps() {
  const mcps = getEnabledMcps();

  logger.info('mcp-lifecycle', 'Shutting down all MCPs', {
    count: mcps.length,
  });

  for (const mcp of mcps) {
    if (mcp.client) {
      try {
        mcp.client.shutdown();
      } catch (error) {
        logger.error('mcp-lifecycle', 'Error shutting down MCP', {
          id: mcp.id,
          error: error.message,
        });
      }
    }

    updateMcpState(mcp.id, {
      initialized: false,
      tools: [],
      client: null,
    });
  }
}

/**
 * Call a tool on an MCP
 * @param {string} mcpId - MCP ID
 * @param {string} toolName - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<string>} Formatted result
 */
export async function callMcpTool(mcpId, toolName, args) {
  const mcp = await ensureInitialized(mcpId);

  if (!mcp.client) {
    throw new Error(`MCP '${mcpId}' client not available`);
  }

  try {
    const result = await mcp.client.callTool(toolName, args);
    return formatToolResult(result, toolName);
  } catch (error) {
    logger.error('mcp-lifecycle', 'Tool call failed', {
      mcpId,
      toolName,
      error: error.message,
    });
    return `Error: ${error.message}`;
  }
}

/**
 * Format tool result for readability
 * @param {Object} result - Raw tool result
 * @param {string} toolName - Tool name
 * @returns {string} Formatted result
 */
function formatToolResult(result, toolName) {
  if (!result) {
    return 'No result returned.';
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

        // Image content block
        if (item.type === 'image') {
          return `[Image: ${item.mimeType || 'image'}]`;
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
 * Get tools for an initialized MCP
 * @param {string} mcpId - MCP ID
 * @returns {Promise<Array>} Array of tool definitions
 */
export async function getMcpTools(mcpId) {
  const mcp = getMcp(mcpId);
  if (!mcp) {
    throw new Error(`MCP '${mcpId}' not found`);
  }

  // If already initialized, return cached tools
  if (mcp.initialized && mcp.tools.length > 0) {
    return mcp.tools;
  }

  // Initialize to discover tools
  await ensureInitialized(mcpId);
  return mcp.tools;
}

export default {
  ensureInitialized,
  shutdownMcp,
  shutdownAllMcps,
  callMcpTool,
  getMcpTools,
};
