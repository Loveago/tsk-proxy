import crypto from 'node:crypto';
import { Router } from 'express';
import axios from 'axios';
import {
  config,
  getAllSites,
  getSite,
  logger,
  addOrUpdateSite,
  removeSite,
  syncSitesWithDb,
  syncConfigWithDb,
  updateConfigAndEnv,
} from '../config/index.js';
import { queueService, metrics } from '../services/queue.js';
import { dispatchWebhook, resolveSite } from '../services/dispatcher.js';
import { getWebhookEventIdentifier } from './webhook.js';
import { paystackService } from '../services/paystack.js';
import { requireDashboardAuth } from '../middleware/auth.js';
import { authenticateDashboardUser, generateDashboardToken } from '../services/auth.js';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiter for login endpoint to prevent brute-force attacks
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: 'Too many login attempts. Please try again after 15 minutes.',
  },
});

/**
 * POST /api/v1/dashboard/auth/login
 * Public authentication endpoint for dashboard administrator
 */
router.post('/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const authResult = authenticateDashboardUser(username, password);

  if (!authResult.success) {
    logger.warn({ ip: req.ip, username }, 'Failed dashboard administrator login attempt');
    return res.status(401).json({
      status: false,
      message: authResult.message || 'Invalid username or password',
    });
  }

  const token = generateDashboardToken(authResult.user);
  const sessionHours = config.dashboard?.sessionHours || 24;

  logger.info({ username: authResult.user.username, ip: req.ip }, 'Dashboard administrator logged in successfully');
  return res.json({
    status: true,
    message: 'Authentication successful',
    token,
    user: authResult.user,
    expiresIn: sessionHours * 3600,
  });
});

/**
 * POST /api/v1/dashboard/auth/logout
 * Logs out the administrator session
 */
router.post('/auth/logout', (req, res) => {
  return res.json({
    status: true,
    message: 'Logged out successfully',
  });
});

/**
 * GET /api/v1/dashboard/auth/me
 * Verifies the current token and returns authenticated admin details
 */
router.get('/auth/me', requireDashboardAuth, (req, res) => {
  return res.json({
    status: true,
    user: req.user,
  });
});

// Protect all remaining dashboard routes with authentication middleware
router.use(requireDashboardAuth);

/**
 * GET /api/v1/dashboard/debug/sites
 * Debug endpoint: shows in-memory sitesCache AND raw PostgreSQL child_sites rows
 */
router.get('/debug/sites', async (req, res) => {
  const inMemory = getAllSites();

  let dbRows = null;
  let dbError = null;
  let hasDbUrl = Boolean(
    config.proxy?.databaseUrl || process.env.DATABASE_URL || process.env.POSTGRES_URL
  );

  if (hasDbUrl) {
    try {
      await syncSitesWithDb(true); // force refresh
      const refreshed = getAllSites();
      dbRows = Object.keys(refreshed);
      dbError = null;
    } catch (err) {
      dbError = err.message;
    }
  }

  return res.json({
    status: true,
    hasDbUrl,
    inMemorySiteKeys: Object.keys(inMemory),
    inMemorySites: inMemory,
    afterForceSyncSiteKeys: dbRows,
    dbError,
    env: {
      DATABASE_URL_set: Boolean(process.env.DATABASE_URL),
      POSTGRES_URL_set: Boolean(process.env.POSTGRES_URL),
      NODE_ENV: process.env.NODE_ENV,
      QUEUE_STORAGE_TYPE: process.env.QUEUE_STORAGE_TYPE,
    },
  });
});

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hrs > 0 || days > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0 || days > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

/**
 * GET /api/v1/dashboard/stats
 * Real-time operational metrics and health overview
 */
