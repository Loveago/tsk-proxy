import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
let DatabaseSync = null;
try {
  const sqliteModule = await import('node:sqlite');
  DatabaseSync = sqliteModule.DatabaseSync;
} catch {
  // node:sqlite is available in Node.js >= 22.5.0; handled gracefully below for Node 18/20 LTS
}
import Redis from 'ioredis';
import { config, logger, resolveConfigFilePath, onConfigUpdated } from '../config/index.js';
import { notifier } from './notifier.js';

// Global metrics tracker
export const metrics = {
  ingested: 0,
  forwarded: 0,
  duplicates: 0,
  retries: 0,
  deadLetters: 0,
  unroutable: 0,
  callbacksTotal: 0,
  callbacksSuccess: 0,
  callbacksFailed: 0,
  totalLatencyMs: 0,
  forwardedCount: 0,
  lastLatencyMs: 0,
  avgLatencyMs: 0,
};

// -------------------------------------------------------------
// Idempotency Store Interface & Adapters
// -------------------------------------------------------------

class MemoryIdempotencyStore {
  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.store = new Map();
    // Periodic sweep for expired items every 15 minutes
    this.sweepInterval = setInterval(() => this.cleanup(), 15 * 60 * 1000);
    if (this.sweepInterval.unref) this.sweepInterval.unref();
  }

  async isDuplicate(eventKey) {
    const entry = this.store.get(eventKey);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(eventKey);
      return false;
    }
    // Any event that has been received or completed is considered duplicate
    return entry.status === 'SUCCESS' || entry.status === 'PROCESSING' || entry.status === 'QUEUED';
  }

  async checkAndRecord(eventKey, status = 'QUEUED') {
    const now = Date.now();
    const entry = this.store.get(eventKey);
    if (entry && now <= entry.expiresAt) {
      const isDup = entry.status === 'SUCCESS' || entry.status === 'PROCESSING' || entry.status === 'QUEUED';
      if (isDup) {
        return { isDuplicate: true, status: entry.status };
      }
    }
    this.store.set(eventKey, {
      status,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    });
    return { isDuplicate: false, status };
  }

  async record(eventKey, status = 'QUEUED') {
    this.store.set(eventKey, {
      status,
      updatedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async updateStatus(eventKey, status) {
    const existing = this.store.get(eventKey);
    if (existing) {
      existing.status = status;
      existing.updatedAt = Date.now();
    } else {
      await this.record(eventKey, status);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, val] of this.store.entries()) {
      if (now > val.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  async clear() {
    this.store.clear();
  }

  async close() {
    clearInterval(this.sweepInterval);
  }
}

class SqliteIdempotencyStore {
  constructor(dbPath) {
    if (!DatabaseSync) {
      throw new Error('node:sqlite is not supported on this Node.js runtime (< 22.5.0)');
    }

    let target = dbPath;
    if (dbPath !== ':memory:') {
      const fullPath = resolveConfigFilePath(dbPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      target = fullPath;
    }

    this.db = new DatabaseSync(target);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        event_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency(expires_at);
    `);
  }

  async isDuplicate(eventKey) {
    const now = Date.now();
    const stmt = this.db.prepare('SELECT status, expires_at FROM idempotency WHERE event_key = ?');
    const row = stmt.get(eventKey);
    if (!row) return false;
    if (now > row.expires_at) {
      const delStmt = this.db.prepare('DELETE FROM idempotency WHERE event_key = ?');
      delStmt.run(eventKey);
      return false;
    }
    return row.status === 'SUCCESS' || row.status === 'PROCESSING' || row.status === 'QUEUED';
  }

  async checkAndRecord(eventKey, status = 'QUEUED', ttlMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const stmt = this.db.prepare('SELECT status, expires_at FROM idempotency WHERE event_key = ?');
    const row = stmt.get(eventKey);
    if (row && now <= row.expires_at) {
      const isDup = row.status === 'SUCCESS' || row.status === 'PROCESSING' || row.status === 'QUEUED';
      if (isDup) {
        return { isDuplicate: true, status: row.status };
      }
    }
    await this.record(eventKey, status, ttlMs);
    return { isDuplicate: false, status };
  }

  async record(eventKey, status = 'QUEUED', ttlMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const stmt = this.db.prepare(`
      INSERT INTO idempotency (event_key, status, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        status = excluded.status,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(eventKey, status, expiresAt, now);
  }

  async updateStatus(eventKey, status) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE idempotency SET status = ?, updated_at = ? WHERE event_key = ?
    `);
    stmt.run(status, now, eventKey);
  }

  async clear() {
    this.db.exec('DELETE FROM idempotency');
  }

  async close() {
    this.db.close();
  }
}

class RedisIdempotencyStore {
  constructor(redisUrl, ttlSeconds = 86400) {
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.ttlSeconds = ttlSeconds;
    this.prefix = 'paystack_proxy:idempotency:';
  }

  async checkAndRecord(eventKey, status = 'QUEUED') {
    try {
      const current = await this.redis.get(`${this.prefix}${eventKey}`);
      if (current && (current === 'SUCCESS' || current === 'PROCESSING' || current === 'QUEUED')) {
        return { isDuplicate: true, status: current };
      }
      await this.redis.set(`${this.prefix}${eventKey}`, status, 'EX', this.ttlSeconds);
      return { isDuplicate: false, status };
    } catch (err) {
      logger.error({ err: err.message, eventKey }, 'Redis checkAndRecord failed, allowing event through');
      return { isDuplicate: false, status };
    }
  }

  async isDuplicate(eventKey) {
    try {
      const status = await this.redis.get(`${this.prefix}${eventKey}`);
      if (!status) return false;
      return status === 'SUCCESS' || status === 'PROCESSING' || status === 'QUEUED';
    } catch (err) {
      logger.error({ err: err.message, eventKey }, 'Redis idempotency check failed, defaulting to false');
      return false;
    }
  }

  async record(eventKey, status = 'QUEUED') {
    try {
      await this.redis.set(`${this.prefix}${eventKey}`, status, 'EX', this.ttlSeconds);
    } catch (err) {
      logger.error({ err: err.message, eventKey }, 'Redis idempotency record failed');
    }
  }

  async updateStatus(eventKey, status) {
    try {
      await this.redis.set(`${this.prefix}${eventKey}`, status, 'EX', this.ttlSeconds);
    } catch (err) {
      logger.error({ err: err.message, eventKey }, 'Redis idempotency update status failed');
    }
  }

  async clear() {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async close() {
    await this.redis.quit();
  }
}

// -------------------------------------------------------------
// Dispatch Queue & Retry Worker
// -------------------------------------------------------------

export class QueueService {
  constructor(options = {}) {
    this._customStoreType = options.queueStore;
    this._customRetryDelays = options.retryDelays;
    this._customMaxRetries = options.maxRetries;
    this._customSqliteDbPath = options.sqliteDbPath;
    this._customRedisUrl = options.redisUrl;
    this.pollIntervalMs = options.pollIntervalMs || 1000;

    this.jobs = []; // In-memory queue storage
    this.recentEvents = []; // In-memory circular buffer of recent webhook dispatches / events
    this.maxRecentEvents = options.maxRecentEvents || 100;
    this.timer = null;
    this.isProcessing = false;
    this.forwarder = null; // Injected dispatcher function

    this.initStore();
  }

  get storeType() {
    return this._customStoreType ?? config.proxy.queueStore ?? 'memory';
  }

  set storeType(val) {
    this._customStoreType = val;
  }

  get retryDelays() {
    return this._customRetryDelays ?? config.proxy.retryDelays ?? [15000, 60000, 300000, 900000];
  }

  set retryDelays(val) {
    this._customRetryDelays = val;
  }

  get maxRetries() {
    return this._customMaxRetries ?? config.proxy.maxRetries ?? 4;
  }

  set maxRetries(val) {
    this._customMaxRetries = val;
  }

  get sqliteDbPath() {
    return this._customSqliteDbPath ?? config.proxy.sqliteDbPath ?? './data/proxy.db';
  }

  set sqliteDbPath(val) {
    this._customSqliteDbPath = val;
  }

  get redisUrl() {
    return this._customRedisUrl ?? config.proxy.redisUrl ?? 'redis://127.0.0.1:6379/0';
  }

  set redisUrl(val) {
    this._customRedisUrl = val;
  }

  async reconfigure() {
    if (this.idempotencyStore && typeof this.idempotencyStore.close === 'function') {
      try {
        await this.idempotencyStore.close();
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to cleanly close previous idempotency store');
      }
    }
    this.initStore();
  }

  initStore() {
    const ttlMs = (config.proxy.idempotencyTtlSeconds || 86400) * 1000;
    if (this.storeType === 'redis') {
      try {
        this.idempotencyStore = new RedisIdempotencyStore(this.redisUrl, config.proxy.idempotencyTtlSeconds);
        logger.info('Using Redis idempotency store');
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to initialize Redis store, falling back to Memory');
        this.idempotencyStore = new MemoryIdempotencyStore(ttlMs);
      }
    } else if (this.storeType === 'sqlite') {
      try {
        this.idempotencyStore = new SqliteIdempotencyStore(this.sqliteDbPath);
        logger.info({ path: this.sqliteDbPath }, 'Using SQLite idempotency store');
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to initialize SQLite store, falling back to Memory');
        this.idempotencyStore = new MemoryIdempotencyStore(ttlMs);
      }
    } else {
      this.idempotencyStore = new MemoryIdempotencyStore(ttlMs);
      logger.info('Using in-memory idempotency store');
    }
  }

  setForwarder(forwarderFn) {
    this.forwarder = forwarderFn;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.processNextBatch(), this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
    logger.info({ pollIntervalMs: this.pollIntervalMs }, 'Retry queue worker started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Retry queue worker stopped');
    }
  }

  async checkAndRecord(eventKey, status = 'QUEUED') {
    return this.idempotencyStore.checkAndRecord(eventKey, status);
  }

  async isDuplicate(eventKey) {
    return this.idempotencyStore.isDuplicate(eventKey);
  }

  async recordEvent(eventKey, status = 'QUEUED') {
    return this.idempotencyStore.record(eventKey, status);
  }

  async updateEventStatus(eventKey, status) {
    return this.idempotencyStore.updateStatus(eventKey, status);
  }

  recordEventLog(entry) {
    if (!entry.timestamp) {
      entry.timestamp = entry.createdAt || new Date().toISOString();
    }
    this.recentEvents.unshift(entry);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.pop();
    }
  }

  updateEventLog(id, patch) {
    const entry = this.recentEvents.find(e => e.id === id);
    if (entry) {
      Object.assign(entry, patch);
    }
  }

  recordExternalEvent({ eventKey, eventType, reference, siteKey = null, targetUrl = null, status, error = null, correlationId = 'unknown' }) {
    const key = eventKey || `${eventType || 'unknown'}:${reference || 'unknown'}`;
    const [derivedType, derivedRef] = key.split(':');
    const nowIso = new Date().toISOString();
    this.recordEventLog({
      id: crypto.randomUUID(),
      eventKey: key,
      eventType: eventType || derivedType || 'unknown',
      reference: reference || derivedRef || '',
      siteKey,
      targetUrl,
      status,
      attempts: 0,
      maxRetries: 0,
      correlationId,
      error,
      timestamp: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  getRecentEvents(limit = 50) {
    return this.recentEvents.slice(0, limit);
  }

  /**
   * Enqueues a webhook payload to be forwarded downstream.
   */
  async enqueue(jobData) {
    const job = {
      id: crypto.randomUUID(),
      eventKey: jobData.eventKey,
      siteKey: jobData.siteKey,
      targetUrl: jobData.targetUrl,
      rawBody: jobData.rawBody,
      headers: jobData.headers || {},
      attempt: 0,
      maxRetries: jobData.maxRetries ?? this.maxRetries,
      nextRunAt: Date.now(), // Dispatch immediately
      createdAt: Date.now(),
      lastError: null,
      correlationId: jobData.correlationId || crypto.randomUUID(),
    };

    metrics.ingested++;
    this.jobs.push(job);

    const [eventType, idPart] = (job.eventKey || '').split(':');
    const displayRef = jobData.reference || idPart || '';
    const createdIso = new Date(job.createdAt).toISOString();
    this.recordEventLog({
      id: job.id,
      eventKey: job.eventKey,
      eventType: eventType || 'unknown',
      reference: displayRef,
      siteKey: job.siteKey,
      targetUrl: job.targetUrl,
      status: 'QUEUED',
      attempts: 0,
      maxRetries: job.maxRetries,
      correlationId: job.correlationId,
      error: null,
      timestamp: createdIso,
      createdAt: createdIso,
      updatedAt: createdIso,
    });

    logger.info(
      {
        jobId: job.id,
        eventKey: job.eventKey,
        siteKey: job.siteKey,
        targetUrl: job.targetUrl,
        correlationId: job.correlationId,
      },
      'Webhook job enqueued'
    );

    // Trigger immediate check in next event loop tick
    setImmediate(() => this.processNextBatch());
    return job;
  }

  /**
   * Processes ready jobs that reached nextRunAt concurrently
   */
  async processNextBatch() {
    if (this.isProcessing || !this.forwarder) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      const readyJobs = [];
      const pendingJobs = [];

      for (const job of this.jobs) {
        if (job.nextRunAt <= now) {
          readyJobs.push(job);
        } else {
          pendingJobs.push(job);
        }
      }

      // Claim ready jobs immediately so new jobs can be appended without race conditions
      this.jobs = pendingJobs;

      if (readyJobs.length > 0) {
        // Execute ready jobs concurrently so that slow endpoints do not block other child sites
        await Promise.allSettled(readyJobs.map(job => this.executeJob(job)));
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Error in queue processing loop');
    } finally {
      this.isProcessing = false;

      // If new jobs arrived or became ready while processing, process them immediately
      const now = Date.now();
      if (this.jobs.some(j => j.nextRunAt <= now)) {
        setImmediate(() => this.processNextBatch());
      }
    }
  }

  async executeJob(job) {
    const startTime = Date.now();
    job.attempt += 1;
    this.updateEventLog(job.id, {
      attempts: job.attempt,
      status: 'PROCESSING',
      updatedAt: new Date().toISOString(),
    });

    logger.info(
      {
        jobId: job.id,
        attempt: job.attempt,
        maxRetries: job.maxRetries,
        siteKey: job.siteKey,
        correlationId: job.correlationId,
      },
      'Dispatching webhook downstream'
    );

    try {
      const result = await this.forwarder(job);

      if (result.success) {
        const durationMs = Date.now() - startTime;
        metrics.forwarded++;
        metrics.forwardedCount++;
        metrics.totalLatencyMs += durationMs;
        metrics.lastLatencyMs = durationMs;
        metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.forwardedCount);

        await this.updateEventStatus(job.eventKey, 'SUCCESS');
        this.updateEventLog(job.id, {
          status: 'SUCCESS',
          httpStatus: result.status || 200,
          durationMs,
          updatedAt: new Date().toISOString(),
        });
        logger.info(
          {
            jobId: job.id,
            siteKey: job.siteKey,
            status: result.status,
            latencyMs: durationMs,
            correlationId: job.correlationId,
          },
          'Webhook successfully delivered downstream'
        );
        return;
      }

      // Forwarder returned failure (e.g. non-2xx status or network timeout)
      await this.handleJobFailure(job, result.error || `HTTP ${result.status}`, startTime, result.status);
    } catch (err) {
      await this.handleJobFailure(job, err.message, startTime, null);
    }
  }

  async handleJobFailure(job, errorMsg, startTime = null, httpStatus = null) {
    job.lastError = errorMsg;
    const durationMs = startTime ? Date.now() - startTime : undefined;
    let resolvedStatus = httpStatus;
    if (!resolvedStatus) {
      const match = String(errorMsg).match(/HTTP\s+(\d{3})/i);
      if (match) resolvedStatus = parseInt(match[1], 10);
    }

    logger.warn(
      {
        jobId: job.id,
        siteKey: job.siteKey,
        attempt: job.attempt,
        maxRetries: job.maxRetries,
        error: errorMsg,
        correlationId: job.correlationId,
      },
      'Webhook downstream delivery failed'
    );

    metrics.retries++;

    if (job.attempt <= job.maxRetries) {
      // Calculate delay with exponential backoff table
      const delayIndex = Math.min(job.attempt - 1, this.retryDelays.length - 1);
      const delayMs = this.retryDelays[delayIndex] || (job.attempt * 15000);
      job.nextRunAt = Date.now() + delayMs;

      this.jobs.push(job);
      this.updateEventLog(job.id, {
        status: 'RETRYING',
        error: errorMsg,
        httpStatus: resolvedStatus,
        attempts: job.attempt,
        nextRunAt: job.nextRunAt,
        durationMs,
        updatedAt: new Date().toISOString(),
      });

      logger.info(
        {
          jobId: job.id,
          nextAttempt: job.attempt + 1,
          retryInMs: delayMs,
          correlationId: job.correlationId,
        },
        'Job re-scheduled for retry'
      );
    } else {
      // Exceeded max retries -> Dead letter
      metrics.deadLetters++;
      await this.updateEventStatus(job.eventKey, 'DEAD_LETTER');
      this.updateEventLog(job.id, {
        status: 'DEAD_LETTER',
        error: errorMsg,
        httpStatus: resolvedStatus,
        attempts: job.attempt,
        durationMs,
        updatedAt: new Date().toISOString(),
      });

      logger.error(
        {
          jobId: job.id,
          eventKey: job.eventKey,
          siteKey: job.siteKey,
          totalAttempts: job.attempt,
          finalError: errorMsg,
          correlationId: job.correlationId,
        },
        'Webhook delivery permanently failed (Dead-Lettered)'
      );

      // Trigger Discord / Telegram alert
      await notifier.notifyFailure({
        type: 'MAX_RETRIES_EXCEEDED',
        event: job.eventKey.split(':')[0],
        reference: job.eventKey.split(':')[1],
        siteKey: job.siteKey,
        targetUrl: job.targetUrl,
        attempts: job.attempt,
        error: errorMsg,
        correlationId: job.correlationId,
      });
    }
  }

  getMetrics() {
    return {
      ...metrics,
      activeJobs: this.jobs.length,
      queuedRetries: this.jobs.filter(j => j.attempt > 0).length,
    };
  }

  async clear() {
    this.jobs = [];
    this.recentEvents = [];
    metrics.ingested = 0;
    metrics.forwarded = 0;
    metrics.duplicates = 0;
    metrics.retries = 0;
    metrics.deadLetters = 0;
    metrics.unroutable = 0;
    metrics.callbacksTotal = 0;
    metrics.callbacksSuccess = 0;
    metrics.callbacksFailed = 0;
    metrics.totalLatencyMs = 0;
    metrics.forwardedCount = 0;
    metrics.lastLatencyMs = 0;
    metrics.avgLatencyMs = 0;
    if (this.idempotencyStore) {
      await this.idempotencyStore.clear();
    }
  }

  async close() {
    this.stop();
    if (this.idempotencyStore) {
      await this.idempotencyStore.close();
    }
  }
}

export const queueService = new QueueService();

if (typeof onConfigUpdated === 'function') {
  onConfigUpdated((newConfig, updatedKeys) => {
    // Clear any instance-level overrides so dynamic getters read from new config
    if (updatedKeys.MAX_RETRIES) {
      queueService._customMaxRetries = null;
    }
    if (updatedKeys.RETRY_DELAYS_MS) {
      queueService._customRetryDelays = null;
    }
    if (updatedKeys.QUEUE_STORAGE_TYPE) {
      queueService._customStoreType = null;
    }
    if (updatedKeys.SQLITE_DB_PATH) {
      queueService._customSqliteDbPath = null;
    }
    if (updatedKeys.REDIS_URL) {
      queueService._customRedisUrl = null;
    }

    if (
      updatedKeys.QUEUE_STORAGE_TYPE ||
      updatedKeys.SQLITE_DB_PATH ||
      updatedKeys.REDIS_URL ||
      updatedKeys.IDEMPOTENCY_TTL_SECONDS
    ) {
      queueService.reconfigure();
    }
  });
}

export default queueService;
