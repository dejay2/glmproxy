/**
 * MCP Manager
 *
 * Handles the MCP management UI - listing, adding, editing, and removing custom MCPs.
 */

import { $, $$, createElement } from './utils.js';
import api from './api.js';

// Local state
let mcps = [];
let editingMcp = null;

/**
 * Initialize the MCP manager
 */
export function init() {
  // Load MCPs on init
  loadMcps();

  // Set up event listeners
  setupEventListeners();
}

/**
 * Load MCPs from the server
 */
async function loadMcps() {
  const listContainer = $('[data-mcp-list]');
  if (!listContainer) return;

  try {
    const response = await api.get('/v1/mcp');
    mcps = response.mcps || [];
    renderMcpList();
  } catch (error) {
    console.error('Failed to load MCPs:', error);
    listContainer.innerHTML = '<p class="mcp-error">Failed to load MCPs</p>';
  }
}

/**
 * Render the MCP list
 */
function renderMcpList() {
  const listContainer = $('[data-mcp-list]');
  if (!listContainer) return;

  if (mcps.length === 0) {
    listContainer.innerHTML = '<p class="mcp-empty">No MCPs configured</p>';
    return;
  }

  listContainer.innerHTML = '';
  for (const mcp of mcps) {
    listContainer.appendChild(createMcpCard(mcp));
  }
}

/**
 * Create an MCP card element
 * @param {Object} mcp - MCP configuration
 * @returns {HTMLElement} Card element
 */
function createMcpCard(mcp) {
  const card = createElement('div', {
    className: 'mcp-card',
    dataset: { mcpId: mcp.id },
  });

  // Status indicator
  const statusClass = mcp.initialized ? 'mcp-status--ready' : 'mcp-status--idle';
  const statusText = mcp.initialized ? `Ready (${mcp.toolCount} tools)` : 'Not initialized';

  card.innerHTML = `
    <div class="mcp-card__header">
      <div class="mcp-card__title">
        <h4>${escapeHtml(mcp.name)}</h4>
        <span class="mcp-status ${statusClass}">${statusText}</span>
      </div>
      <div class="mcp-card__actions">
        <label class="toggle toggle--sm">
          <input type="checkbox" class="toggle__input" data-mcp-toggle="${mcp.id}" ${mcp.enabled ? 'checked' : ''}>
          <span class="toggle__slider"></span>
        </label>
        <button class="btn btn--icon btn--sm btn--secondary" data-mcp-test="${mcp.id}" title="Test connection">
          <span>Test</span>
        </button>
        <button class="btn btn--icon btn--sm" data-mcp-edit="${mcp.id}" title="Edit">
          <span>Edit</span>
        </button>
        <button class="btn btn--icon btn--sm btn--danger" data-mcp-delete="${mcp.id}" title="Delete">
          <span>Del</span>
        </button>
      </div>
    </div>
    <div class="mcp-card__body">
      <div class="mcp-card__info">
        <span class="mcp-card__label">Command:</span>
        <code>${escapeHtml(mcp.command)} ${escapeHtml(mcp.args.join(' '))}</code>
      </div>
      <div class="mcp-card__info">
        <span class="mcp-card__label">Triggers:</span>
        <span>${mcp.triggers.map(t => `<span class="mcp-trigger">${escapeHtml(t)}</span>`).join(' ')}</span>
      </div>
      <div class="mcp-card__info">
        <span class="mcp-card__label">API Key:</span>
        <span>${mcp.apiKeyConfigured ? '✓ Configured' : 'Not required'}</span>
      </div>
    </div>
  `;

  return card;
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  // Add MCP button
  const addBtn = $('[data-action="add-mcp"]');
  if (addBtn) {
    addBtn.addEventListener('click', () => openModal());
  }

  // MCP list delegation
  const listContainer = $('[data-mcp-list]');
  if (listContainer) {
    listContainer.addEventListener('click', handleListClick);
    listContainer.addEventListener('change', handleListChange);
  }

  // Modal events
  const modal = $('[data-mcp-modal]');
  if (modal) {
    // Close button
    const closeBtn = $('[data-action="close-modal"]', modal);
    if (closeBtn) {
      closeBtn.addEventListener('click', closeModal);
    }

    // Cancel button
    const cancelBtn = $('[data-action="cancel-mcp"]', modal);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeModal);
    }

    // Save button
    const saveBtn = $('[data-action="save-mcp"]', modal);
    if (saveBtn) {
      saveBtn.addEventListener('click', saveMcp);
    }

    // Click outside to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
  }
}

