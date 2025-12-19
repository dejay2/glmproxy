/**
 * MCP Registry
 *
 * In-memory registry for managing custom MCP servers.
 * Provides CRUD operations for MCP configurations.
 * Persists configurations to ~/.ccglm/mcps.json.
 */

import { getDefaultMcps } from './defaults.js';
import { readJsonFile, writeJsonFile, setEnvApiKey } from '../persistence/index.js';
import logger from '../utils/logger.js';

const MCP_FILE = 'mcps.json';

// In-memory registry of MCPs
let mcpRegistry = [];

// Initialize flag
let initialized = false;

/**
 * Generate environment variable name from MCP ID
 * e.g., "ref-tools" -> "REF_TOOLS_API_KEY"
 * @param {string} mcpId - MCP ID
 * @returns {string} Environment variable name
 */
function generateEnvVarName(mcpId) {
  return `${mcpId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Load MCPs from persistence file
 * Hydrates apiKeyValue from environment variables using auto-generated env var name
 * @returns {Array|null} Array of MCPs or null if file doesn't exist
 */
function loadMcps() {
  const data = readJsonFile(MCP_FILE);
  if (data && Array.isArray(data)) {
    return data.map((mcp) => {
      // Use stored apiKeyName or auto-generate from ID
      const envVarName = mcp.apiKeyName || generateEnvVarName(mcp.id);
      return {
        ...mcp,
        // Hydrate apiKeyValue from environment at runtime
        apiKeyValue: process.env[envVarName] || '',
        // Reset runtime state
        initialized: false,
        tools: [],
        client: null,
      };
    });
  }
  return null;
}

/**
 * Save MCPs to persistence file
 * Excludes apiKeyValue and runtime state
 */
function saveMcps() {
  const data = mcpRegistry.map((mcp) => ({
    id: mcp.id,
    name: mcp.name,
    enabled: mcp.enabled,
    command: mcp.command,
    args: mcp.args,
    env: mcp.env,
    triggers: mcp.triggers,
    apiKeyName: mcp.apiKeyName,
    apiKeyAsArg: mcp.apiKeyAsArg,
    headers: mcp.headers,
    // Note: apiKeyValue NOT saved (read from env)
    // Note: runtime state (initialized, tools, client) NOT saved
  }));
  writeJsonFile(MCP_FILE, data);
}

/**
 * Initialize the MCP registry
 * Loads from persistence file if exists, otherwise seeds from defaults
 */
export function initRegistry() {
  if (initialized) {
    return;
  }

  // Try loading from persistence file first
  const savedMcps = loadMcps();
  if (savedMcps) {
    mcpRegistry = savedMcps;
    logger.info('mcp-registry', 'Registry loaded from persistence', {
      mcpCount: mcpRegistry.length,
      mcps: mcpRegistry.map((m) => m.id),
    });
  } else {
    // No persistence file, seed from defaults
    mcpRegistry = getDefaultMcps();
    // Save the defaults to persistence
    saveMcps();
    logger.info('mcp-registry', 'Registry initialized with defaults', {
      mcpCount: mcpRegistry.length,
      mcps: mcpRegistry.map((m) => m.id),
    });
  }

  initialized = true;
}

/**
 * Get all MCPs in the registry
 * @returns {Array} Array of MCP configurations
 */
export function getAllMcps() {
  return mcpRegistry.map((mcp) => sanitizeMcpForResponse(mcp));
}

/**
 * Get an MCP by ID
 * @param {string} id - MCP ID
 * @returns {Object|null} MCP configuration or null if not found
 */
export function getMcp(id) {
  const mcp = mcpRegistry.find((m) => m.id === id);
  return mcp || null;
}

/**
 * Get an MCP by ID (sanitized for API response)
 * @param {string} id - MCP ID
 * @returns {Object|null} Sanitized MCP configuration or null
 */
export function getMcpSafe(id) {
  const mcp = getMcp(id);
  return mcp ? sanitizeMcpForResponse(mcp) : null;
}

/**
 * Add a new MCP to the registry
 * @param {Object} config - MCP configuration
 * @returns {Object} Added MCP (sanitized)
 * @throws {Error} If MCP with same ID already exists
 */
export function addMcp(config) {
  // Validate required fields
  if (!config.id || typeof config.id !== 'string') {
    throw new Error('MCP id is required and must be a string');
  }
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('MCP name is required and must be a string');
  }
  if (!config.command || typeof config.command !== 'string') {
    throw new Error('MCP command is required and must be a string');
  }

  // Check for duplicate ID
  if (mcpRegistry.find((m) => m.id === config.id)) {
    throw new Error(`MCP with id '${config.id}' already exists`);
  }

  // Validate command (security: only allow known commands)
  const allowedCommands = ['npx', 'node', 'python', 'python3'];
  if (!allowedCommands.includes(config.command)) {
    throw new Error(`Command '${config.command}' is not allowed. Allowed: ${allowedCommands.join(', ')}`);
  }

  // Create MCP entry with defaults
  // Auto-generate apiKeyName from ID if not provided
  const apiKeyName = config.apiKeyName || generateEnvVarName(config.id);
  const mcp = {
    id: config.id,
    name: config.name,
    enabled: config.enabled !== false,
    command: config.command,
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env || {},
    triggers: Array.isArray(config.triggers) ? config.triggers : [],
    apiKeyName: apiKeyName,
    apiKeyValue: config.apiKeyValue || '',
    apiKeyAsArg: config.apiKeyAsArg || false,
    headers: config.headers || {},
    // Runtime state
    initialized: false,
    tools: [],
    client: null,
  };

  // If API key value provided, save to .env file
  if (mcp.apiKeyValue) {
    const saved = setEnvApiKey(mcp.apiKeyName, mcp.apiKeyValue);
    if (saved) {
      logger.info('mcp-registry', 'API key saved to .env', { keyName: mcp.apiKeyName });
    }
  }

  mcpRegistry.push(mcp);

  // Persist to disk
  saveMcps();

  logger.info('mcp-registry', 'MCP added', {
    id: mcp.id,
    name: mcp.name,
    command: mcp.command,
  });

  return sanitizeMcpForResponse(mcp);
}

/**
 * Update an MCP in the registry
 * @param {string} id - MCP ID
 * @param {Object} updates - Fields to update
 * @returns {Object} Updated MCP (sanitized)
 * @throws {Error} If MCP not found
 */
export function updateMcp(id, updates) {
  const mcp = getMcp(id);
  if (!mcp) {
    throw new Error(`MCP with id '${id}' not found`);
  }

  // Update allowed fields
  const allowedFields = [
    'name',
    'enabled',
    'args',
    'env',
    'triggers',
    'apiKeyValue',
    'apiKeyAsArg',
    'headers',
  ];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      mcp[field] = updates[field];
    }
  }

  // If config changed, mark as needing re-initialization
  if (
    updates.args !== undefined ||
    updates.env !== undefined ||
    updates.apiKeyValue !== undefined ||
    updates.apiKeyAsArg !== undefined
  ) {
    mcp.initialized = false;
    mcp.tools = [];
    // Client will be shut down by lifecycle manager
  }

  // If API key value provided, save to .env file using auto-generated name
  if (updates.apiKeyValue) {
    const envVarName = mcp.apiKeyName || generateEnvVarName(mcp.id);
    mcp.apiKeyName = envVarName; // Ensure apiKeyName is set
    const saved = setEnvApiKey(envVarName, updates.apiKeyValue);
    if (saved) {
      logger.info('mcp-registry', 'API key saved to .env', { keyName: envVarName });
    }
  }

  // Persist to disk
  saveMcps();

  logger.info('mcp-registry', 'MCP updated', {
    id: mcp.id,
    fields: Object.keys(updates),
  });

  return sanitizeMcpForResponse(mcp);
}

/**
 * Remove an MCP from the registry
 * @param {string} id - MCP ID
 * @returns {boolean} True if removed
 * @throws {Error} If MCP not found
 */
export function removeMcp(id) {
  const index = mcpRegistry.findIndex((m) => m.id === id);
  if (index === -1) {
    throw new Error(`MCP with id '${id}' not found`);
  }

  const mcp = mcpRegistry[index];

  // Client shutdown handled by caller (lifecycle manager)
  mcpRegistry.splice(index, 1);

  // Persist to disk
  saveMcps();

  logger.info('mcp-registry', 'MCP removed', { id });

  return true;
}

/**
 * Enable an MCP
 * @param {string} id - MCP ID
 * @returns {Object} Updated MCP (sanitized)
 */
export function enableMcp(id) {
  return updateMcp(id, { enabled: true });
}

/**
 * Disable an MCP
 * @param {string} id - MCP ID
 * @returns {Object} Updated MCP (sanitized)
 */
export function disableMcp(id) {
  const mcp = getMcp(id);
  if (!mcp) {
    throw new Error(`MCP with id '${id}' not found`);
  }

  mcp.enabled = false;
  mcp.initialized = false;
  mcp.tools = [];
  // Client will be shut down by lifecycle manager

  // Persist to disk
  saveMcps();

  return sanitizeMcpForResponse(mcp);
}

/**
 * Get tools for an MCP
 * @param {string} id - MCP ID
 * @returns {Array} Array of tool definitions
 */
export function getMcpTools(id) {
  const mcp = getMcp(id);
  if (!mcp) {
    throw new Error(`MCP with id '${id}' not found`);
  }

  return mcp.tools || [];
}

/**
 * Update runtime state for an MCP (called by lifecycle manager)
 * @param {string} id - MCP ID
 * @param {Object} state - Runtime state updates
 */
export function updateMcpState(id, state) {
  const mcp = getMcp(id);
  if (!mcp) {
    return;
  }

  if (state.initialized !== undefined) {
    mcp.initialized = state.initialized;
  }
  if (state.tools !== undefined) {
    mcp.tools = state.tools;
  }
  if (state.client !== undefined) {
    mcp.client = state.client;
  }
}

/**
 * Get all enabled MCPs
 * @returns {Array} Array of enabled MCP configurations
 */
export function getEnabledMcps() {
  return mcpRegistry.filter((m) => m.enabled);
}

/**
 * Sanitize MCP for API response (hide sensitive data)
 * @param {Object} mcp - MCP configuration
 * @returns {Object} Sanitized MCP
 */
function sanitizeMcpForResponse(mcp) {
  return {
    id: mcp.id,
    name: mcp.name,
    enabled: mcp.enabled,
    command: mcp.command,
    args: mcp.args,
    triggers: mcp.triggers,
    apiKeyName: mcp.apiKeyName,
    apiKeyConfigured: !!mcp.apiKeyValue,
    apiKeyAsArg: mcp.apiKeyAsArg,
    // Runtime state
    initialized: mcp.initialized,
    toolCount: mcp.tools?.length || 0,
  };
}

/**
 * Reset registry (for testing)
 */
export function resetRegistry() {
  // Shutdown all clients first
  for (const mcp of mcpRegistry) {
    if (mcp.client) {
      try {
        mcp.client.shutdown();
      } catch (e) {
        // Ignore errors during reset
      }
    }
  }

  mcpRegistry = [];
  initialized = false;
}

export default {
  initRegistry,
  getAllMcps,
  getMcp,
  getMcpSafe,
  addMcp,
  updateMcp,
  removeMcp,
  enableMcp,
  disableMcp,
  getMcpTools,
  updateMcpState,
  getEnabledMcps,
  resetRegistry,
};
