/**
 * Theme management - dark/light mode switching
 */

import { $ } from './utils.js';

const THEME_KEY = 'glm-proxy-theme';
const THEMES = {
  LIGHT: 'light',
  DARK: 'dark',
};

class ThemeManager {
  constructor() {
    this.currentTheme = this.loadTheme();
    this.appElement = null;
    this.iconElement = null;
  }

  /**
   * Initialize theme manager
   */
  init() {
    this.appElement = $('.app');
    this.iconElement = $('[data-theme-icon]');

    // Apply saved theme
    this.applyTheme(this.currentTheme);

    // Set up toggle button
    const toggleBtn = $('[data-action="toggle-theme"]');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggle());
    }

    // Listen for system theme changes
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!this.isThemeSaved()) {
          this.applyTheme(e.matches ? THEMES.DARK : THEMES.LIGHT);
        }
      });
    }
  }

  /**
   * Load theme from localStorage or system preference
   * @returns {string} theme name
   */
  loadTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) {
      return saved;
    }

    // Check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return THEMES.DARK;
    }

    return THEMES.LIGHT;
  }

  /**
   * Save theme to localStorage
   * @param {string} theme - Theme name
   */
  saveTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
  }

  /**
   * Check if theme is explicitly saved
   * @returns {boolean} true if theme is saved
   */
  isThemeSaved() {
    return localStorage.getItem(THEME_KEY) !== null;
  }

  /**
   * Apply theme to document
   * @param {string} theme - Theme name
   */
  applyTheme(theme) {
    this.currentTheme = theme;

    if (this.appElement) {
      this.appElement.dataset.theme = theme;
    }

    if (this.iconElement) {
      this.iconElement.textContent = theme === THEMES.DARK ? '☀️' : '🌙';
    }

    this.saveTheme(theme);
  }

  /**
   * Toggle between light and dark themes
   */
  toggle() {
    const newTheme = this.currentTheme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
    this.applyTheme(newTheme);
  }

  /**
   * Get current theme
   * @returns {string} current theme name
   */
  getTheme() {
    return this.currentTheme;
  }

  /**
   * Set specific theme
   * @param {string} theme - Theme name
   */
  setTheme(theme) {
    if (Object.values(THEMES).includes(theme)) {
      this.applyTheme(theme);
    }
  }
}

export const themeManager = new ThemeManager();
export default themeManager;
