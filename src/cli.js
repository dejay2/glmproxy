#!/usr/bin/env node

/**
 * GLM Enhanced Proxy CLI
 *
 * Commands:
 *   ccglm           - Start proxy and launch Claude Code
 *   ccglm ui        - Open the web dashboard
 *   ccglm start     - Start proxy server in foreground
 *   ccglm activate  - Print shell exports for manual activation
 *   ccglm status    - Check if proxy is running
 *   ccglm stop      - Stop background proxy server
 */

import { spawn, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DEFAULT_PORT = process.env.PORT || 4567;
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_MODEL = process.env.GLM_MODEL || 'glm4.6';
const PID_FILE = join(__dirname, '..', '.glmproxy.pid');

// Claude Code environment overrides
const CLAUDE_ENV = {
  ANTHROPIC_AUTH_TOKEN: 'glmproxy',  // Dummy token, proxy uses ZAI_API_KEY
  ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_MODEL,
};

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message, color = '') {
  console.log(`${color}${message}${colors.reset}`);
}

function logHeader() {
  log('\n⚡ GLM Enhanced Proxy', colors.bright + colors.cyan);
  log('─'.repeat(40), colors.dim);
}

/**
 * Check if the proxy server is running
 */
async function isServerRunning(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const req = createServer().listen(port, host);
    req.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    req.on('listening', () => {
      req.close();
      resolve(false);
    });
  });
}

/**
 * Wait for server to be ready
 */
async function waitForServer(port = DEFAULT_PORT, host = DEFAULT_HOST, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const response = await fetch(`http://${host}:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Start the proxy server in background
 */
async function startServerBackground() {
  const running = await isServerRunning();
  if (running) {
    log('✓ Proxy already running', colors.green);
    return true;
  }

  log('Starting proxy server...', colors.dim);

  const serverPath = join(__dirname, 'index.js');
  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });

  // Save PID for later cleanup
  fs.writeFileSync(PID_FILE, child.pid.toString());
  child.unref();

  // Wait for server to be ready
  const ready = await waitForServer();
  if (ready) {
    log(`✓ Proxy started on http://${DEFAULT_HOST}:${DEFAULT_PORT}`, colors.green);
    return true;
  } else {
    log('✗ Failed to start proxy server', colors.red);
    return false;
  }
}

/**
 * Start server in foreground (blocking)
 */
async function startServerForeground() {
  logHeader();
  log(`Starting server on http://${DEFAULT_HOST}:${DEFAULT_PORT}\n`, colors.dim);

  // Import and run the server directly
  await import('./index.js');
}

/**
 * Stop background server
 */
function stopServer() {
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(PID_FILE);
      log('✓ Proxy server stopped', colors.green);
      return true;
    } catch (err) {
      if (err.code === 'ESRCH') {
        // Process already dead
        fs.unlinkSync(PID_FILE);
        log('✓ Proxy was not running', colors.yellow);
        return true;
      }
      log(`✗ Failed to stop server: ${err.message}`, colors.red);
      return false;
    }
  } else {
    log('✓ Proxy was not running', colors.yellow);
    return true;
  }
}

/**
 * Open URL in default browser
 */
function openBrowser(url) {
  const platform = process.platform;
  let cmd;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    // Linux
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      log(`Open this URL in your browser: ${url}`, colors.yellow);
    }
  });
}

/**
 * Launch Claude Code with proxy environment
 */
async function launchClaudeCode(args = [], skipPermissions = false) {
  logHeader();

  // Start proxy if not running
  const started = await startServerBackground();
  if (!started) {
    process.exit(1);
  }

  const proxyUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

  log(`\nLaunching Claude Code with GLM proxy...`, colors.dim);
  log(`  ANTHROPIC_BASE_URL=${proxyUrl}`, colors.dim);
  log(`  Model: ${DEFAULT_MODEL}`, colors.dim);
  if (skipPermissions) {
    log(`  --dangerously-skip-permissions enabled`, colors.yellow);
  }
  log('');

  // Build args - add --dangerously-skip-permissions if requested
  const claudeArgs = [...args];
  if (skipPermissions && !claudeArgs.includes('--dangerously-skip-permissions')) {
    claudeArgs.unshift('--dangerously-skip-permissions');
  }

  // Spawn claude with proxy environment
  const child = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyUrl,
      ...CLAUDE_ENV,
    },
  });

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      log('\n✗ Claude Code CLI not found', colors.red);
      log('Install it with: npm install -g @anthropic-ai/claude-code', colors.yellow);
      process.exit(1);
    }
    log(`\n✗ Failed to launch Claude Code: ${err.message}`, colors.red);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

