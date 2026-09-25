# Paystack Multi-Site Webhook & Callback Proxy (Dispatcher)

A production-grade, secure, and resilient webhook dispatcher and payment callback proxy for Paystack. Allows multiple independent child web applications (e.g., e-commerce, digital products, SaaS portals) to share a single Paystack merchant account seamlessly.

---

## Architecture Overview

```
                                    +----------------------------------+
                                    |         Paystack Engine          |
                                    +----------------------------------+
                                        /                          \
            1. Webhooks (POST)         /                            \ 2. Callback Redirects (GET)
                                      v                              v
                      +------------------------------------------------------+
                      |      Paystack Multi-Site Dispatcher Proxy            |
                      |  - IP Whitelist check                                |
                      |  - Timing-safe HMAC SHA512 signature validation      |
                      |  - 24h Idempotency / Deduplication Cache             |
                      |  - Dual Fallback Site Resolution:                    |
                      |       (1) metadata -> (2) prefix -> (3) fallback     |
                      |  - Responds 200 OK within 500ms                      |
                      |  - Async retry queue with exponential backoff        |
                      |  - Proxy HMAC signature header (x-proxy-signature)   |
                      |  - Dead-letter alerting (Discord / Telegram)         |
                      +------------------------------------------------------+
                                   /             |              \
                                  /              |               \
                                 v               v                v
                 +-------------------+  +-------------------+  +-------------------+
                 | Child Site: Lufak |  | Child Site: SaaS  |  |  Ops Fallback Sink|
                 | (E-Commerce Store)|  |  (Subscription)   |  |   (Dead-Letter)   |
                 +-------------------+  +-------------------+  +-------------------+
```

---

## Features

- **Dual Fallback Origin Resolution:**
  1. *Metadata Inspection:* Checks `data.metadata.origin_site`, `data.metadata.site_id`, or `data.metadata.custom_fields`.
  2. *Reference Prefix Parsing:* Extracts prefix from `data.reference` pattern `<site_key>_<unique_id>` (e.g. `lufak_order_12948` -> `lufak`).
  3. *Default Fallback:* Seamlessly catches unmapped events via a configured `fallback` site without dropping data.
- **Timing-Safe HMAC SHA512 Verification:** Validates `x-paystack-signature` using constant-time comparison against unparsed raw body buffer (`req.rawBody`).
- **Downstream Proxy Authenticity:** Appends `x-proxy-signature` (HMAC SHA256) and `x-proxy-timestamp` signed with an internal shared secret (`PROXY_SHARED_SECRET`) for child site integrity verification.
- **Idempotency & Deduplication:** Caches event keys (`${event}:${id||reference}`) for 24 hours. Returns immediate 200 OK without re-dispatching duplicates to prevent double-crediting.
- **Pluggable Storage Adapters:** Supports `memory` (zero dependency), `sqlite` (crash-resilient local persistence via native `node:sqlite`), and `redis` (distributed Redis clusters).
- **Background Retries with Exponential Backoff:** Asynchronously delivers webhooks. If a child site is down or times out (default: 8s), retries up to 4 times: `+15s`, `+1m`, `+5m`, `+15m`.
- **Ops Failure Alerts:** Automatically posts formatted embeds to Discord or Markdown alerts to Telegram when max retries are exceeded or unroutable events are detected.
- **Paystack Callback Interceptor:** Intercepts browser payment redirects, verifies reference against Paystack's API, and redirects customers (302) to `${childSite.callbackUrl}?reference=${ref}&status=${status}`.
- **Monitoring & Observability:** Structured JSON logging via Pino with correlation IDs, plus `/health` and `/metrics` endpoints.

---

## File Structure

