/**
 * Main application entry point
 * Orchestrates all modules and handles global events
 */

import { $, $$ } from './utils.js';
import api from './api.js';
import themeManager from './theme.js';
import settings from './settings.js';
import mcpManager from './mcp-manager.js';

class App {
  constructor() {
    this.currentTab = 'settings';
    this.connectionStatus = 'disconnected';
  }

  /**
   * Initialize application
   */
  async init() {
    // Initialize modules
    themeManager.init();
    settings.init();
    mcpManager.init();

    // Set up tab navigation
    this.initTabs();

    // Set up toast notifications
    this.initToasts();

    // Check server connection
    await this.checkConnection();

    // Poll connection status
    setInterval(() => this.checkConnection(), 10000);

    // Load version info
    this.loadVersion();
  }

  /**
   * Initialize tab navigation
   */
  initTabs() {
    const tabButtons = $$('[data-tab]');
    const panels = $$('[data-panel]');

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tabName = button.dataset.tab;
        this.switchTab(tabName);
      });
    });
  }

  /**
   * Switch to a different tab
   * @param {string} tabName - Tab name to switch to
   */
  switchTab(tabName) {
    this.currentTab = tabName;

    // Update tab buttons
    const tabButtons = $$('[data-tab]');
    tabButtons.forEach((button) => {
      button.classList.toggle('nav__item--active', button.dataset.tab === tabName);
    });

    // Update panels
    const panels = $$('[data-panel]');
    panels.forEach((panel) => {
      panel.classList.toggle('panel--active', panel.dataset.panel === tabName);
    });
  }

  /**
   * Initialize toast notification system
   */
  initToasts() {
    window.addEventListener('toast', (event) => {
      const { type, message } = event.detail;
      this.showToast(type, message);
    });
  }

  /**
   * Show toast notification
   * @param {string} type - Toast type (success, error, info)
   * @param {string} message - Toast message
   */
  showToast(type, message) {
    const container = $('[data-toast-container]');
    if (!container) return;

    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `
      <span class="toast__icon">${icons[type] || 'ℹ'}</span>
      <span class="toast__message">${this.escapeHtml(message)}</span>
      <button class="toast__close" aria-label="Close">×</button>
    `;

    // Close button
    toast.querySelector('.toast__close').addEventListener('click', () => {
      this.removeToast(toast);
    });

    container.appendChild(toast);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      this.removeToast(toast);
    }, 5000);
  }

  /**
   * Remove toast notification
   * @param {Element} toast - Toast element
   */
  removeToast(toast) {
    toast.style.animation = 'toastSlideIn 200ms ease reverse';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 200);
  }

  /**
   * Check server connection status
   */
  async checkConnection() {
    const statusIndicator = $('[data-status-indicator]');
    const statusText = $('[data-status-text]');

    if (!statusIndicator || !statusText) return;

    try {
      // Update to connecting state
      this.updateConnectionStatus('connecting');

      const health = await api.checkHealth();

      if (health.status === 'ok') {
        this.updateConnectionStatus('connected');
      } else {
        this.updateConnectionStatus('degraded', health.validation?.errors?.join(', '));
      }
    } catch (error) {
      console.error('Connection check failed:', error);
      this.updateConnectionStatus('disconnected', error.message);
    }
  }

  /**
   * Update connection status display
   * @param {string} status - Connection status
   * @param {string} message - Optional status message
   */
  updateConnectionStatus(status, message = '') {
    this.connectionStatus = status;

    const statusIndicator = $('[data-status-indicator]');
    const statusText = $('[data-status-text]');

    if (!statusIndicator || !statusText) return;

    // Remove all status classes
    statusIndicator.classList.remove(
      'status__indicator--connected',
      'status__indicator--connecting',
      'status__indicator--disconnected'
    );

    // Add current status class
    statusIndicator.classList.add(`status__indicator--${status}`);

    // Update text
    const statusMessages = {
      connected: 'Connected',
      connecting: 'Connecting...',
      disconnected: 'Disconnected',
      degraded: 'Degraded',
    };

    statusText.textContent = message || statusMessages[status] || 'Unknown';
  }

  /**
   * Load version information
   */
  async loadVersion() {
    try {
      const config = await api.getConfig();
      const versionEl = $('[data-version]');
      if (versionEl && config.version) {
        versionEl.textContent = `v${config.version}`;
      }
    } catch (error) {
      console.error('Failed to load version:', error);
    }
  }

  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
  });
} else {
  const app = new App();
  app.init();
}
