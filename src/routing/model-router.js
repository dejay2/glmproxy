/**
 * Model Router: Intelligent model selection based on request content
 *
 * Detects images in messages and routes to appropriate model:
 * - glm-4.6: Text-only requests (faster, cheaper)
 * - glm-4.6v: Vision-capable requests (handles images)
 */

import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * Check if a content block is an image
 * @param {Object} block - Content block
 * @returns {boolean} true if block is an image
 */
function isImageBlock(block) {
  if (!block || typeof block !== 'object') {
    return false;
  }

  // Direct image block (Anthropic format)
  if (block.type === 'image') {
    return true;
  }

  // OpenAI image_url format (already transformed or passed through)
  if (block.type === 'image_url') {
    return true;
  }

  return false;
}

/**
 * Check if a content block is a video
 * @param {Object} block - Content block
 * @returns {boolean} true if block is a video
 */
function isVideoBlock(block) {
  if (!block || typeof block !== 'object') {
    return false;
  }

  // Direct video block (Anthropic-like format)
  if (block.type === 'video') {
    return true;
  }

  // OpenAI video_url format (already transformed or passed through)
  if (block.type === 'video_url') {
    return true;
  }

  return false;
}

/**
 * Check if a content block is visual media (image or video)
 * @param {Object} block - Content block
 * @returns {boolean} true if block is visual media
 */
function isMediaBlock(block) {
  return isImageBlock(block) || isVideoBlock(block);
}

/**
 * Check if a content array contains visual media (images or videos)
 * @param {Array} contentArray - Array of content blocks
 * @returns {boolean} true if any block is visual media
 */
function contentHasMedia(contentArray) {
  if (!Array.isArray(contentArray)) {
    return false;
  }

  return contentArray.some((block) => {
    // Direct image or video block
    if (isMediaBlock(block)) {
      return true;
    }

    // Tool result might contain images/videos in its content
    if (block.type === 'tool_result') {
      // tool_result content can be string or array
      if (typeof block.content === 'string') {
        return false;
      }
      if (Array.isArray(block.content)) {
        return block.content.some((c) => isMediaBlock(c));
      }
    }

    return false;
  });
}

/**
 * Detect if any messages contain visual media (images or videos)
 * Scans all messages for media content in:
 * - Direct image/video blocks
 * - Image/Video URLs
 * - Tool results containing images/videos (e.g., screenshots)
 *
 * @param {Array} messages - Array of Anthropic or OpenAI messages
 * @returns {boolean} true if any message contains visual media
 */
export function detectMedia(messages) {
  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((msg) => {
    const content = msg.content;

    // String content - no media possible
    if (typeof content === 'string') {
      return false;
    }

    // Array content - check each block
    if (Array.isArray(content)) {
      return contentHasMedia(content);
    }

    return false;
  });
}

/**
 * Detect if any messages contain images (alias for backwards compatibility)
 * @param {Array} messages - Array of Anthropic or OpenAI messages
 * @returns {boolean} true if any message contains images
 * @deprecated Use detectMedia() instead
 */
export function detectImages(messages) {
  return detectMedia(messages);
}

/**
 * Select appropriate model based on message content
 *
 * @param {Array} messages - Array of messages to analyze
 * @param {Object} options - Optional configuration override
 * @param {string} options.textModel - Model for text-only requests
 * @param {string} options.visionModel - Model for vision requests
 * @returns {Object} Model selection result with model name and hasMedia/hasImages flags
 */
export function selectModel(messages, options = {}) {
  const textModel = options.textModel || config.models?.text || config.defaultModel;
  const visionModel = options.visionModel || config.models?.vision || config.visionModel;

  const hasMedia = detectMedia(messages);

  const selectedModel = hasMedia ? visionModel : textModel;

  logger.debug('Model selection', {
    hasMedia,
    selectedModel,
    textModel,
    visionModel,
  });

  return {
    model: selectedModel,
    hasMedia,
    hasImages: hasMedia, // backwards compatibility
  };
}

export default { detectImages, detectMedia, selectModel };
