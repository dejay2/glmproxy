/**
 * Configuration module - reads from environment variables
 *
 * SECURITY NOTES:
 * - API keys should be set via ZAI_API_KEY environment variable
 * - API keys can be updated at runtime via frontend and saved to .env
 * - API keys are NEVER exposed in /config endpoint responses
 * - API keys are NEVER logged (even in debug mode)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readJsonFile, writeJsonFile, setEnvApiKey } from './persistence/index.js';

// Load .env from project root synchronously before config is created
// This ensures env vars are available regardless of cwd
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Only set if not already defined (env vars take precedence)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
} catch {
  // .env file not found or not readable - use existing env vars
}

const SETTINGS_FILE = 'settings.json';

// Load saved settings on module init
const saved = readJsonFile(SETTINGS_FILE) || {};

const config = {
  // Server configuration
  port: parseInt(process.env.PORT, 10) || 4567,
  host: process.env.HOST || '127.0.0.1',

  // Z.ai API configuration
  zaiApiKey: process.env.ZAI_API_KEY || '',
  zaiBaseUrl: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  zaiAnthropicUrl: process.env.ZAI_ANTHROPIC_URL || 'https://api.z.ai/api/anthropic/v1/messages',
  bigModelUrl: process.env.BIGMODEL_URL || 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',

  // Endpoint configuration
  // mode: 'anthropic' | 'openai' | 'bigmodel'
  // - anthropic: Z.ai Anthropic endpoint (fast, buffered responses)
  // - openai: Z.ai OpenAI endpoint (real-time streaming)
  // - bigmodel: BigModel OpenAI-compatible endpoint (alternative provider)
  endpoint: {
    mode: saved.endpoint?.mode || process.env.ENDPOINT_MODE || 'anthropic',
    // Legacy support: if USE_ANTHROPIC_ENDPOINT is explicitly set, derive mode from it
    useAnthropic: process.env.USE_ANTHROPIC_ENDPOINT !== 'false',  // Deprecated, use ENDPOINT_MODE instead
  },

  // Model configuration
  defaultModel: 'glm-4.7',
  visionModel: 'glm-4.6v',

  // Models object for routing
  models: {
    text: 'glm-4.7',
    vision: 'glm-4.6v',
  },

  // Web search enabled flag
  webSearch: {
    enabled: saved.webSearch?.enabled ?? (process.env.WEB_SEARCH_ENABLED !== 'false'),  // Enabled by default, set WEB_SEARCH_ENABLED=false to disable
  },

  // Request defaults
  defaultTemperature: 1.0,

  // Reasoning configuration
  reasoning: {
    forceReasoning: saved.reasoning?.forceReasoning ?? (process.env.FORCE_REASONING !== 'false'),  // Inject reasoning prompt (default: true)
  },

  // MCP (Model Context Protocol) server configuration
  mcp: {
    search: {
      url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
      toolName: 'webSearchPrime',
    },
    reader: {
      url: 'https://api.z.ai/api/mcp/web_reader/mcp',
      toolName: 'webReader',
    },
  },

  // Tool execution settings
  toolExecution: {
    maxIterations: 15,       // Maximum tool call loops before error (generous for complex research)
    maxConsecutiveInternal: 10, // Max consecutive internal-only tool calls before forcing response
    timeout: 30000,          // Per-tool timeout in milliseconds
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'none',
    includeTimestamp: true,
  },

  // Streaming configuration
  streaming: {
    enabled: saved.streaming?.enabled ?? (process.env.STREAMING_ENABLED === 'true'),  // Set to true to enable streaming
    chunkSize: saved.streaming?.chunkSize ?? (parseInt(process.env.STREAMING_CHUNK_SIZE, 10) || 20),  // Characters per chunk
    chunkDelay: saved.streaming?.chunkDelay ?? (parseInt(process.env.STREAMING_CHUNK_DELAY, 10) || 0), // Delay between chunks in ms
  },

  // Version info
  version: '1.0.0',
};

/**
 * Validate required configuration
 * @returns {Object} validation result with isValid and errors
 */
