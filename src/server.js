import 'dotenv/config';
import { app } from './app.js';
import { config, logger } from './config/index.js';
import { queueService } from './services/queue.js';

const PORT = config.port || 3000;

// Start background retry worker
queueService.start();

const server = app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      env: config.env,
      storageType: config.proxy.queueStore,
      ipWhitelistEnabled: config.paystack.enableIpWhitelist,
    },
    `Paystack Multi-Site Proxy Server listening on port ${PORT}`
  );
});

// Graceful shutdown handling
let isShuttingDown = false;

async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received, starting graceful termination...');

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Drain and close queue service
      await queueService.close();
      logger.info('Queue worker and storage connections closed');
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'Error during graceful shutdown');
      process.exit(1);
    }
  });

  // Force close after 10 seconds if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection detected');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught Exception detected, shutting down');
  process.exit(1);
});
