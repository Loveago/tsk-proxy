import crypto from 'node:crypto';
import axios from 'axios';
import { config, getSite, getAllSites, logger, syncSitesWithDb } from '../config/index.js';
import { queueService, metrics } from './queue.js';
import { notifier } from './notifier.js';

/**
 * Computes an HMAC SHA256 signature using the proxy's internal shared secret.
 * Downstream child sites use this header to verify that the request originated from the proxy.
 *
 * @param {Buffer|string} rawBody
 * @param {string} secret
 * @returns {string} Hex encoded signature
 */
export function computeProxySignature(rawBody, secret = config.proxy.sharedSecret) {
  if (!rawBody) return '';
  const content = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return crypto.createHmac('sha256', secret).update(content).digest('hex');
}

/**
 * Safely parses metadata field which may be an object, JSON string, or undefined.
 *
 * @param {any} metadata
 * @returns {object|null}
 */
export function parseMetadata(metadata) {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extracts raw transaction reference or order ID string from payload / data object.
 *
 * @param {object} data
 * @returns {string}
 */
export function getRawReference(data) {
  if (!data || typeof data !== 'object') return '';
  const ref = data.reference != null ? data.reference : (data.trxref != null ? data.trxref : data.order_id);
  return ref != null ? String(ref).trim() : '';
}

/**
 * Safely evaluates regex or glob reference patterns with ReDoS and length guards.
 *
 * @param {string} patternStr
 * @param {string} reference
 * @returns {boolean}
 */
export function matchReferencePattern(patternStr, reference) {
  if (!patternStr || !reference) return false;
  if (typeof patternStr !== 'string' || typeof reference !== 'string') return false;
  const str = patternStr.trim();
  const ref = reference.trim();
  if (!str || !ref) return false;

  // Length and safety guards against excessive evaluation / ReDoS
  if (str.length > 150 || ref.length > 300) return false;

  // Guard against known catastrophic backtracking patterns (e.g. (a+)+ or (.*a){2,})
  if (/([+*]|\{\d+,?\d*\})\s*([+*]|\{\d+,?\d*\})/.test(str) || /(\([^()]+\)[+*])\1+/.test(str)) {
    return false;
  }

  try {
    let regex;
    // Regex detection: anchors, character classes, alternation, groups, escapes, or regex wildcards (.* or .+)
    const isRegex = str.startsWith('^') || str.endsWith('$') ||
      str.includes('.*') || str.includes('.+') ||
      /[\\()\[\]{}+|]/.test(str);

    if (isRegex) {
      regex = new RegExp(str, 'i');
    } else if (str.includes('*') || str.includes('?')) {
      // Glob pattern: escape regex metacharacters, convert * to .* and ? to .
      const escaped = str.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      regex = new RegExp(`^${escaped}$`, 'i');
    } else {
      regex = new RegExp(`^${str}`, 'i');
    }
    return regex.test(ref);
  } catch {
    return false;
  }
}

/**
 * Resolves full destination callback redirect URL using smart flow rules:
 * 1. Dynamic metadata.redirect_path resolved against child site base callback URL
 * 2. Direct metadata callback_url / redirect_url
 * 3. Flow key matching against site.flowRoutes / site.callbackRules (via metadata.flow)
 * 4. Reference sub-pattern matching against site.flowRoutes / site.callbackRules (e.g. wallet, checkout)
 * 5. Default base callback URL
 *
 * @param {object} options
 * @param {object} options.site - Configured site object
 * @param {object} [options.payload] - Transaction or webhook payload
 * @param {string} [options.reference] - Transaction reference
 * @returns {string}
 */
export function resolveTargetCallbackUrl({ site, payload, reference }) {
  if (!site) return '';
  const baseCallbackUrl = site.callbackUrl || (site.webhookUrl ? getOriginUrl(site.webhookUrl) : '');
  const data = (payload && payload.data) ? payload.data : (payload || {});
  const metadata = parseMetadata(data.metadata) || {};
  const ref = String(reference || getRawReference(data) || '').trim();
  const flowRules = site.flowRoutes || site.callbackRules || {};

  // 1. Dynamic metadata.redirect_path resolving against child site base callback URL
  const redirectPath = metadata.redirect_path || metadata.redirectPath;
  if (redirectPath && typeof redirectPath === 'string') {
    const relPath = redirectPath.trim();
    if (relPath) {
      if (baseCallbackUrl) {
        try {
          return new URL(relPath, baseCallbackUrl).toString();
        } catch {}
      }
      return relPath;
    }
  }

  // 2. Direct full redirect_url or callback_url in metadata
  const directUrl = metadata.callback_url || metadata.redirect_url || metadata.callbackUrl || metadata.redirectUrl;
  if (directUrl && typeof directUrl === 'string') {
    try {
      new URL(directUrl);
      return directUrl.trim();
    } catch {}
  }

  // 3. Flow key resolution via metadata.flow / metadata.flow_type / metadata.flowType / metadata.flowKey
  const flowKey = metadata.flow || metadata.flow_type || metadata.flowType || metadata.flow_key || metadata.flowKey;
  if (flowKey && typeof flowKey === 'string') {
    const cleanFlowKey = flowKey.trim().toLowerCase();
    for (const [ruleKey, targetUrl] of Object.entries(flowRules)) {
      if (ruleKey.toLowerCase() === cleanFlowKey) {
        return resolveUrlAgainstBase(targetUrl, baseCallbackUrl);
      }
    }
  }

  // 4. Reference-based flow routing: match flow keys or regex rules against reference
  if (ref && typeof flowRules === 'object') {
    // Sort rules by key length descending so longer/more specific rules match first
    const sortedRules = Object.entries(flowRules)
      .filter(([k, v]) => Boolean(k && v))
      .sort((a, b) => b[0].length - a[0].length);

    for (const [ruleKey, targetUrl] of sortedRules) {
      try {
        let isMatch = false;
        if (ruleKey.startsWith('^') || ruleKey.endsWith('$') || ruleKey.includes('.*') || /[\(\)\[\]\{\}\+\|\\]/.test(ruleKey)) {
          isMatch = matchReferencePattern(ruleKey, ref);
        } else {
          const cleanRule = ruleKey.toLowerCase().trim();
          const cleanRef = ref.toLowerCase().trim();
          const tokenRegex = new RegExp(`(?:^|[^a-zA-Z0-9])${cleanRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-zA-Z0-9]|$)`, 'i');
          if (tokenRegex.test(cleanRef) || cleanRef.includes(cleanRule)) {
            isMatch = true;
          }
        }
        if (isMatch) {
          return resolveUrlAgainstBase(targetUrl, baseCallbackUrl);
        }
      } catch {}
    }
  }

  return baseCallbackUrl;
}

function getOriginUrl(urlStr) {
  try {
    return new URL(urlStr).origin;
  } catch {
    return '';
  }
}

function resolveUrlAgainstBase(targetUrl, baseCallbackUrl) {
  if (!targetUrl) return baseCallbackUrl;
  const trimmed = String(targetUrl).trim();
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    if (baseCallbackUrl) {
      try {
        return new URL(trimmed, baseCallbackUrl).toString();
      } catch {}
    }
    return trimmed;
  }
}

