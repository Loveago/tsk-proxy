import 'dotenv/config';

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY || '',
    enableIpWhitelist: process.env.ENABLE_IP_WHITELIST === 'true',
    ipWhitelist: (process.env.PAYSTACK_IP_WHITELIST || '52.31.139.228,52.31139.228,52.214.14.220,54.76.137.41')
      .split(',')
      .map(ip => ip.trim())
      .filter(Boolean),
  },

  proxy: {
    sharedSecret: process.env.PROXY_SHARED_SECRET || 'insecure-default-proxy-secret-key-change-in-production',
    timeoutMs: parseInt(process.env.FORWARD_TIMEOUT_MS || '8000', 10),
    retryDelays: (process.env.RETRY_DELAYS_MS || '15000,60000,300000,900000')
      .split(',')
      .map(d => parseInt(d.trim(), 10))
      .filter(d => !Number.isNaN(d)),
    maxRetries: parseInt(process.env.MAX_RETRIES || '4', 10),
    queueStore: process.env.QUEUE_STORAGE_TYPE || 'memory',
    sqliteDbPath: process.env.SQLITE_DB_PATH || './data/proxy.db',
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
    databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
    idempotencyTtlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10),
    logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
  },

  notifications: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
    },
  },

  dashboard: {
    authEnabled: process.env.DASHBOARD_AUTH_ENABLED !== 'false',
    username: process.env.DASHBOARD_USERNAME || 'admin',
    password: process.env.DASHBOARD_PASSWORD || 'paystack-proxy-admin-2026',
    jwtSecret: process.env.DASHBOARD_JWT_SECRET || process.env.PROXY_SHARED_SECRET || 'tsk-proxy-dashboard-jwt-secret-key-min-32-chars',
    sessionHours: parseInt(process.env.DASHBOARD_SESSION_HOURS || '24', 10),
  },

  sitesConfigPath: process.env.SITES_CONFIG_PATH || './config/sites.json',
};