router.get('/stats', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb();
  }
  if (typeof syncConfigWithDb === 'function') {
    await syncConfigWithDb();
  }
  const uptimeSeconds = Math.floor(process.uptime());
  const memory = process.memoryUsage();
  const queueMetrics = queueService.getMetrics();
  const sites = getAllSites();

  res.json({
    status: 'ok',
    uptimeSeconds,
    uptimeHuman: formatUptime(uptimeSeconds),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    env: config.env,
    storageType: config.proxy.queueStore,
    ipWhitelistEnabled: Boolean(config.paystack.enableIpWhitelist),
    secretConfigured: Boolean(config.paystack.secretKey),
    webhookSecretConfigured: Boolean(config.paystack.webhookSecret),
    port: config.port,
    sitesCount: Object.keys(sites).length,
    metrics: {
      ingested: queueMetrics.ingested,
      forwarded: queueMetrics.forwarded,
      duplicates: queueMetrics.duplicates,
      retries: queueMetrics.retries,
      deadLetters: queueMetrics.deadLetters,
      unroutable: queueMetrics.unroutable,
      callbacksTotal: queueMetrics.callbacksTotal,
      callbacksSuccess: queueMetrics.callbacksSuccess,
      callbacksFailed: queueMetrics.callbacksFailed,
      activeJobs: queueMetrics.activeJobs,
      queuedRetries: queueMetrics.queuedRetries,
      avgLatencyMs: queueMetrics.avgLatencyMs || 0,
      lastLatencyMs: queueMetrics.lastLatencyMs || 0,
    },
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      rssMb: (memory.rss / (1024 * 1024)).toFixed(1),
      heapUsedMb: (memory.heapUsed / (1024 * 1024)).toFixed(1),
      heapTotalMb: (memory.heapTotal / (1024 * 1024)).toFixed(1),
    },
  });
});

/**
 * GET /api/v1/dashboard/config
 * Retrieves full runtime and persisted configuration
 */
router.get('/config', async (req, res) => {
  if (typeof syncConfigWithDb === 'function') {
    await syncConfigWithDb(true);
  }

  res.json({
    status: true,
    config: {
      paystack: {
        secretKey: config.paystack.secretKey || '',
        webhookSecret: config.paystack.webhookSecret || '',
        enableIpWhitelist: Boolean(config.paystack.enableIpWhitelist),
        ipWhitelist: config.paystack.ipWhitelist || [],
      },
      proxy: {
        sharedSecret: config.proxy.sharedSecret || '',
        timeoutMs: config.proxy.timeoutMs || 8000,
        maxRetries: config.proxy.maxRetries ?? 4,
        retryDelays: config.proxy.retryDelays || [15000, 60000, 300000, 900000],
        queueStore: config.proxy.queueStore || 'memory',
        sqliteDbPath: config.proxy.sqliteDbPath || './data/proxy.db',
        redisUrl: config.proxy.redisUrl || 'redis://127.0.0.1:6379/0',
        idempotencyTtlSeconds: config.proxy.idempotencyTtlSeconds || 86400,
      },
      notifications: {
        discordWebhookUrl: config.notifications.discordWebhookUrl || '',
        telegram: {
          botToken: config.notifications.telegram.botToken || '',
          chatId: config.notifications.telegram.chatId || '',
        },
      },
      server: {
        port: config.port || 3000,
        env: config.env || 'development',
        logLevel: config.logLevel || 'info',
        sitesConfigPath: config.sitesConfigPath || './config/sites.json',
      },
      dashboard: {
        authEnabled: Boolean(config.dashboard?.authEnabled !== false),
        username: config.dashboard?.username || 'admin',
        hasPassword: Boolean(config.dashboard?.password),
        sessionHours: config.dashboard?.sessionHours || 24,
      },
    },
  });
});

/**
 * POST /api/v1/dashboard/config
 * Persists and immediately applies configuration changes
 */
