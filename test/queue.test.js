import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../src/services/queue.js';
import { notifier } from '../src/services/notifier.js';

describe('Queue Service & Retry Mechanism', () => {
  let queue;

  beforeEach(() => {
    queue = new QueueService({
      queueStore: 'memory',
      retryDelays: [20, 40, 80],
      maxRetries: 2,
      pollIntervalMs: 50,
    });
  });

  afterEach(async () => {
    await queue.close();
  });

  it('marks idempotency as duplicate after recording event', async () => {
    const eventKey = 'charge.success:test_ref_100';

    assert.equal(await queue.isDuplicate(eventKey), false);

    await queue.recordEvent(eventKey, 'SUCCESS');

    assert.equal(await queue.isDuplicate(eventKey), true);
  });

  it('delivers job successfully on first attempt when forwarder returns success', async () => {
    let forwardCalls = 0;
    queue.setForwarder(async (job) => {
      forwardCalls++;
      return { success: true, status: 200 };
    });

    await queue.enqueue({
      eventKey: 'charge.success:test_ref_200',
      siteKey: 'lufak',
      targetUrl: 'https://store.lufak.test/webhook',
      rawBody: '{"event":"charge.success"}',
    });

    // Wait for setImmediate / queue execution
    await new Promise(r => setTimeout(r, 50));

    assert.equal(forwardCalls, 1);
    const isDup = await queue.isDuplicate('charge.success:test_ref_200');
    assert.equal(isDup, true);
  });

  it('retries failed job and dead-letters after exceeding maxRetries', async () => {
    let forwardCalls = 0;
    let failureNotified = false;

    // Spy on notifier
    const originalNotify = notifier.notifyFailure;
    notifier.notifyFailure = async (alert) => {
      if (alert.type === 'MAX_RETRIES_EXCEEDED') {
        failureNotified = true;
      }
    };

    queue.setForwarder(async (job) => {
      forwardCalls++;
      return { success: false, status: 500, error: 'Internal Server Error' };
    });

    queue.start();

    await queue.enqueue({
      eventKey: 'charge.success:test_fail_300',
      siteKey: 'saas',
      targetUrl: 'https://app.saas.test/webhook',
      rawBody: '{"event":"charge.success"}',
    });

    // Wait for all retries (initial + 2 retries = 3 attempts total)
    // Delays are [20ms, 40ms], plus pollInterval 50ms
    await new Promise(r => setTimeout(r, 350));

    notifier.notifyFailure = originalNotify;

    // Total attempts should be 1 (initial) + 2 (retries) = 3 attempts
    assert.equal(forwardCalls, 3);
    assert.equal(failureNotified, true);

    const metrics = queue.getMetrics();
    assert.ok(metrics.deadLetters >= 1);
  });

  it('supports SQLite storage adapter for idempotency', async () => {
    const sqliteQueue = new QueueService({
      queueStore: 'sqlite',
      sqliteDbPath: ':memory:', // SQLite in-memory DB
    });

    const eventKey = 'invoice.update:inv_99812';
    assert.equal(await sqliteQueue.isDuplicate(eventKey), false);

    await sqliteQueue.recordEvent(eventKey, 'SUCCESS');
    assert.equal(await sqliteQueue.isDuplicate(eventKey), true);

    // Test checkAndRecord on SQLite
    const res1 = await sqliteQueue.checkAndRecord('invoice.update:new_1', 'QUEUED');
    assert.equal(res1.isDuplicate, false);
    const res2 = await sqliteQueue.checkAndRecord('invoice.update:new_1', 'QUEUED');
    assert.equal(res2.isDuplicate, true);

    await sqliteQueue.close();
  });

  it('processes multiple ready jobs concurrently so a slow job does not block others', async () => {
    const executionOrder = [];
    queue.setForwarder(async (job) => {
      if (job.siteKey === 'slow_site') {
        await new Promise(r => setTimeout(r, 60));
        executionOrder.push('slow_done');
        return { success: true, status: 200 };
      }
      if (job.siteKey === 'fast_site') {
        await new Promise(r => setTimeout(r, 10));
        executionOrder.push('fast_done');
        return { success: true, status: 200 };
      }
      return { success: true, status: 200 };
    });

    // Enqueue slow job first, then fast job
    await queue.enqueue({
      eventKey: 'charge.success:slow_1',
      siteKey: 'slow_site',
      targetUrl: 'https://slow.test/webhook',
      rawBody: '{"event":"charge.success"}',
    });

    await queue.enqueue({
      eventKey: 'charge.success:fast_1',
      siteKey: 'fast_site',
      targetUrl: 'https://fast.test/webhook',
      rawBody: '{"event":"charge.success"}',
    });

    // Wait enough time for both to finish
    await new Promise(r => setTimeout(r, 120));

    // Fast job must finish BEFORE slow job finishes because they run concurrently
    assert.equal(executionOrder[0], 'fast_done');
    assert.equal(executionOrder[1], 'slow_done');
  });

  it('supports PostgreSQL storage initialization and graceful error handling', async () => {
    const pgQueue = new QueueService({
      queueStore: 'postgres',
      databaseUrl: 'postgres://mock_user:mock_pass@127.0.0.1:5432/mock_db',
    });

    assert.equal(pgQueue.storeType, 'postgres');
    assert.ok(pgQueue.idempotencyStore);

    // If PostgreSQL server is not locally running, it gracefully allows checkAndRecord without throwing
    const res = await pgQueue.checkAndRecord('charge.success:pg_test_1', 'QUEUED');
    assert.equal(typeof res.isDuplicate, 'boolean');

    await pgQueue.close();
  });

  it('automatically prunes event logs older than retention period (default 30 days)', async () => {
    // Seed events: one recent (today), one old (35 days ago), and one expired (40 days ago)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const recentEvent = {
      id: 'recent-event-1',
      eventKey: 'charge.success:rec_1',
      eventType: 'charge.success',
      reference: 'rec_1',
      status: 'SUCCESS',
      createdAt: new Date(now - 2 * dayMs).toISOString(),
    };

    const oldEvent1 = {
      id: 'old-event-1',
      eventKey: 'charge.success:old_1',
      eventType: 'charge.success',
      reference: 'old_1',
      status: 'SUCCESS',
      createdAt: new Date(now - 35 * dayMs).toISOString(),
    };

    const oldEvent2 = {
      id: 'old-event-2',
      eventKey: 'charge.success:old_2',
      eventType: 'charge.success',
      reference: 'old_2',
      status: 'FAILED',
      createdAt: new Date(now - 45 * dayMs).toISOString(),
    };

    queue.recordEventLog(recentEvent);
    queue.recordEventLog(oldEvent1);
    queue.recordEventLog(oldEvent2);

    assert.equal(queue.recentEvents.length, 3);

    // Run cleanup with 30-day retention
    const result = await queue.cleanupOldLogs(30);

    assert.equal(result.retentionDays, 30);
    assert.equal(result.deletedLogs, 2);
    assert.equal(result.memoryDeletedLogs, 2);

    // Recent event remains, 35-day and 45-day events are deleted
    assert.equal(queue.recentEvents.length, 1);
    assert.equal(queue.recentEvents[0].id, 'recent-event-1');
  });

  it('defaults log retention period to 30 days and supports custom override', () => {
    assert.equal(queue.logRetentionDays, 30);
    queue.logRetentionDays = 60;
    assert.equal(queue.logRetentionDays, 60);
  });
});