/**
 * Resolves the target child site using the Smart Origin Resolution Hierarchy:
 * 1. Exact metadata resolution (metadata.origin_site, metadata.site_id, metadata.site_key, etc.)
 * 2. Smart Pattern / Prefix matching against configured sites' referencePrefixes & referencePatterns
 * 3. Standard delimiter splitting (first token before '_' or '-')
 * 4. Designated fallback site ('fallback')
 *
 * @param {object} payload - Paystack event payload or transaction data
 * @returns {{ siteKey: string, site: object, matchType: string, matchedRule?: string, resolvedCallbackUrl?: string } | null}
 */
export function resolveSite(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload.data || payload;
  const reference = getRawReference(data);

  // 1. Exact Metadata Resolution
  const metadata = parseMetadata(data.metadata);
  if (metadata) {
    let siteKey = metadata.origin_site || metadata.site_id || metadata.site_key || metadata.site || metadata.target_site ||
      metadata.originSite || metadata.siteId || metadata.siteKey || metadata.targetSite;

    // Check custom_fields array if standard fields are absent
    if (!siteKey && Array.isArray(metadata.custom_fields)) {
      const field = metadata.custom_fields.find(
        f => f && (f.variable_name === 'origin_site' || f.variable_name === 'site_id' || f.variable_name === 'site_key' || f.variable_name === 'site' || f.variable_name === 'originSite' || f.variable_name === 'siteKey')
      );
      if (field && field.value) {
        siteKey = field.value;
      }
    }

    // Check if metadata itself was an array of custom fields
    if (!siteKey && Array.isArray(metadata)) {
      const field = metadata.find(
        f => f && (f.variable_name === 'origin_site' || f.variable_name === 'site_id' || f.variable_name === 'site_key' || f.variable_name === 'site' || f.variable_name === 'originSite' || f.variable_name === 'siteKey')
      );
      if (field && field.value) {
        siteKey = field.value;
      }
    }

    if (siteKey !== undefined && siteKey !== null) {
      const normalizedKey = String(siteKey).toLowerCase().trim();
      const site = getSite(normalizedKey);
      if (site) {
        return {
          siteKey: normalizedKey,
          site,
          matchType: 'metadata',
          resolvedCallbackUrl: resolveTargetCallbackUrl({ site, payload, reference }),
        };
      }
    }
  }

  // 2. Smart Pattern / Prefix Matching against configured referencePrefixes & referencePatterns
  if (reference) {
    const allSites = getAllSites();

    // 2a. Smart Prefix Matching: collect all prefixes across sites and sort by length descending
    // This guarantees specific prefixes (e.g. "tsk_wallet") are tested before generic ones ("tsk")
    const prefixCandidates = [];
    for (const [key, site] of Object.entries(allSites)) {
      if (key === 'fallback') continue;
      const prefixes = Array.isArray(site.referencePrefixes)
        ? site.referencePrefixes
        : (typeof site.referencePrefixes === 'string'
            ? site.referencePrefixes.split(',').map(s => s.trim()).filter(Boolean)
            : []);

      for (const prefix of prefixes) {
        if (!prefix) continue;
        prefixCandidates.push({
          siteKey: key,
          site,
          prefix: String(prefix).trim(),
        });
      }
    }

    prefixCandidates.sort((a, b) => b.prefix.length - a.prefix.length);

    const cleanRef = reference.toLowerCase().trim();
    for (const item of prefixCandidates) {
      const cleanPrefix = item.prefix.toLowerCase();
      if (cleanRef.startsWith(cleanPrefix)) {
        return {
          siteKey: item.siteKey,
          site: item.site,
          matchType: 'smart_prefix',
          matchedRule: item.prefix,
          resolvedCallbackUrl: resolveTargetCallbackUrl({ site: item.site, payload, reference }),
        };
      }
    }

    // 2b. Smart Pattern Matching (Regex / Glob)
    const patternCandidates = [];
    for (const [key, site] of Object.entries(allSites)) {
      if (key === 'fallback') continue;
      const patterns = Array.isArray(site.referencePatterns)
        ? site.referencePatterns
        : (typeof site.referencePatterns === 'string'
            ? site.referencePatterns.split(',').map(s => s.trim()).filter(Boolean)
            : []);

      for (const pattern of patterns) {
        if (!pattern) continue;
        patternCandidates.push({
          siteKey: key,
          site,
          pattern: String(pattern).trim(),
        });
      }
    }

    patternCandidates.sort((a, b) => b.pattern.length - a.pattern.length);

    for (const item of patternCandidates) {
      if (matchReferencePattern(item.pattern, reference)) {
        return {
          siteKey: item.siteKey,
          site: item.site,
          matchType: 'smart_pattern',
          matchedRule: item.pattern,
          resolvedCallbackUrl: resolveTargetCallbackUrl({ site: item.site, payload, reference }),
        };
      }
    }

    // 3. Standard Delimiter Splitting (first token before '_' or '-')
    for (const delimiter of ['_', '-']) {
      const parts = reference.split(delimiter);
      if (parts.length > 1 && parts[0].trim().length > 0) {
        const candidateKey = parts[0].toLowerCase().trim();
        if (candidateKey !== 'fallback') {
          const site = getSite(candidateKey);
          if (site) {
            return {
              siteKey: candidateKey,
              site,
              matchType: 'reference',
              resolvedCallbackUrl: resolveTargetCallbackUrl({ site, payload, reference }),
            };
          }
        }
      }
    }
  }

  // 4. Default Fallback
  const fallbackSite = getSite('fallback');
  if (fallbackSite) {
    return {
      siteKey: 'fallback',
      site: fallbackSite,
      matchType: 'fallback',
      resolvedCallbackUrl: resolveTargetCallbackUrl({ site: fallbackSite, payload, reference }),
    };
  }

  return null;
}

