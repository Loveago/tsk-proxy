import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';

describe('Health & Metrics Endpoints', () => {
  it('GET /health returns 200 with status ok and system metadata', async () => {
    const res = await request(app)
      .get('/health')
      .expect(200);

    assert.equal(res.body.status, 'ok');
    assert.equal(typeof res.body.uptimeSeconds, 'number');
    assert.ok(res.body.timestamp);
    assert.equal(typeof res.body.configuredSites, 'number');
  });

  it('GET /metrics returns 200 with memory and event counters', async () => {
    const res = await request(app)
      .get('/metrics')
      .expect(200);

    assert.equal(typeof res.body.uptimeSeconds, 'number');
    assert.ok(res.body.memory);
    assert.equal(typeof res.body.memory.heapUsedBytes, 'number');
    assert.ok(res.body.events);
    assert.equal(typeof res.body.events.ingested, 'number');
    assert.equal(typeof res.body.events.forwarded, 'number');
    assert.equal(typeof res.body.events.duplicates, 'number');
    assert.equal(typeof res.body.events.retries, 'number');
    assert.equal(typeof res.body.events.deadLetters, 'number');
    assert.equal(typeof res.body.events.unroutable, 'number');
    assert.equal(typeof res.body.events.avgLatencyMs, 'number');
    assert.equal(typeof res.body.events.lastLatencyMs, 'number');
    assert.ok(res.body.queue);
    assert.equal(typeof res.body.queue.activeJobs, 'number');
    assert.equal(typeof res.body.queue.queuedRetries, 'number');
    assert.ok(res.body.callbacks);
    assert.equal(typeof res.body.callbacks.total, 'number');
    assert.equal(typeof res.body.callbacks.success, 'number');
    assert.equal(typeof res.body.callbacks.failed, 'number');
  });
});
