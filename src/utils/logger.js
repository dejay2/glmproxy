/**
 * Structured Logger with Log Levels
 *
 * Provides consistent logging format with timestamps, levels, and context.
 * Configurable via LOG_LEVEL environment variable.
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

/**
 * Logger class with structured output
 */
class Logger {
  /**
   * @param {string} level - Minimum log level to output
   * @param {Object} options - Logger options
   */
  constructor(level = 'info', options = {}) {
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.includeTimestamp = options.includeTimestamp !== false;
    this.includeStackTrace = options.includeStackTrace || false;
  }

  /**
   * Format log message with timestamp, level, and context
   * @param {string} level - Log level
   * @param {string} context - Context identifier (e.g., 'request', 'mcp', 'tool')
   * @param {string} message - Log message
   * @param {Object} data - Additional data to include
   * @returns {string} Formatted log line
   */
  _format(level, context, message, data) {
    const parts = [];

    if (this.includeTimestamp) {
      parts.push(`[${new Date().toISOString()}]`);
    }

    parts.push(`[${level.toUpperCase()}]`);

    if (context) {
      parts.push(`[${context}]`);
    }

    parts.push(message);

    if (data !== undefined && data !== null) {
      if (typeof data === 'object') {
        parts.push(JSON.stringify(data));
      } else {
        parts.push(String(data));
      }
    }

    return parts.join(' ');
  }

  /**
   * Internal log method
   * @param {string} level - Log level
   * @param {string} context - Context identifier
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  _log(level, context, message, data) {
    if (LOG_LEVELS[level] < this.level) {
      return;
    }

    const formatted = this._format(level, context, message, data);

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  /**
   * Log at debug level
   * @param {string} contextOrMessage - Context string or message if no context
   * @param {string|Object} messageOrData - Message string or data object
   * @param {Object} data - Additional data (optional)
   */
  debug(contextOrMessage, messageOrData, data) {
    if (typeof messageOrData === 'string') {
      this._log('debug', contextOrMessage, messageOrData, data);
    } else {
      this._log('debug', null, contextOrMessage, messageOrData);
    }
  }

  /**
   * Log at info level
   * @param {string} contextOrMessage - Context string or message if no context
   * @param {string|Object} messageOrData - Message string or data object
   * @param {Object} data - Additional data (optional)
   */
  info(contextOrMessage, messageOrData, data) {
    if (typeof messageOrData === 'string') {
      this._log('info', contextOrMessage, messageOrData, data);
    } else {
      this._log('info', null, contextOrMessage, messageOrData);
    }
  }

  /**
   * Log at warn level
   * @param {string} contextOrMessage - Context string or message if no context
   * @param {string|Object} messageOrData - Message string or data object
   * @param {Object} data - Additional data (optional)
   */
  warn(contextOrMessage, messageOrData, data) {
    if (typeof messageOrData === 'string') {
      this._log('warn', contextOrMessage, messageOrData, data);
    } else {
      this._log('warn', null, contextOrMessage, messageOrData);
    }
  }

  /**
   * Log at error level
   * @param {string} contextOrMessage - Context string or message if no context
   * @param {string|Object} messageOrData - Message string or data object
   * @param {Object} data - Additional data (optional)
   */
  error(contextOrMessage, messageOrData, data) {
    if (typeof messageOrData === 'string') {
      this._log('error', contextOrMessage, messageOrData, data);
    } else {
      this._log('error', null, contextOrMessage, messageOrData);
    }
  }

  /**
   * Log an incoming HTTP request
   * @param {Object} req - HTTP request object
   * @param {number} messageCount - Number of messages in request
   */
  request(req, messageCount) {
    this.info('request', `${req.method} ${req.url}`, {
      messages: messageCount,
      contentType: req.headers['content-type'],
    });
  }

  /**
   * Log an HTTP response
   * @param {number} status - HTTP status code
   * @param {string} stopReason - Anthropic stop_reason
   * @param {number} durationMs - Request duration in milliseconds
   */
  response(status, stopReason, durationMs) {
    this.info('response', `${status} ${stopReason}`, {
      duration: `${durationMs}ms`,
    });
  }

  /**
   * Log tool execution
   * @param {string} toolName - Name of the tool
   * @param {number} durationMs - Execution duration in milliseconds
   * @param {boolean} success - Whether execution succeeded
   * @param {Object} details - Additional details (optional)
   */
  tool(toolName, durationMs, success, details = {}) {
    const level = success ? 'info' : 'warn';
    this._log(level, 'tool', `${toolName} ${success ? 'completed' : 'failed'}`, {
      duration: `${durationMs}ms`,
      success,
      ...details,
    });
  }

  /**
   * Log error with optional stack trace
   * @param {string} context - Context identifier
   * @param {string} message - Error message
   * @param {Error} error - Error object
   */
  errorWithStack(context, message, error) {
    const data = {
      error: error.message,
      name: error.name,
    };

    // Include stack trace in debug mode
    if (this.level <= LOG_LEVELS.debug && error.stack) {
      data.stack = error.stack;
    }

    this._log('error', context, message, data);
  }

  /**
   * Log GLM API call
   * @param {string} model - Model name
   * @param {number} messageCount - Number of messages
   * @param {boolean} hasTools - Whether request includes tools
   */
  glmCall(model, messageCount, hasTools) {
    this.debug('glm', 'Calling GLM API', {
      model,
      messages: messageCount,
      hasTools,
    });
  }

  /**
   * Log GLM API response
   * @param {string} model - Model name
   * @param {string} finishReason - Finish reason from GLM
   * @param {number} durationMs - Call duration in milliseconds
   * @param {Object} usage - Token usage
   */
  glmResponse(model, finishReason, durationMs, usage = {}) {
    this.debug('glm', 'GLM response received', {
      model,
      finishReason,
      duration: `${durationMs}ms`,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    });
  }

  /**
   * Log MCP call
   * @param {string} toolName - MCP tool name
   * @param {string} url - MCP endpoint URL
   */
  mcpCall(toolName, url) {
    this.debug('mcp', `Calling ${toolName}`, { url });
  }

  /**
   * Log MCP response
   * @param {string} toolName - MCP tool name
   * @param {boolean} success - Whether call succeeded
   * @param {number} durationMs - Call duration in milliseconds
   */
  mcpResponse(toolName, success, durationMs) {
    const level = success ? 'debug' : 'warn';
    this._log(level, 'mcp', `${toolName} ${success ? 'completed' : 'failed'}`, {
      duration: `${durationMs}ms`,
    });
  }

  /**
   * Log tool loop iteration
   * @param {number} iteration - Current iteration
   * @param {number} maxIterations - Maximum iterations
   * @param {number} messageCount - Current message count
   */
  toolLoopIteration(iteration, maxIterations, messageCount) {
    this.debug('toolloop', `Iteration ${iteration}/${maxIterations}`, {
      messages: messageCount,
    });
  }

  /**
   * Log server startup
   * @param {string} host - Server host
   * @param {number} port - Server port
   */
  serverStart(host, port) {
    this.info('server', `Listening on http://${host}:${port}`);
  }

  /**
   * Log server shutdown
   * @param {string} signal - Signal received (SIGTERM, SIGINT, etc.)
   */
  serverShutdown(signal) {
    this.info('server', `Received ${signal}, shutting down gracefully`);
  }
}

// Create singleton logger instance from environment
const logLevel = process.env.LOG_LEVEL || 'none';
const logger = new Logger(logLevel, {
  includeTimestamp: true,
  includeStackTrace: logLevel === 'debug',
});

export { Logger };
export default logger;