/**
 * Executes the downstream HTTP POST to child site webhook endpoint.
 *
 * @param {object} job
 * @returns {Promise<{success: boolean, status?: number, error?: string}>}
 */
export async function forwardWebhookDownstream(job) {
  const { targetUrl, rawBody, headers, correlationId, siteKey } = job;
  const timeoutMs = config.proxy.timeoutMs;
  const timestamp = new Date().toISOString();

  // Compute internal proxy authentication signature using per-site secret or global shared secret
  const site = getSite(siteKey);
  const secret = site?.secret || config.proxy.sharedSecret;
  const proxySignature = computeProxySignature(rawBody, secret);

  const forwardHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'Paystack-MultiSite-Proxy/1.0',
    'x-paystack-signature': headers['x-paystack-signature'] || headers['X-Paystack-Signature'] || '',
    'x-proxy-signature': proxySignature,
    'x-proxy-timestamp': timestamp,
    'x-correlation-id': correlationId,
    'x-target-site': siteKey,
  };

  try {
    const response = await axios.post(targetUrl, rawBody, {
      headers: forwardHeaders,
      timeout: timeoutMs,
      validateStatus: status => status >= 200 && status < 300,
    });

    return {
      success: true,
      status: response.status,
    };
  } catch (err) {
    const status = err.response?.status;
    const errorMsg = err.response
      ? `HTTP ${status}: ${JSON.stringify(err.response.data || '')}`
      : err.code === 'ECONNABORTED'
      ? `Request timed out after ${timeoutMs}ms`
      : err.message;

    return {
      success: false,
      status,
      error: errorMsg,
    };
  }
}