/**
 * Handle clicks in the MCP list
 * @param {Event} e - Click event
 */
async function handleListClick(e) {
  const testBtn = e.target.closest('[data-mcp-test]');
  if (testBtn) {
    const mcpId = testBtn.dataset.mcpTest;
    await testMcp(mcpId);
    return;
  }

  const editBtn = e.target.closest('[data-mcp-edit]');
  if (editBtn) {
    const mcpId = editBtn.dataset.mcpEdit;
    const mcp = mcps.find(m => m.id === mcpId);
    if (mcp) {
      openModal(mcp);
    }
    return;
  }

  const deleteBtn = e.target.closest('[data-mcp-delete]');
  if (deleteBtn) {
    const mcpId = deleteBtn.dataset.mcpDelete;
    if (confirm(`Delete MCP "${mcpId}"?`)) {
      await deleteMcp(mcpId);
    }
    return;
  }
}

/**
 * Handle change events in the MCP list
 * @param {Event} e - Change event
 */
async function handleListChange(e) {
  const toggle = e.target.closest('[data-mcp-toggle]');
  if (toggle) {
    const mcpId = toggle.dataset.mcpToggle;
    const enabled = toggle.checked;
    await toggleMcp(mcpId, enabled);
  }
}

/**
 * Open the MCP modal for adding/editing
 * @param {Object|null} mcp - MCP to edit, or null for new
 */
function openModal(mcp = null) {
  const modal = $('[data-mcp-modal]');
  if (!modal) return;

  editingMcp = mcp;

  // Update modal title
  const title = $('[data-modal-title]', modal);
  if (title) {
    title.textContent = mcp ? 'Edit MCP Server' : 'Add MCP Server';
  }

  // Fill form fields
  const form = $('[data-mcp-form]', modal);
  if (form) {
    const idInput = $('[name="mcp-id"]', form);
    const nameInput = $('[name="mcp-name"]', form);
    const commandInput = $('[name="mcp-command"]', form);
    const argsInput = $('[name="mcp-args"]', form);
    const triggersInput = $('[name="mcp-triggers"]', form);
    const apiKeyInput = $('[name="mcp-api-key"]', form);
    const apiKeyHint = $('[data-api-key-hint]', form);
    const apiKeyAsArgInput = $('[name="mcp-api-key-as-arg"]', form);

    if (mcp) {
      if (idInput) {
        idInput.value = mcp.id;
        idInput.disabled = true;
      }
      if (nameInput) nameInput.value = mcp.name;
      if (commandInput) commandInput.value = mcp.command;
      if (argsInput) argsInput.value = mcp.args.join(' ');
      if (triggersInput) triggersInput.value = mcp.triggers.join('\n');
      if (apiKeyInput) {
        apiKeyInput.value = ''; // Don't show existing key
        apiKeyInput.placeholder = mcp.apiKeyConfigured ? '(configured - leave blank to keep)' : 'Enter API key';
      }
      if (apiKeyHint) {
        apiKeyHint.textContent = mcp.apiKeyConfigured
          ? 'API key is configured. Leave blank to keep existing, or enter new value to update.'
          : 'Leave blank if not required. Key is saved securely to .env file.';
      }
      if (apiKeyAsArgInput) apiKeyAsArgInput.checked = mcp.apiKeyAsArg || false;
    } else {
      if (idInput) {
        idInput.value = '';
        idInput.disabled = false;
      }
      if (nameInput) nameInput.value = '';
      if (commandInput) commandInput.value = 'npx';
      if (argsInput) argsInput.value = '';
      if (triggersInput) triggersInput.value = '';
      if (apiKeyInput) {
        apiKeyInput.value = '';
        apiKeyInput.placeholder = 'Enter API key';
      }
      if (apiKeyHint) {
        apiKeyHint.textContent = 'Leave blank if not required. Key is saved securely to .env file.';
      }
      if (apiKeyAsArgInput) apiKeyAsArgInput.checked = false;
    }
  }

  modal.classList.add('modal--open');
}

