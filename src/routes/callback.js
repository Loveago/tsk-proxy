import { Router } from 'express';
import { paystackService } from '../services/paystack.js';
import { resolveSite, resolveTargetCallbackUrl } from '../services/dispatcher.js';
import { getSite, logger, syncSitesWithDb, syncConfigWithDb } from '../config/index.js';
import { metrics } from '../services/queue.js';

const router = Router();

/**
 * Renders a clean, accessible HTML error view when callback redirection fails.
 */
function renderHtmlError(title, message, reference = '', details = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Paystack Proxy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1); padding: 32px; max-width: 480px; width: 100%; border: 1px solid #e2e8f0; }
    .icon { font-size: 40px; margin-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 12px; color: #0f172a; }
    p { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px; }
    .details { background: #f1f5f9; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; word-break: break-all; margin-bottom: 20px; color: #334155; }
    .btn { display: inline-block; background: #0ea5e9; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 14px; }
    .btn:hover { background: #0284c7; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${reference ? `<div class="details"><strong>Reference:</strong> ${reference}<br/>${details ? `<strong>Info:</strong> ${details}` : ''}</div>` : ''}
    <p>Please contact support or return to the merchant site.</p>
  </div>
</body>
</html>`;
}

/**
 * GET /api/v1/paystack/callback
 * Browser redirect interceptor from Paystack payment flow.
 */
router.get('/callback', async (req, res, next) => {
  metrics.callbacksTotal++;
  const correlationId = req.id || req.headers['x-correlation-id'] || 'unknown';
  const rawReference = req.query.reference || req.query.trxref;

  if (!rawReference || typeof rawReference !== 'string' || rawReference.trim().length === 0) {
    metrics.callbacksFailed++;
    logger.warn({ correlationId, query: req.query }, 'Callback accessed without transaction reference');
    return res.status(400).send(
      renderHtmlError(
        'Missing Transaction Reference',
        'No valid reference or trxref parameter was provided in the payment callback.',
        ''
      )
    );
  }

  const reference = rawReference.trim();

  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb();
  }
  if (typeof syncConfigWithDb === 'function') {
    await syncConfigWithDb();
  }

  try {
    // 1. Query Paystack API to verify transaction status
    const verifyResult = await paystackService.verifyTransaction(reference, correlationId);

    if (!verifyResult.success || !verifyResult.data) {
      metrics.callbacksFailed++;
      logger.error(
        { correlationId, reference, err: verifyResult.message },
        'Failed to verify transaction status with Paystack'
      );

      // Attempt to resolve target site from reference prefix so customer returns to the originating child site
      const siteResolution = resolveSite({ data: { reference } });
      const targetSite = siteResolution?.site || getSite('fallback');

      if (targetSite) {
        const targetCallbackUrl = resolveTargetCallbackUrl({
          site: targetSite,
          payload: { data: { reference } },
          reference,
        });

        if (targetCallbackUrl) {
          try {
            const redirectUrl = new URL(targetCallbackUrl);
            redirectUrl.searchParams.set('reference', reference);
            redirectUrl.searchParams.set('status', 'verification_failed');
            redirectUrl.searchParams.set('error', verifyResult.message || 'Verification failed');
            if (req.query.trxref) {
              redirectUrl.searchParams.set('trxref', String(req.query.trxref).trim());
            }
            // Forward extra query parameters from Paystack
            for (const [qKey, qVal] of Object.entries(req.query)) {
              if (qKey !== 'reference' && qKey !== 'status' && qKey !== 'trxref' && qKey !== 'error' && typeof qVal === 'string') {
                redirectUrl.searchParams.set(qKey, qVal);
              }
            }
            return res.redirect(302, redirectUrl.toString());
          } catch {
            // If URL formatting fails, fall through to error view
          }
        }
      }

      return res.status(502).send(
        renderHtmlError(
          'Verification Failed',
          'Unable to verify transaction details with Paystack. Your payment may still have been processed.',
          reference,
          verifyResult.message
        )
      );
    }

    const txData = verifyResult.data;

    // 2. Resolve origin site using Smart Resolution Hierarchy
    const resolution = resolveSite({ data: { ...txData, reference: txData.reference || reference } });

    const targetSite = resolution?.site || getSite('fallback');
    const siteKey = resolution?.siteKey || (targetSite ? 'fallback' : null);

    const targetCallbackUrl = targetSite
      ? resolveTargetCallbackUrl({
          site: targetSite,
          payload: { data: txData },
          reference,
        })
      : null;

    if (!targetSite || !targetCallbackUrl) {
      metrics.callbacksFailed++;
      logger.warn(
        { correlationId, reference, txData },
        'Unroutable callback: Target site could not be resolved or lacks callbackUrl'
      );

      return res.status(404).send(
        renderHtmlError(
          'Site Resolution Failed',
          'Could not determine the originating merchant application for this payment transaction.',
          reference,
          `Status: ${txData.status}`
        )
      );
    }

    metrics.callbacksSuccess++;

    // 3. Format target redirect URL
    let destinationUrl;
    try {
      destinationUrl = new URL(targetCallbackUrl);
    } catch {
      return res.status(500).send(
        renderHtmlError(
          'Invalid Callback URL',
          'The target site has an invalid callback URL configured.',
          reference
        )
      );
    }

    destinationUrl.searchParams.set('reference', reference);
    destinationUrl.searchParams.set('status', txData.status || 'unknown');
    if (req.query.trxref) {
      destinationUrl.searchParams.set('trxref', String(req.query.trxref).trim());
    }
    // Forward extra query parameters from Paystack
    for (const [qKey, qVal] of Object.entries(req.query)) {
      if (qKey !== 'reference' && qKey !== 'status' && qKey !== 'trxref' && typeof qVal === 'string') {
        destinationUrl.searchParams.set(qKey, qVal);
      }
    }

    logger.info(
      {
        correlationId,
        reference,
        siteKey,
        status: txData.status,
        redirectUrl: destinationUrl.toString(),
      },
      'Redirecting browser to child site callback URL'
    );

    return res.redirect(302, destinationUrl.toString());
  } catch (err) {
    metrics.callbacksFailed++;
    logger.error({ correlationId, reference, err: err.message }, 'Unexpected error in callback handler');
    next(err);
  }
});

export default router;
