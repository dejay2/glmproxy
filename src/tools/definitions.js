/**
 * Tool Definitions
 *
 * Defines the tools we inject into GLM requests for web search and reading.
 * Tools are executed via Z.ai's MCP servers.
 * Also handles custom MCP tool integration.
 */

import config from '../config.js';
import { isClaudeTool } from './triggers.js';
import { getTriggeredMcps, findMcpForTool } from '../mcp/triggers.js';
import { getEnabledMcps, getMcp } from '../mcp/registry.js';
import { ensureInitialized } from '../mcp/lifecycle.js';
import logger from '../utils/logger.js';

/**
 * Web search tool definition in OpenAI function format.
 * Description explicitly clarifies this is for INTERNET searches, not local files.
 */
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the INTERNET for current information, news, documentation, or real-time data. ' +
      'Use ONLY when you need up-to-date information from the web that is not available locally. ' +
      'DO NOT use this for searching local files or code - use Glob, Grep, or Read tools for local file operations.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query - be specific and descriptive for best results',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * Web reader tool definition in OpenAI function format.
 * Description explicitly clarifies this is for INTERNET URLs, not local files.
 */
export const WEB_READER_TOOL = {
  type: 'function',
  function: {
    name: 'web_reader',
    description:
      'Fetch and read the content of a specific webpage URL from the INTERNET. ' +
      'Use ONLY when you need to read full content of a webpage, article, or online documentation. ' +
      'DO NOT use this for reading local files - use the Read tool for local file operations.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to read (must be http:// or https://)',
        },
      },
      required: ['url'],
    },
  },
};

/**
 * Web search tool definition in Anthropic format.
 */
export const WEB_SEARCH_TOOL_ANTHROPIC = {
  name: 'web_search',
  description:
    'Search the INTERNET for current information, news, documentation, or real-time data. ' +
    'Use ONLY when you need up-to-date information from the web that is not available locally. ' +
    'DO NOT use this for searching local files or code - use Glob, Grep, or Read tools for local file operations.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query - be specific and descriptive for best results',
      },
    },
    required: ['query'],
  },
};

/**
 * Web reader tool definition in Anthropic format.
 */
export const WEB_READER_TOOL_ANTHROPIC = {
  name: 'web_reader',
  description:
    'Fetch and read the content of a specific webpage URL from the INTERNET. ' +
    'Use ONLY when you need to read full content of a webpage, article, or online documentation. ' +
    'DO NOT use this for reading local files - use the Read tool for local file operations.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL of the webpage to read (must be http:// or https://)',
      },
    },
    required: ['url'],
  },
};

/**
 * Get injected tools in OpenAI format.
 * Always returns web_search and web_reader tools.
 * Caller should check config/triggers before calling.
 */
export function getInjectedTools() {
  return [WEB_SEARCH_TOOL, WEB_READER_TOOL];
}

/**
 * Get injected tools in Anthropic format.
 * Always returns web_search and web_reader tools.
 * Caller should check config/triggers before calling.
 */
export function getInjectedToolsAnthropic() {
  return [WEB_SEARCH_TOOL_ANTHROPIC, WEB_READER_TOOL_ANTHROPIC];
}

/**
 * Names of tools that the proxy handles internally via API calls.
 * Includes aliases for equivalent tools from different clients (Claude Code, etc.)
 */
export const OUR_TOOL_NAMES = ['web_search', 'web_reader'];

/**
 * Tool name aliases - maps client tool names to our internal tool names.
 * This allows seamless interception of equivalent tools from different clients.
 *
 * Claude Code uses: WebSearch, WebFetch
 * Our tools: web_search, web_reader
 */
export const TOOL_ALIASES = {
  // Claude Code's tools
  'WebSearch': 'web_search',
  'websearch': 'web_search',
  'Websearch': 'web_search',
  'WebFetch': 'web_reader',
  'webfetch': 'web_reader',
  'Webfetch': 'web_reader',
  // Cline/other clients might use different names
  'search_web': 'web_search',
  'fetch_url': 'web_reader',
  'read_url': 'web_reader',
  'browse': 'web_reader',
};

/**
 * Check if a tool is one we handle internally (including aliases).
 * @param {string} name - Tool name to check
 * @returns {boolean} True if this is an internally-handled tool
 */
export function isOurTool(name) {
  // Check direct match or alias
  return OUR_TOOL_NAMES.includes(name) || TOOL_ALIASES.hasOwnProperty(name);
}

