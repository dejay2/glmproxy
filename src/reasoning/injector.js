/**
 * Reasoning Prompt Injector
 * Injects explicit reasoning instructions to force GLM-4.6 to think step-by-step
 */

import logger from '../utils/logger.js';

/**
 * The reasoning prompt to inject before the last user message
 * Short and punchy to cut through large system prompts
 */
export const REASONING_PROMPT = `ultrathink really hard

Think step-by-step in <reasoning_content> tags before answering.`;

/**
 * Inject reasoning prompt into messages array
 * Inserts BEFORE the last user message to prime the model for reasoning
 *
 * @param {Array} messages - OpenAI format messages array
 * @returns {Array} Messages with reasoning prompt injected
 */
export function injectReasoningPrompt(messages) {
  const reasoningMessage = {
    role: 'user',
    content: REASONING_PROMPT,
  };

  const result = [...messages];

  // Find last user message index
  let lastUserIdx = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  // Assistant acknowledgment to maintain alternating user/assistant pattern
  const assistantAck = {
    role: 'assistant',
    content: 'I understand. I will think step by step and show my reasoning in <reasoning_content> tags before providing my final answer.',
  };

  if (lastUserIdx >= 0) {
    // Insert reasoning prompt + assistant ack before last user message
    result.splice(lastUserIdx, 0, reasoningMessage, assistantAck);
    logger.debug('Injected reasoning prompt before last user message', {
      insertIndex: lastUserIdx,
      totalMessages: result.length,
    });
  } else {
    // No user message found, append at end
    result.push(reasoningMessage, assistantAck);
    logger.debug('No user message found, appended reasoning prompt at end');
  }

  return result;
}

/**
 * Extract reasoning content from response text
 * Handles <reasoning_content>...</reasoning_content> tags in message content
 *
 * @param {string} content - The message content to extract reasoning from
 * @returns {Object} Object with reasoning (string|null) and content (cleaned string)
 */
export function extractReasoning(content) {
  if (!content || typeof content !== 'string') {
    return { reasoning: null, content: content || '' };
  }

  const match = content.match(/<reasoning_content>([\s\S]*?)<\/reasoning_content>/);

  if (match) {
    const reasoning = match[1].trim();
    const cleanedContent = content
      .replace(/<reasoning_content>[\s\S]*?<\/reasoning_content>/, '')
      .trim();

    logger.debug('Extracted reasoning from content tags', {
      reasoningLength: reasoning.length,
      cleanedContentLength: cleanedContent.length,
    });

    return {
      reasoning: reasoning || null,  // Return null if empty after trim
      content: cleanedContent,
    };
  }

  return { reasoning: null, content };
}

export default {
  injectReasoningPrompt,
  extractReasoning,
  REASONING_PROMPT,
};