router.post('/config', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({
      status: false,
      message: 'Invalid configuration updates payload: expected JSON object',
    });
  }

  try {
    const updated = await updateConfigAndEnv(updates);

    return res.json({
      status: true,
      message: 'Configuration updated and applied successfully without server restart',
      config: {
        paystack: {
          secretKey: updated.paystack.secretKey || '',
          webhookSecret: updated.paystack.webhookSecret || '',
          enableIpWhitelist: Boolean(updated.paystack.enableIpWhitelist),
          ipWhitelist: updated.paystack.ipWhitelist || [],
        },
        proxy: {
          sharedSecret: updated.proxy.sharedSecret || '',
          timeoutMs: updated.proxy.timeoutMs || 8000,
          maxRetries: updated.proxy.maxRetries ?? 4,
          retryDelays: updated.proxy.retryDelays || [15000, 60000, 300000, 900000],
          queueStore: updated.proxy.queueStore || 'memory',
          sqliteDbPath: updated.proxy.sqliteDbPath || './data/proxy.db',
          redisUrl: updated.proxy.redisUrl || 'redis://127.0.0.1:6379/0',
          idempotencyTtlSeconds: updated.proxy.idempotencyTtlSeconds || 86400,
        },
        notifications: {
          discordWebhookUrl: updated.notifications.discordWebhookUrl || '',
          telegram: {
            botToken: updated.notifications.telegram.botToken || '',
            chatId: updated.notifications.telegram.chatId || '',
          },
        },
        server: {
          port: updated.port || 3000,
          env: updated.env || 'development',
          logLevel: updated.logLevel || 'info',
          sitesConfigPath: updated.sitesConfigPath || './config/sites.json',
        },
        dashboard: {
          authEnabled: Boolean(updated.dashboard?.authEnabled !== false),
          username: updated.dashboard?.username || 'admin',
          hasPassword: Boolean(updated.dashboard?.password),
          sessionHours: updated.dashboard?.sessionHours || 24,
        },
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to apply configuration updates');
    return res.status(500).json({
      status: false,
      message: `Failed to update configuration: ${err.message}`,
    });
  }
});

function normalizePrefixes(input) {
  if (Array.isArray(input)) return input.map(s => String(s).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function normalizePatterns(input) {
  if (Array.isArray(input)) return input.map(s => String(s).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function normalizeFlowRoutes(input) {
  if (!input) return {};
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      return {};
    }
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const res = {};
    for (const [k, v] of Object.entries(input)) {
      if (k && v && typeof v === 'string') {
        res[String(k).trim()] = v.trim();
      }
    }
    return res;
  }
  return {};
}

/**
 * GET /api/v1/dashboard/sites
 * List configured child sites from sites.json
 */
router.get('/sites', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb();
  }
  const sites = getAllSites();
  const list = Object.entries(sites).map(([key, site]) => ({
    key,
    name: site.name || key,
    webhookUrl: site.webhookUrl || '',
    callbackUrl: site.callbackUrl || '',
    hasSecret: Boolean(site.secret),
    secret: site.secret || '',
    referencePrefixes: Array.isArray(site.referencePrefixes) ? site.referencePrefixes : [],
    referencePatterns: Array.isArray(site.referencePatterns) ? site.referencePatterns : [],
    flowRoutes: site.flowRoutes || site.callbackRules || {},
  }));

  res.json({
    status: true,
    count: list.length,
    sites: list,
  });
});

/**
 * POST /api/v1/dashboard/sites
 * Add a new child site dynamically to sites.json and PostgreSQL
 */
router.post('/sites', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb(true);
  }

  const {
    key,
    name,
    webhookUrl,
    callbackUrl = '',
    secret = '',
    referencePrefixes,
    referencePatterns,
    flowRoutes,
    callbackRules,
  } = req.body || {};

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ status: false, message: 'Site key is required' });
  }
  const cleanKey = key.trim().toLowerCase();
  if (!/^[a-zA-Z0-9_-]+$/.test(cleanKey)) {
    return res.status(400).json({ status: false, message: 'Site key must only contain letters, numbers, hyphens, and underscores' });
  }

  const existingSites = getAllSites();
  if (existingSites[cleanKey]) {
    return res.status(409).json({ status: false, message: `Site '${cleanKey}' already exists` });
  }

  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return res.status(400).json({ status: false, message: 'Valid webhookUrl is required' });
  }

  try {
    new URL(webhookUrl);
  } catch {
    return res.status(400).json({ status: false, message: 'webhookUrl must be a valid URL (e.g. https://...)' });
  }

  if (callbackUrl) {
    try {
      new URL(callbackUrl);
    } catch {
      return res.status(400).json({ status: false, message: 'callbackUrl must be a valid URL if provided' });
    }
  }

  const siteData = {
    name: (name && String(name).trim()) || cleanKey,
    webhookUrl: webhookUrl.trim(),
    callbackUrl: callbackUrl ? callbackUrl.trim() : '',
    secret: secret ? secret.trim() : '',
    referencePrefixes: normalizePrefixes(referencePrefixes),
    referencePatterns: normalizePatterns(referencePatterns),
    flowRoutes: normalizeFlowRoutes(flowRoutes || callbackRules),
  };

  await addOrUpdateSite(cleanKey, siteData);

  return res.status(201).json({
    status: true,
    message: `Site '${cleanKey}' created successfully`,
    site: {
      key: cleanKey,
      ...siteData,
      hasSecret: Boolean(siteData.secret),
    },
  });
});

/**
 * PUT /api/v1/dashboard/sites/:id
 * Update an existing child site in sites.json and PostgreSQL (upserts if not previously cached)
 */
