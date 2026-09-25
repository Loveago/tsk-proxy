import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import { app } from '../src/app.js';
import { setSitesForTesting, reloadSites } from '../src/config/index.js';
import { paystackService } from '../src/services/paystack.js';

describe('Paystack Callback Interceptor & Redirector', () => {
  const originalVerify = paystackService.verifyTransaction;

  beforeEach(() => {
    setSitesForTesting({
      lufak: {
        name: 'Lufak Store',
        webhookUrl: 'https://store.lufak.test/webhook',
        callbackUrl: 'https://store.lufak.test/checkout/complete',
      },
      saas: {
        name: 'SaaS Platform',
        webhookUrl: 'https://app.saas.test/webhook',
        callbackUrl: 'https://app.saas.test/billing/verify',
      },
      fallback: {
        name: 'Ops Fallback',
        webhookUrl: 'https://ops.fallback.test/webhook',
        callbackUrl: 'https://ops.fallback.test/failed',
      },
    });
  });

  afterEach(() => {
    paystackService.verifyTransaction = originalVerify;
    reloadSites();
  });

  it('returns 400 when reference query parameter is missing', async () => {
    const res = await request(app)
      .get('/api/v1/paystack/callback')
      .expect(400);

    assert.match(res.text, /Missing Transaction Reference/i);
  });

  it('redirects (302) to target site callback URL resolved from metadata origin_site', async () => {
    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 150000,
        metadata: { origin_site: 'lufak' },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=lufak_order_12345')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://store.lufak.test/checkout/complete'));
    assert.match(location, /reference=lufak_order_12345/);
    assert.match(location, /status=success/);
  });

  it('redirects (302) to target site callback URL resolved from reference prefix', async () => {
    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 25000,
        // No metadata provided
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=saas_txn_999')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://app.saas.test/billing/verify'));
    assert.match(location, /reference=saas_txn_999/);
    assert.match(location, /status=success/);
  });

  it('redirects to fallback callback URL when Paystack transaction verification fails', async () => {
    paystackService.verifyTransaction = async () => ({
      success: false,
      message: 'Transaction not found or network failure',
      data: null,
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=invalid_ref_000')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://ops.fallback.test/failed'));
    assert.match(location, /status=verification_failed/);
    assert.match(location, /reference=invalid_ref_000/);
  });

  it('renders readable error view when site cannot be resolved and no fallback configured', async () => {
    setSitesForTesting({
      lufak: {
        name: 'Lufak Store',
        webhookUrl: 'https://store.lufak.test/webhook',
        callbackUrl: 'https://store.lufak.test/checkout/complete',
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        // unknown origin
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=completely_unknown_999')
      .expect(404);

    assert.match(res.text, /Site Resolution Failed/i);
    assert.match(res.text, /completely_unknown_999/);
  });

  it('redirects to child site callback URL when verification fails but reference prefix identifies site', async () => {
    paystackService.verifyTransaction = async () => ({
      success: false,
      message: 'Card declined or timeout',
      data: null,
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=lufak_order_declined_123')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://store.lufak.test/checkout/complete'));
    assert.match(location, /reference=lufak_order_declined_123/);
    assert.match(location, /status=verification_failed/);
  });

  it('trims leading/trailing whitespace in reference query parameter', async () => {
    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        metadata: { origin_site: 'lufak' },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=%20%20lufak_order_spaces%20%20')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.match(location, /reference=lufak_order_spaces/);
    assert.doesNotMatch(location, /reference=%20/);
  });

  it('renders readable error view when site callback URL is malformed instead of 500 crash', async () => {
    setSitesForTesting({
      malformed: {
        name: 'Malformed Site',
        webhookUrl: 'https://malformed.test/webhook',
        callbackUrl: 'invalid-uri-scheme-format',
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        metadata: { origin_site: 'malformed' },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=malformed_ref_1')
      .expect(500);

    assert.match(res.text, /Invalid Callback URL/i);
  });

  it('redirects (302) to target site callback URL resolved from hyphen-prefixed reference', async () => {
    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 35000,
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=saas-billing-998')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://app.saas.test/billing/verify'));
    assert.match(location, /reference=saas-billing-998/);
  });

  it('redirects to site callback URL resolved via custom referencePrefixes', async () => {
    setSitesForTesting({
      datasite: {
        name: 'Data Platform',
        webhookUrl: 'https://data.test/webhook',
        callbackUrl: 'https://data.test/callback',
        referencePrefixes: ['tsk_data', 'topup'],
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 5000, // 50 GHS in pesewas
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=tsk_data_user_9912')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://data.test/callback'));
    assert.match(location, /reference=tsk_data_user_9912/);
    assert.match(location, /status=success/);
  });

  it('redirects to site callback URL resolved via custom referencePatterns regex', async () => {
    setSitesForTesting({
      ghana_store: {
        name: 'Ghana Local Store',
        webhookUrl: 'https://ghanastore.test/webhook',
        callbackUrl: 'https://ghanastore.test/checkout/done',
        referencePatterns: ['^gh_[0-9]+_.*'],
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 10000,
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=gh_233_payment_alpha')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://ghanastore.test/checkout/done'));
    assert.match(location, /reference=gh_233_payment_alpha/);
    assert.match(location, /status=success/);
  });

  it('redirects to dedicated flowRoutes URL matching reference sub-pattern (wallet vs checkout)', async () => {
    setSitesForTesting({
      multihub: {
        name: 'Multi Flow Hub',
        webhookUrl: 'https://hub.test/webhook',
        callbackUrl: 'https://hub.test/default/callback',
        referencePrefixes: ['tsk_hub'],
        flowRoutes: {
          wallet: 'https://hub.test/dashboard/wallet/success',
          checkout: 'https://hub.test/store/order-complete',
        },
      },
    });

    // 1. Wallet payment flow
    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 2000,
      },
    });

    const walletRes = await request(app)
      .get('/api/v1/paystack/callback?reference=tsk_hub_wallet_1001')
      .expect(302);

    assert.ok(walletRes.headers.location.startsWith('https://hub.test/dashboard/wallet/success'));
    assert.match(walletRes.headers.location, /reference=tsk_hub_wallet_1001/);
    assert.match(walletRes.headers.location, /status=success/);

    // 2. Checkout payment flow
    const checkoutRes = await request(app)
      .get('/api/v1/paystack/callback?reference=tsk_hub_checkout_2002')
      .expect(302);

    assert.ok(checkoutRes.headers.location.startsWith('https://hub.test/store/order-complete'));
    assert.match(checkoutRes.headers.location, /reference=tsk_hub_checkout_2002/);
    assert.match(checkoutRes.headers.location, /status=success/);
  });

  it('redirects to dynamic metadata.redirect_path resolved against base child site callback URL', async () => {
    setSitesForTesting({
      custom_site: {
        name: 'Custom Site',
        webhookUrl: 'https://custom.test/webhook',
        callbackUrl: 'https://custom.test/base/return',
        referencePrefixes: ['cst'],
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        metadata: {
          redirect_path: '/account/topup/complete',
        },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=cst_txn_7788')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://custom.test/account/topup/complete'));
    assert.match(location, /reference=cst_txn_7788/);
    assert.match(location, /status=success/);
  });

  it('redirects to flowRoutes callback URL when metadata.flow is specified', async () => {
    setSitesForTesting({
      saas_portal: {
        name: 'SaaS Portal',
        webhookUrl: 'https://portal.test/webhook',
        callbackUrl: 'https://portal.test/callback',
        flowRoutes: {
          billing: 'https://portal.test/billing/done',
          onboarding: 'https://portal.test/onboarding/welcome',
        },
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        metadata: {
          origin_site: 'saas_portal',
          flow: 'onboarding',
        },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=portal_user_abc')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://portal.test/onboarding/welcome'));
    assert.match(location, /reference=portal_user_abc/);
    assert.match(location, /status=success/);
  });

  it('preserves trxref even when trxref equals reference and forwards extra query params', async () => {
    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 5000,
        metadata: { origin_site: 'lufak' },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=lufak_ref_100&trxref=lufak_ref_100&utm_source=twitter&session_id=sess_99')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.match(location, /reference=lufak_ref_100/);
    assert.match(location, /trxref=lufak_ref_100/);
    assert.match(location, /utm_source=twitter/);
    assert.match(location, /session_id=sess_99/);
    assert.match(location, /status=success/);
  });

  it('resolves relative flowRoutes URLs against child site base callback URL or webhook origin', async () => {
    setSitesForTesting({
      store_site: {
        name: 'Store Site',
        webhookUrl: 'https://myshop.gh/api/webhook',
        callbackUrl: 'https://myshop.gh/checkout/finish',
        referencePrefixes: ['store_site'],
        flowRoutes: {
          wallet: '/dashboard/wallet/success',
          checkout: '/store/orders/complete',
        },
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 25000,
        metadata: { flow: 'wallet' },
      },
    });

    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=store_site_ref_200')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    assert.ok(location.startsWith('https://myshop.gh/dashboard/wallet/success'));
    assert.match(location, /reference=store_site_ref_200/);
    assert.match(location, /status=success/);
  });

  it('correctly matches token boundary in flowRoutes (e.g. checkout does not erroneously match out)', async () => {
    setSitesForTesting({
      boundary_site: {
        name: 'Boundary Site',
        webhookUrl: 'https://boundary.test/webhook',
        callbackUrl: 'https://boundary.test/default',
        referencePrefixes: ['bound'],
        flowRoutes: {
          out: 'https://boundary.test/out/page',
          checkout: 'https://boundary.test/store/checkout-done',
        },
      },
    });

    paystackService.verifyTransaction = async (reference) => ({
      success: true,
      data: {
        status: 'success',
        reference,
        amount: 15000,
      },
    });

    // Reference contains 'checkout'
    const res = await request(app)
      .get('/api/v1/paystack/callback?reference=bound_checkout_9988')
      .expect(302);

    const location = res.headers.location;
    assert.ok(location);
    // Must route to checkout, NOT hijacked by out!
    assert.ok(location.startsWith('https://boundary.test/store/checkout-done'));
    assert.match(location, /reference=bound_checkout_9988/);
  });
});
