import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';

import { app } from '../src/app.js';
import { config, setSitesForTesting, reloadSites } from '../src/config/index.js';
import { queueService } from '../src/services/queue.js';
import { computePaystackSignature } from '../src/middleware/auth.js';
import { computeProxySignature } from '../src/services/dispatcher.js';

describe('Paystack Webhook Ingestion & Dispatcher', () => {
  const testSecret = 'sk_test_mock_webhook_secret_key_12345';
  const proxySecret = 'test_proxy_shared_secret_abc';

  beforeEach(async () => {
    // Set test configuration
    config.paystack.secretKey = testSecret;
    config.paystack.webhookSecret = testSecret;
    config.proxy.sharedSecret = proxySecret;
    config.paystack.enableIpWhitelist = false;

    // Configure test sites
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
    await queueService.clear();
    reloadSites();
  });

  it('rejects webhook with 401 when x-paystack-signature header is missing', async () => {
    const payload = { event: 'charge.success', data: { id: 1001, reference: 'test_ref' } };

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .send(payload)
      .expect(401);

    assert.equal(res.body.status, false);
    assert.match(res.body.message, /Missing x-paystack-signature/i);
  });

  it('rejects webhook with 401 when x-paystack-signature is invalid', async () => {
    const payload = JSON.stringify({ event: 'charge.success', data: { id: 1002, reference: 'test_ref' } });

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'invalid_signature_string_hex_digest')
      .send(payload)
      .expect(401);

    assert.equal(res.body.status, false);
    assert.match(res.body.message, /Invalid webhook signature/i);
  });

  it('accepts webhook with valid HMAC SHA512 signature and returns 200 within 500ms', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 2001,
        reference: 'lufak_order_9981',
        amount: 50000,
        metadata: { origin_site: 'lufak' },
      },
    });

    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'lufak');
    assert.equal(res.body.event, 'charge.success');
  });

  it('deduplicates re-delivered events and returns 200 without duplicate dispatch', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 3001,
        reference: 'lufak_dup_001',
        metadata: { origin_site: 'lufak' },
      },
    });

    const signature = computePaystackSignature(payload, testSecret);

    // First ingestion
    const res1 = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res1.body.status, true);
    assert.equal(res1.body.duplicate, undefined);

    // Second ingestion (duplicate redelivery from Paystack)
    const res2 = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res2.body.status, true);
    assert.equal(res2.body.duplicate, true);
    assert.match(res2.body.message, /already received/i);
  });

  it('resolves site via reference prefix when metadata is absent', async () => {
    const payload = JSON.stringify({
      event: 'subscription.create',
      data: {
        id: 4001,
        reference: 'saas_sub_88329',
        // No metadata provided
      },
    });

    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'saas');
  });

  it('routes to fallback site when site key is not recognized', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 5001,
        reference: 'unknownsite_txn_9999',
      },
    });

    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'fallback');
  });

  it('handles unroutable event cleanly when no fallback site exists', async () => {
    // Remove fallback site
    setSitesForTesting({
      lufak: {
        name: 'Lufak Store',
        webhookUrl: 'https://store.lufak.test/webhook',
        callbackUrl: 'https://store.lufak.test/callback',
      },
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 6001,
        reference: 'random_txn_777',
      },
    });

    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.routable, false);
    assert.match(res.body.message, /unroutable/i);
  });

  it('enforces IP whitelist when enabled and rejects unauthorized IP', async () => {
    config.paystack.enableIpWhitelist = true;
    config.paystack.ipWhitelist = ['52.31.139.228'];

    const payload = JSON.stringify({
      event: 'charge.success',
      data: { id: 7001, reference: 'lufak_ref_1' },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .set('x-forwarded-for', '198.51.100.23') // Unauthorized IP
      .send(payload)
      .expect(403);

    assert.equal(res.body.status, false);
    assert.match(res.body.message, /not authorized/i);
  });

  it('allows request when IP matches Paystack IP whitelist', async () => {
    config.paystack.enableIpWhitelist = true;
    config.paystack.ipWhitelist = ['52.31.139.228', '52.214.14.220'];

    const payload = JSON.stringify({
      event: 'charge.success',
      data: { id: 8001, reference: 'lufak_ref_2', metadata: { origin_site: 'lufak' } },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .set('x-forwarded-for', '52.31.139.228') // Authorized IP
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'lufak');
  });

  it('tolerates uppercase signature hex and surrounding whitespace', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { id: 9001, reference: 'lufak_casing_1', metadata: { origin_site: 'lufak' } },
    });
    const signature = computePaystackSignature(payload, testSecret).toUpperCase();

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', `  ${signature}  `)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'lufak');
  });

  it('resolves site when metadata is provided directly as an array of custom fields', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 9002,
        reference: 'custom_order_112',
        metadata: [
          { variable_name: 'origin_site', value: 'lufak' },
        ],
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'lufak');
  });

  it('resolves site when site_id is a numeric identifier matching a configured site', async () => {
    setSitesForTesting({
      '100': {
        name: 'Numbered Store',
        webhookUrl: 'https://store100.test/webhook',
        callbackUrl: 'https://store100.test/callback',
      },
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 9003,
        reference: 'random_ref_999',
        metadata: { site_id: 100 },
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, '100');
  });

  it('atomically deduplicates concurrent webhooks arriving at the same millisecond', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { id: 9999, reference: 'race_ref_001', metadata: { origin_site: 'lufak' } },
    });
    const signature = computePaystackSignature(payload, testSecret);

    // Fire two requests concurrently
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(payload),
      request(app)
        .post('/api/v1/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(payload),
    ]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    // Exactly one should be marked as duplicate
    const duplicates = [res1.body.duplicate, res2.body.duplicate].filter(Boolean);
    assert.equal(duplicates.length, 1);
  });

  it('allows request when IP matches typo alias IP 52.31139.228', async () => {
    config.paystack.enableIpWhitelist = true;
    config.paystack.ipWhitelist = ['52.31139.228'];

    const payload = JSON.stringify({
      event: 'charge.success',
      data: { id: 9005, reference: 'lufak_ref_ip_typo', metadata: { origin_site: 'lufak' } },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .set('x-forwarded-for', '52.31139.228')
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'lufak');
  });

  it('verifies computeProxySignature generates valid SHA256 HMAC for child sites', () => {
    const rawBody = '{"event":"charge.success"}';
    const sig = computeProxySignature(rawBody, proxySecret);

    const expected = crypto.createHmac('sha256', proxySecret).update(rawBody).digest('hex');
    assert.equal(sig, expected);
  });

  it('preserves data.id === 0 in event identifier without falling back to no_id', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 0,
        amount: 5000,
        metadata: { origin_site: 'lufak' },
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(await queueService.isDuplicate('charge.success:0'), true);
  });

  it('does not falsely deduplicate distinct events lacking id/reference', async () => {
    const payload1 = JSON.stringify({
      event: 'customeridentification.success',
      data: {
        customer_code: 'CUS_alice',
        email: 'alice@example.com',
        metadata: { origin_site: 'lufak' },
      },
    });
    const sig1 = computePaystackSignature(payload1, testSecret);

    const payload2 = JSON.stringify({
      event: 'customeridentification.success',
      data: {
        customer_code: 'CUS_bob',
        email: 'bob@example.com',
        metadata: { origin_site: 'lufak' },
      },
    });
    const sig2 = computePaystackSignature(payload2, testSecret);

    const res1 = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig1)
      .send(payload1)
      .expect(200);

    assert.equal(res1.body.status, true);
    assert.equal(res1.body.duplicate, undefined);

    // Event 2 is for a different customer; must NOT be flagged as duplicate
    const res2 = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig2)
      .send(payload2)
      .expect(200);

    assert.equal(res2.body.status, true);
    assert.equal(res2.body.duplicate, undefined);
  });

  it('routes webhook via hyphen-separated reference prefix (saas-sub-...)', async () => {
    const payload = JSON.stringify({
      event: 'subscription.create',
      data: {
        id: 77112,
        reference: 'saas-sub-77112',
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'saas');
  });

  it('routes webhook via metadata.site_key or metadata.site', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 88223,
        reference: 'unknown_prefix_123',
        metadata: { site_key: 'lufak' },
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'lufak');
  });

  it('routes webhook via site referencePrefixes list', async () => {
    setSitesForTesting({
      fintech: {
        name: 'FinTech App',
        webhookUrl: 'https://fintech.test/webhook',
        callbackUrl: 'https://fintech.test/cb',
        referencePrefixes: ['tsk_wallet', 'tsk_topup'],
      },
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 991100,
        reference: 'tsk_wallet_user_gh_5544',
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'fintech');
  });

  it('routes webhook via site referencePatterns regex', async () => {
    setSitesForTesting({
      ghana_edu: {
        name: 'Ghana Education',
        webhookUrl: 'https://edu.gh/webhook',
        callbackUrl: 'https://edu.gh/cb',
        referencePatterns: ['^gh_edu_[0-9]+_.*'],
      },
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 992200,
        reference: 'gh_edu_2026_tuition_fees',
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'ghana_edu');
  });

  it('verifies resolution hierarchy: metadata overrides referencePrefix', async () => {
    setSitesForTesting({
      site_a: {
        name: 'Site A',
        webhookUrl: 'https://a.test/webhook',
        referencePrefixes: ['prefix_a'],
      },
      site_b: {
        name: 'Site B',
        webhookUrl: 'https://b.test/webhook',
        referencePrefixes: ['prefix_b'],
      },
    });

    // Reference starts with prefix_a, but metadata points to site_b
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 993300,
        reference: 'prefix_a_order_123',
        metadata: { origin_site: 'site_b' },
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'site_b'); // Metadata wins!
  });

  it('prioritizes longer, more specific prefixes over shorter generic prefixes across sites', async () => {
    // general site defined first with prefix 'tsk'
    setSitesForTesting({
      general: {
        name: 'General Site',
        webhookUrl: 'https://general.test/webhook',
        referencePrefixes: ['tsk'],
      },
      wallet: {
        name: 'Wallet Site',
        webhookUrl: 'https://wallet.test/webhook',
        referencePrefixes: ['tsk_wallet'],
      },
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 994400,
        reference: 'tsk_wallet_credit_5544',
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'wallet'); // tsk_wallet wins over tsk!
  });

  it('routes webhook with unanchored regex pattern like gh_.* and glob pattern like tsk_*', async () => {
    setSitesForTesting({
      gh_site: {
        name: 'Ghana Site',
        webhookUrl: 'https://gh.test/webhook',
        referencePatterns: ['gh_.*'],
      },
      glob_site: {
        name: 'Glob Site',
        webhookUrl: 'https://glob.test/webhook',
        referencePatterns: ['store_*'],
      },
    });

    // 1. Unanchored regex gh_.*
    const payload1 = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 995501,
        reference: 'gh_cedi_payment_2026',
      },
    });
    const sig1 = computePaystackSignature(payload1, testSecret);
    const res1 = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig1)
      .send(payload1)
      .expect(200);

    assert.equal(res1.body.status, true);
    assert.equal(res1.body.site, 'gh_site');

    // 2. Glob pattern store_*
    const payload2 = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 995502,
        reference: 'store_checkout_abc',
      },
    });
    const sig2 = computePaystackSignature(payload2, testSecret);
    const res2 = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig2)
      .send(payload2)
      .expect(200);

    assert.equal(res2.body.status, true);
    assert.equal(res2.body.site, 'glob_site');
  });

  it('resolves metadata with camelCase properties (originSite, siteId)', async () => {
    setSitesForTesting({
      app_portal: {
        name: 'App Portal',
        webhookUrl: 'https://portal.test/webhook',
      },
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 996600,
        reference: 'random_external_ref_123',
        metadata: { originSite: 'app_portal' },
      },
    });
    const signature = computePaystackSignature(payload, testSecret);

    const res = await request(app)
      .post('/api/v1/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(payload)
      .expect(200);

    assert.equal(res.body.status, true);
    assert.equal(res.body.site, 'app_portal');
  });
});