router.put('/sites/:id', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb(true);
  }

  const { id } = req.params;
  const siteKey = String(id || '').trim().toLowerCase();
  const existingSites = getAllSites();

  const {
    name,
    webhookUrl,
    callbackUrl,
    secret,
    newKey,
    referencePrefixes,
    referencePatterns,
    flowRoutes,
    callbackRules,
  } = req.body || {};

  if (webhookUrl !== undefined && webhookUrl !== '') {
    try {
      new URL(webhookUrl);
    } catch {
      return res.status(400).json({ status: false, message: 'webhookUrl must be a valid URL' });
    }
  }

  if (callbackUrl) {
    try {
      new URL(callbackUrl);
    } catch {
      return res.status(400).json({ status: false, message: 'callbackUrl must be a valid URL' });
    }
  }

  const current = existingSites[siteKey] || {};
  const finalWebhookUrl = webhookUrl !== undefined ? String(webhookUrl).trim() : (current.webhookUrl || '');

  if (!finalWebhookUrl) {
    return res.status(400).json({ status: false, message: `A valid webhookUrl is required for site '${siteKey}'` });
  }

  const updatedData = {
    name: name !== undefined ? String(name).trim() : (current.name || siteKey),
    webhookUrl: finalWebhookUrl,
    callbackUrl: callbackUrl !== undefined ? String(callbackUrl).trim() : (current.callbackUrl || ''),
    secret: secret !== undefined ? String(secret).trim() : (current.secret || ''),
    referencePrefixes: referencePrefixes !== undefined ? normalizePrefixes(referencePrefixes) : (current.referencePrefixes || []),
    referencePatterns: referencePatterns !== undefined ? normalizePatterns(referencePatterns) : (current.referencePatterns || []),
    flowRoutes: (flowRoutes !== undefined || callbackRules !== undefined) ? normalizeFlowRoutes(flowRoutes || callbackRules) : (current.flowRoutes || current.callbackRules || {}),
  };

  let targetKey = siteKey;
  if (newKey && String(newKey).trim().toLowerCase() !== siteKey) {
    const cleanNewKey = String(newKey).trim().toLowerCase();
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanNewKey)) {
      return res.status(400).json({ status: false, message: 'New site key contains invalid characters' });
    }
    if (existingSites[cleanNewKey] && cleanNewKey !== siteKey) {
      return res.status(409).json({ status: false, message: `Site key '${cleanNewKey}' is already taken` });
    }
    await removeSite(siteKey);
    targetKey = cleanNewKey;
  }

  await addOrUpdateSite(targetKey, updatedData);

  return res.json({
    status: true,
    message: `Site '${targetKey}' updated successfully`,
    site: {
      key: targetKey,
      ...updatedData,
      hasSecret: Boolean(updatedData.secret),
    },
  });
});

/**
 * DELETE /api/v1/dashboard/sites/:id
 * Remove a child site from sites.json and PostgreSQL
 */
router.delete('/sites/:id', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb(true);
  }

  const { id } = req.params;
  const siteKey = String(id || '').trim().toLowerCase();

  await removeSite(siteKey);

  return res.json({
    status: true,
    message: `Site '${siteKey}' deleted successfully`,
    deletedKey: siteKey,
  });
});

/**
 * POST /api/v1/dashboard/sites/:key/ping
 * Test reachability of a child site's webhook endpoint
 */
router.post('/sites/:key/ping', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb(true);
  }

  const { key } = req.params;
  const site = getSite(key);

  if (!site || !site.webhookUrl) {
    return res.status(404).json({
      status: false,
      message: `Configured site '${key}' not found or missing webhookUrl`,
    });
  }

  const startTime = Date.now();
  try {
    const response = await axios({
      method: 'OPTIONS',
      url: site.webhookUrl,
      timeout: 3500,
      validateStatus: () => true, // Accept any status code as evidence of reachability
    });

    const durationMs = Date.now() - startTime;
    return res.json({
      status: true,
      reachable: true,
      siteKey: key,
      webhookUrl: site.webhookUrl,
      httpStatus: response.status,
      durationMs,
    });
  } catch (err) {
    // If OPTIONS fails, try a fast GET / HEAD fallback before declaring unreachable
    try {
      const fallbackResponse = await axios({
        method: 'GET',
        url: site.webhookUrl,
        timeout: 2500,
        validateStatus: () => true,
      });

      const durationMs = Date.now() - startTime;
      return res.json({
        status: true,
        reachable: true,
        siteKey: key,
        webhookUrl: site.webhookUrl,
        httpStatus: fallbackResponse.status,
        durationMs,
      });
    } catch (fallbackErr) {
      const durationMs = Date.now() - startTime;
      return res.json({
        status: false,
        reachable: false,
        siteKey: key,
        webhookUrl: site.webhookUrl,
        error: fallbackErr.message || 'Connection failed or timed out',
        durationMs,
      });
    }
  }
});

