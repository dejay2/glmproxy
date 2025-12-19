/**
 * Default MCP Configurations
 *
 * Pre-configured MCP servers that come with the proxy.
 * These provide common functionality like documentation lookup and browser automation.
 */

/**
 * Default MCP configurations for pre-installed servers
 */
export const DEFAULT_MCPS = [
  {
    id: 'ref-tools',
    name: 'Ref Tools',
    enabled: true,

    // Command config
    command: 'npx',
    args: ['ref-tools-mcp@latest'],
    env: {},

    // Trigger keywords (activate this MCP when detected in user message)
    triggers: [
      'search docs',
      'find documentation',
      'api reference',
      'library docs',
      'ref tools',
      'ref-tools',
    ],

    // API key config
    apiKeyName: 'REF_API_KEY',
    apiKeyValue: process.env.REF_API_KEY || '',
    apiKeyAsArg: false,

    // Custom headers (for future remote MCP support)
    headers: {},
  },
  {
    id: 'playwright',
    name: 'Playwright Browser',
    enabled: true,

    // Command config
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    env: {},

    // Trigger keywords
    triggers: [
      'use playwright',
      'browser automation',
      'take screenshot',
      'web scrape',
      'playwright',
      'automate browser',
    ],

    // No API key required
    apiKeyName: '',
    apiKeyValue: '',
    apiKeyAsArg: false,

    headers: {},
  },
  {
    id: 'context7',
    name: 'Context7',
    enabled: true,

    // Command config
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    env: {},

    // Trigger keywords
    triggers: [
      'context7',
      'library documentation',
      'get docs for',
      'latest docs',
      'resolve library id',
    ],

    // API key is optional (for higher rate limits)
    apiKeyName: 'CONTEXT7_API_KEY',
    apiKeyValue: process.env.CONTEXT7_API_KEY || '',
    apiKeyAsArg: true, // Context7 expects --api-key argument

    headers: {},
  },
];

/**
 * Get a copy of default MCP configurations
 * @returns {Array} Array of default MCP configs
 */
export function getDefaultMcps() {
  return DEFAULT_MCPS.map((mcp) => ({
    ...mcp,
    // Runtime state (not persisted)
    initialized: false,
    tools: [],
    client: null,
  }));
}

export default {
  DEFAULT_MCPS,
  getDefaultMcps,
};
