import { Router } from 'express';
import { getAllSites, config } from '../config/index.js';
import { queueService } from '../services/queue.js';

const router = Router();

/**
 * GET /health
 * System liveness and basic health check
 */
router.get('/health', (req, res) => {
  const sites = getAllSites();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    configuredSites: Object.keys(sites).length,
    storageType: config.proxy.queueStore,
  });
});

/**
 * GET /metrics
 * System operational metrics for Prometheus/monitoring tools
 */
router.get('/metrics', (req, res) => {
  const memory = process.memoryUsage();
  const queueMetrics = queueService.getMetrics();

  res.json({
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
    },
    events: {
      ingested: queueMetrics.ingested,
      forwarded: queueMetrics.forwarded,
      duplicates: queueMetrics.duplicates,
      retries: queueMetrics.retries,
      deadLetters: queueMetrics.deadLetters,
      unroutable: queueMetrics.unroutable,
      avgLatencyMs: queueMetrics.avgLatencyMs || 0,
      lastLatencyMs: queueMetrics.lastLatencyMs || 0,
    },
    queue: {
      activeJobs: queueMetrics.activeJobs,
      queuedRetries: queueMetrics.queuedRetries,
    },
    callbacks: {
      total: queueMetrics.callbacksTotal,
      success: queueMetrics.callbacksSuccess,
      failed: queueMetrics.callbacksFailed,
    },
  });
});

export default router;