/**
 * GET /api/v1/dashboard/events
 * Recent webhook event dispatch log
 */
router.get('/events', async (req, res) => {
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 100) : 50;
  const events = typeof queueService.fetchRecentEvents === 'function'
    ? await queueService.fetchRecentEvents(limit)
    : queueService.getRecentEvents(limit);

  res.json({
    status: true,
    count: events.length,
    events,
  });
});

/**
 * POST /api/v1/dashboard/simulate
 * Interactive Webhook Simulator:
 * Generates Paystack webhook payload with valid HMAC SHA512 signature,
 * enqueues for dispatch, and returns comprehensive resolution feedback.
 */
router.post('/simulate', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb();
  }
  if (typeof syncConfigWithDb === 'function') {
    await syncConfigWithDb();
  }

  const correlationId = `sim-${crypto.randomUUID().slice(0, 8)}`;
  const {
    eventType = 'charge.success',
    siteKey = '',
    reference: customReference = '',
    amount = 5000,
    email = 'simulated.customer@example.com',
    currency = 'GHS',
    routingMechanism = 'both', // 'reference', 'metadata', 'both', 'none'
    customPayload = null,
    customData = {},
  } = req.body;

  let payload;
  let rawBodyString;

  if (customPayload) {
    try {
      payload = typeof customPayload === 'string' ? JSON.parse(customPayload) : customPayload;
      rawBodyString = typeof customPayload === 'string' ? customPayload : JSON.stringify(customPayload);
    } catch (parseErr) {
      return res.status(400).json({
        status: false,
        message: `Malformed custom JSON payload: ${parseErr.message}`,
      });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.event) {
      return res.status(400).json({
        status: false,
        message: 'Invalid custom webhook payload: must be a valid JSON object containing an "event" property',
      });
    }
  } else {
    // Generate reference with site prefix if routing by reference is enabled
    let ref = customReference.trim();
    if (!ref) {
      const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if ((routingMechanism === 'reference' || routingMechanism === 'both') && siteKey) {
        const targetSite = getSite(siteKey);
        const prefixes = normalizePrefixes(targetSite?.referencePrefixes);
        const prefix = prefixes[0] || siteKey;
        ref = `${prefix}_sim_${uniqueSuffix}`;
      } else {
        ref = `sim_txn_${uniqueSuffix}`;
      }
    }

    const metadata = {};
    if ((routingMechanism === 'metadata' || routingMechanism === 'both') && siteKey) {
      metadata.origin_site = siteKey;
      metadata.custom_fields = [
        {
          variable_name: 'origin_site',
          value: siteKey,
          display_name: 'Originating Site',
        },
      ];
    }

    payload = {
      event: eventType || 'charge.success',
      data: {
        id: Math.floor(Math.random() * 90000000) + 10000000,
        domain: 'test',
        status: 'success',
        reference: ref,
        amount: Number(amount) || 50000,
        message: null,
        gateway_response: 'Successful',
        paid_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        channel: 'card',
        currency: currency || 'GHS',
        ip_address: '127.0.0.1',
        metadata: Object.keys(metadata).length > 0 ? metadata : {},
        customer: {
          id: Math.floor(Math.random() * 100000) + 10000,
          first_name: 'Alex',
          last_name: 'PaystackTester',
          email: email || 'simulated.customer@example.com',
          customer_code: 'CUS_sim_test_user',
          phone: '+233241234567',
        },
        ...customData,
      },
    };

    rawBodyString = JSON.stringify(payload);
  }

  // Calculate Paystack HMAC SHA512 signature
  const webhookSecret = config.paystack.webhookSecret || config.paystack.secretKey || 'test_sim_secret';
  const rawBodyBuf = Buffer.from(rawBodyString, 'utf8');
  const signature = crypto.createHmac('sha512', webhookSecret).update(rawBodyBuf).digest('hex');

  const eventIdentifier = getWebhookEventIdentifier(payload);
  const eventKey = `${payload.event}:${eventIdentifier}`;

  try {
    // Check deduplication
    const dedupeResult = await queueService.checkAndRecord(eventKey, 'QUEUED');
    if (dedupeResult.isDuplicate) {
      metrics.duplicates++;
      queueService.recordExternalEvent({
        eventKey,
        eventType: payload.event,
        reference: eventIdentifier,
        status: 'DUPLICATE',
        correlationId,
      });

      return res.status(200).json({
        status: true,
        simulated: true,
        duplicate: true,
        message: 'Duplicate event detected (already ingested and processed in idempotency store)',
        eventKey,
        signature,
        payload,
      });
    }

    // Resolve site & enqueue
    const dispatchResult = await dispatchWebhook({
      eventKey,
      payload,
      rawBody: rawBodyBuf,
      headers: {
        'x-paystack-signature': signature,
        'content-type': 'application/json',
      },
      correlationId,
    });

    if (dispatchResult.unroutable) {
      await queueService.updateEventStatus(eventKey, 'UNROUTABLE');
      queueService.recordExternalEvent({
        eventKey,
        eventType: payload.event,
        reference: eventIdentifier,
        status: 'UNROUTABLE',
        error: 'No matching child site or fallback destination configured',
        correlationId,
      });

      const safeCurlBody = rawBodyString.replace(/'/g, "'\\''");
      return res.status(200).json({
        status: true,
        simulated: true,
        unroutable: true,
        message: 'Event simulated successfully, but unroutable to any child site',
        eventKey,
        signature,
        payload,
        curlExample: `curl -X POST http://localhost:${config.port || 3000}/api/v1/paystack/webhook \\\n  -H "Content-Type: application/json" \\\n  -H "x-paystack-signature: ${signature}" \\\n  -d '${safeCurlBody}'`,
      });
    }

    const safeCurlBody = rawBodyString.replace(/'/g, "'\\''");
    return res.status(200).json({
      status: true,
      simulated: true,
      unroutable: false,
      message: 'Simulated webhook payload signed and enqueued for downstream dispatch',
      eventKey,
      resolvedSite: dispatchResult.siteKey,
      targetUrl: dispatchResult.targetUrl,
      matchType: dispatchResult.matchType,
      signature,
      payload,
      curlExample: `curl -X POST http://localhost:${config.port || 3000}/api/v1/paystack/webhook \\\n  -H "Content-Type: application/json" \\\n  -H "x-paystack-signature: ${signature}" \\\n  -d '${safeCurlBody}'`,
    });
  } catch (err) {
    logger.error({ correlationId, err: err.message }, 'Failed to simulate webhook dispatch');
    return res.status(500).json({
      status: false,
      message: `Simulator error: ${err.message}`,
    });
  }
});