/**
 * Check if a tool should be handled internally based on name AND config.
 *
 * Two cases for internal handling:
 * 1. Claude Code's tools (WebSearch, WebFetch) - ALWAYS intercept when config enabled
 * 2. Our injected tools (web_search, web_reader) - only when config enabled
 *
 * This is the single source of truth for tool interception logic.
 *
 * @param {string} toolName - Tool name to check
 * @param {Object} [configOverride] - Optional config override (uses global config if not provided)
 * @returns {boolean} True if tool should be handled internally
 */
export function shouldHandleInternally(toolName, configOverride = null) {
  const cfg = configOverride || config;
  const webSearchEnabled = cfg.webSearch?.enabled || false;

  // Check if this is a custom MCP tool (always handle internally if MCP is initialized)
  const mcpInfo = findMcpForTool(toolName);
  if (mcpInfo) {
    return true;
  }

  if (!webSearchEnabled) {
    return false;
  }

  // Always intercept Claude Code's tools when config is enabled
  if (isClaudeTool(toolName)) {
    return true;
  }

  // Handle our injected tools when enabled
  return isOurTool(toolName);
}

/**
 * Get the canonical internal tool name for a given tool name.
 * Handles aliases from different clients.
 * @param {string} name - Tool name (possibly an alias)
 * @returns {string} Canonical internal tool name
 */
export function getCanonicalToolName(name) {
  if (OUR_TOOL_NAMES.includes(name)) {
    return name;
  }
  return TOOL_ALIASES[name] || name;
}

export default {
  WEB_SEARCH_TOOL,
  WEB_READER_TOOL,
  WEB_SEARCH_TOOL_ANTHROPIC,
  WEB_READER_TOOL_ANTHROPIC,
  getInjectedTools,
  getInjectedToolsAnthropic,
  OUR_TOOL_NAMES,
  isOurTool,
  shouldHandleInternally,
  isCustomMcpTool: findMcpForTool,
  getTriggeredMcpToolsForInjection,
  getTriggeredMcpToolsForInjectionAnthropic,
};

/**
 * Get triggered MCP tools in OpenAI format for injection into request
 * @param {Array} messages - Anthropic format messages
 * @returns {Promise<Object>} Object with { tools: Array, mcpIds: string[] }
 */
export async function getTriggeredMcpToolsForInjection(messages) {
  const triggeredMcpIds = getTriggeredMcps(messages);

  if (triggeredMcpIds.length === 0) {
    return { tools: [], mcpIds: [] };
  }

  const tools = [];
  const mcpIds = [];

  for (const mcpId of triggeredMcpIds) {
    try {
      // Ensure MCP is initialized and get tools
      const mcp = await ensureInitialized(mcpId);

      if (mcp && mcp.tools) {
        mcpIds.push(mcpId);

        // Convert MCP tools to OpenAI format
        for (const tool of mcp.tools) {
          tools.push({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description || '',
              parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
          });
        }

        logger.info('tool-definitions', 'Injecting MCP tools', {
          mcpId,
          toolCount: mcp.tools.length,
          tools: mcp.tools.map((t) => t.name),
        });
      }
    } catch (error) {
      logger.error('tool-definitions', 'Failed to get MCP tools', {
        mcpId,
        error: error.message,
      });
    }
  }

  return { tools, mcpIds };
}

/**
 * Get triggered MCP tools in Anthropic format for injection into request
 * @param {Array} messages - Anthropic format messages
 * @returns {Promise<Object>} Object with { tools: Array, mcpIds: string[] }
 */
export async function getTriggeredMcpToolsForInjectionAnthropic(messages) {
  const triggeredMcpIds = getTriggeredMcps(messages);

  if (triggeredMcpIds.length === 0) {
    return { tools: [], mcpIds: [] };
  }

  const tools = [];
  const mcpIds = [];

  for (const mcpId of triggeredMcpIds) {
    try {
      // Ensure MCP is initialized and get tools
      const mcp = await ensureInitialized(mcpId);

      if (mcp && mcp.tools) {
        mcpIds.push(mcpId);

        // Convert MCP tools to Anthropic format
        for (const tool of mcp.tools) {
          tools.push({
            name: tool.name,
            description: tool.description || '',
            input_schema: tool.inputSchema || { type: 'object', properties: {} },
          });
        }

        logger.info('tool-definitions', 'Injecting MCP tools (Anthropic)', {
          mcpId,
          toolCount: mcp.tools.length,
          tools: mcp.tools.map((t) => t.name),
        });
      }
    } catch (error) {
      logger.error('tool-definitions', 'Failed to get MCP tools', {
        mcpId,
        error: error.message,
      });
    }
  }

  return { tools, mcpIds };
}
