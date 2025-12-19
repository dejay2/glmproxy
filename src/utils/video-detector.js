/**
 * Video File Path Detector
 *
 * Detects video file paths in message text and converts them to proper
 * video content blocks. This enables Claude Code to send video files
 * by just mentioning their path in the message.
 *
 * Patterns detected:
 * - @filename.mp4 (Claude Code file reference style)
 * - /absolute/path/to/video.mp4
 * - ./relative/path/to/video.mp4
 * - ../parent/path/to/video.mp4
 * - ~/home/path/to/video.mp4
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, extname, dirname } from 'path';
import { homedir } from 'os';
import logger from './logger.js';

// Supported video extensions
const VIDEO_EXTENSIONS = ['.mp4', '.mpeg', '.mpg', '.webm', '.mov'];

// MIME types for video extensions
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * Check if a file extension is a supported video format
 * @param {string} ext - File extension (with dot)
 * @returns {boolean}
 */
function isVideoExtension(ext) {
  return VIDEO_EXTENSIONS.includes(ext.toLowerCase());
}

/**
 * Get MIME type for a video file extension
 * @param {string} ext - File extension (with dot)
 * @returns {string} MIME type
 */
function getVideoMimeType(ext) {
  return VIDEO_MIME_TYPES[ext.toLowerCase()] || 'video/mp4';
}

/**
 * Resolve a file path, handling home directory and relative paths
 * @param {string} filePath - The file path to resolve
 * @param {string} workingDir - Working directory for relative paths
 * @returns {string} Resolved absolute path
 */
function resolvePath(filePath, workingDir = process.cwd()) {
  // Handle home directory
  if (filePath.startsWith('~/')) {
    return resolve(homedir(), filePath.slice(2));
  }
  // Handle absolute paths
  if (filePath.startsWith('/')) {
    return filePath;
  }
  // Handle relative paths
  return resolve(workingDir, filePath);
}

/**
 * Extract video file paths from text content
 * @param {string} text - Text to search for video paths
 * @returns {Array<{match: string, path: string, start: number, end: number}>}
 */
function extractVideoPaths(text) {
  const results = [];

  // Pattern 1: @filename.ext (Claude Code style - at the start of the string or after whitespace)
  // This matches @video.mp4 but not part of an email like user@video.mp4
  const atPattern = /(?:^|[\s\n])(@[\w\-.]+\.(?:mp4|mpeg|mpg|webm|mov))\b/gi;

  // Pattern 2: Absolute paths /path/to/video.ext
  const absolutePattern = /(\/[\w\-./]+\.(?:mp4|mpeg|mpg|webm|mov))\b/gi;

  // Pattern 3: Relative paths ./path or ../path
  const relativePattern = /(\.\.?\/[\w\-./]+\.(?:mp4|mpeg|mpg|webm|mov))\b/gi;

  // Pattern 4: Home directory ~/path
  const homePattern = /(~\/[\w\-./]+\.(?:mp4|mpeg|mpg|webm|mov))\b/gi;

  // Helper to add matches
  const addMatches = (pattern, getText) => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fullMatch = match[1];
      const path = getText ? getText(fullMatch) : fullMatch;
      results.push({
        match: fullMatch,
        path: path,
        start: match.index + (match[0].length - fullMatch.length),
        end: match.index + match[0].length,
      });
    }
  };

  // Extract @filename references (remove @ prefix for path)
  addMatches(atPattern, (m) => m.slice(1));

  // Extract absolute paths
  addMatches(absolutePattern);

  // Extract relative paths
  addMatches(relativePattern);

  // Extract home directory paths
  addMatches(homePattern);

  // Sort by position and remove duplicates
  results.sort((a, b) => a.start - b.start);

  // Remove overlapping matches (keep earlier ones)
  const filtered = [];
  let lastEnd = -1;
  for (const result of results) {
    if (result.start >= lastEnd) {
      filtered.push(result);
      lastEnd = result.end;
    }
  }

  return filtered;
}

/**
 * Read a video file and convert to base64
 * @param {string} filePath - Path to the video file
 * @param {string} workingDir - Working directory for relative paths
 * @param {string} originalPath - Original path as written in the message (for logging)
 * @returns {Promise<{data: string, mediaType: string}|null>}
 */
async function readVideoAsBase64(filePath, workingDir, originalPath = null) {
  try {
    const resolvedPath = resolvePath(filePath, workingDir);

    // Check if file exists
    if (!existsSync(resolvedPath)) {
      logger.debug('video-detector', `File not found: ${resolvedPath}`);
      return null;
    }

    // Check file extension
    const ext = extname(resolvedPath);
    if (!isVideoExtension(ext)) {
      logger.debug('video-detector', `Not a video file: ${resolvedPath}`);
      return null;
    }

    // Read file
    const buffer = await readFile(resolvedPath);
    const data = buffer.toString('base64');
    const mediaType = getVideoMimeType(ext);

    // Log video file read with both resolved and original paths for transparency
    logger.info('video-detector', 'Auto-reading video file', {
      path: resolvedPath,
      originalPath: originalPath || filePath,
      size: buffer.length,
      mediaType,
    });

    return { data, mediaType };
  } catch (error) {
    logger.warn('video-detector', `Failed to read video file: ${filePath}`, {
      error: error.message,
    });
    return null;
  }
}

