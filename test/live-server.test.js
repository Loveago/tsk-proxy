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
        serverProcess.on('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    if (mockDownstreamServer) {
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
});
