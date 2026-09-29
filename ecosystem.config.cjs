/**
 * PM2 Process Manager Configuration for Paystack Multi-Site Proxy
 * Usage: pm2 start ecosystem.config.cjs --env production
 */

try {
  require('dotenv').config();
} catch {}

module.exports = {
  apps: [
    {
      name: 'paystack-proxy',
      script: 'src/server.js',
      // When using PostgreSQL or Redis queue storage, cluster mode with multiple instances is supported.
      // When using in-memory or SQLite storage, use 1 instance to avoid queue state divergence.
      instances: process.env.QUEUE_STORAGE_TYPE === 'postgres' || process.env.QUEUE_STORAGE_TYPE === 'redis' ? 'max' : 1,
      exec_mode: process.env.QUEUE_STORAGE_TYPE === 'postgres' || process.env.QUEUE_STORAGE_TYPE === 'redis' ? 'cluster' : 'fork',
      watch: false,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 150,
      listen_timeout: 10000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
