import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { computePaystackSignature } from '../src/middleware/auth.js';
import { computeProxySignature } from '../src/services/dispatcher.js';
import { paystackService } from '../src/services/paystack.js';

describe('Standalone Server Process Live E2E Verification', () => {
  const TEST_PORT = 3005;
  const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`;
  const LIVE_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_4ea66408f423b58eea1a7a2b1f0aadc9f99618bb';
  const TEST_SITES_PATH = path.resolve('config/test-live-sites.json');
  let serverProcess;
  let mockDownstreamServer;
  let mockDownstreamPort;
  let mockDownstreamBaseUrl;
  const receivedDownstreamRequests = [];

  before(async () => {
    // Start local mock downstream receiver
    await new Promise(resolve => {
      mockDownstreamServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          receivedDownstreamRequests.push({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: body ? JSON.parse(body) : null,
            rawBody: body,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      mockDownstreamServer.listen(0, '127.0.0.1', () => {
        mockDownstreamPort = mockDownstreamServer.address().port;
        mockDownstreamBaseUrl = `http://127.0.0.1:${mockDownstreamPort}`;
        resolve();
      });
    });

    // Write temporary test sites configuration pointing to mock downstream server
    fs.writeFileSync(
      TEST_SITES_PATH,
      JSON.stringify(
        {
          sites: {
            lufak: {
              name: 'Lufak Store',
              webhookUrl: `${mockDownstreamBaseUrl}/lufak/webhook`,
              callbackUrl: `${mockDownstreamBaseUrl}/lufak/checkout/complete`,
              secret: 'lufak_live_proc_secret',
            },
            saas: {
              name: 'SaaS Platform',
              webhookUrl: `${mockDownstreamBaseUrl}/saas/webhook`,
              callbackUrl: `${mockDownstreamBaseUrl}/saas/billing/verify`,
              secret: 'saas_live_proc_secret',
            },
          },
        },
        null,
        2
      )
    );

    // Spawn server process
    serverProcess = spawn('node', ['src/server.js'], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PAYSTACK_SECRET_KEY: LIVE_KEY,
        PAYSTACK_WEBHOOK_SECRET: LIVE_KEY,
        ENABLE_IP_WHITELIST: 'false',
        QUEUE_STORAGE_TYPE: 'memory',
        SITES_CONFIG_PATH: TEST_SITES_PATH,
        DASHBOARD_PASSWORD: 'test-admin-live-pass',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait until server is listening
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await axios.get(`${SERVER_URL}/health`, { timeout: 500 });
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    assert.ok(ready, 'Standalone server failed to start within timeout');
  });

  after(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try {
            serverProcess.kill('SIGKILL');
          } catch {}
          resolve();
        }, 1500);
        serverProcess.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (mockDownstreamServer) {
      if (typeof mockDownstreamServer.closeAllConnections === 'function') {
        mockDownstreamServer.closeAllConnections();
      }
      await new Promise(resolve => mockDownstreamServer.close(resolve));
    }
    if (fs.existsSync(TEST_SITES_PATH)) {
      try {
        fs.unlinkSync(TEST_SITES_PATH);
      } catch {}
    }
  });

  it('GET /health returns 200 on running server process', async () => {
    const res = await axios.get(`${SERVER_URL}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
  });

  it('verifies live Paystack transaction over HTTP on running server', async () => {
    const ref = `lufak_live_srv_${Date.now()}`;
    // 1. Initialize real transaction on Paystack using paystackService
    const initRes = await paystackService.initializeTransaction({
      email: 'server-live-test@example.com',
      amount: 50000,
      reference: ref,
      metadata: {
        origin_site: 'lufak',
      },
    });
    assert.equal(initRes.success, true);
    assert.equal(initRes.data.reference, ref);

    // 2. Query running server callback endpoint without following redirects
    const res = await axios.get(`${SERVER_URL}/api/v1/paystack/callback?reference=${ref}`, {
      maxRedirects: 0,
      validateStatus: status => status === 302,
    });

    assert.equal(res.status, 302);
    const location = res.headers.location;
    assert.ok(location);
    assert.match(location, /checkout\/complete/);
    assert.match(location, new RegExp(ref));
    assert.match(location, /status=abandoned/);
  });

  it('ingests live HMAC signed webhook and deduplicates on running server', async () => {
    const eventId = Date.now();
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: eventId,
        reference: `lufak_srv_wh_${eventId}`,
        amount: 80000,
        metadata: { origin_site: 'lufak' },
      },
    });

    const signature = computePaystackSignature(payload, LIVE_KEY);

    // First POST
    const res1 = await axios.post(`${SERVER_URL}/api/v1/paystack/webhook`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
      },
    });

    assert.equal(res1.status, 200);
    assert.equal(res1.data.status, true);
    assert.equal(res1.data.message, 'Event queued for dispatch');
    assert.equal(res1.data.site, 'lufak');

    // Wait for downstream forwarding
    await new Promise(r => setTimeout(r, 150));
    const matching = receivedDownstreamRequests.find(r => r.body?.data?.id === eventId);
    assert.ok(matching, 'Running server did not forward webhook downstream');
    assert.equal(matching.headers['x-target-site'], 'lufak');
    assert.equal(matching.headers['x-paystack-signature'], signature);
    const expectedProxySig = computeProxySignature(matching.rawBody, 'lufak_live_proc_secret');
    assert.equal(matching.headers['x-proxy-signature'], expectedProxySig);

    const initialDownstreamCount = receivedDownstreamRequests.length;

    // Duplicate POST
    const res2 = await axios.post(`${SERVER_URL}/api/v1/paystack/webhook`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
      },
    });

    assert.equal(res2.status, 200);
    assert.equal(res2.data.status, true);
    assert.equal(res2.data.duplicate, true);

    await new Promise(r => setTimeout(r, 150));
    assert.equal(receivedDownstreamRequests.length, initialDownstreamCount, 'Duplicate webhook was wrongly dispatched downstream');
  });

  it('authenticates to dashboard and verifies all homepage metrics and system gauges on running server', async () => {
    // 1. Authenticate to dashboard
    const loginRes = await axios.post(`${SERVER_URL}/api/v1/dashboard/auth/login`, {
      username: 'admin',
      password: 'test-admin-live-pass',
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.data.status, true);
    assert.ok(loginRes.data.token);
    const token = loginRes.data.token;

    // 2. Fetch stats
    const statsRes = await axios.get(`${SERVER_URL}/api/v1/dashboard/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.data.status, 'ok');
    assert.ok(statsRes.data.metrics);
    assert.equal(typeof statsRes.data.metrics.ingested, 'number');
    assert.equal(typeof statsRes.data.metrics.forwarded, 'number');
    assert.equal(typeof statsRes.data.metrics.duplicates, 'number');
    assert.equal(typeof statsRes.data.metrics.retries, 'number');
    assert.equal(typeof statsRes.data.metrics.deadLetters, 'number');
    assert.equal(typeof statsRes.data.metrics.unroutable, 'number');
    assert.equal(typeof statsRes.data.metrics.callbacksTotal, 'number');
    assert.equal(typeof statsRes.data.metrics.callbacksSuccess, 'number');
    assert.equal(typeof statsRes.data.metrics.callbacksFailed, 'number');
    assert.equal(typeof statsRes.data.metrics.activeJobs, 'number');
    assert.equal(typeof statsRes.data.metrics.queuedRetries, 'number');
    assert.equal(typeof statsRes.data.metrics.avgLatencyMs, 'number');
    assert.equal(typeof statsRes.data.metrics.lastLatencyMs, 'number');

    // Badges & Gauges
    assert.equal(typeof statsRes.data.uptimeHuman, 'string');
    assert.equal(typeof statsRes.data.nodeVersion, 'string');
    assert.equal(statsRes.data.storageType, 'memory');
    assert.equal(typeof statsRes.data.ipWhitelistEnabled, 'boolean');
    assert.equal(typeof statsRes.data.secretConfigured, 'boolean');
    assert.equal(typeof statsRes.data.webhookSecretConfigured, 'boolean');

    // Memory
    assert.ok(statsRes.data.memory);
    assert.ok(statsRes.data.memory.heapUsedMb);
    assert.ok(statsRes.data.memory.heapTotalMb);
    assert.ok(statsRes.data.memory.rssMb);
    assert.equal(typeof statsRes.data.memory.heapPercent, 'number');
    assert.equal(typeof statsRes.data.memory.rssPercent, 'number');

    // 3. Verify /metrics endpoint
    const metricsRes = await axios.get(`${SERVER_URL}/metrics`);
    assert.equal(metricsRes.status, 200);
    assert.ok(metricsRes.data.events);
    assert.equal(typeof metricsRes.data.events.unroutable, 'number');
    assert.equal(typeof metricsRes.data.events.avgLatencyMs, 'number');
    assert.equal(typeof metricsRes.data.events.lastLatencyMs, 'number');
    assert.ok(metricsRes.data.queue);
    assert.ok(metricsRes.data.callbacks);

    // 4. Verify SSE stream on running standalone server
    const sseRes = await axios.get(`${SERVER_URL}/api/v1/dashboard/events/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'stream',
      timeout: 3000,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers['content-type'], /text\/event-stream/);
    await new Promise((resolve) => {
      sseRes.data.on('data', chunk => {
        const text = chunk.toString();
        if (text.includes('event: stats')) {
          assert.ok(text.includes('"status":"ok"'));
          sseRes.data.destroy();
          resolve();
        }
      });
      sseRes.data.on('error', () => resolve());
    });
  });
});
