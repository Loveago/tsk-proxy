import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import pg from 'pg';
import defaultConfig from '../../config/default.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

export const config = { ...defaultConfig };

// Setup structured logger
export const logger = pino({
  level: config.logLevel || 'info',
  base: {
    service: 'paystack-proxy',
    env: config.env,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    config.env === 'development' && process.env.NODE_ENV !== 'test'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

let sitesCache = {};

export function resolveConfigFilePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(projectRoot, filePath);
}

export function reloadSites() {
  try {
    const fullPath = resolveConfigFilePath(config.sitesConfigPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(content);
      sitesCache = parsed.sites || {};
      logger.info({ sitesCount: Object.keys(sitesCache).length, path: fullPath }, 'Sites configuration loaded successfully');
    } else {
      logger.warn({ path: fullPath }, 'Sites configuration file not found, defaulting to empty sites map');
      sitesCache = {};
    }
  } catch (err) {
    logger.error({ err, path: config.sitesConfigPath }, 'Failed to parse sites configuration file');
  }
  return sitesCache;
}

// Initial load
reloadSites();

export function getSite(siteKey) {
  if (!siteKey || typeof siteKey !== 'string') return null;
  const key = siteKey.toLowerCase().trim();
  return sitesCache[key] || null;
}

export function getAllSites() {
  return { ...sitesCache };
}

export function setSitesForTesting(customSites) {
  sitesCache = { ...customSites };
}

let sitesPgPool = null;

function getSitesPgPool() {
  const dbUrl = config.proxy?.databaseUrl || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) return null;
  if (!sitesPgPool) {
    const isLocal =
      dbUrl.includes('localhost') ||
      dbUrl.includes('127.0.0.1') ||
      dbUrl.includes('host.docker.internal');
    sitesPgPool = new pg.Pool({
      connectionString: dbUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
    });
    sitesPgPool.on('error', (err) => {
      logger.warn({ err: err.message }, 'PostgreSQL child sites pool warning');
    });
  }
  return sitesPgPool;
}

let tableCreated = false;
let lastSyncTime = 0;

export async function syncSitesWithDb(force = false) {
  const pool = getSitesPgPool();
  if (!pool) return sitesCache;
  const now = Date.now();
  if (!force && now - lastSyncTime < 2000) {
    return sitesCache;
  }
  try {
    if (!tableCreated) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS child_sites (
          site_key VARCHAR(100) PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      tableCreated = true;
    }
    const res = await pool.query('SELECT site_key, data FROM child_sites');
    if (res.rows.length > 0) {
      const dbSites = {};
      for (const row of res.rows) {
        dbSites[row.site_key] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      }
      sitesCache = dbSites;
    } else {
      // First run: seed child_sites from initial sites.json
      for (const [key, data] of Object.entries(sitesCache)) {
        await pool.query(
          `INSERT INTO child_sites (site_key, data, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (site_key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [key, JSON.stringify(data)]
        );
      }
    }
    lastSyncTime = Date.now();
  } catch (err) {
    logger.warn({ err: err.message }, 'PostgreSQL child_sites sync warning; falling back to memory/file');
  }
  return sitesCache;
}

// Perform initial background sync if DB is configured
syncSitesWithDb().catch(() => {});

export async function saveSites(newSites) {
  sitesCache = { ...newSites };

  try {
    const fullPath = resolveConfigFilePath(config.sitesConfigPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let parsed = { sites: {} };
    if (fs.existsSync(fullPath)) {
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        parsed = { sites: {} };
      }
    }
    parsed.sites = { ...newSites };
    fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'Filesystem is read-only (Vercel); updated sites in-memory and database');
  }

  const pool = getSitesPgPool();
  if (pool) {
    try {
      await pool.query('DELETE FROM child_sites');
      for (const [key, data] of Object.entries(newSites)) {
        await pool.query(
          `INSERT INTO child_sites (site_key, data, updated_at) VALUES ($1, $2, NOW())`,
          [key, JSON.stringify(data)]
        );
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to persist all child sites to PostgreSQL');
    }
  }

  return sitesCache;
}

export async function addOrUpdateSite(key, siteData) {
  const normalizedKey = String(key).toLowerCase().trim();
  sitesCache[normalizedKey] = siteData;

  try {
    const fullPath = resolveConfigFilePath(config.sitesConfigPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let parsed = { sites: {} };
    if (fs.existsSync(fullPath)) {
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        parsed = { sites: {} };
      }
    }
    if (!parsed.sites) parsed.sites = {};
    parsed.sites[normalizedKey] = siteData;
    fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  } catch (err) {
    logger.warn({ err: err.message, siteKey: normalizedKey }, 'Filesystem is read-only (Vercel); saved site in-memory and database');
  }

  const pool = getSitesPgPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO child_sites (site_key, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (site_key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [normalizedKey, JSON.stringify(siteData)]
      );
    } catch (err) {
      logger.warn({ err: err.message, siteKey: normalizedKey }, 'Failed to persist child site to PostgreSQL');
    }
  }

  lastSyncTime = Date.now();
  return sitesCache;
}

export async function removeSite(key) {
  const normalizedKey = String(key).toLowerCase().trim();
  if (sitesCache[normalizedKey]) {
    delete sitesCache[normalizedKey];
  }

  try {
    const fullPath = resolveConfigFilePath(config.sitesConfigPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let parsed = { sites: {} };
    if (fs.existsSync(fullPath)) {
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        parsed = { sites: {} };
      }
    }
    if (parsed.sites && parsed.sites[normalizedKey]) {
      delete parsed.sites[normalizedKey];
      fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    }
  } catch (err) {
    logger.warn({ err: err.message, siteKey: normalizedKey }, 'Filesystem is read-only (Vercel); removed site from memory and database');
  }

  const pool = getSitesPgPool();
  if (pool) {
    try {
      await pool.query('DELETE FROM child_sites WHERE site_key = $1', [normalizedKey]);
    } catch (err) {
      logger.warn({ err: err.message, siteKey: normalizedKey }, 'Failed to delete child site from PostgreSQL');
    }
  }

  lastSyncTime = Date.now();
  return sitesCache;
}

const configUpdateListeners = [];

export function onConfigUpdated(listener) {
  if (typeof listener === 'function') {
    configUpdateListeners.push(listener);
  }
}

/**
 * Updates application configuration in memory and persists to .env file.
 * Immediately applies changes without requiring a server restart.
 *
 * @param {object} updates - Key-value map of configuration updates (can be ENV_KEYS or camelCase or nested)
 * @returns {object} Updated config object
 */
export async function updateConfigAndEnv(updates = {}) {
  const envPath = path.resolve(projectRoot, '.env');
  let envLines = [];
  if (fs.existsSync(envPath)) {
    envLines = fs.readFileSync(envPath, 'utf8').split('\n');
  }

  const flatEnvUpdates = {};

  // Normalize inputs into flat ENV keys
  function processField(envKey, val) {
    if (val !== undefined && val !== null) {
      if (Array.isArray(val)) {
        flatEnvUpdates[envKey] = val.join(',');
      } else {
        flatEnvUpdates[envKey] = String(val).trim();
      }
    }
  }

  // Handle nested or flat payloads
  if (updates.paystack) {
    if (updates.paystack.secretKey !== undefined) processField('PAYSTACK_SECRET_KEY', updates.paystack.secretKey);
    if (updates.paystack.webhookSecret !== undefined) processField('PAYSTACK_WEBHOOK_SECRET', updates.paystack.webhookSecret);
    if (updates.paystack.enableIpWhitelist !== undefined) processField('ENABLE_IP_WHITELIST', String(updates.paystack.enableIpWhitelist));
    if (updates.paystack.ipWhitelist !== undefined) processField('PAYSTACK_IP_WHITELIST', updates.paystack.ipWhitelist);
  }
  if (updates.proxy) {
    if (updates.proxy.sharedSecret !== undefined) processField('PROXY_SHARED_SECRET', updates.proxy.sharedSecret);
    if (updates.proxy.timeoutMs !== undefined) processField('FORWARD_TIMEOUT_MS', updates.proxy.timeoutMs);
    if (updates.proxy.maxRetries !== undefined) processField('MAX_RETRIES', updates.proxy.maxRetries);
    if (updates.proxy.retryDelays !== undefined) processField('RETRY_DELAYS_MS', updates.proxy.retryDelays);
    if (updates.proxy.queueStore !== undefined) processField('QUEUE_STORAGE_TYPE', updates.proxy.queueStore);
    if (updates.proxy.sqliteDbPath !== undefined) processField('SQLITE_DB_PATH', updates.proxy.sqliteDbPath);
    if (updates.proxy.redisUrl !== undefined) processField('REDIS_URL', updates.proxy.redisUrl);
    if (updates.proxy.databaseUrl !== undefined) processField('DATABASE_URL', updates.proxy.databaseUrl);
    if (updates.proxy.idempotencyTtlSeconds !== undefined) processField('IDEMPOTENCY_TTL_SECONDS', updates.proxy.idempotencyTtlSeconds);
  }
  if (updates.notifications) {
    if (updates.notifications.discordWebhookUrl !== undefined) processField('DISCORD_WEBHOOK_URL', updates.notifications.discordWebhookUrl);
    if (updates.notifications.telegram) {
      if (updates.notifications.telegram.botToken !== undefined) processField('TELEGRAM_BOT_TOKEN', updates.notifications.telegram.botToken);
      if (updates.notifications.telegram.chatId !== undefined) processField('TELEGRAM_CHAT_ID', updates.notifications.telegram.chatId);
    }
  }
  if (updates.dashboard) {
    if (updates.dashboard.authEnabled !== undefined) processField('DASHBOARD_AUTH_ENABLED', String(updates.dashboard.authEnabled));
    if (updates.dashboard.username !== undefined) processField('DASHBOARD_USERNAME', updates.dashboard.username);
    if (updates.dashboard.password !== undefined && updates.dashboard.password !== '') processField('DASHBOARD_PASSWORD', updates.dashboard.password);
    if (updates.dashboard.jwtSecret !== undefined && updates.dashboard.jwtSecret !== '') processField('DASHBOARD_JWT_SECRET', updates.dashboard.jwtSecret);
    if (updates.dashboard.sessionHours !== undefined) processField('DASHBOARD_SESSION_HOURS', updates.dashboard.sessionHours);
  }
  if (updates.server) {
    if (updates.server.port !== undefined) processField('PORT', updates.server.port);
    if (updates.server.env !== undefined) processField('NODE_ENV', updates.server.env);
    if (updates.server.nodeEnv !== undefined) processField('NODE_ENV', updates.server.nodeEnv);
    if (updates.server.logLevel !== undefined) processField('LOG_LEVEL', updates.server.logLevel);
    if (updates.server.sitesConfigPath !== undefined) processField('SITES_CONFIG_PATH', updates.server.sitesConfigPath);
  }

  // Support top-level camelCase mappings
  const camelCaseMap = {
    paystackSecretKey: 'PAYSTACK_SECRET_KEY',
    secretKey: 'PAYSTACK_SECRET_KEY',
    paystackWebhookSecret: 'PAYSTACK_WEBHOOK_SECRET',
    webhookSecret: 'PAYSTACK_WEBHOOK_SECRET',
    enableIpWhitelist: 'ENABLE_IP_WHITELIST',
    paystackIpWhitelist: 'PAYSTACK_IP_WHITELIST',
    ipWhitelist: 'PAYSTACK_IP_WHITELIST',
    proxySharedSecret: 'PROXY_SHARED_SECRET',
    sharedSecret: 'PROXY_SHARED_SECRET',
    forwardTimeoutMs: 'FORWARD_TIMEOUT_MS',
    timeoutMs: 'FORWARD_TIMEOUT_MS',
    maxRetries: 'MAX_RETRIES',
    retryDelaysMs: 'RETRY_DELAYS_MS',
    retryDelays: 'RETRY_DELAYS_MS',
    queueStorageType: 'QUEUE_STORAGE_TYPE',
    queueStore: 'QUEUE_STORAGE_TYPE',
    sqliteDbPath: 'SQLITE_DB_PATH',
    redisUrl: 'REDIS_URL',
    databaseUrl: 'DATABASE_URL',
    postgresUrl: 'POSTGRES_URL',
    idempotencyTtlSeconds: 'IDEMPOTENCY_TTL_SECONDS',
    discordWebhookUrl: 'DISCORD_WEBHOOK_URL',
    telegramBotToken: 'TELEGRAM_BOT_TOKEN',
    telegramChatId: 'TELEGRAM_CHAT_ID',
    sitesConfigPath: 'SITES_CONFIG_PATH',
    port: 'PORT',
    logLevel: 'LOG_LEVEL',
    nodeEnv: 'NODE_ENV',
    env: 'NODE_ENV',
    dashboardAuthEnabled: 'DASHBOARD_AUTH_ENABLED',
    dashboardUsername: 'DASHBOARD_USERNAME',
    dashboardPassword: 'DASHBOARD_PASSWORD',
    dashboardJwtSecret: 'DASHBOARD_JWT_SECRET',
    dashboardSessionHours: 'DASHBOARD_SESSION_HOURS',
  };

  for (const [camelKey, envTarget] of Object.entries(camelCaseMap)) {
    if (updates[camelKey] !== undefined) {
      processField(envTarget, updates[camelKey]);
    }
  }

  // Also support direct ENV keys or top-level keys
  const directEnvKeys = [
    'PORT', 'NODE_ENV', 'LOG_LEVEL',
    'PAYSTACK_SECRET_KEY', 'PAYSTACK_WEBHOOK_SECRET', 'ENABLE_IP_WHITELIST', 'PAYSTACK_IP_WHITELIST',
    'PROXY_SHARED_SECRET', 'FORWARD_TIMEOUT_MS', 'RETRY_DELAYS_MS', 'MAX_RETRIES',
    'QUEUE_STORAGE_TYPE', 'SQLITE_DB_PATH', 'REDIS_URL', 'IDEMPOTENCY_TTL_SECONDS',
    'DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'SITES_CONFIG_PATH',
    'DASHBOARD_AUTH_ENABLED', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD', 'DASHBOARD_JWT_SECRET', 'DASHBOARD_SESSION_HOURS',
  ];

  for (const envKey of directEnvKeys) {
    if (updates[envKey] !== undefined) {
      processField(envKey, updates[envKey]);
    }
  }

  // Apply to in-memory config & process.env
  applyEnvUpdates(flatEnvUpdates);

  // Update .env file lines
  const keysToUpdate = new Set(Object.keys(flatEnvUpdates));
  const newEnvLines = envLines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) {
      return line;
    }
    const eqIdx = line.indexOf('=');
    const lineKey = line.slice(0, eqIdx).trim();
    if (keysToUpdate.has(lineKey)) {
      keysToUpdate.delete(lineKey);
      return `${lineKey}=${flatEnvUpdates[lineKey]}`;
    }
    return line;
  });

  // Append any keys that didn't exist in .env
  for (const remainingKey of keysToUpdate) {
    newEnvLines.push(`${remainingKey}=${flatEnvUpdates[remainingKey]}`);
  }

  try {
    fs.writeFileSync(envPath, newEnvLines.join('\n'), 'utf8');
    logger.info({ updatedKeys: Object.keys(flatEnvUpdates) }, 'Configuration updated and written to .env');
  } catch (err) {
    logger.warn({ err: err.message }, 'Read-only filesystem (Vercel); updated configuration in memory and database');
  }

  // Persist dynamic configuration to PostgreSQL app_config table
  const pool = getSitesPgPool();
  if (pool) {
    try {
      if (!configTableCreated) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS app_config (
            key VARCHAR(100) PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        configTableCreated = true;
      }
      for (const [key, val] of Object.entries(flatEnvUpdates)) {
        await pool.query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, String(val)]
        );
      }
      lastConfigSyncTime = Date.now();
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to persist app_config to PostgreSQL');
    }
  }

  // Notify registered listeners (e.g. queueService to dynamically adapt)
  for (const listener of configUpdateListeners) {
    try {
      listener(config, flatEnvUpdates);
    } catch (err) {
      logger.error({ err: err.message }, 'Error in config update listener');
    }
  }

  return config;
}

export function applyEnvUpdates(flatEnvUpdates) {
  if (!flatEnvUpdates || typeof flatEnvUpdates !== 'object') return;

  for (const [key, val] of Object.entries(flatEnvUpdates)) {
    process.env[key] = val;

    switch (key) {
      case 'PAYSTACK_SECRET_KEY':
        config.paystack.secretKey = val;
        break;
      case 'PAYSTACK_WEBHOOK_SECRET':
        config.paystack.webhookSecret = val;
        break;
      case 'ENABLE_IP_WHITELIST':
        config.paystack.enableIpWhitelist = val === 'true' || val === true;
        break;
      case 'PAYSTACK_IP_WHITELIST':
        config.paystack.ipWhitelist = typeof val === 'string' ? val.split(',').map(s => s.trim()).filter(Boolean) : (Array.isArray(val) ? val : []);
        break;
      case 'PROXY_SHARED_SECRET':
        config.proxy.sharedSecret = val;
        break;
      case 'FORWARD_TIMEOUT_MS':
        config.proxy.timeoutMs = parseInt(val, 10) || 8000;
        break;
      case 'MAX_RETRIES': {
        const parsed = parseInt(val, 10);
        config.proxy.maxRetries = Number.isNaN(parsed) ? 4 : parsed;
        break;
      }
      case 'RETRY_DELAYS_MS':
        config.proxy.retryDelays = typeof val === 'string' ? val.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !Number.isNaN(d)) : (Array.isArray(val) ? val : [15000, 60000, 300000, 900000]);
        break;
      case 'QUEUE_STORAGE_TYPE':
        config.proxy.queueStore = val;
        break;
      case 'SQLITE_DB_PATH':
        config.proxy.sqliteDbPath = val;
        break;
      case 'REDIS_URL':
        config.proxy.redisUrl = val;
        break;
      case 'DATABASE_URL':
      case 'POSTGRES_URL':
        config.proxy.databaseUrl = val;
        break;
      case 'IDEMPOTENCY_TTL_SECONDS':
        config.proxy.idempotencyTtlSeconds = parseInt(val, 10) || 86400;
        break;
      case 'DISCORD_WEBHOOK_URL':
        config.notifications.discordWebhookUrl = val;
        break;
      case 'TELEGRAM_BOT_TOKEN':
        config.notifications.telegram.botToken = val;
        break;
      case 'TELEGRAM_CHAT_ID':
        config.notifications.telegram.chatId = val;
        break;
      case 'LOG_LEVEL':
        config.logLevel = val;
        if (logger) logger.level = val;
        break;
      case 'PORT':
        config.port = parseInt(val, 10) || 3000;
        break;
      case 'NODE_ENV':
        config.env = val;
        break;
      case 'SITES_CONFIG_PATH':
        config.sitesConfigPath = val;
        reloadSites();
        break;
      case 'DASHBOARD_AUTH_ENABLED':
        if (!config.dashboard) config.dashboard = {};
        config.dashboard.authEnabled = val === 'true' || val === true;
        break;
      case 'DASHBOARD_USERNAME':
        if (!config.dashboard) config.dashboard = {};
        config.dashboard.username = val;
        break;
      case 'DASHBOARD_PASSWORD':
        if (!config.dashboard) config.dashboard = {};
        config.dashboard.password = val;
        break;
      case 'DASHBOARD_JWT_SECRET':
        if (!config.dashboard) config.dashboard = {};
        config.dashboard.jwtSecret = val;
        break;
      case 'DASHBOARD_SESSION_HOURS':
        if (!config.dashboard) config.dashboard = {};
        config.dashboard.sessionHours = parseInt(val, 10) || 24;
        break;
    }
  }
}

let configTableCreated = false;
let lastConfigSyncTime = 0;

export async function syncConfigWithDb(force = false) {
  const pool = getSitesPgPool();
  if (!pool) return config;
  const now = Date.now();
  if (!force && now - lastConfigSyncTime < 2000) {
    return config;
  }
  try {
    if (!configTableCreated) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      configTableCreated = true;
    }
    const res = await pool.query('SELECT key, value FROM app_config');
    if (res.rows.length > 0) {
      const dbUpdates = {};
      for (const row of res.rows) {
        dbUpdates[row.key] = row.value;
      }
      applyEnvUpdates(dbUpdates);

      for (const listener of configUpdateListeners) {
        try {
          listener(config, dbUpdates);
        } catch (err) {
          logger.error({ err: err.message }, 'Error in config update listener during DB sync');
        }
      }
    }
    lastConfigSyncTime = Date.now();
  } catch (err) {
    logger.warn({ err: err.message }, 'PostgreSQL app_config sync warning; using memory/env defaults');
  }
  return config;
}

// Initial background sync
syncConfigWithDb().catch(() => {});

export default {
  config,
  logger,
  getSite,
  getAllSites,
  reloadSites,
  saveSites,
  addOrUpdateSite,
  removeSite,
  syncSitesWithDb,
  syncConfigWithDb,
  applyEnvUpdates,
  updateConfigAndEnv,
  onConfigUpdated,
  setSitesForTesting,
};

