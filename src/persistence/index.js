/**
 * Persistence utilities for ~/.ccglm/ directory
 *
 * Provides file-based persistence for MCP configurations and runtime settings.
 * API keys are never stored in JSON files - they are read from environment at runtime.
 */

import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';

const CONFIG_DIR_NAME = '.ccglm';

// Get project root for .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Get the config directory path (~/.ccglm/)
 * Creates the directory if it doesn't exist
 * @returns {string} Absolute path to config directory
 */
export function getConfigDir() {
  const configDir = join(homedir(), CONFIG_DIR_NAME);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  return configDir;
}

/**
 * Read and parse a JSON file from the config directory
 * @param {string} filename - Filename (e.g., 'mcps.json')
 * @returns {Object|Array|null} Parsed JSON data or null if file doesn't exist
 */
export function readJsonFile(filename) {
  const filePath = join(getConfigDir(), filename);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    // Log error but return null to allow fallback to defaults
    console.error(`[persistence] Failed to read ${filename}:`, err.message);
    return null;
  }
}

/**
 * Write JSON data to a file in the config directory (atomic write)
 * @param {string} filename - Filename (e.g., 'mcps.json')
 * @param {Object|Array} data - Data to write
 * @returns {boolean} True if successful
 */
export function writeJsonFile(filename, data) {
  const configDir = getConfigDir();
  const filePath = join(configDir, filename);
  const tempPath = join(configDir, `.${filename}.tmp`);

  try {
    const content = JSON.stringify(data, null, 2);
    // Write to temp file first, then rename for atomic operation
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    console.error(`[persistence] Failed to write ${filename}:`, err.message);
    return false;
  }
}

/**
 * Read environment variables from .env file
 * @returns {Object} Key-value pairs from .env file
 */
export function readEnvFile() {
  const envPath = join(PROJECT_ROOT, '.env');

  if (!existsSync(envPath)) {
    return {};
  }

  try {
    const content = readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        env[key] = value;
      }
    }
    return env;
  } catch (err) {
    console.error('[persistence] Failed to read .env:', err.message);
    return {};
  }
}

/**
 * Set an API key in the .env file
 * Creates the file if it doesn't exist, updates if key exists
 * @param {string} keyName - Environment variable name (e.g., 'REF_API_KEY')
 * @param {string} keyValue - API key value
 * @returns {boolean} True if successful
 */
export function setEnvApiKey(keyName, keyValue) {
  if (!keyName || !keyValue) {
    return false;
  }

  const envPath = join(PROJECT_ROOT, '.env');
  let lines = [];

  // Read existing .env if it exists
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      lines = content.split('\n');
    } catch (err) {
      console.error('[persistence] Failed to read .env:', err.message);
      return false;
    }
  }

  // Check if key already exists and update it
  let found = false;
  const newLine = `${keyName}=${keyValue}`;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(`${keyName}=`) || trimmed.startsWith(`${keyName} =`)) {
      lines[i] = newLine;
      found = true;
      break;
    }
  }

  // If not found, append to end
  if (!found) {
    // Add newline before if file doesn't end with one
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(newLine);
  }

  // Write back
  try {
    writeFileSync(envPath, lines.join('\n'), 'utf-8');
    // Also update process.env for current session
    process.env[keyName] = keyValue;
    return true;
  } catch (err) {
    console.error('[persistence] Failed to write .env:', err.message);
    return false;
  }
}

export default {
  getConfigDir,
  readJsonFile,
  writeJsonFile,
  readEnvFile,
  setEnvApiKey,
};