/**
 * Print shell activation exports
 */
function printActivation() {
  const proxyUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  console.log(`export ANTHROPIC_BASE_URL="${proxyUrl}"`);
  console.log(`export ANTHROPIC_AUTH_TOKEN="glmproxy"`);
  console.log(`export ANTHROPIC_DEFAULT_OPUS_MODEL="${DEFAULT_MODEL}"`);
  console.log(`export ANTHROPIC_DEFAULT_SONNET_MODEL="${DEFAULT_MODEL}"`);
  console.log(`export ANTHROPIC_DEFAULT_HAIKU_MODEL="${DEFAULT_MODEL}"`);
}

/**
 * Show server status
 */
async function showStatus() {
  logHeader();

  const running = await isServerRunning();
  if (running) {
    log(`✓ Proxy is running on http://${DEFAULT_HOST}:${DEFAULT_PORT}`, colors.green);

    // Try to get health info
    try {
      const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`);
      const health = await response.json();
      log(`  Version: ${health.version}`, colors.dim);
      log(`  Uptime: ${Math.round(health.uptime / 1000)}s`, colors.dim);
      if (health.config) {
        log(`  Streaming: ${health.config.streamingEnabled ? 'on' : 'off'}`, colors.dim);
      }
    } catch {
      // Ignore health check errors
    }
  } else {
    log('✗ Proxy is not running', colors.yellow);
    log(`  Start it with: ccglm start`, colors.dim);
  }
}

/**
 * Open the web UI
 */
async function openUI() {
  logHeader();

  // Start proxy if not running
  const started = await startServerBackground();
  if (!started) {
    process.exit(1);
  }

  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  log(`\nOpening dashboard: ${url}`, colors.dim);
  openBrowser(url);
}

/**
 * Show help
 */
function showHelp() {
  logHeader();
  log('\nUsage: ccglm [command] [options]\n');

  log('Commands:', colors.bright);
  log('  (none)      Start proxy and launch Claude Code');
  log('  yolo        Same, but with --dangerously-skip-permissions');
  log('  ui          Open the web dashboard');
  log('  start       Start proxy server (foreground)');
  log('  stop        Stop background proxy server');
  log('  status      Check if proxy is running');
  log('  activate    Print shell exports for manual use');
  log('  help        Show this help message\n');

  log('Examples:', colors.bright);
  log('  ccglm                  # Start proxy + Claude Code');
  log('  ccglm yolo             # Same, but skip permission prompts');
  log('  ccglm ui               # Open settings dashboard');
  log('  ccglm start            # Run proxy in foreground');
  log('  eval $(ccglm activate) # Set env vars in shell\n');

  log('Environment:', colors.bright);
  log(`  PORT=${DEFAULT_PORT}              Server port`);
  log(`  HOST=${DEFAULT_HOST}        Server host`);
  log(`  GLM_MODEL=${DEFAULT_MODEL}        Model name for Claude Code`);
  log('  ZAI_API_KEY            Z.ai API key (required)\n');
}

// Main entry point
async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case 'yolo':
      // Launch with --dangerously-skip-permissions
      await launchClaudeCode(args, true);
      break;

    case 'ui':
      await openUI();
      break;

    case 'start':
      await startServerForeground();
      break;

    case 'stop':
      stopServer();
      break;

    case 'status':
      await showStatus();
      break;

    case 'activate':
    case 'env':
      printActivation();
      break;

    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    case undefined:
      // Default: start proxy and launch Claude Code
      await launchClaudeCode(args, false);
      break;

    default:
      // Pass unknown commands to Claude Code
      await launchClaudeCode([command, ...args], false);
      break;
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
