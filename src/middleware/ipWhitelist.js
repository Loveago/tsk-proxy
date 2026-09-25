import { config, logger } from '../config/index.js';

/**
 * Normalizes IPv6-mapped IPv4 addresses (e.g. ::ffff:52.31.139.228 -> 52.31.139.228)
 *
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  if (!ip) return '';
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.substring(7);
  }
  return trimmed;
}

/**
 * Extracts client IP from request, handling headers if behind reverse proxy
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getClientIp(req) {
  // Check x-forwarded-for if present
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const rawIp = Array.isArray(xForwardedFor)
      ? xForwardedFor[0]
      : xForwardedFor.split(',')[0];
    return normalizeIp(rawIp);
  }
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

/**
 * Express middleware for toggleable Paystack IP whitelisting
 */
export function ipWhitelist(req, res, next) {
  if (!config.paystack.enableIpWhitelist) {
    return next();
  }

  const clientIp = getClientIp(req);
  const allowedIps = (config.paystack.ipWhitelist || []).map(normalizeIp);
  const correlationId = req.id || req.headers['x-correlation-id'] || 'unknown';

  const isAllowed = allowedIps.includes(clientIp);

  if (!isAllowed) {
    logger.warn(
      {
        correlationId,
        clientIp,
        allowedIps,
      },
      'Forbidden: Webhook rejected due to IP not in Paystack whitelist'
    );
    return res.status(403).json({
      status: false,
      message: 'Forbidden: Client IP not authorized for webhook ingestion',
    });
  }

  next();
}

export default ipWhitelist;