```text
paystack-proxy/
├── package.json              # Project dependencies and test/start scripts
├── .env.example              # Template environment configuration
├── config/
│   ├── default.js            # Default runtime configurations & fallbacks
│   └── sites.json            # Dynamic registry of child sites and endpoints
├── src/
│   ├── app.js                # Express app configuration & middleware pipeline
│   ├── server.js             # HTTP server entrypoint with graceful shutdown
│   ├── config/
│   │   └── index.js          # Unified config, sites loader & Pino logger
│   ├── middleware/
│   │   ├── auth.js           # Timing-safe HMAC SHA512 signature validation
│   │   ├── ipWhitelist.js    # Optional Paystack IP address whitelist filter
│   │   └── errorHandler.js   # Global error handling and 404 handler
│   ├── services/
│   │   ├── dispatcher.js     # Site resolution and downstream Axios dispatcher
│   │   ├── queue.js          # Retry worker and pluggable idempotency store
│   │   ├── paystack.js       # Paystack transaction verification API client
│   │   └── notifier.js       # Discord & Telegram failure alert hooks
│   └── routes/
│       ├── webhook.js        # POST /api/v1/paystack/webhook
│       ├── callback.js       # GET  /api/v1/paystack/callback
│       └── health.js         # GET  /health and GET /metrics
└── test/
    ├── webhook.test.js       # Signature, routing, and idempotency tests
    ├── callback.test.js      # Callback interceptor and redirect tests
    ├── queue.test.js         # Retry worker and backoff tests
    └── health.test.js        # Health and metrics endpoint tests
```

---

## Prerequisites

- **Node.js:** v18.0.0 or later (v20+ / v22+ LTS recommended)
- **npm:** v9.0.0 or later

---

## Quick Start (Local Development)

### 1. Clone & Install Dependencies
```bash
cd "paystack-proxy"
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Update `.env` with your actual Paystack secret key:
```ini
PORT=3000
PAYSTACK_SECRET_KEY=sk_test_your_paystack_secret_key
PAYSTACK_WEBHOOK_SECRET=sk_test_your_paystack_secret_key
PROXY_SHARED_SECRET=your-secure-internal-shared-secret-key-min-32-chars
QUEUE_STORAGE_TYPE=memory
ENABLE_IP_WHITELIST=false
```

### 3. Configure Child Sites in `config/sites.json`
Define your registered applications:
```json
{
  "sites": {
    "lufak": {
      "name": "Lufak E-Commerce",
      "webhookUrl": "https://store.lufak.com/api/v1/paystack/webhook",
      "callbackUrl": "https://store.lufak.com/checkout/complete",
      "secret": "lufak_internal_secret"
    },
    "saas": {
      "name": "SaaS Platform",
      "webhookUrl": "https://app.saasplatform.io/billing/webhook",
      "callbackUrl": "https://app.saasplatform.io/billing/callback"
    },
    "fallback": {
      "name": "Ops Fallback Sink",
      "webhookUrl": "https://ops.example.com/webhooks/paystack-unmatched",
      "callbackUrl": "https://ops.example.com/checkout/failed"
    }
  }
}
```

### 4. Run the Development Server
```bash
# Development mode with hot-reload
npm run dev

# Production start
npm start
```

---

## Running Tests

Execute the automated test suite using Node's native test runner:
```bash
npm test
```
The test suite validates:
- HMAC SHA512 signature validation and rejection of invalid/missing signatures
- Deduplication and idempotency verification
- Dual Fallback origin resolution (metadata, reference prefix, and default fallback)
- IP whitelisting filters
- Paystack callback redirection and error handling
- Retry scheduling and dead-letter alert notifications
- Health check and metrics counters

---

## Paystack Dashboard Setup

In your **Paystack Dashboard -> Settings -> Preferences**:
1. **Webhook URL:** Set to `https://proxy.yourdomain.com/api/v1/paystack/webhook`
2. **Callback URL:** Set to `https://proxy.yourdomain.com/api/v1/paystack/callback`

### How Child Sites Initialize Payments

#### Option A: Metadata (Recommended)
When initiating a transaction from any child application, provide `origin_site` in the metadata:
```javascript
const response = await paystack.transaction.initialize({
  email: 'customer@example.com',
  amount: 500000, // in pesewas (100 pesewas = 1 GHS, e.g. GH₵ 5,000.00)
  currency: 'GHS',
  metadata: {
    origin_site: 'lufak',
    flow: 'wallet', // optional flow routing key matching site.flowRoutes
    redirect_path: '/dashboard/wallet/success', // optional dynamic callback redirect path
  }
});
```