/**
 * GET /api/v1/dashboard/verify/:reference
 * Transaction verification lookup tool (inspect Paystack transactions by reference)
 */
router.get('/verify/:reference', async (req, res) => {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb();
  }

  const { reference } = req.params;
  const cleanRef = String(reference || '').trim();

  if (!cleanRef) {
    return res.status(400).json({
      status: false,
      message: 'Transaction reference is required',
    });
  }

  const result = await paystackService.verifyTransaction(cleanRef, `verify-${crypto.randomUUID().slice(0, 8)}`);

  // Detect which site this transaction resolves to
  const resolved = resolveSite(result.data || { reference: cleanRef });

  return res.json({
    status: true,
    reference: cleanRef,
    resolvedSite: resolved ? {
      key: resolved.siteKey,
      name: resolved.site?.name || resolved.siteKey,
      matchType: resolved.matchType,
      matchedRule: resolved.matchedRule || null,
      callbackUrl: resolved.site?.callbackUrl || null,
      webhookUrl: resolved.site?.webhookUrl || null,
      referencePrefixes: resolved.site?.referencePrefixes || [],
      referencePatterns: resolved.site?.referencePatterns || [],
      flowRoutes: resolved.site?.flowRoutes || resolved.site?.callbackRules || {},
      resolvedCallbackUrl: resolved.resolvedCallbackUrl || resolved.site?.callbackUrl || null,
    } : null,
    verification: result,
  });
});

/**
 * POST /api/v1/dashboard/calculate-signature
 * Computes Paystack HMAC SHA512 signature for arbitrary JSON payload
 */
router.post('/calculate-signature', (req, res) => {
  const { payload, secret } = req.body;
  if (!payload) {
    return res.status(400).json({ status: false, message: 'Payload is required' });
  }

  const secretKey = secret || config.paystack.webhookSecret || config.paystack.secretKey || '';
  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', secretKey).update(Buffer.from(rawBody, 'utf8')).digest('hex');

  res.json({
    status: true,
    signature,
    secretUsed: secretKey ? (secretKey.slice(0, 7) + '...' + secretKey.slice(-4)) : '(empty)',
  });
});

export default router;
