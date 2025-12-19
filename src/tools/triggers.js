/**
 * Web Search Trigger Detection
 *
 * Determines when to inject web search tools based on user message content.
 * This prevents spurious web searches by only enabling tools when the user
 * explicitly asks for web information.
 */

import logger from '../utils/logger.js';

/**
 * Trigger phrases that indicate the user wants web search.
 * Case-insensitive matching.
 */
const WEB_SEARCH_TRIGGERS = [
  // Explicit search requests
  'search the web',
  'search online',
  'look up online',
  'find online',
  'search for',
  'look this up',
  'websearch',
  'web search',

  // News/current info requests
  'current news',
  'latest news',
  'recent news',
  'what is the latest',
  'what are the latest',
  'what\'s the latest',

  // Documentation/reference requests
  'latest docs',
  'latest documentation',
  'current documentation',
  'official docs',
  'official documentation',
];

/**
 * Claude Code tool names that we always intercept.
 * These are the native tool names Claude Code uses for web operations.
 */
export const CLAUDE_TOOL_NAMES = [
  'WebSearch',
  'WebFetch',
  'websearch',
  'webfetch',
  'Websearch',
  'Webfetch',
];

/**
 * Check if the last user message contains a web search trigger phrase.
 *
 * @param {Array} messages - Anthropic format messages
 * @returns {boolean} True if user message contains a trigger phrase
 */
export function hasWebSearchTrigger(messages) {
  if (!messages || messages.length === 0) {
    logger.debug('websearch-trigger', 'No messages to check for triggers');
    return false;
  }

  // Find the last user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) {
    logger.debug('websearch-trigger', 'No user message found');
    return false;
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

  // Check for trigger phrases (case-insensitive)
  const lowerContent = textContent.toLowerCase();
  const matchedTrigger = WEB_SEARCH_TRIGGERS.find((trigger) => lowerContent.includes(trigger));

  if (matchedTrigger) {
    logger.info('websearch-trigger', 'Web search trigger detected', {
      trigger: matchedTrigger,
      messagePreview: textContent.substring(0, 100) + (textContent.length > 100 ? '...' : ''),
    });
    return true;
  }

  logger.debug('websearch-trigger', 'No web search trigger found', {
    messagePreview: textContent.substring(0, 50) + (textContent.length > 50 ? '...' : ''),
  });
  return false;
}

/**
 * Check if a tool name is a Claude Code web tool that should always be intercepted.
 *
 * @param {string} toolName - Tool name to check
 * @returns {boolean} True if this is a Claude Code web tool
 */
export function isClaudeTool(toolName) {
  const isMatch = CLAUDE_TOOL_NAMES.includes(toolName);
  if (isMatch) {
    logger.info('websearch-intercept', 'Claude Code web tool detected for interception', {
      toolName,
    });
  }
  return isMatch;
}

export default {
  hasWebSearchTrigger,
  isClaudeTool,
  CLAUDE_TOOL_NAMES,
  WEB_SEARCH_TRIGGERS,
};