// Bind forwarder to queue service
queueService.setForwarder(forwardWebhookDownstream);

/**
 * Dispatcher coordinator: resolves destination, checks routability, enqueues job.
 *
 * @param {object} params
 * @param {string} params.eventKey
 * @param {object} params.payload
 * @param {Buffer|string} params.rawBody
 * @param {object} params.headers
 * @param {string} params.correlationId
 * @returns {Promise<{queued: boolean, unroutable: boolean, siteKey?: string, targetUrl?: string, matchType?: string}>}
 */
export async function dispatchWebhook({ eventKey, payload, rawBody, headers, correlationId }) {
  if (typeof syncSitesWithDb === 'function') {
    await syncSitesWithDb();
  }

  const resolution = resolveSite(payload);

  if (!resolution || !resolution.site.webhookUrl) {
    metrics.unroutable++;
    logger.error(
      {
        correlationId,
        eventKey,
        payloadData: payload.data,
      },
      'Unroutable webhook event received: No matching site or fallback destination'
    );

    // Notify alert hook of unroutable event
    await notifier.notifyFailure({
      type: 'UNROUTABLE_EVENT',
      event: payload.event,
      reference: payload.data?.reference || payload.data?.id,
      siteKey: 'unroutable',
      attempts: 0,
      error: 'Payload origin could not be resolved via metadata or reference prefix, and no fallback configured',
      correlationId,
    });

    return { queued: false, unroutable: true };
  }

  const { siteKey, site, matchType, matchedRule } = resolution;
  logger.info(
    {
      correlationId,
      siteKey,
      matchType,
      matchedRule,
      targetUrl: site.webhookUrl,
      eventKey,
    },
    'Resolved target child site for webhook dispatch'
  );

  await queueService.enqueue({
    eventKey,
    siteKey,
    targetUrl: site.webhookUrl,
    rawBody,
    headers,
    correlationId,
    reference: payload?.data?.reference || payload?.data?.id || (eventKey ? eventKey.split(':')[1] : ''),
  });

  return {
    queued: true,
    unroutable: false,
    siteKey,
    targetUrl: site.webhookUrl,
    matchType,
  };
}

export default {
  computeProxySignature,
  getRawReference,
  matchReferencePattern,
  resolveTargetCallbackUrl,
  resolveSite,
  forwardWebhookDownstream,
  dispatchWebhook,
};
