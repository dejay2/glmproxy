/**
 * Message format conversion utilities
 *
 * Handles conversion between Anthropic and OpenAI message formats
 */

import logger from '../utils/logger.js';

/**
 * Extract text content from Anthropic content (string or array of blocks)
 * @param {string|Array} content - Anthropic message content
 * @returns {string} extracted text content
 */
export function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  // Extract text from text blocks, skip other types for now
  const textParts = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text);

  return textParts.join('\n');
}

/**
 * Transform Anthropic image block to OpenAI image_url format
 *
 * Anthropic base64 format:
 * { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 *
 * Anthropic URL format:
 * { type: "image", source: { type: "url", url: "https://..." } }
 *
 * OpenAI format:
 * { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 * or
 * { type: "image_url", image_url: { url: "https://..." } }
 *
 * @param {Object} block - Anthropic image block
 * @returns {Object} OpenAI image_url block
 */
export function transformImageBlock(block) {
  if (!block.source) {
    logger.warn('Image block missing source property');
    throw new Error('Image block missing source property');
  }

  const sourceType = block.source.type;

  if (sourceType === 'base64') {
    const mediaType = block.source.media_type || 'image/png';
    const data = block.source.data;

    if (!data) {
      throw new Error('Base64 image missing data property');
    }

    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${data}`,
      },
    };
  }

  if (sourceType === 'url') {
    const url = block.source.url;

    if (!url) {
      throw new Error('URL image missing url property');
    }

    return {
      type: 'image_url',
      image_url: { url },
    };
  }

  throw new Error(`Unknown image source type: ${sourceType}`);
}

/**
 * Transform video block to OpenAI video_url format
 *
 * Input base64 format:
 * { type: "video", source: { type: "base64", media_type: "video/mp4", data: "..." } }
 *
 * Input URL format:
 * { type: "video", source: { type: "url", url: "https://..." } }
 *
 * OpenAI format:
 * { type: "video_url", video_url: { url: "data:video/mp4;base64,..." } }
 * or
 * { type: "video_url", video_url: { url: "https://..." } }
 *
 * @param {Object} block - Video block
 * @returns {Object} OpenAI video_url block
 */
export function transformVideoBlock(block) {
  if (!block.source) {
    logger.warn('Video block missing source property');
    throw new Error('Video block missing source property');
  }

  const sourceType = block.source.type;

  if (sourceType === 'base64') {
    const mediaType = block.source.media_type || 'video/mp4';
    const data = block.source.data;

    if (!data) {
      throw new Error('Base64 video missing data property');
    }

    return {
      type: 'video_url',
      video_url: {
        url: `data:${mediaType};base64,${data}`,
      },
    };
  }

  if (sourceType === 'url') {
    const url = block.source.url;

    if (!url) {
      throw new Error('URL video missing url property');
    }

    return {
      type: 'video_url',
      video_url: { url },
    };
  }

  throw new Error(`Unknown video source type: ${sourceType}`);
}

/**
 * Convert Anthropic content to OpenAI content format
 * Handles text blocks, image blocks, video blocks, and mixed content
 *
 * @param {string|Array} content - Anthropic message content
 * @returns {string|Array} OpenAI formatted content
 */
export function convertContentToOpenAI(content) {
  // String content passes through directly
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  let hasMedia = false;

  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      // Transform Anthropic image to OpenAI format
      try {
        const imageBlock = transformImageBlock(block);
        parts.push(imageBlock);
        hasMedia = true;
      } catch (error) {
        logger.warn('Failed to transform image block', { error: error.message });
        // Skip malformed image blocks
      }
    } else if (block.type === 'image_url') {
      // Already in OpenAI format, pass through
      parts.push(block);
      hasMedia = true;
    } else if (block.type === 'video') {
      // Transform video to OpenAI format
      try {
        const videoBlock = transformVideoBlock(block);
        parts.push(videoBlock);
        hasMedia = true;
      } catch (error) {
        logger.warn('Failed to transform video block', { error: error.message });
        // Skip malformed video blocks
      }
    } else if (block.type === 'video_url') {
      // Already in OpenAI format, pass through
      parts.push(block);
      hasMedia = true;
    }
    // Skip tool_use, tool_result for now (handled in later phases)
  }

  // If only one text part and no media, return as simple string
  if (parts.length === 1 && parts[0].type === 'text' && !hasMedia) {
    return parts[0].text;
  }

  // If no parts, return empty string
  if (parts.length === 0) {
    return '';
  }

  return parts;
}

/**
 * Convert a single Anthropic message to OpenAI format
 * Handles user messages, assistant messages with tool_use, and user messages with tool_result
 *
 * @param {Object} message - Anthropic message
 * @returns {Object|Array} OpenAI formatted message(s) - may return array for tool_result handling
 */
export function convertMessageToOpenAI(message) {
  const { role, content } = message;

  // Handle user messages with tool_result blocks
  if (role === 'user' && Array.isArray(content)) {
    const toolResults = content.filter((block) => block.type === 'tool_result');
    const otherContent = content.filter((block) => block.type !== 'tool_result');

    // If there are tool_result blocks, convert them to OpenAI tool messages
    if (toolResults.length > 0) {
      const messages = [];

      // Add tool result messages (OpenAI uses role: 'tool')
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: formatToolResultContent(result.content),
        });
      }

      // If there's other content in the user message, add it as a separate user message
      if (otherContent.length > 0) {
        messages.push({
          role: 'user',
          content: convertContentToOpenAI(otherContent),
        });
      }

      return messages;
    }
  }

  // Handle assistant messages with tool_use blocks
  if (role === 'assistant' && Array.isArray(content)) {
    const toolUses = content.filter((block) => block.type === 'tool_use');
    const textContent = content.filter((block) => block.type === 'text');

    if (toolUses.length > 0) {
      const assistantMessage = {
        role: 'assistant',
        content: textContent.length > 0 ? textContent.map((b) => b.text).join('\n') : null,
        tool_calls: toolUses.map((block) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        })),
      };
      return assistantMessage;
    }
  }

  // Standard message conversion
  return {
    role,
    content: convertContentToOpenAI(content),
  };
}

/**
 * Format tool result content for OpenAI format.
 * Handles string content, array content, and error results.
 *
 * @param {string|Array|Object} content - Tool result content
 * @returns {string} Formatted content string
 */
function formatToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }

  return String(content || '');
}

/**
 * Create Anthropic text content block
 * @param {string} text - Text content
 * @returns {Object} Anthropic text content block
 */
export function createTextBlock(text) {
  return {
    type: 'text',
    text,
  };
}

/**
 * Create Anthropic content array from text
 * @param {string} text - Text content
 * @returns {Array} Anthropic content array
 */
export function createContentArray(text) {
  return [createTextBlock(text)];
}
