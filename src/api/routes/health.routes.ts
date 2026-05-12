import { Router } from 'express';
import { healthCheck, readiness, liveness, metrics } from '../controllers/health.controller';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/health
// Full health check with component latencies
// ---------------------------------------------------------------------------
router.get('/', healthCheck);

// ---------------------------------------------------------------------------
// GET /api/v1/health/ready
// Kubernetes readiness probe (503 if DB is down)
// ---------------------------------------------------------------------------
router.get('/ready', readiness);

// ---------------------------------------------------------------------------
// GET /api/v1/health/live
// Kubernetes liveness probe (always 200 while process is running)
// ---------------------------------------------------------------------------
router.get('/live', liveness);

// ---------------------------------------------------------------------------
// GET /api/v1/health/metrics
// Prometheus metrics endpoint
// ---------------------------------------------------------------------------
router.get('/metrics', metrics);

export default router;