#### Option B: Smart Reference Prefix or Pattern
Prefix the transaction reference with any configured `referencePrefixes` or match a `referencePatterns` regex:
```javascript
// Matches referencePrefix "tsk_wallet" or pattern "^tsk_(wallet|store)_.*"
const reference = `tsk_wallet_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const response = await paystack.transaction.initialize({
  email: 'customer@example.com',
  amount: 500000, // GH₵ 5,000.00 in pesewas
  currency: 'GHS',
  reference: reference
});
```

The Smart Reference Matching Engine evaluates:
1. **Exact Metadata Resolution:** `metadata.origin_site`, `metadata.site_id`, `metadata.site_key`, or `custom_fields`.
2. **Smart Prefix & Pattern Matching:** Site-configured `referencePrefixes` and `referencePatterns` regexes.
3. **Flow Callback Routes:** Dedicated redirection endpoints for flows (e.g. `wallet` vs `checkout`).
4. **Standard Delimiter Splitting:** First token before `_` or `-`.
5. **Fallback:** Designated `fallback` sink.

---

## Downstream Child Site Webhook Verification

Child sites should verify that incoming requests originate from the proxy by validating the `x-proxy-signature` header:

```javascript
import crypto from 'node:crypto';

export function verifyProxySignature(rawBody, signature, sharedSecret) {
  const expected = crypto
    .createHmac('sha256', sharedSecret)
    .update(rawBody)
    .digest('hex');

  const bufA = Buffer.from(expected, 'utf8');
  const bufB = Buffer.from(signature, 'utf8');

  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
```

---

## Production Deployment

### Option 1: Process Management via PM2 (Recommended)

1. Install PM2 globally:
```bash
npm install -g pm2
```

2. Create `ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [
    {
      name: 'paystack-proxy',
      script: 'src/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        QUEUE_STORAGE_TYPE: 'sqlite', // or 'redis'
        SQLITE_DB_PATH: '/var/lib/paystack-proxy/proxy.db',
        ENABLE_IP_WHITELIST: 'true'
      },
      max_memory_restart: '500M',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
```

3. Start and persist PM2:
```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

---

### Option 2: Linux systemd Service

1. Create a dedicated system user:
```bash
sudo useradd -r -s /bin/false paystack-proxy
sudo mkdir -p /var/lib/paystack-proxy
sudo chown -R paystack-proxy:paystack-proxy /var/lib/paystack-proxy
```

2. Create `/etc/systemd/system/paystack-proxy.service`:
```ini
[Unit]
Description=Paystack Multi-Site Webhook & Callback Proxy
After=network.target

[Service]
Type=simple
User=paystack-proxy
WorkingDirectory=/var/www/paystack-proxy
EnvironmentFile=/var/www/paystack-proxy/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=paystack-proxy
KillSignal=SIGTERM
TimeoutStopSec=15
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

3. Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable paystack-proxy
sudo systemctl start paystack-proxy
sudo systemctl status paystack-proxy
```

---

## Monitoring Endpoints

- `GET /health`:
```json
{
  "status": "ok",
  "uptimeSeconds": 1420,
  "timestamp": "2026-09-23T12:00:00.000Z",
  "configuredSites": 4,
  "storageType": "sqlite"
}
```

- `GET /metrics`:
```json
{
  "uptimeSeconds": 1420,
  "timestamp": "2026-09-23T12:00:00.000Z",
  "memory": {
    "rssBytes": 45129728,
    "heapTotalBytes": 20971520,
    "heapUsedBytes": 14680064,
    "externalBytes": 1823744
  },
  "events": {
    "ingested": 105,
    "forwarded": 103,
    "duplicates": 2,
    "retries": 1,
    "deadLetters": 0,
    "unroutable": 0
  },
  "queue": {
    "activeJobs": 0,
    "queuedRetries": 0
  },
  "callbacks": {
    "total": 45,
    "success": 45,
    "failed": 0
  }
}
```