export function validateConfig() {
  const errors = [];

  if (!config.zaiApiKey) {
    errors.push('ZAI_API_KEY environment variable is required');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Get a summary of the current configuration (safe to log)
 * @returns {Object} configuration summary without sensitive values
 */
export function getConfigSummary() {
  return {
    port: config.port,
    host: config.host,
    apiKeyConfigured: !!config.zaiApiKey,
    endpoint: {
      mode: config.endpoint.mode,
      useAnthropic: config.endpoint.useAnthropic,
    },
    models: {
      text: config.models.text,
      vision: config.models.vision,
    },
    webSearch: {
      enabled: config.webSearch.enabled,
    },
    reasoning: {
      forceReasoning: config.reasoning.forceReasoning,
    },
    toolExecution: {
      maxIterations: config.toolExecution.maxIterations,
      timeout: config.toolExecution.timeout,
    },
    logging: config.logging,
    streaming: config.streaming,
  };
}

/**
 * Update runtime configuration
 * @param {Object} updates - Configuration updates to apply
 * @returns {Object} updated configuration summary
 */
export function updateConfig(updates) {
  // Apply updates to mutable config properties
  if (updates.reasoning !== undefined) {
    if (typeof updates.reasoning === 'boolean') {
      config.reasoning.forceReasoning = updates.reasoning;
    } else if (typeof updates.reasoning === 'object') {
      if (updates.reasoning.forceReasoning !== undefined) {
        config.reasoning.forceReasoning = updates.reasoning.forceReasoning;
      }
    }
  }

  if (updates.streaming !== undefined) {
    if (typeof updates.streaming === 'boolean') {
      config.streaming.enabled = updates.streaming;
    } else if (typeof updates.streaming === 'object') {
      if (updates.streaming.enabled !== undefined) {
        config.streaming.enabled = updates.streaming.enabled;
      }
      if (updates.streaming.chunkSize !== undefined) {
        const parsed = parseInt(updates.streaming.chunkSize, 10);
        config.streaming.chunkSize = Number.isNaN(parsed) ? 20 : parsed;
      }
      if (updates.streaming.chunkDelay !== undefined) {
        config.streaming.chunkDelay = parseInt(updates.streaming.chunkDelay, 10) || 0;
      }
    }
  }

  if (updates.webSearch !== undefined) {
    if (typeof updates.webSearch === 'boolean') {
      config.webSearch.enabled = updates.webSearch;
    } else if (typeof updates.webSearch === 'object' && updates.webSearch.enabled !== undefined) {
      config.webSearch.enabled = updates.webSearch.enabled;
    }
  }

  // API key can be updated at runtime - persist to .env file
  if (updates.zaiApiKey !== undefined && typeof updates.zaiApiKey === 'string') {
    config.zaiApiKey = updates.zaiApiKey;
    // Save to .env so it persists across restarts
    if (updates.zaiApiKey) {
      setEnvApiKey('ZAI_API_KEY', updates.zaiApiKey);
    }
  }

  // Endpoint configuration (switch between endpoints)
  if (updates.endpoint !== undefined) {
    const validModes = ['anthropic', 'openai', 'bigmodel'];
    if (typeof updates.endpoint === 'string') {
      // Direct string value: {"endpoint": "openai"}
      if (validModes.includes(updates.endpoint)) {
        config.endpoint.mode = updates.endpoint;
        config.endpoint.useAnthropic = updates.endpoint === 'anthropic';
      }
    } else if (typeof updates.endpoint === 'object') {
      if (updates.endpoint.mode !== undefined) {
        if (validModes.includes(updates.endpoint.mode)) {
          config.endpoint.mode = updates.endpoint.mode;
          // Also update legacy useAnthropic for compatibility
          config.endpoint.useAnthropic = updates.endpoint.mode === 'anthropic';
        }
      }
      // Legacy support
      if (updates.endpoint.useAnthropic !== undefined) {
        config.endpoint.useAnthropic = !!updates.endpoint.useAnthropic;
      }
    }
  }

  // Persist settings to disk
  saveSettings();

  return getConfigSummary();
}

/**
 * Save current settings to persistence file
 * Excludes API keys and server-only settings
 */
function saveSettings() {
  writeJsonFile(SETTINGS_FILE, {
    endpoint: { mode: config.endpoint.mode },
    reasoning: { forceReasoning: config.reasoning.forceReasoning },
    streaming: {
      enabled: config.streaming.enabled,
      chunkSize: config.streaming.chunkSize,
      chunkDelay: config.streaming.chunkDelay,
    },
    webSearch: { enabled: config.webSearch.enabled },
    // Note: zaiApiKey is NOT saved (security)
  });
}

export default config;
