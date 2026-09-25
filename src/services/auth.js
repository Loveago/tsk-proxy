import crypto from 'node:crypto';
import { config, logger } from '../config/index.js';
import { timingSafeCompare } from '../middleware/auth.js';

/**
 * Base64URL encode string or Buffer
 * @param {string|Buffer} input
 * @returns {string}
 */
export function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Base64URL decode string
 * @param {string} input
 * @returns {string}
 */
export function base64UrlDecode(input) {
  let base64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Signs a standard JWT with HMAC-SHA256
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
export function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${message}.${signature}`;
}

/**
 * Verifies a JWT token signature and expiration
 * @param {string} token
 * @param {string} secret
 * @returns {object|null} Decoded payload or null if invalid/expired
 */
export function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, receivedSig] = parts;
  const message = `${encodedHeader}.${encodedPayload}`;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (!timingSafeCompare(expectedSig, receivedSig)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Returns JWT secret for dashboard authentication
 * @returns {string}
 */
export function getDashboardJwtSecret() {
  return (
    config.dashboard?.jwtSecret ||
    config.proxy?.sharedSecret ||
    'tsk-proxy-dashboard-jwt-fallback-secret-min-32-chars'
  );
}

/**
 * Generates an authentication token for the dashboard admin
 * @param {object} userPayload
 * @returns {string} JWT token string
 */
export function generateDashboardToken(userPayload = {}) {
  const username = userPayload.username || config.dashboard?.username || 'admin';
  const sessionHours = config.dashboard?.sessionHours || 24;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + sessionHours * 3600;

  const payload = {
    sub: username,
    username,
    role: 'admin',
    iat: now,
    exp,
  };

  return signJwt(payload, getDashboardJwtSecret());
}

/**
 * Verifies a dashboard authentication token
 * @param {string} token
 * @returns {object|null}
 */
export function verifyDashboardToken(token) {
  return verifyJwt(token, getDashboardJwtSecret());
}

/**
 * Authenticates dashboard administrator credentials
 * @param {string} username
 * @param {string} password
 * @returns {{ success: boolean, user?: object, message?: string }}
 */
export function authenticateDashboardUser(username, password) {
  const expectedUsername = config.dashboard?.username || 'admin';
  const expectedPassword = config.dashboard?.password || 'paystack-proxy-admin-2026';

  if (!username || !password) {
    return { success: false, message: 'Username and password are required' };
  }

  const cleanUser = String(username).trim();
  const cleanPass = String(password);

  const isUserValid = timingSafeCompare(cleanUser, expectedUsername);
  const isPassValid = timingSafeCompare(cleanPass, expectedPassword);

  if (!isUserValid || !isPassValid) {
    return { success: false, message: 'Invalid username or password' };
  }

  return {
    success: true,
    user: {
      username: expectedUsername,
      role: 'admin',
    },
  };
}
