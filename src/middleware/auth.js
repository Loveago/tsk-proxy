import crypto from 'node:crypto';
import { config, logger } from '../config/index.js';

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Uses crypto.timingSafeEqual with safe length mismatch handling.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    // Run dummy comparison to prevent timing leaks on length inequality
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Computes Paystack HMAC SHA512 signature for raw payload buffer.
 *
 * @param {Buffer|string} rawBody
 * @param {string} secret
 * @returns {string} Hex encoded signature
 */
export function computePaystackSignature(rawBody, secret) {
  if (!secret) return '';
  return crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');
}

/**
 * Verifies Paystack HMAC SHA512 signature.
 *
 * @param {Buffer|string} rawBody
 * @param {string} signature
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyPaystackSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) {
    return false;
  }
  const cleanSig = String(signature).trim().toLowerCase();
  const computed = computePaystackSignature(rawBody, secret);
  return timingSafeCompare(computed.toLowerCase(), cleanSig);
}

/**
 * Express middleware to validate Paystack webhook HMAC SHA512 signature.
 */
export function validatePaystackSignature(req, res, next) {
  const signature = req.headers['x-paystack-signature'];
  const correlationId = req.id || req.headers['x-correlation-id'] || 'unknown';

  if (!signature) {
    logger.warn({ correlationId, ip: req.ip }, 'Rejected webhook: Missing x-paystack-signature header');
    return res.status(401).json({
      status: false,
      message: 'Missing x-paystack-signature header',
    });
  }

  const rawBody = req.rawBody;
  if (!rawBody || (Buffer.isBuffer(rawBody) && rawBody.length === 0)) {
    logger.warn({ correlationId, ip: req.ip }, 'Rejected webhook: Missing or empty raw request body');
    return res.status(400).json({
      status: false,
      message: 'Missing raw request body',
    });
  }

  const secret = config.paystack.webhookSecret || config.paystack.secretKey;
  if (!secret) {
    logger.error({ correlationId }, 'Paystack webhook secret is not configured on the server');
    return res.status(500).json({
      status: false,
      message: 'Server configuration error: Webhook secret missing',
    });
  }

  const isValid = verifyPaystackSignature(rawBody, signature, secret);

  if (!isValid) {
    logger.warn(
      {
        correlationId,
        ip: req.ip,
        receivedSignature: signature,
      },
      'Rejected webhook: Invalid x-paystack-signature HMAC SHA512'
    );
    return res.status(401).json({
      status: false,
      message: 'Invalid webhook signature',
    });
  }

  req.paystackVerified = true;
  next();
}

/**
 * Express middleware to authenticate web dashboard and configuration API requests.
 * Accepts Bearer token in Authorization header, x-dashboard-token header, or ?token= query.
 */
export function requireDashboardAuth(req, res, next) {
  // Allow disabling auth explicitly via DASHBOARD_AUTH_ENABLED=false
  if (config.dashboard?.authEnabled === false) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-dashboard-token']) {
    token = String(req.headers['x-dashboard-token']).trim();
  } else if (req.query && req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({
      status: false,
      message: 'Unauthorized: Authentication required to access dashboard',
    });
  }

  // Import lazily or use auth service
  import('../services/auth.js')
    .then(({ verifyDashboardToken }) => {
      const user = verifyDashboardToken(token);
      if (!user) {
        return res.status(401).json({
          status: false,
          message: 'Unauthorized: Invalid or expired dashboard session token',
        });
      }

      req.user = user;
      next();
    })
    .catch(err => {
      logger.error({ err: err.message }, 'Failed to verify dashboard token');
      res.status(500).json({
        status: false,
        message: 'Internal authentication error',
      });
    });
}

export default validatePaystackSignature;