/**
 * Process a message and convert video file references to content blocks
 * @param {Object} message - Anthropic format message
 * @param {string} workingDir - Working directory for relative paths
 * @returns {Promise<Object>} Processed message with video blocks
 */
export async function processMessageVideos(message, workingDir) {
  if (!message || message.role !== 'user') {
    return message;
  }

  const content = message.content;

  // Handle string content
  if (typeof content === 'string') {
    return processStringContent(message, content, workingDir);
  }

  // Handle array content
  if (Array.isArray(content)) {
    return processArrayContent(message, content, workingDir);
  }

  return message;
}

/**
 * Process string content for video references
 * @param {Object} message - The message object
 * @param {string} text - Text content to process
 * @param {string} workingDir - Working directory for relative paths
 */
async function processStringContent(message, text, workingDir) {
  const videoPaths = extractVideoPaths(text);

  if (videoPaths.length === 0) {
    return message;
  }

  logger.debug('video-detector', 'Found video paths in string content', {
    paths: videoPaths.map(p => p.path),
    workingDir,
  });

  // Convert to content blocks
  const blocks = [];
  let lastIndex = 0;

  for (const videoPath of videoPaths) {
    // Add text before this video reference
    if (videoPath.start > lastIndex) {
      const textBefore = text.slice(lastIndex, videoPath.start).trim();
      if (textBefore) {
        blocks.push({ type: 'text', text: textBefore });
      }
    }

    // Try to read the video file (pass match as originalPath for logging)
    const videoData = await readVideoAsBase64(videoPath.path, workingDir, videoPath.match);

    if (videoData) {
      // Add video block
      blocks.push({
        type: 'video',
        source: {
          type: 'base64',
          media_type: videoData.mediaType,
          data: videoData.data,
        },
      });
    } else {
      // Keep original text if file couldn't be read
      blocks.push({ type: 'text', text: videoPath.match });
    }

    lastIndex = videoPath.end;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      blocks.push({ type: 'text', text: remaining });
    }
  }

  // If we only have one text block, keep it as string
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return { ...message, content: blocks[0].text };
  }

  return { ...message, content: blocks };
}

/**
 * Process array content for video references
 * @param {Object} message - The message object
 * @param {Array} blocks - Content blocks to process
 * @param {string} workingDir - Working directory for relative paths
 */
async function processArrayContent(message, blocks, workingDir) {
  const newBlocks = [];
  let modified = false;

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const videoPaths = extractVideoPaths(block.text);

      if (videoPaths.length > 0) {
        // Process this text block for videos
        const processed = await processStringContent(
          { role: 'user', content: block.text },
          block.text,
          workingDir
        );

        if (Array.isArray(processed.content)) {
          newBlocks.push(...processed.content);
          modified = true;
        } else if (typeof processed.content === 'string') {
          newBlocks.push({ type: 'text', text: processed.content });
        } else {
          newBlocks.push(block);
        }
      } else {
        newBlocks.push(block);
      }
    } else {
      newBlocks.push(block);
    }
  }

  if (modified) {
    return { ...message, content: newBlocks };
  }

  return message;
}

/**
 * Extract working directory from system prompt
 * Claude Code includes "Working directory: /path/to/project" in system prompts
 * @param {string|Array} system - System prompt (string or array of content blocks)
 * @returns {string|null} Working directory or null if not found
 */
export function extractWorkingDirectory(system) {
  if (!system) {
    return null;
  }

  // Convert to string if it's an array of content blocks
  let systemText = '';
  if (typeof system === 'string') {
    systemText = system;
  } else if (Array.isArray(system)) {
    systemText = system
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  // Look for "Working directory: /path/to/project" pattern
  const match = systemText.match(/Working directory:\s*([^\n]+)/i);
  if (match) {
    const workingDir = match[1].trim();
    logger.debug('video-detector', 'Extracted working directory from system prompt', { workingDir });
    return workingDir;
  }

  return null;
}

/**
 * Process all messages in a request for video file references
 * @param {Array} messages - Array of Anthropic format messages
 * @param {string} workingDir - Working directory for relative paths
 * @returns {Promise<Array>} Processed messages
 */
export async function processMessagesForVideos(messages, workingDir) {
  if (!messages || !Array.isArray(messages)) {
    return messages;
  }

  const processed = [];

  for (const message of messages) {
    const processedMessage = await processMessageVideos(message, workingDir);
    processed.push(processedMessage);
  }

  return processed;
}

export default {
  processMessageVideos,
  processMessagesForVideos,
  extractVideoPaths,
  extractWorkingDirectory,
};
