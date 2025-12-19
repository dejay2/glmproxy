/**
 * MCP Trigger Detection
 *
 * Detects when user messages contain trigger keywords for custom MCPs.
 * Each MCP can have its own set of trigger phrases.
 */

import { getEnabledMcps } from './registry.js';
import logger from '../utils/logger.js';

/**
 * Check which MCPs are triggered by the user message
 * @param {Array} messages - Anthropic format messages
 * @returns {Array} Array of triggered MCP IDs
 */
export function getTriggeredMcps(messages) {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Find the last user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) {
    return [];
  }

  // Extract text content from the message
  let textContent = '';
  if (typeof lastUserMessage.content === 'string') {
    textContent = lastUserMessage.content;
  } else if (Array.isArray(lastUserMessage.content)) {
    textContent = lastUserMessage.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ');
  }

  const lowerContent = textContent.toLowerCase();

  // Check each enabled MCP for trigger matches
  const enabledMcps = getEnabledMcps();
  const triggeredMcps = [];

  for (const mcp of enabledMcps) {
    if (!mcp.triggers || mcp.triggers.length === 0) {
      continue;
    }

    // Check if any trigger phrase matches
    const matchedTrigger = mcp.triggers.find((trigger) =>
      lowerContent.includes(trigger.toLowerCase())
    );

    if (matchedTrigger) {
      logger.info('mcp-triggers', 'MCP triggered', {
        mcpId: mcp.id,
        trigger: matchedTrigger,
        messagePreview: textContent.substring(0, 100),
      });
      triggeredMcps.push(mcp.id);
    }
  }

  if (triggeredMcps.length > 0) {
    logger.info('mcp-triggers', 'Triggered MCPs', { mcps: triggeredMcps });
  }

  return triggeredMcps;
}

/**
 * Check if a specific MCP is triggered by the user message
 * @param {string} mcpId - MCP ID
 * @param {Array} messages - Anthropic format messages
 * @returns {boolean} True if MCP is triggered
 */
export function isMcpTriggered(mcpId, messages) {
  const triggeredMcps = getTriggeredMcps(messages);
  return triggeredMcps.includes(mcpId);
}

/**
 * Get all tools from triggered MCPs
 * @param {Array} messages - Anthropic format messages
 * @returns {Object} Object with { mcpIds: string[], tools: Array }
 */
export function getTriggeredMcpTools(messages) {
  const triggeredMcps = getTriggeredMcps(messages);
  const enabledMcps = getEnabledMcps();

  const tools = [];
  const mcpIds = [];

  for (const mcpId of triggeredMcps) {
    const mcp = enabledMcps.find((m) => m.id === mcpId);
    if (mcp && mcp.initialized && mcp.tools) {
      mcpIds.push(mcpId);
      tools.push(...mcp.tools);
    }
  }

  return { mcpIds, tools };
}

/**
 * Check if a tool belongs to a custom MCP
 * @param {string} toolName - Tool name to check
 * @returns {Object|null} MCP info { mcpId, tool } or null
 */
export function findMcpForTool(toolName) {
  const enabledMcps = getEnabledMcps();

  for (const mcp of enabledMcps) {
    if (!mcp.tools) continue;

    const tool = mcp.tools.find((t) => t.name === toolName);
    if (tool) {
      return { mcpId: mcp.id, tool };
    }
  }

  return null;
}

/**
 * Check if a tool is from a custom MCP (not web_search/web_reader)
 * @param {string} toolName - Tool name
 * @returns {boolean} True if tool is from a custom MCP
 */
export function isCustomMcpTool(toolName) {
  return findMcpForTool(toolName) !== null;
}

export default {
  getTriggeredMcps,
  isMcpTriggered,
  getTriggeredMcpTools,
  findMcpForTool,
  isCustomMcpTool,
};
