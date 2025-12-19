/**
 * Custom Error Classes
 *
 * Error hierarchy for the GLM Proxy with Anthropic error format compatibility.
 * All errors can be transformed to Anthropic error response format.
 */

/**
 * Base proxy error class
 * All custom errors extend this class
 */
export class ProxyError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} type - Anthropic error type
   * @param {number} status - HTTP status code
   */
  constructor(message, type = 'api_error', status = 500) {
    super(message);
    this.name = 'ProxyError';
    this.type = type;
    this.status = status;
  }

  /**
   * Convert to Anthropic error response format
   * @returns {Object} Anthropic error response
   */
  toAnthropicError() {
    return {
      type: 'error',
      error: {
        type: this.type,
        message: this.message,
      },
    };
  }
}

/**
 * Invalid request error (400)
 * Thrown when request validation fails
 */
export class InvalidRequestError extends ProxyError {
  constructor(message) {
    super(message, 'invalid_request_error', 400);
    this.name = 'InvalidRequestError';
  }
}

/**
 * Authentication error (401)
 * Thrown when API key is missing or invalid
 */
export class AuthenticationError extends ProxyError {
  constructor(message = 'Invalid API key') {
    super(message, 'authentication_error', 401);
    this.name = 'AuthenticationError';
  }
}

/**
 * Rate limit error (429)
 * Thrown when upstream API returns rate limit
 */
export class RateLimitError extends ProxyError {
  constructor(message = 'Rate limit exceeded. Please retry after some time.') {
    super(message, 'rate_limit_error', 429);
    this.name = 'RateLimitError';
  }
}

/**
 * Overloaded error (529)
 * Thrown when upstream API is overloaded
 */
export class OverloadedError extends ProxyError {
  constructor(message = 'The API is temporarily overloaded. Please try again later.') {
    super(message, 'overloaded_error', 529);
    this.name = 'OverloadedError';
  }
}

/**
 * API error (500)
 * General upstream API errors
 */
export class ApiError extends ProxyError {
  constructor(message = 'An error occurred while processing your request.') {
    super(message, 'api_error', 500);
    this.name = 'ApiError';
  }
}

/**
 * GLM API error
 * Thrown when the Z.ai GLM API returns an error
 */
export class GlmApiError extends ProxyError {
  /**
   * @param {string} message - Error message
   * @param {number} upstreamStatus - HTTP status from GLM API
   * @param {string} upstreamBody - Response body from GLM API
   */
  constructor(message, upstreamStatus = 500, upstreamBody = '') {
    // Map GLM status codes to Anthropic error types
    let type = 'api_error';
    let status = 500;

    if (upstreamStatus === 401) {
      type = 'authentication_error';
      status = 401;
    } else if (upstreamStatus === 429) {
      type = 'rate_limit_error';
      status = 429;
    } else if (upstreamStatus === 503 || upstreamStatus === 529) {
      type = 'overloaded_error';
      status = 529;
    } else if (upstreamStatus >= 400 && upstreamStatus < 500) {
      type = 'invalid_request_error';
      status = 400;
    }

    super(message, type, status);
    this.name = 'GlmApiError';
    this.upstreamStatus = upstreamStatus;
    this.upstreamBody = upstreamBody;
  }
}

/**
 * MCP error
 * Thrown when MCP tool execution fails
 */
export class McpError extends ProxyError {
  /**
   * @param {string} message - Error message
   * @param {string} toolName - Name of the MCP tool that failed
   */
  constructor(message, toolName = 'unknown') {
    super(message, 'api_error', 500);
    this.name = 'McpError';
    this.toolName = toolName;
  }
}

/**
 * Transform error
 * Thrown when message transformation fails
 */
export class TransformError extends ProxyError {
  /**
   * @param {string} message - Error message
   * @param {string} stage - Transformation stage (request/response)
   */
  constructor(message, stage = 'unknown') {
    super(message, 'api_error', 500);
    this.name = 'TransformError';
    this.stage = stage;
  }
}

/**
 * Tool execution error
 * Thrown when the tool execution loop fails
 */
export class ToolExecutionError extends ProxyError {
  /**
   * @param {string} message - Error message
   * @param {number} iteration - Current loop iteration
   */
  constructor(message, iteration = 0) {
    super(message, 'api_error', 500);
    this.name = 'ToolExecutionError';
    this.iteration = iteration;
  }
}

/**
 * Convert any error to Anthropic error response format
 * @param {Error} error - Any error object
 * @returns {Object} Anthropic error response
 */
export function toAnthropicError(error) {
  if (error instanceof ProxyError) {
    return error.toAnthropicError();
  }

  // Handle standard JavaScript errors
  return {
    type: 'error',
    error: {
      type: 'api_error',
      message: error.message || 'An unexpected error occurred',
    },
  };
}

/**
 * Get HTTP status code for an error
 * @param {Error} error - Any error object
 * @returns {number} HTTP status code
 */
export function getErrorStatus(error) {
  if (error instanceof ProxyError) {
    return error.status;
  }
  return 500;
}

export default {
  ProxyError,
  InvalidRequestError,
  AuthenticationError,
  RateLimitError,
  OverloadedError,
  ApiError,
  GlmApiError,
  McpError,
  TransformError,
  ToolExecutionError,
  toAnthropicError,
  getErrorStatus,
};
