import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import request from 'supertest';

import { app } from '../src/app.js';
import { config, setSitesForTesting, reloadSites } from '../src/config/index.js';
import { queueService } from '../src/services/queue.js';
import { computePaystackSignature } from '../src/middleware/auth.js';
import { computeProxySignature } from '../src/services/dispatcher.js';
import { paystackService } from '../src/services/paystack.js';

describe('Real Paystack API & Live Test Key End-to-End Tests', () => {
  const LIVE_TEST_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_4ea66408f423b58eea1a7a2b1f0aadc9f99618bb';
  let mockDownstreamServer;
  let mockDownstreamPort;
  let mockDownstreamBaseUrl;
  const receivedDownstreamRequests = [];

  before(async () => {
    // Confirm test key is configured
    assert.ok(LIVE_TEST_KEY, 'PAYSTACK_SECRET_KEY must be provided');
    assert.match(LIVE_TEST_KEY, /^sk_test_[0-9a-f]{40}$/i, 'Must be valid Paystack test key');

    // Ensure config uses the live key
    config.paystack.secretKey = LIVE_TEST_KEY;
    config.paystack.webhookSecret = LIVE_TEST_KEY;
    config.paystack.enableIpWhitelist = false;

    // Start local mock downstream HTTP server to receive dispatched webhooks and callbacks
    await new Promise((resolve) => {
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
          res.end(JSON.stringify({ received: true }));
        });
      });

      mockDownstreamServer.listen(0, '127.0.0.1', () => {
        mockDownstreamPort = mockDownstreamServer.address().port;
        mockDownstreamBaseUrl = `http://127.0.0.1:${mockDownstreamPort}`;
        resolve();
      });
    });

    // Configure test sites pointing to our mock downstream receiver
    setSitesForTesting({
      lufak: {
        name: 'Lufak E-Commerce Store',
        webhookUrl: `${mockDownstreamBaseUrl}/lufak/webhook`,
        callbackUrl: `${mockDownstreamBaseUrl}/lufak/checkout/complete`,
        secret: 'lufak_internal_secret_key_e2e',
      },
      saas: {
        name: 'SaaS Platform Billing',
        webhookUrl: `${mockDownstreamBaseUrl}/saas/webhook`,
        callbackUrl: `${mockDownstreamBaseUrl}/saas/billing/verify`,
        secret: 'saas_internal_secret_key_e2e',
      },
      fallback: {
        name: 'Default Fallback Sink',
        webhookUrl: `${mockDownstreamBaseUrl}/fallback/webhook`,
        callbackUrl: `${mockDownstreamBaseUrl}/fallback/callback`,
        secret: 'fallback_internal_secret_key_e2e',
      },
    });

    await queueService.clear();
  });

  after(async () => {
    await queueService.clear();
    reloadSites();
    if (mockDownstreamServer) {
      await new Promise(resolve => mockDownstreamServer.close(resolve));
    }
  });

  describe('1. Live Paystack API Transaction Initialization & Verification', () => {
    it('initializes a transaction directly with live Paystack API using the test key', async () => {
      const reference = `lufak_e2e_live_${Date.now()}`;
      const initPayload = {
        email: 'e2e-tester@example.com',
        amount: 250000, // 2,500 GHS in pesewas
        currency: 'GHS',
        reference,
        metadata: {
          origin_site: 'lufak',
          customer_id: 'cust_98765',
        },
      };

      const response = await axios.post('https://api.paystack.co/transaction/initialize', initPayload, {
        headers: {
          Authorization: `Bearer ${LIVE_TEST_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      assert.equal(response.status, 200);
      assert.equal(response.data.status, true);
      assert.ok(response.data.data.authorization_url);
      assert.ok(response.data.data.access_code);
      assert.equal(response.data.data.reference, reference);
    });

    it('verifies live Paystack transaction through proxy callback and redirects to metadata-resolved child site', async () => {
      const reference = `lufak_e2e_cb_${Date.now()}`;
      // Initialize transaction on Paystack
      await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: 'e2e-callback@example.com',
          amount: 150000,
          reference,
          metadata: {
            origin_site: 'lufak',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${LIVE_TEST_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Hit proxy callback endpoint
      const res = await request(app)
        .get(`/api/v1/paystack/callback?reference=${reference}`)
        .expect(302);

      const location = res.headers.location;
      assert.ok(location, 'Expected 302 redirect Location header');
      const redirectUrl = new URL(location);

      assert.equal(redirectUrl.origin, mockDownstreamBaseUrl);
      assert.equal(redirectUrl.pathname, '/lufak/checkout/complete');
      assert.equal(redirectUrl.searchParams.get('reference'), reference);
      assert.equal(redirectUrl.searchParams.get('status'), 'abandoned');
    });

    it('verifies live transaction routed via reference prefix (saas_...) without metadata', async () => {
      const reference = `saas_e2e_cb_${Date.now()}`;
      // Initialize transaction on Paystack without origin_site in metadata
      await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: 'e2e-saas@example.com',
          amount: 300000,
          reference,
        },
        {
          headers: {
            Authorization: `Bearer ${LIVE_TEST_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Hit proxy callback endpoint
      const res = await request(app)
        .get(`/api/v1/paystack/callback?reference=${reference}`)
        .expect(302);

      const location = res.headers.location;
      assert.ok(location);
      const redirectUrl = new URL(location);

      assert.equal(redirectUrl.origin, mockDownstreamBaseUrl);
      assert.equal(redirectUrl.pathname, '/saas/billing/verify');
      assert.equal(redirectUrl.searchParams.get('reference'), reference);
      assert.equal(redirectUrl.searchParams.get('status'), 'abandoned');
    });

    it('initializes and verifies transaction using paystackService client against live Paystack API', async () => {
      const reference = `lufak_svc_live_${Date.now()}`;
      const initResult = await paystackService.initializeTransaction({
        email: 'e2e-service@example.com',
        amount: 180000,
        reference,
        metadata: {
          origin_site: 'lufak',
        },
      });

      assert.equal(initResult.success, true);
      assert.ok(initResult.data.authorization_url);
      assert.ok(initResult.data.access_code);
      assert.equal(initResult.data.reference, reference);

      // Verify transaction reference with live Paystack API
      const verifyResult = await paystackService.verifyTransaction(reference);
      assert.equal(verifyResult.success, true);
      assert.equal(verifyResult.data.reference, reference);
      assert.equal(verifyResult.data.amount, 180000);
      assert.equal(verifyResult.data.metadata.origin_site, 'lufak');
    });

    it('verifies live transaction routed via hyphen-separated reference prefix (saas-e2e-...) without metadata', async () => {
      const reference = `saas-e2e-cb-${Date.now()}`;
      await paystackService.initializeTransaction({
        email: 'e2e-hyphen@example.com',
        amount: 220000,
        reference,
      });

      // Hit proxy callback endpoint
      const res = await request(app)
        .get(`/api/v1/paystack/callback?reference=${reference}`)
        .expect(302);

      const location = res.headers.location;
      assert.ok(location);
      const redirectUrl = new URL(location);

      assert.equal(redirectUrl.origin, mockDownstreamBaseUrl);
      assert.equal(redirectUrl.pathname, '/saas/billing/verify');
      assert.equal(redirectUrl.searchParams.get('reference'), reference);
    });

    it('handles non-existent transaction reference gracefully with fallback redirect', async () => {
      const nonExistentRef = `fallback_nonexistent_${Date.now()}`;
      const res = await request(app)
        .get(`/api/v1/paystack/callback?reference=${nonExistentRef}`)
        .expect(302);

      const location = res.headers.location;
      assert.ok(location);
      const redirectUrl = new URL(location);
      assert.equal(redirectUrl.origin, mockDownstreamBaseUrl);
      assert.equal(redirectUrl.pathname, '/fallback/callback');
      assert.equal(redirectUrl.searchParams.get('status'), 'verification_failed');
      assert.equal(redirectUrl.searchParams.get('reference'), nonExistentRef);
    });
  });

  describe('2. Real HMAC Signed Webhook Ingestion, Deduplication & Downstream Dispatch', () => {
    it('successfully verifies genuine Paystack HMAC SHA512 signature and delivers downstream to Lufak site', async () => {
      const testEventId = Date.now();
      const payload = {
        event: 'charge.success',
        data: {
          id: testEventId,
          reference: `lufak_wh_live_${testEventId}`,
          amount: 750000,
          currency: 'GHS',
          status: 'success',
          metadata: {
            origin_site: 'lufak',
            cart_id: 'cart_555',
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      // Compute actual HMAC SHA512 using user's real Paystack test key
      const paystackSignature = computePaystackSignature(rawBody, LIVE_TEST_KEY);

      const res = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', paystackSignature)
        .send(rawBody)
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.message, 'Event queued for dispatch');
      assert.equal(res.body.site, 'lufak');
      assert.equal(res.body.targetUrl, `${mockDownstreamBaseUrl}/lufak/webhook`);

      // Wait briefly for asynchronous queue worker to forward downstream
      await new Promise(r => setTimeout(r, 100));

      // Check downstream received request
      const matchingReq = receivedDownstreamRequests.find(
        r => r.body?.data?.id === testEventId && r.url === '/lufak/webhook'
      );
      assert.ok(matchingReq, 'Downstream receiver did not receive webhook');

      // Verify downstream authentication headers
      assert.equal(matchingReq.headers['x-target-site'], 'lufak');
      assert.equal(matchingReq.headers['x-paystack-signature'], paystackSignature);
      assert.ok(matchingReq.headers['x-correlation-id']);
      assert.ok(matchingReq.headers['x-proxy-timestamp']);

      // Verify proxy signature HMAC SHA256 was computed with lufak's site secret
      const expectedProxySignature = computeProxySignature(matchingReq.rawBody, 'lufak_internal_secret_key_e2e');
      assert.equal(matchingReq.headers['x-proxy-signature'], expectedProxySignature);
    });

    it('atomically deduplicates duplicate webhooks with identical eventKey', async () => {
      const duplicateEventId = 88776655;
      const payload = {
        event: 'charge.success',
        data: {
          id: duplicateEventId,
          reference: `lufak_dup_${duplicateEventId}`,
          amount: 10000,
          metadata: { origin_site: 'lufak' },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = computePaystackSignature(rawBody, LIVE_TEST_KEY);

      // First delivery
      const res1 = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(rawBody)
        .expect(200);

      assert.equal(res1.body.status, true);
      assert.equal(res1.body.duplicate, undefined);

      await new Promise(r => setTimeout(r, 100));
      const downstreamCountBefore = receivedDownstreamRequests.filter(
        r => r.body?.data?.id === duplicateEventId
      ).length;
      assert.equal(downstreamCountBefore, 1);

      // Second delivery (duplicate retry from Paystack)
      const res2 = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(rawBody)
        .expect(200);

      assert.equal(res2.body.status, true);
      assert.equal(res2.body.duplicate, true);
      assert.equal(res2.body.message, 'Event already received and processed');

      await new Promise(r => setTimeout(r, 100));
      const downstreamCountAfter = receivedDownstreamRequests.filter(
        r => r.body?.data?.id === duplicateEventId
      ).length;
      // Must NOT deliver downstream again!
      assert.equal(downstreamCountAfter, 1);
    });

    it('routes webhook to SaaS child site via reference prefix (saas_...) with valid HMAC SHA512', async () => {
      const saasEventId = Date.now() + 10;
      const payload = {
        event: 'subscription.create',
        data: {
          id: saasEventId,
          reference: `saas_sub_${saasEventId}`,
          amount: 50000,
          plan: 'pro-monthly',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = computePaystackSignature(rawBody, LIVE_TEST_KEY);

      const res = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(rawBody)
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.site, 'saas');
      assert.equal(res.body.targetUrl, `${mockDownstreamBaseUrl}/saas/webhook`);

      await new Promise(r => setTimeout(r, 100));
      const matchingReq = receivedDownstreamRequests.find(
        r => r.body?.data?.id === saasEventId && r.url === '/saas/webhook'
      );
      assert.ok(matchingReq, 'Downstream receiver did not receive SaaS webhook');
      assert.equal(matchingReq.headers['x-target-site'], 'saas');

      // Verify proxy signature for saas site
      const expectedProxySignature = computeProxySignature(matchingReq.rawBody, 'saas_internal_secret_key_e2e');
      assert.equal(matchingReq.headers['x-proxy-signature'], expectedProxySignature);
    });

    it('rejects tampered or counterfeit webhook signature with 401 Unauthorized', async () => {
      const payload = {
        event: 'charge.success',
        data: { id: 999999, reference: 'tampered_ref' },
      };
      const rawBody = JSON.stringify(payload);
      // Bad signature
      const badSignature = 'a'.repeat(128);

      const res = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', badSignature)
        .send(rawBody)
        .expect(401);

      assert.equal(res.body.status, false);
      assert.equal(res.body.message, 'Invalid webhook signature');
    });

    it('rejects payload when body is tampered after HMAC computation', async () => {
      const originalPayload = { event: 'charge.success', data: { amount: 1000 } };
      const signature = computePaystackSignature(JSON.stringify(originalPayload), LIVE_TEST_KEY);

      const tamperedPayload = { event: 'charge.success', data: { amount: 99999999 } };

      const res = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(JSON.stringify(tamperedPayload))
        .expect(401);

      assert.equal(res.body.status, false);
      assert.equal(res.body.message, 'Invalid webhook signature');
    });

    it('routes webhook with hyphen-separated reference prefix and delivers downstream', async () => {
      const hypEventId = Date.now() + 20;
      const payload = {
        event: 'charge.success',
        data: {
          id: hypEventId,
          reference: `lufak-hyphen-wh-${hypEventId}`,
          amount: 65000,
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = computePaystackSignature(rawBody, LIVE_TEST_KEY);

      const res = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(rawBody)
        .expect(200);

      assert.equal(res.body.status, true);
      assert.equal(res.body.site, 'lufak');

      await new Promise(r => setTimeout(r, 100));
      const matchingReq = receivedDownstreamRequests.find(
        r => r.body?.data?.id === hypEventId && r.url === '/lufak/webhook'
      );
      assert.ok(matchingReq, 'Downstream receiver did not receive hyphen-prefixed webhook');
    });

    it('correctly routes and does not collide distinct customer identification events', async () => {
      const payload1 = {
        event: 'customeridentification.success',
        data: {
          customer_code: `CUS_live_e2e_1_${Date.now()}`,
          email: 'cust1@example.com',
          metadata: { origin_site: 'lufak' },
        },
      };
      const raw1 = JSON.stringify(payload1);
      const sig1 = computePaystackSignature(raw1, LIVE_TEST_KEY);

      const payload2 = {
        event: 'customeridentification.success',
        data: {
          customer_code: `CUS_live_e2e_2_${Date.now()}`,
          email: 'cust2@example.com',
          metadata: { origin_site: 'saas' },
        },
      };
      const raw2 = JSON.stringify(payload2);
      const sig2 = computePaystackSignature(raw2, LIVE_TEST_KEY);

      const res1 = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', sig1)
        .send(raw1)
        .expect(200);

      assert.equal(res1.body.status, true);
      assert.equal(res1.body.site, 'lufak');
      assert.equal(res1.body.duplicate, undefined);

      const res2 = await request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', sig2)
        .send(raw2)
        .expect(200);

      assert.equal(res2.body.status, true);
      assert.equal(res2.body.site, 'saas');
      assert.equal(res2.body.duplicate, undefined);

      await new Promise(r => setTimeout(r, 100));
    });
  });
});
