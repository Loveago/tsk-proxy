import crypto from 'node:crypto';
import { Router } from 'express';
import { validatePaystackSignature } from '../middleware/auth.js';
import { ipWhitelist } from '../middleware/ipWhitelist.js';
import { queueService, metrics } from '../services/queue.js';
import { dispatchWebhook } from '../services/dispatcher.js';
import { logger, syncSitesWithDb } from '../config/index.js';

/**
 * Extracts a stable, unique identifier for an event payload.
 * Prevents false duplicate collisions across distinct events lacking explicit id/reference.
 *
 * @param {object} payload
 * @returns {string}
 */
export function getWebhookEventIdentifier(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') {
    return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex').slice(0, 16);
  }

  // 1. Explicit numeric or string ID (preserves id: 0)
  if (data.id !== undefined && data.id !== null && data.id !== '') {
    return String(data.id);
  }

  // 2. Reference or trxref
  if (data.reference !== undefined && data.reference !== null && data.reference !== '') {
    return String(data.reference);
  }
  if (data.trxref !== undefined && data.trxref !== null && data.trxref !== '') {
    return String(data.trxref);
  }

  // 3. Domain entity codes
  if (data.subscription_code) return String(data.subscription_code);
  if (data.transfer_code) return String(data.transfer_code);
  if (data.refund_code) return String(data.refund_code);
  if (data.invoice_code) return String(data.invoice_code);
  if (data.customer_code) return String(data.customer_code);
  if (data.dedicated_account_number) return String(data.dedicated_account_number);

  // 4. Stable cryptographic fingerprint of data
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

const router = Router();

/**
 * POST /api/v1/paystack/webhook
 * Primary Paystack webhook ingestion endpoint.
 */
router.post(
  '/webhook',
  ipWhitelist,
  validatePaystackSignature,
  async (req, res, next) => {
    const correlationId = req.id || req.headers['x-correlation-id'] || 'unknown';
    const payload = req.body;

    if (!payload || !payload.event) {
      logger.warn({ correlationId }, 'Received webhook with missing event field');
      return res.status(400).json({
        status: false,
        message: 'Invalid webhook payload: Missing event identifier',
      });
    }

    const eventName = payload.event;
    const identifier = getWebhookEventIdentifier(payload);
    const eventKey = `${eventName}:${identifier}`;

    try {
      // Deduplication & Idempotency check with atomic reservation
      const dedupeResult = await queueService.checkAndRecord(eventKey, 'QUEUED');
      if (dedupeResult.isDuplicate) {
        metrics.duplicates++;
        queueService.recordExternalEvent({
          eventKey,
          eventType: eventName,
          reference: identifier,
          status: 'DUPLICATE',
          correlationId,
        });
        logger.info(
          { correlationId, eventKey },
          'Duplicate webhook event detected, acknowledging without re-dispatching'
        );
        return res.status(200).json({
          status: true,
          message: 'Event already received and processed',
          duplicate: true,
        });
      }

      if (typeof syncSitesWithDb === 'function') {
        await syncSitesWithDb();
      }

      // Dispatch event to child site asynchronously
      const dispatchResult = await dispatchWebhook({
        eventKey,
        payload,
        rawBody: req.rawBody,
        headers: req.headers,
        correlationId,
      });

      if (dispatchResult.unroutable) {
        await queueService.updateEventStatus(eventKey, 'UNROUTABLE');
        queueService.recordExternalEvent({
          eventKey,
          eventType: eventName,
          reference: identifier,
          status: 'UNROUTABLE',
          error: 'No matching child site or fallback destination configured',
          correlationId,
        });
        return res.status(200).json({
          status: true,
          message: 'Event received but unroutable to any configured child site',
          event: eventName,
          routable: false,
        });
      }

      // Immediate 200 OK acknowledgment to Paystack within 500ms
      return res.status(200).json({
        status: true,
        message: 'Event queued for dispatch',
        event: eventName,
        site: dispatchResult.siteKey,
        targetUrl: dispatchResult.targetUrl,
      });
    } catch (err) {
      logger.error({ correlationId, eventKey, err: err.message }, 'Failed to ingest webhook');
      next(err);
    }
  }
);

export default router;
