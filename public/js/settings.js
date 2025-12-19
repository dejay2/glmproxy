/**
 * Settings panel management
 *
 * API keys are synced to the server which saves them to .env file.
 * Other settings are cached in localStorage and synced to server on save.
 */

import { $, $$ } from './utils.js';
import api from './api.js';

const SETTINGS_KEY = 'glm-proxy-settings';

class SettingsManager {
  constructor() {
    this.settings = this.loadSettings();
    this.apiKeySyncTimer = null;
  }

  /**
   * Load settings from localStorage
   * @returns {Object} settings object
   */
  loadSettings() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved settings:', e);
      }
    }

    return {
      apiKey: '',
      endpointMode: 'anthropic',
      forceReasoning: true,
      webSearch: true,
      webRead: true,
      streaming: false,
      systemPrompt: '',
    };
  }

  /**
   * Save settings to localStorage
   */
  saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  /**
   * Initialize settings panel
   */
  init() {
    // Load API key
    const apiKeyInput = $('[data-api-key]');
    if (apiKeyInput) {
      apiKeyInput.value = this.settings.apiKey;
      apiKeyInput.addEventListener('input', (e) => {
        this.settings.apiKey = e.target.value;
        api.setApiKey(e.target.value);
        this.saveSettings();
        // Auto-sync API key to server so it takes effect immediately for ALL clients
        this.syncApiKeyToServer(e.target.value);
      });
    }

    // API key visibility toggle
    const toggleKeyBtn = $('[data-action="toggle-api-key"]');
    if (toggleKeyBtn) {
      toggleKeyBtn.addEventListener('click', () => {
        const input = $('[data-api-key]');
        const icon = $('[data-eye-icon]');
        if (input.type === 'password') {
          input.type = 'text';
          icon.textContent = '👁️‍🗨️';
        } else {
          input.type = 'password';
          icon.textContent = '👁️';
        }
      });
    }

    // Endpoint mode dropdown
    this.initSelect('endpoint-mode', this.settings.endpointMode);

    // Feature toggles
    this.initToggle('force-reasoning', this.settings.forceReasoning);
    this.initToggle('web-search', this.settings.webSearch);
    this.initToggle('web-read', this.settings.webRead);
    this.initToggle('streaming', this.settings.streaming);

    // Save button
    const saveBtn = $('[data-action="save-settings"]');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.save());
    }

    // Load server info
    this.loadServerInfo();

    // Apply API key if saved locally
    if (this.settings.apiKey) {
      api.setApiKey(this.settings.apiKey);
      // Sync to server on page load in case server was restarted
      // This ensures server has the key even if .env wasn't configured
      this.syncApiKeyToServer(this.settings.apiKey);
    }
  }

  /**
   * Initialize select dropdown
   * @param {string} name - Select name
   * @param {string} value - Initial value
   */
  initSelect(name, value) {
    const select = $(`[data-select="${name}"]`);
    if (select) {
      select.value = value;
      select.addEventListener('change', (e) => {
        const settingKey = name.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        this.settings[settingKey] = e.target.value;
      });
    }
  }

  /**
   * Initialize toggle switch
   * @param {string} name - Toggle name
   * @param {boolean} checked - Initial state
   */
  initToggle(name, checked) {
    const toggle = $(`[data-toggle="${name}"]`);
    if (toggle) {
      toggle.checked = checked;
      toggle.addEventListener('change', (e) => {
        const settingKey = name.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        this.settings[settingKey] = e.target.checked;
      });
    }
  }

  /**
   * Load server information and sync settings from server
   */
  async loadServerInfo() {
    try {
      const config = await api.getConfig();

      // Sync server config to local settings (server is source of truth)
      this.syncFromServer(config);

      // Update server info display
      const serverUrl = $('[data-server-url]');
      if (serverUrl) {
        serverUrl.textContent = `http://${config.host}:${config.port}`;
      }

      const textModel = $('[data-text-model]');
      if (textModel) {
        textModel.textContent = config.models?.text || 'glm-4.6';
      }

      const visionModel = $('[data-vision-model]');
      if (visionModel) {
        visionModel.textContent = config.models?.vision || 'glm-4.6v';
      }

      // Update uptime periodically
      this.updateUptime();
      setInterval(() => this.updateUptime(), 1000);
    } catch (error) {
      console.error('Failed to load server info:', error);
    }
  }

  /**
   * Sync settings from server config
   * @param {Object} serverConfig - Server configuration
   */
  syncFromServer(serverConfig) {
    // Sync endpoint mode
    if (serverConfig.endpoint?.mode !== undefined) {
      this.settings.endpointMode = serverConfig.endpoint.mode;
      const modeSelect = $('[data-select="endpoint-mode"]');
      if (modeSelect) {
        modeSelect.value = this.settings.endpointMode;
      }
    }

    // Sync streaming settings
    if (serverConfig.streaming !== undefined) {
      this.settings.streaming = serverConfig.streaming.enabled ?? this.settings.streaming;

      const streamingToggle = $('[data-toggle="streaming"]');
      if (streamingToggle) {
        streamingToggle.checked = this.settings.streaming;
      }
    }

    // Sync webSearch setting
    if (serverConfig.webSearch !== undefined) {
      this.settings.webSearch = serverConfig.webSearch.enabled ?? this.settings.webSearch;
      const webSearchToggle = $('[data-toggle="web-search"]');
      if (webSearchToggle) {
        webSearchToggle.checked = this.settings.webSearch;
      }
    }

    // Sync forceReasoning setting
    if (serverConfig.reasoning !== undefined) {
      this.settings.forceReasoning = serverConfig.reasoning.forceReasoning ?? this.settings.forceReasoning;
      const forceReasoningToggle = $('[data-toggle="force-reasoning"]');
      if (forceReasoningToggle) {
        forceReasoningToggle.checked = this.settings.forceReasoning;
      }
    }

    // Save synced settings to localStorage
    this.saveSettings();
  }

  /**
   * Update uptime display
   */
  async updateUptime() {
    try {
      const health = await api.checkHealth();
      const uptimeEl = $('[data-uptime]');
      if (uptimeEl && health.uptime !== undefined) {
        const uptime = health.uptime;
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

        uptimeEl.textContent = parts.join(' ');
      }
    } catch (error) {
      // Silently fail - uptime is not critical
    }
  }

  /**
   * Sync API key to server with debounce (server saves to .env)
   * @param {string} apiKey - API key to sync
   */
  syncApiKeyToServer(apiKey) {
    // Clear existing timer
    if (this.apiKeySyncTimer) {
      clearTimeout(this.apiKeySyncTimer);
    }

    // Debounce: wait 500ms after last keypress before syncing
    this.apiKeySyncTimer = setTimeout(async () => {
      try {
        await api.updateConfig({ zaiApiKey: apiKey });
        console.log('API key synced to server');
      } catch (error) {
        console.error('Failed to sync API key to server:', error);
      }
    }, 500);
  }

  /**
   * Save settings and show confirmation
   */
  async save() {
    // Save to localStorage
    this.saveSettings();

    // Also update server config so settings apply to ALL clients (including Claude Code)
    try {
      await api.updateConfig({
        streaming: {
          enabled: this.settings.streaming,
        },
        webSearch: this.settings.webSearch,
        reasoning: {
          forceReasoning: this.settings.forceReasoning,
        },
        zaiApiKey: this.settings.apiKey,
        endpoint: {
          mode: this.settings.endpointMode,
        },
      });

      // Show toast notification
      const event = new CustomEvent('toast', {
        detail: {
          type: 'success',
          message: 'Settings saved to server',
        },
      });
      window.dispatchEvent(event);
    } catch (error) {
      console.error('Failed to update server config:', error);
      // Show error toast
      const event = new CustomEvent('toast', {
        detail: {
          type: 'error',
          message: `Failed to save to server: ${error.message}`,
        },
      });
      window.dispatchEvent(event);
    }
  }

  /**
   * Get current settings
   * @returns {Object} current settings
   */
  getSettings() {
    return { ...this.settings };
  }

  /**
   * Get specific setting
   * @param {string} key - Setting key
   * @returns {any} setting value
   */
  get(key) {
    return this.settings[key];
  }

  /**
   * Set specific setting
   * @param {string} key - Setting key
   * @param {any} value - Setting value
   */
  set(key, value) {
    this.settings[key] = value;
    this.saveSettings();
  }
}

export const settings = new SettingsManager();
export default settings;
