/**
 * GLM Enhanced Proxy - Entry Point
 *
 * HTTP proxy server that transforms Anthropic Messages API requests
 * to Z.ai GLM-4.7 API format.
 */

import 'dotenv/config';
import { startServer } from './server.js';
import logger from './utils/logger.js';
import config from './config.js';

async function main() {
  try {
    logger.info('server', `Starting GLM Enhanced Proxy v${config.version}...`);
    await startServer();
  } catch (error) {
    logger.errorWithStack('server', 'Failed to start server', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.errorWithStack('process', 'Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.errorWithStack('process', 'Unhandled rejection', error);
  process.exit(1);
});

main();
