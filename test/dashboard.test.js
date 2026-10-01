import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import request from 'supertest';

import { app } from '../src/app.js';
import { config, setSitesForTesting, reloadSites } from '../src/config/index.js';
import { queueService } from '../src/services/queue.js';
import { paystackService } from '../src/services/paystack.js';
import { generateDashboardToken } from '../src/services/auth.js';

describe('Web UI Dashboard & Simulator Endpoints', () => {
  const testSecret = 'sk_test_dashboard_mock_secret_9988';
  const originalVerify = paystackService.verifyTransaction;
  let authToken = '';

  const authReq = {
    get: (url) => request(app).get(url).set('Authorization', `Bearer ${authToken}`),
    post: (url) => request(app).post(url).set('Authorization', `Bearer ${authToken}`),
    put: (url) => request(app).put(url).set('Authorization', `Bearer ${authToken}`),
    delete: (url) => request(app).delete(url).set('Authorization', `Bearer ${authToken}`),
  };

  beforeEach(async () => {
    authToken = generateDashboardToken({ username: 'admin' });
    config.paystack.secretKey = testSecret;
    config.paystack.webhookSecret = testSecret;
    config.paystack.enableIpWhitelist = false;

    setSitesForTesting({
      lufak: {
        name: 'Lufak Store',
        webhookUrl: 'https://store.lufak.test/webhook',
        callbackUrl: 'https://store.lufak.test/callback',
      },
      saas: {
        name: 'SaaS Platform',
        webhookUrl: 'https://app.saas.test/webhook',
        callbackUrl: 'https://app.saas.test/callback',
      },
      fallback: {
        name: 'Ops Fallback',
        webhookUrl: 'https://ops.fallback.test/webhook',
        callbackUrl: 'https://ops.fallback.test/callback',
      },
    });

    await queueService.clear();
  });

  afterEach(async () => {
    paystackService.verifyTransaction = originalVerify;
    await queueService.clear();
    reloadSites();
  });

  describe('Static UI Dashboard Serving', () => {
    it('GET / serves the dashboard HTML with 200 OK', async () => {
      const res = await request(app)
        .get('/')
        .expect(200);

      assert.match(res.headers['content-type'], /html/);
      assert.match(res.text, /Paystack Multi-Site Proxy/i);
      assert.match(res.text, /Webhook Simulator/i);
      assert.match(res.text, /Live Event Log/i);
    });

    it('GET /dashboard serves the dashboard HTML with 200 OK', async () => {
      const res = await request(app)
        .get('/dashboard')
        .expect(200);

      assert.match(res.headers['content-type'], /html/);
      assert.match(res.text, /Paystack Multi-Site Proxy/i);
    });

    it('ensures all DOM elements queried by dashboard client JS exist in public/index.html', () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const htmlPath = path.resolve(__dirname, '../public/index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // 1. Extract keys defined in `const elements = { ... }`
      const elementsBlockMatch = html.match(/const elements = \{([\s\S]*?)\};/);
      assert.ok(elementsBlockMatch, 'elements definition object should exist in index.html');
      const definedKeys = new Set();
      for (const line of elementsBlockMatch[1].split('\n')) {
        const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*:/);
        if (m) definedKeys.add(m[1]);
      }

      // 2. Extract every elements.<prop> access in the script
      const usageMatches = [...html.matchAll(/elements\.([a-zA-Z0-9_]+)/g)];
      const missingKeys = new Set();
      for (const match of usageMatches) {
        const key = match[1];
        if (!definedKeys.has(key)) {
          missingKeys.add(key);
        }
      }
      assert.deepEqual([...missingKeys], [], `The following properties are accessed via elements.<prop> but not defined in elements: ${[...missingKeys].join(', ')}`);

      // 3. Verify all getElementById static calls exist in HTML
      const idCalls = [...html.matchAll(/getElementById\(['"]([a-zA-Z0-9_\-]+)['"]\)/g)].map(m => m[1]);
      const missingDomIds = idCalls.filter(id => !html.includes(`id="${id}"`) && !html.includes(`id='${id}'`));
      assert.deepEqual(missingDomIds, [], `The following element IDs are queried with getElementById but do not exist in HTML: ${missingDomIds.join(', ')}`);
    });
  });

  describe('Dashboard Authentication & Authorization (/api/v1/dashboard/auth)', () => {
    it('blocks access to /api/v1/dashboard/config with 401 when no token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/dashboard/config')
        .expect(401);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /authentication required/i);
    });

    it('blocks access to /api/v1/dashboard/stats with 401 when no token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/dashboard/stats')
        .expect(401);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /authentication required/i);
    });

    it('blocks access to /api/v1/dashboard/sites with 401 when no token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/dashboard/sites')
        .expect(401);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /authentication required/i);
    });

    it('blocks access with 401 when forged Bearer token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/dashboard/config')
        .set('Authorization', 'Bearer forged-invalid-token')
        .expect(401);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /invalid or expired/i);
    });

    it('POST /api/v1/dashboard/auth/login rejects incorrect username or password with 401', async () => {
      const res = await request(app)
        .post('/api/v1/dashboard/auth/login')
        .send({
          username: 'wrong-admin',
          password: 'wrong-password',
        })
        .expect(401);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /invalid username or password/i);
    });

    it('POST /api/v1/dashboard/auth/login successfully logs in with valid credentials and returns JWT token', async () => {
      const res = await request(app)
        .post('/api/v1/dashboard/auth/login')
        .send({
          username: config.dashboard?.username || 'admin',
          password: config.dashboard?.password || 'paystack-proxy-admin-2026',
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.ok(res.body.token);
      assert.equal(res.body.user.username, config.dashboard?.username || 'admin');
      assert.equal(typeof res.body.expiresIn, 'number');
    });

    it('GET /api/v1/dashboard/auth/me returns authenticated user details with valid token', async () => {
      const res = await request(app)
        .get('/api/v1/dashboard/auth/me')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.user.username, 'admin');
    });

    it('POST /api/v1/dashboard/auth/logout returns success message', async () => {
      const res = await request(app)
        .post('/api/v1/dashboard/auth/logout')
        .expect(200);

      assert.equal(res.body.status, true);
      assert.match(res.body.message, /logged out successfully/i);
    });
  });

  describe('GET /api/v1/dashboard/stats', () => {
    it('returns system health, uptime, memory, and metrics', async () => {
      const res = await authReq
        .get('/api/v1/dashboard/stats')
        .expect(200);

      assert.equal(res.body.status, 'ok');
      assert.equal(typeof res.body.uptimeSeconds, 'number');
      assert.ok(res.body.uptimeHuman);
      assert.ok(res.body.metrics);
      assert.equal(typeof res.body.metrics.ingested, 'number');
      assert.equal(typeof res.body.metrics.forwarded, 'number');
      assert.equal(typeof res.body.metrics.duplicates, 'number');
      assert.equal(typeof res.body.metrics.retries, 'number');
      assert.equal(typeof res.body.metrics.deadLetters, 'number');
      assert.equal(typeof res.body.metrics.unroutable, 'number');
      assert.equal(typeof res.body.metrics.callbacksTotal, 'number');
      assert.equal(typeof res.body.metrics.callbacksSuccess, 'number');
      assert.equal(typeof res.body.metrics.callbacksFailed, 'number');
      assert.equal(typeof res.body.metrics.activeJobs, 'number');
      assert.equal(typeof res.body.metrics.queuedRetries, 'number');
      assert.equal(typeof res.body.metrics.avgLatencyMs, 'number');
      assert.equal(typeof res.body.metrics.lastLatencyMs, 'number');
      assert.equal(typeof res.body.sitesCount, 'number');
      assert.equal(typeof res.body.storageType, 'string');
      assert.equal(typeof res.body.ipWhitelistEnabled, 'boolean');
      assert.equal(typeof res.body.secretConfigured, 'boolean');
      assert.equal(typeof res.body.webhookSecretConfigured, 'boolean');
      assert.equal(typeof res.body.sharedSecretConfigured, 'boolean');
      assert.equal(typeof res.body.databaseConfigured, 'boolean');
      assert.ok(res.body.memory);
      assert.ok(res.body.memory.heapUsedMb);
      assert.ok(res.body.memory.heapTotalMb);
      assert.ok(res.body.memory.rssMb);
      assert.equal(typeof res.body.memory.heapPercent, 'number');
      assert.equal(typeof res.body.memory.rssPercent, 'number');
    });
  });

  describe('GET /api/v1/dashboard/events/stream (SSE)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app)
        .get('/api/v1/dashboard/events/stream')
        .expect(401);
    });

    it('establishes SSE stream and receives initial stats event snapshot', (done) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        const req = http.get(
          `http://127.0.0.1:${port}/api/v1/dashboard/events/stream?token=${encodeURIComponent(authToken)}`,
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers['content-type'], /text\/event-stream/);
            let chunks = '';
            res.on('data', (chunk) => {
              chunks += chunk.toString();
              if (chunks.includes('event: stats')) {
                assert.ok(chunks.includes('"status":"ok"'));
                assert.ok(chunks.includes('metrics'));
                req.destroy();
                server.close(done);
              }
            });
          }
        );
        req.on('error', (err) => {
          server.close(() => done(err));
        });
      });
    });
  });

  describe('GET /api/v1/dashboard/sites', () => {
    it('returns configured child sites list with names and URLs', async () => {
      const res = await authReq
        .get('/api/v1/dashboard/sites')
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.count, 3);
      assert.ok(Array.isArray(res.body.sites));

      const lufak = res.body.sites.find(s => s.key === 'lufak');
      assert.ok(lufak);
      assert.equal(lufak.name, 'Lufak Store');
      assert.equal(lufak.webhookUrl, 'https://store.lufak.test/webhook');
      assert.equal(lufak.callbackUrl, 'https://store.lufak.test/callback');
    });

    it('POST /api/v1/dashboard/sites/:key/ping returns reachability status for non-existent site', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/sites/nonexistent/ping')
        .expect(404);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /not found/i);
    });
  });

  describe('POST /api/v1/dashboard/simulate (Webhook Simulator)', () => {
    it('simulates charge.success webhook, calculates HMAC-SHA512, and resolves site', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({
          eventType: 'charge.success',
          siteKey: 'lufak',
          reference: 'lufak_sim_test_001',
          amount: 75000,
          email: 'sim-user@example.com',
          routingMechanism: 'reference',
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.simulated, true);
      assert.equal(res.body.resolvedSite, 'lufak');
      assert.equal(res.body.matchType, 'reference');
      assert.equal(res.body.targetUrl, 'https://store.lufak.test/webhook');
      assert.ok(res.body.signature);
      assert.ok(res.body.curlExample);
      assert.match(res.body.curlExample, /curl -X POST/);

      // Verify HMAC SHA512 matches expected
      const expectedSig = crypto
        .createHmac('sha512', testSecret)
        .update(JSON.stringify(res.body.payload))
        .digest('hex');
      assert.equal(res.body.signature, expectedSig);

      // Verify event appears in recent events
      const eventsRes = await authReq
        .get('/api/v1/dashboard/events')
        .expect(200);

      assert.ok(eventsRes.body.count > 0);
      const found = eventsRes.body.events.find(e => e.reference === 'lufak_sim_test_001');
      assert.ok(found);
      assert.equal(found.siteKey, 'lufak');
    });

    describe('GET /api/v1/dashboard/events pagination and filtering', () => {
      beforeEach(async () => {
        queueService.recordExternalEvent({
          eventKey: 'charge.success:ref_page_001',
          eventType: 'charge.success',
          reference: 'ref_page_001',
          siteKey: 'lufak',
          status: 'SUCCESS',
        });
        queueService.recordExternalEvent({
          eventKey: 'charge.success:ref_page_002',
          eventType: 'charge.success',
          reference: 'ref_page_002',
          siteKey: 'saas',
          status: 'SUCCESS',
        });
        queueService.recordExternalEvent({
          eventKey: 'charge.success:ref_page_003',
          eventType: 'charge.success',
          reference: 'ref_page_003',
          siteKey: 'lufak',
          status: 'UNROUTABLE',
        });
        queueService.recordExternalEvent({
          eventKey: 'subscription.create:ref_page_004',
          eventType: 'subscription.create',
          reference: 'ref_page_004',
          siteKey: 'saas',
          status: 'DUPLICATE',
        });
      });

      it('returns pagination metadata (page, limit, total, totalPages)', async () => {
        const res = await authReq
          .get('/api/v1/dashboard/events?page=1&limit=2')
          .expect(200);

        assert.equal(res.body.status, true);
        assert.equal(res.body.page, 1);
        assert.equal(res.body.limit, 2);
        assert.equal(res.body.total, 4);
        assert.equal(res.body.totalPages, 2);
        assert.equal(res.body.events.length, 2);
      });

      it('navigates to page 2 without overlapping items', async () => {
        const page1 = await authReq
          .get('/api/v1/dashboard/events?page=1&limit=2')
          .expect(200);
        const page2 = await authReq
          .get('/api/v1/dashboard/events?page=2&limit=2')
          .expect(200);

        assert.equal(page1.body.events.length, 2);
        assert.equal(page2.body.events.length, 2);
        const page1Refs = page1.body.events.map(e => e.reference);
        const page2Refs = page2.body.events.map(e => e.reference);
        for (const r of page1Refs) {
          assert.ok(!page2Refs.includes(r), `Page 2 should not contain ${r} from Page 1`);
        }
      });

      it('filters events by status (SUCCESS matches SUCCESS)', async () => {
        const res = await authReq
          .get('/api/v1/dashboard/events?status=SUCCESS')
          .expect(200);

        assert.equal(res.body.total, 2);
        for (const ev of res.body.events) {
          assert.equal(ev.status, 'SUCCESS');
        }
      });

      it('filters events by siteKey', async () => {
        const res = await authReq
          .get('/api/v1/dashboard/events?site=saas')
          .expect(200);

        assert.equal(res.body.total, 2);
        for (const ev of res.body.events) {
          assert.equal(ev.siteKey, 'saas');
        }
      });

      it('filters events by search query', async () => {
        const res = await authReq
          .get('/api/v1/dashboard/events?search=ref_page_003')
          .expect(200);

        assert.equal(res.body.total, 1);
        assert.equal(res.body.events[0].reference, 'ref_page_003');
      });
    });

    it('simulates webhook routing via metadata.origin_site', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({
          eventType: 'subscription.create',
          siteKey: 'saas',
          reference: 'generic_ref_9999',
          routingMechanism: 'metadata',
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.resolvedSite, 'saas');
      assert.equal(res.body.matchType, 'metadata');
      assert.equal(res.body.targetUrl, 'https://app.saas.test/webhook');
    });

    it('detects duplicate events when simulating identical eventKey', async () => {
      const payload = {
        event: 'charge.success',
        data: {
          id: 55555,
          reference: 'lufak_dedupe_sim_test',
          amount: 20000,
        },
      };

      // First submission
      const res1 = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({ customPayload: payload })
        .expect(200);

      assert.equal(res1.body.duplicate, undefined);

      // Second submission with exact same event & identifier
      const res2 = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({ customPayload: payload })
        .expect(200);

      assert.equal(res2.body.duplicate, true);
      assert.match(res2.body.message, /Duplicate event detected/i);
    });

    it('handles unroutable simulated event when no site matches and fallback removed', async () => {
      setSitesForTesting({
        lufak: {
          name: 'Lufak Store',
          webhookUrl: 'https://store.lufak.test/webhook',
          callbackUrl: 'https://store.lufak.test/callback',
        },
      });

      const res = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({
          eventType: 'charge.success',
          reference: 'completely_unknown_ref_123',
          routingMechanism: 'none',
        })
        .expect(200);

      assert.equal(res.body.unroutable, true);
      assert.match(res.body.message, /unroutable/i);
    });

    it('returns 400 for malformed custom JSON payload in simulator', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({ customPayload: '{ invalid_json' })
        .expect(400);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /Malformed custom JSON payload/i);
    });

    it('returns 400 when custom payload lacks an event field or is not an object', async () => {
      const res1 = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({ customPayload: { data: { reference: 'test_123' } } })
        .expect(400);

      assert.equal(res1.body.status, false);
      assert.match(res1.body.message, /event/i);

      const res2 = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({ customPayload: ['an_array'] })
        .expect(400);

      assert.equal(res2.body.status, false);
      assert.match(res2.body.message, /valid JSON object/i);
    });

    it('properly escapes single quotes in simulated payload curl example', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({
          eventType: 'charge.success',
          siteKey: 'lufak',
          email: "customer.o'connor@example.com",
          reference: "lufak_order_o'reilly_99",
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.ok(res.body.curlExample);
      assert.ok(res.body.curlExample.includes("'\\''"));
    });
  });

  describe('GET /api/v1/dashboard/verify/:reference (Transaction Verification Tool)', () => {
    it('queries verification API and resolves child site from reference prefix', async () => {
      paystackService.verifyTransaction = async (reference) => ({
        success: true,
        data: {
          id: 991122,
          reference,
          amount: 150000,
          status: 'success',
          gateway_response: 'Successful',
          channel: 'card',
          customer: { email: 'buyer@lufak.com' },
        },
      });

      const res = await authReq
        .get('/api/v1/dashboard/verify/lufak_order_7788')
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.reference, 'lufak_order_7788');
      assert.ok(res.body.resolvedSite);
      assert.equal(res.body.resolvedSite.key, 'lufak');
      assert.equal(res.body.resolvedSite.matchType, 'reference');
      assert.equal(res.body.verification.success, true);
      assert.equal(res.body.verification.data.amount, 150000);
    });

    it('returns 400 when reference is empty or whitespace', async () => {
      const res = await authReq
        .get('/api/v1/dashboard/verify/%20')
        .expect(400);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /reference is required/i);
    });
  });

  describe('POST /api/v1/dashboard/calculate-signature', () => {
    it('computes HMAC-SHA512 signature for a given payload', async () => {
      const payload = { event: 'charge.success', data: { id: 1234 } };
      const secret = 'custom_secret_key_abc';

      const expected = crypto
        .createHmac('sha512', secret)
        .update(Buffer.from(JSON.stringify(payload), 'utf8'))
        .digest('hex');

      const res = await authReq
        .post('/api/v1/dashboard/calculate-signature')
        .send({ payload, secret })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.signature, expected);
    });

    it('returns 400 when payload is missing', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/calculate-signature')
        .send({})
        .expect(400);

      assert.equal(res.body.status, false);
      assert.match(res.body.message, /Payload is required/i);
    });
  });

  describe('GET & POST /api/v1/dashboard/config', () => {
    const envPath = path.resolve('.env');
    const backupEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null;
    const backupConfig = {
      secretKey: config.paystack.secretKey,
      enableIpWhitelist: config.paystack.enableIpWhitelist,
      timeoutMs: config.proxy.timeoutMs,
      maxRetries: config.proxy.maxRetries,
    };

    afterEach(() => {
      if (backupEnv !== null) {
        fs.writeFileSync(envPath, backupEnv, 'utf8');
      }
      config.paystack.secretKey = backupConfig.secretKey;
      config.paystack.enableIpWhitelist = backupConfig.enableIpWhitelist;
      config.proxy.timeoutMs = backupConfig.timeoutMs;
      config.proxy.maxRetries = backupConfig.maxRetries;
      process.env.PAYSTACK_SECRET_KEY = backupConfig.secretKey;
      process.env.ENABLE_IP_WHITELIST = String(backupConfig.enableIpWhitelist);
    });

    it('returns runtime configuration via GET /api/v1/dashboard/config', async () => {
      const res = await authReq
        .get('/api/v1/dashboard/config')
        .expect(200);

      assert.equal(res.body.status, true);
      assert.ok(res.body.config);
      assert.ok(res.body.config.paystack);
      assert.ok(res.body.config.proxy);
      assert.ok(res.body.config.notifications);
      assert.equal(res.body.config.paystack.secretKey, testSecret);
    });

    it('updates and immediately applies config without restart via POST /api/v1/dashboard/config', async () => {
      const newSecret = 'sk_test_dynamically_updated_key_8899';
      const res = await authReq
        .post('/api/v1/dashboard/config')
        .send({
          paystack: {
            secretKey: newSecret,
            enableIpWhitelist: true,
          },
          proxy: {
            timeoutMs: 12000,
            maxRetries: 5,
          },
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(config.paystack.secretKey, newSecret);
      assert.equal(config.paystack.enableIpWhitelist, true);
      assert.equal(config.proxy.timeoutMs, 12000);
      assert.equal(config.proxy.maxRetries, 5);

      // Verify immediate reflection in GET /config
      const checkRes = await authReq
        .get('/api/v1/dashboard/config')
        .expect(200);

      assert.equal(checkRes.body.config.paystack.secretKey, newSecret);
      assert.equal(checkRes.body.config.paystack.enableIpWhitelist, true);
      assert.equal(checkRes.body.config.proxy.timeoutMs, 12000);
      assert.equal(checkRes.body.config.proxy.maxRetries, 5);
      assert.equal(queueService.maxRetries, 5);
    });

    it('updates queueService and settings dynamically via top-level camelCase fields', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/config')
        .send({
          maxRetries: 7,
          timeoutMs: 9500,
          retryDelays: [1000, 2000],
          sqliteDbPath: './data/custom.db',
          sitesConfigPath: './config/sites.json',
          logLevel: 'warn',
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(config.proxy.maxRetries, 7);
      assert.equal(queueService.maxRetries, 7);
      assert.equal(config.proxy.timeoutMs, 9500);
      assert.deepEqual(queueService.retryDelays, [1000, 2000]);
      assert.equal(queueService.sqliteDbPath, './data/custom.db');
      assert.equal(config.logLevel, 'warn');
    });

    it('correctly sets and preserves maxRetries = 0 without reverting to 4', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/config')
        .send({
          proxy: {
            maxRetries: 0,
          },
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(config.proxy.maxRetries, 0);
      assert.equal(queueService.maxRetries, 0);

      const checkRes = await authReq.get('/api/v1/dashboard/config').expect(200);
      assert.equal(checkRes.body.config.proxy.maxRetries, 0);
    });

    it('immediately reloads sites when SITES_CONFIG_PATH is changed via POST /config', async () => {
      const tempSitesPath = path.resolve('config/temp-test-sites.json');
      fs.writeFileSync(
        tempSitesPath,
        JSON.stringify({
          sites: {
            customtest: {
              name: 'Custom Test App',
              webhookUrl: 'https://custom.test/hook',
            },
          },
        }),
        'utf8'
      );

      try {
        const res = await authReq
          .post('/api/v1/dashboard/config')
          .send({
            server: {
              sitesConfigPath: './config/temp-test-sites.json',
            },
          })
          .expect(200);

        assert.equal(res.body.status, true);
        assert.equal(config.sitesConfigPath, './config/temp-test-sites.json');

        // Check if sites endpoint reflects the newly loaded site immediately
        const sitesRes = await authReq.get('/api/v1/dashboard/sites').expect(200);
        assert.ok(sitesRes.body.sites.some(s => s.key === 'customtest'));
      } finally {
        if (fs.existsSync(tempSitesPath)) {
          fs.unlinkSync(tempSitesPath);
        }
        config.sitesConfigPath = './config/sites.json';
        reloadSites();
      }
    });
  });

  describe('Sites CRUD Management (POST, PUT, DELETE /api/v1/dashboard/sites)', () => {
    const sitesJsonPath = path.resolve('config/sites.json');
    const backupSites = fs.readFileSync(sitesJsonPath, 'utf8');

    afterEach(() => {
      fs.writeFileSync(sitesJsonPath, backupSites, 'utf8');
      reloadSites();
    });

    it('POST /api/v1/dashboard/sites creates a new child site', async () => {
      const res = await authReq
        .post('/api/v1/dashboard/sites')
        .send({
          key: 'test_store',
          name: 'Test Store Dynamic',
          webhookUrl: 'https://teststore.com/webhook',
          callbackUrl: 'https://teststore.com/callback',
          secret: 'test_secret_123',
        })
        .expect(201);

      assert.equal(res.body.status, true);
      assert.equal(res.body.site.key, 'test_store');
      assert.equal(res.body.site.name, 'Test Store Dynamic');

      const sitesRes = await authReq.get('/api/v1/dashboard/sites').expect(200);
      const found = sitesRes.body.sites.find(s => s.key === 'test_store');
      assert.ok(found);
      assert.equal(found.webhookUrl, 'https://teststore.com/webhook');
    });

    it('POST /api/v1/dashboard/sites rejects invalid key or duplicate', async () => {
      const res1 = await authReq
        .post('/api/v1/dashboard/sites')
        .send({ key: 'invalid space key', webhookUrl: 'https://foo.com/hook' })
        .expect(400);
      assert.equal(res1.body.status, false);

      const res2 = await authReq
        .post('/api/v1/dashboard/sites')
        .send({ key: 'lufak', webhookUrl: 'https://foo.com/hook' })
        .expect(409);
      assert.equal(res2.body.status, false);
    });

    it('PUT /api/v1/dashboard/sites/:id updates an existing site', async () => {
      const res = await authReq
        .put('/api/v1/dashboard/sites/lufak')
        .send({
          name: 'Updated Lufak Store',
          webhookUrl: 'https://updated.lufak.com/webhook',
        })
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.site.name, 'Updated Lufak Store');
      assert.equal(res.body.site.webhookUrl, 'https://updated.lufak.com/webhook');
    });

    it('DELETE /api/v1/dashboard/sites/:id deletes an existing site', async () => {
      const res = await authReq
        .delete('/api/v1/dashboard/sites/lufak')
        .expect(200);

      assert.equal(res.body.status, true);

      const check = await authReq.get('/api/v1/dashboard/sites').expect(200);
      assert.equal(check.body.sites.some(s => s.key === 'lufak'), false);
    });

    it('creates missing parent directories when adding a site to a new directory path', async () => {
      const customSubdirPath = './config/nested_dir/sites.json';
      const fullCustomSubdirPath = path.resolve(customSubdirPath);
      config.sitesConfigPath = customSubdirPath;

      try {
        const res = await authReq
          .post('/api/v1/dashboard/sites')
          .send({
            key: 'nested_site',
            name: 'Nested Site',
            webhookUrl: 'https://nested.example.com/webhook',
          })
          .expect(201);

        assert.equal(res.body.status, true);
        assert.ok(fs.existsSync(fullCustomSubdirPath));
      } finally {
        const nestedDir = path.dirname(fullCustomSubdirPath);
        if (fs.existsSync(nestedDir)) {
          fs.rmSync(nestedDir, { recursive: true, force: true });
        }
        config.sitesConfigPath = './config/sites.json';
        reloadSites();
      }
    });

    it('POST and PUT /api/v1/dashboard/sites support referencePrefixes, referencePatterns, and flowRoutes', async () => {
      // 1. Create with smart reference rules and flow routes
      const createRes = await authReq
        .post('/api/v1/dashboard/sites')
        .send({
          key: 'smart_store',
          name: 'Smart Ghana Store',
          webhookUrl: 'https://smart.store.gh/webhook',
          callbackUrl: 'https://smart.store.gh/callback',
          referencePrefixes: ['tsk_wallet', 'tsk_store'],
          referencePatterns: ['^tsk_(wallet|store)_.*', '^gh_.*'],
          flowRoutes: {
            wallet: 'https://smart.store.gh/wallet/success',
            checkout: 'https://smart.store.gh/checkout/done',
          },
        })
        .expect(201);

      assert.equal(createRes.body.status, true);
      assert.deepEqual(createRes.body.site.referencePrefixes, ['tsk_wallet', 'tsk_store']);
      assert.deepEqual(createRes.body.site.referencePatterns, ['^tsk_(wallet|store)_.*', '^gh_.*']);
      assert.equal(createRes.body.site.flowRoutes.wallet, 'https://smart.store.gh/wallet/success');

      // 2. Verify GET /sites includes the new fields
      const getRes = await authReq.get('/api/v1/dashboard/sites').expect(200);
      const found = getRes.body.sites.find(s => s.key === 'smart_store');
      assert.ok(found);
      assert.deepEqual(found.referencePrefixes, ['tsk_wallet', 'tsk_store']);
      assert.deepEqual(found.referencePatterns, ['^tsk_(wallet|store)_.*', '^gh_.*']);
      assert.equal(found.flowRoutes.wallet, 'https://smart.store.gh/wallet/success');

      // 3. Update with new rules
      const updateRes = await authReq
        .put('/api/v1/dashboard/sites/smart_store')
        .send({
          referencePrefixes: 'topup, recharge',
          referencePatterns: '^topup_.*',
          flowRoutes: { topup: 'https://smart.store.gh/topup/success' },
        })
        .expect(200);

      assert.equal(updateRes.body.status, true);
      assert.deepEqual(updateRes.body.site.referencePrefixes, ['topup', 'recharge']);
      assert.deepEqual(updateRes.body.site.referencePatterns, ['^topup_.*']);
      assert.equal(updateRes.body.site.flowRoutes.topup, 'https://smart.store.gh/topup/success');

      // Clean up
      await authReq.delete('/api/v1/dashboard/sites/smart_store').expect(200);
    });

    it('POST /api/v1/dashboard/simulate generates Ghana GHS currency and +233 customer phone', async () => {
      const simRes = await authReq
        .post('/api/v1/dashboard/simulate')
        .send({
          siteKey: 'lufak',
          amount: 5000,
        })
        .expect(200);

      assert.equal(simRes.body.status, true);
      assert.equal(simRes.body.payload.data.currency, 'GHS');
      assert.equal(simRes.body.payload.data.amount, 5000);
      assert.match(simRes.body.payload.data.customer.phone, /^\+233/);
    });

    it('GET /api/v1/dashboard/verify/:reference returns enriched resolvedSite with smart matching info', async () => {
      paystackService.verifyTransaction = async (reference) => ({
        success: true,
        data: {
          status: 'success',
          reference,
          amount: 50000,
          currency: 'GHS',
        },
      });

      const res = await authReq
        .get('/api/v1/dashboard/verify/lufak_order_9981')
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.reference, 'lufak_order_9981');
      assert.ok(res.body.resolvedSite);
      assert.equal(res.body.resolvedSite.key, 'lufak');
      assert.ok(Array.isArray(res.body.resolvedSite.referencePrefixes));
      assert.ok(Array.isArray(res.body.resolvedSite.referencePatterns));
      assert.ok(res.body.resolvedSite.flowRoutes);
      assert.ok(res.body.resolvedSite.resolvedCallbackUrl);
    });
  });
});