/**
 * Close the MCP modal
 */
function closeModal() {
  const modal = $('[data-mcp-modal]');
  if (modal) {
    modal.classList.remove('modal--open');
    editingMcp = null;
  }
}

/**
 * Save MCP from modal form
 */
async function saveMcp() {
  const form = $('[data-mcp-form]');
  if (!form) return;

  const idInput = $('[name="mcp-id"]', form);
  const nameInput = $('[name="mcp-name"]', form);
  const commandInput = $('[name="mcp-command"]', form);
  const argsInput = $('[name="mcp-args"]', form);
  const triggersInput = $('[name="mcp-triggers"]', form);
  const apiKeyInput = $('[name="mcp-api-key"]', form);
  const apiKeyAsArgInput = $('[name="mcp-api-key-as-arg"]', form);

  const mcpData = {
    id: idInput?.value.trim(),
    name: nameInput?.value.trim(),
    command: commandInput?.value.trim(),
    args: argsInput?.value.trim().split(/\s+/).filter(a => a),
    triggers: triggersInput?.value.trim().split('\n').map(t => t.trim()).filter(t => t),
    apiKeyAsArg: apiKeyAsArgInput?.checked || false,
  };

  // Only include API key value if provided (backend will auto-generate env var name)
  const apiKeyValue = apiKeyInput?.value.trim();
  if (apiKeyValue) {
    mcpData.apiKeyValue = apiKeyValue;
  }

  // Validate
  if (!mcpData.id) {
    showToast('error', 'MCP ID is required');
    return;
  }
  if (!mcpData.name) {
    showToast('error', 'MCP name is required');
    return;
  }
  if (!mcpData.command) {
    showToast('error', 'Command is required');
    return;
  }

  try {
    if (editingMcp) {
      // Update existing
      await api.request(`/v1/mcp/${encodeURIComponent(mcpData.id)}`, {
        method: 'PATCH',
        body: mcpData,
      });
      showToast('success', 'MCP updated');
    } else {
      // Create new
      await api.post('/v1/mcp', mcpData);
      showToast('success', 'MCP added');
    }

    closeModal();
    await loadMcps();
  } catch (error) {
    showToast('error', `Failed to save MCP: ${error.message}`);
  }
}

/**
 * Delete an MCP
 * @param {string} mcpId - MCP ID
 */
async function deleteMcp(mcpId) {
  try {
    await api.request(`/v1/mcp/${encodeURIComponent(mcpId)}`, {
      method: 'DELETE',
    });
    showToast('success', 'MCP deleted');
    await loadMcps();
  } catch (error) {
    showToast('error', `Failed to delete MCP: ${error.message}`);
  }
}

/**
 * Toggle MCP enabled/disabled
 * @param {string} mcpId - MCP ID
 * @param {boolean} enabled - Whether to enable
 */
async function toggleMcp(mcpId, enabled) {
  try {
    const endpoint = enabled ? 'enable' : 'disable';
    await api.post(`/v1/mcp/${encodeURIComponent(mcpId)}/${endpoint}`, {});
    showToast('success', `MCP ${enabled ? 'enabled' : 'disabled'}`);
    await loadMcps();
  } catch (error) {
    showToast('error', `Failed to toggle MCP: ${error.message}`);
    // Reload to reset toggle state
    await loadMcps();
  }
}

/**
 * Test MCP connection
 * @param {string} mcpId - MCP ID
 */
async function testMcp(mcpId) {
  showToast('info', 'Testing MCP connection...');
  try {
    const response = await api.get(`/v1/mcp/${encodeURIComponent(mcpId)}/tools`);
    const toolCount = response.tools?.length || 0;
    showToast('success', `Connected with ${toolCount} tool${toolCount !== 1 ? 's' : ''} available`);
    await loadMcps(); // Refresh to show updated status
  } catch (error) {
    showToast('error', `Failed to connect: ${error.message}`);
  }
}

/**
 * Show a toast notification
 * @param {string} type - Toast type (success, error, info)
 * @param {string} message - Toast message
 */
function showToast(type, message) {
  const event = new CustomEvent('toast', {
    detail: { type, message },
  });
  window.dispatchEvent(event);
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export default {
  init,
};
