/**
 * API Client for GLM Proxy
 * Handles all communication with the backend server
 */

const BASE_URL = window.location.origin;

class ApiClient {
  constructor() {
    this.apiKey = null;
  }

  /**
   * Set API key for requests
   * @param {string} key - Z.ai API key
   */
  setApiKey(key) {
    this.apiKey = key;
  }

  /**
   * Make HTTP request
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} response data
   */
  async request(endpoint, options = {}) {
    const url = `${BASE_URL}${endpoint}`;
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    };

    // Add API key header if available
    if (this.apiKey) {
      config.headers['X-Api-Key'] = this.apiKey;
    }

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: { message: response.statusText },
        }));
        throw new Error(errorData.error?.message || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    }
  }

  /**
   * GET request
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} response data
   */
  get(endpoint, options = {}) {
    return this.request(endpoint, { method: 'GET', ...options });
  }

  /**
   * POST request
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} response data
   */
  post(endpoint, body, options = {}) {
    return this.request(endpoint, { method: 'POST', body, ...options });
  }

  /**
   * Check server health
   * @returns {Promise<Object>} health status
   */
  async checkHealth() {
    return this.get('/health');
  }

  /**
   * Get server configuration
   * @returns {Promise<Object>} configuration
   */
  async getConfig() {
    return this.get('/config');
  }

  /**
   * Update server configuration
   * @param {Object} updates - Configuration updates
   * @returns {Promise<Object>} updated configuration
   */
  async updateConfig(updates) {
    return this.post('/config', updates);
  }
}

export const api = new ApiClient();
export default api;
