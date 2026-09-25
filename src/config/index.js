import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
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

export function saveSites(newSites) {
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
  return reloadSites();
}

export function addOrUpdateSite(key, siteData) {
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
  const normalizedKey = String(key).toLowerCase().trim();
  parsed.sites[normalizedKey] = siteData;
  fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return reloadSites();
}

export function removeSite(key) {
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
  const normalizedKey = String(key).toLowerCase().trim();
  if (parsed.sites && parsed.sites[normalizedKey]) {
    delete parsed.sites[normalizedKey];
    fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  }
  return reloadSites();
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
export function updateConfigAndEnv(updates = {}) {
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
        config.paystack.ipWhitelist = val.split(',').map(s => s.trim()).filter(Boolean);
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
        config.proxy.retryDelays = val.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !Number.isNaN(d));
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
    logger.error({ err: err.message }, 'Failed to write updated configuration to .env');
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

export default {
  config,
  logger,
  getSite,
  getAllSites,
  reloadSites,
  saveSites,
  addOrUpdateSite,
  removeSite,
  updateConfigAndEnv,
  onConfigUpdated,
  setSitesForTesting,
};

