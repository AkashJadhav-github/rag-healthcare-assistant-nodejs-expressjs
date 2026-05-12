import { Request, Response, NextFunction } from 'express';
import prisma from '../../db/postgres';
import { cacheService } from '../../services/cache.service';
import { asyncHandler } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import { register } from '../../services/metrics.service';

const log = createLogger('HealthController');

// ---------------------------------------------------------------------------
// Process start time for uptime calculation
// ---------------------------------------------------------------------------

const processStartTime = Date.now();

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/health
 *
 * Performs active liveness checks against PostgreSQL and Redis, returning a
 * structured status payload with per-component latencies.
 */
export const healthCheck = asyncHandler(
  async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const version = process.env.npm_package_version ?? '1.0.0';
    const uptimeSeconds = Math.floor((Date.now() - processStartTime) / 1000);

    // ── Database check ────────────────────────────────────────────────────
    const dbStart = Date.now();
    let dbStatus: 'healthy' | 'unhealthy' = 'unhealthy';
    let dbError: string | undefined;

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = 'healthy';
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
      log.error('Health check: database unreachable', { error: dbError });
    }

    const dbLatencyMs = Date.now() - dbStart;

    // ── Cache check ───────────────────────────────────────────────────────
    const cacheStart = Date.now();
    let cacheStatus: 'healthy' | 'unhealthy' = 'unhealthy';
    let cacheError: string | undefined;

    try {
      const alive = await cacheService.healthCheck();
      cacheStatus = alive ? 'healthy' : 'unhealthy';
    } catch (err) {
      cacheError = err instanceof Error ? err.message : String(err);
      log.error('Health check: cache unreachable', { error: cacheError });
    }

    const cacheLatencyMs = Date.now() - cacheStart;

    // ── Overall status ────────────────────────────────────────────────────
    const overallStatus =
      dbStatus === 'healthy' && cacheStatus === 'healthy' ? 'healthy' : 'degraded';

    const statusCode = overallStatus === 'healthy' ? 200 : 207;

    res.status(statusCode).json({
      status: overallStatus,
      version,
      uptimeSeconds,
      components: {
        database: {
          status: dbStatus,
          latencyMs: dbLatencyMs,
          ...(dbError ? { error: dbError } : {}),
        },
        cache: {
          status: cacheStatus,
          latencyMs: cacheLatencyMs,
          ...(cacheError ? { error: cacheError } : {}),
        },
        api: {
          status: 'healthy',
        },
      },
      timestamp: new Date().toISOString(),
    });
  }
);

// ---------------------------------------------------------------------------
// readiness
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/health/ready
 *
 * Kubernetes readiness probe. Returns 503 if the database is unavailable so
 * the pod is removed from the load balancer until the dependency recovers.
 */
export const readiness = async (_req: Request, res: Response): Promise<void> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    log.warn('Readiness probe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({ status: 'not_ready', error: 'Database unavailable' });
  }
};

// ---------------------------------------------------------------------------
// liveness
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/health/live
 *
 * Kubernetes liveness probe. Always returns 200 while the process is alive.
 * If this endpoint fails, the container will be restarted.
 */
export const liveness = (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'alive' });
};

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/health/metrics
 *
 * Exposes Prometheus metrics in text/plain format for scraping by
 * Prometheus / Grafana.
 */
export const metrics = async (_req: Request, res: Response): Promise<void> => {
  try {
    const metricsData = await register.metrics();
    res.set('Content-Type', register.contentType);
    res.status(200).send(metricsData);
  } catch (err) {
    log.error('Failed to collect Prometheus metrics', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
};
