import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import { logger, config } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import webhookRouter from './routes/webhook.js';
import callbackRouter from './routes/callback.js';
import healthRouter from './routes/health.js';
import dashboardRouter from './routes/dashboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

export function createApp() {
  const app = express();

  // Trust first proxy hop (e.g. Nginx, AWS ALB, Cloudflare)
  app.set('trust proxy', 1);

  // Security HTTP headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Permit clean inline CSS on fallback error views
    })
  );

  // Global Rate Limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      status: false,
      message: 'Too many requests, please try again later.',
    },
  });
  app.use(limiter);

  // Structured request logging with correlation ID
  app.use(
    pinoHttp({
      logger,
      genReqId: req => req.headers['x-correlation-id'] || crypto.randomUUID(),
      customLogLevel: (req, res, err) => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: {
        ignore: req => req.url === '/health' || req.url === '/metrics' || req.url.startsWith('/api/v1/dashboard/stats') || req.url.startsWith('/api/v1/dashboard/events'),
      },
    })
  );

  // Raw body retention middleware for cryptographic HMAC SHA512 signature validation
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
      limit: '2mb',
    })
  );

  app.use(
    express.urlencoded({
      extended: true,
      verify: (req, res, buf) => {
        if (!req.rawBody) req.rawBody = buf;
      },
      limit: '2mb',
    })
  );

  // Health and Metrics endpoints
  app.use('/', healthRouter);

  // Dashboard API endpoints
  app.use('/api/v1/dashboard', dashboardRouter);

  // Serve static UI assets and dashboard views
  const frontendOutDir = path.resolve(__dirname, '../frontend/out');
  if (fs.existsSync(frontendOutDir)) {
    app.use(express.static(frontendOutDir));
  }
  app.use(express.static(publicDir));

  app.get('/', (req, res) => {
    if (fs.existsSync(path.join(frontendOutDir, 'index.html'))) {
      return res.sendFile(path.join(frontendOutDir, 'index.html'));
    }
    if (fs.existsSync(path.join(publicDir, 'app.html'))) {
      return res.sendFile(path.join(publicDir, 'app.html'));
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/dashboard', (req, res) => {
    if (fs.existsSync(path.join(frontendOutDir, 'index.html'))) {
      return res.sendFile(path.join(frontendOutDir, 'index.html'));
    }
    if (fs.existsSync(path.join(publicDir, 'app.html'))) {
      return res.sendFile(path.join(publicDir, 'app.html'));
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Paystack Webhook and Callback endpoints
  app.use('/api/v1/paystack', webhookRouter);
  app.use('/api/v1/paystack', callbackRouter);

  // 404 Handler
  app.use(notFoundHandler);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
