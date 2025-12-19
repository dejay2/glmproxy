/**
 * Local MCP Client
 *
 * Manages subprocess spawning and stdio JSON-RPC communication
 * for local MCP servers (npx-based).
 */

import { spawn } from 'node:child_process';
import logger from '../utils/logger.js';

/**
 * Local MCP client that communicates via stdio JSON-RPC
 */
export class LocalMcpClient {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.initialized = false;
    this.tools = [];
  }

  /**
   * Spawn the MCP subprocess
   * @returns {Promise<void>}
   */
  async spawn() {
    if (this.process) {
      logger.debug('mcp-local', 'Process already running', { id: this.config.id });
      return;
    }

    const env = { ...process.env, ...this.config.env };

    // Build args (copy to avoid mutating config)
    const args = [...this.config.args];

    // Add API key to env or args
    if (this.config.apiKeyValue) {
      if (this.config.apiKeyAsArg) {
        args.push('--api-key', this.config.apiKeyValue);
      } else if (this.config.apiKeyName) {
        env[this.config.apiKeyName] = this.config.apiKeyValue;
      }
    }

    logger.info('mcp-local', 'Spawning MCP process', {
      id: this.config.id,
      command: this.config.command,
      args: args.map((a) => (a === this.config.apiKeyValue ? '[REDACTED]' : a)),
    });

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });

        // Handle stdout for JSON-RPC responses
        this.process.stdout.on('data', (data) => this.handleOutput(data));

        // Handle stderr (log but don't fail)
        this.process.stderr.on('data', (data) => {
          const stderr = data.toString().trim();
          if (stderr) {
            logger.debug('mcp-local', `[${this.config.id}] stderr: ${stderr}`);
          }
        });

        // Handle process exit
        this.process.on('exit', (code) => this.handleExit(code));

        // Handle spawn error
        this.process.on('error', (error) => {
          logger.error('mcp-local', 'Spawn error', {
            id: this.config.id,
            error: error.message,
          });
          this.cleanup();
          reject(error);
        });

        // Give process a moment to start, then resolve
        // Real initialization happens in initialize()
        setTimeout(() => resolve(), 100);
      } catch (error) {
        logger.error('mcp-local', 'Failed to spawn process', {
          id: this.config.id,
          error: error.message,
        });
        reject(error);
      }
    });
  }

  /**
   * Handle stdout data from subprocess
   * @param {Buffer} data - Raw output data
   */
  handleOutput(data) {
    this.buffer += data.toString();

    // Process complete lines (JSON-RPC messages are newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (error) {
        logger.debug('mcp-local', 'Non-JSON output', {
          id: this.config.id,
          line: line.substring(0, 200),
        });
      }
    }
  }

  /**
   * Handle parsed JSON-RPC message
   * @param {Object} message - Parsed JSON-RPC message
   */
  handleMessage(message) {
    // Check if this is a response to a pending request
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // This is a notification or request from the server
      logger.debug('mcp-local', 'Received server message', {
        id: this.config.id,
        method: message.method,
      });
    }
  }

  /**
   * Handle process exit
   * @param {number} code - Exit code
   */
  handleExit(code) {
    logger.info('mcp-local', 'Process exited', {
      id: this.config.id,
      code,
    });

    // Reject all pending requests
    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error(`MCP process exited with code ${code}`));
    }
    this.pendingRequests.clear();

    this.cleanup();
  }

  /**
   * Clean up process state
   */
  cleanup() {
    this.process = null;
    this.initialized = false;
    this.buffer = '';
  }

  /**
   * Initialize the MCP connection
   * @returns {Promise<Object>} Initialize result
   */
  async initialize() {
    if (!this.process) {
      await this.spawn();
    }

    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'glm-proxy', version: '1.0.0' },
    });

    this.initialized = true;

    // Send initialized notification
    await this.sendNotification('notifications/initialized', {});

    logger.info('mcp-local', 'MCP initialized', {
      id: this.config.id,
      serverInfo: result?.serverInfo,
    });

    return result;
  }

  /**
   * List available tools from the MCP
   * @returns {Promise<Array>} Array of tool definitions
   */
  async listTools() {
    if (!this.initialized) {
      await this.initialize();
    }

    const result = await this.sendRequest('tools/list', {});
    this.tools = result?.tools || [];

    logger.info('mcp-local', 'Tools discovered', {
      id: this.config.id,
      toolCount: this.tools.length,
      tools: this.tools.map((t) => t.name),
    });

    return this.tools;
  }

  /**
   * Call a tool on the MCP
   * @param {string} name - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<Object>} Tool result
   */
  async callTool(name, args) {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = Date.now();

    logger.info('mcp-local', 'Calling tool', {
      id: this.config.id,
      tool: name,
      args,
    });

    try {
      const result = await this.sendRequest('tools/call', {
        name,
        arguments: args,
      });

      const durationMs = Date.now() - startTime;
      logger.info('mcp-local', 'Tool call completed', {
        id: this.config.id,
        tool: name,
        durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error('mcp-local', 'Tool call failed', {
        id: this.config.id,
        tool: name,
        durationMs,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Send a JSON-RPC request and wait for response
   * @param {string} method - RPC method name
   * @param {Object} params - Method parameters
   * @param {number} timeout - Timeout in ms (default 30s)
   * @returns {Promise<any>} Response result
   */
  sendRequest(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin.writable) {
        reject(new Error('MCP process not running'));
        return;
      }

      const id = ++this.requestId;

      // Set timeout
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout after ${timeout}ms`));
        }
      }, timeout);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      // Send request
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process.stdin.write(request + '\n');

      logger.debug('mcp-local', 'Request sent', {
        id: this.config.id,
        requestId: id,
        method,
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   * @param {string} method - RPC method name
   * @param {Object} params - Method parameters
   */
  sendNotification(method, params) {
    if (!this.process || !this.process.stdin.writable) {
      return;
    }

    const notification = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process.stdin.write(notification + '\n');

    logger.debug('mcp-local', 'Notification sent', {
      id: this.config.id,
      method,
    });
  }

  /**
   * Shutdown the MCP process
   */
  shutdown() {
    if (!this.process) {
      return;
    }

    logger.info('mcp-local', 'Shutting down MCP', { id: this.config.id });

    // Try graceful shutdown first
    try {
      this.process.stdin.end();
    } catch (e) {
      // Ignore
    }

    // Force kill after timeout
    setTimeout(() => {
      if (this.process) {
        try {
          this.process.kill('SIGKILL');
        } catch (e) {
          // Ignore
        }
      }
    }, 1000);

    this.cleanup();
  }

  /**
   * Check if the client is connected and initialized
   * @returns {boolean} True if ready
   */
  isReady() {
    return this.process !== null && this.initialized;
  }
}

export default LocalMcpClient;
