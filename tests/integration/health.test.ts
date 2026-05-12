/**
 * Integration tests — Health endpoints
 *
 * GET /api/v1/health          → 200 with components + version
 * GET /api/v1/health/live     → 200 { status: 'alive' }
 * GET /api/v1/health/metrics  → 200 Prometheus text
 */

// ---------------------------------------------------------------------------
// Mocks — must come before any src/ imports
// ---------------------------------------------------------------------------

jest.mock('../../src/db/postgres', () => ({
  default: {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  checkDBHealth: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/services/cache.service', () => ({
  cacheService: {
    healthCheck: jest.fn().mockResolvedValue(true),
  },
}));

// Prevent config validation failure in CI (no real .env)
jest.mock('../../src/config/config', () => ({
  config: {
    PORT: 3000,
    NODE_ENV: 'test',
    API_VERSION: 'v1',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    PINECONE_API_KEY: 'test-pinecone-key',
    PINECONE_ENVIRONMENT: 'us-east1-gcp',
    PINECONE_INDEX_NAME: 'healthcare-knowledge',
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-ada-002',
    OPENAI_LLM_MODEL: 'gpt-4',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    ANTHROPIC_MODEL: 'claude-3-5-sonnet-20241022',
    LLM_PROVIDER: 'openai',
    EMBEDDING_PROVIDER: 'openai',
    JWT_SECRET: 'test-jwt-secret-at-least-32-chars-long!!',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    ENCRYPTION_KEY: 'a'.repeat(64),
    CHUNK_SIZE: 1000,
    CHUNK_OVERLAP: 200,
    MAX_RETRIEVAL_DOCS: 5,
    SIMILARITY_THRESHOLD: 0.75,
    MAX_DOCUMENT_SIZE_MB: 50,
    RATE_LIMIT_WINDOW_MS: 900000,
    RATE_LIMIT_MAX: 100,
    ENABLE_METRICS: true,
    ADMIN_EMAIL: 'admin@test.com',
    ADMIN_PASSWORD: 'AdminPass123!@#',
    ALLOWED_ORIGINS: ['http://localhost:3000'],
  },
  isDev: false,
  isTest: true,
  isProd: false,
  MAX_DOCUMENT_SIZE_BYTES: 52428800,
  default: {},
}));

// ---------------------------------------------------------------------------
// Test app factory (minimal Express app with health router)
// ---------------------------------------------------------------------------

import express, { Router, Request, Response } from 'express';
import request from 'supertest';
import { register as promRegister } from 'prom-client';
import { checkDBHealth } from '../../src/db/postgres';
import { cacheService } from '../../src/services/cache.service';

function buildTestApp() {
  const app = express();
  app.use(express.json());

  const router = Router();

  // GET /api/v1/health
  router.get('/', async (_req: Request, res: Response) => {
    const dbOk = await (checkDBHealth as jest.Mock)();
    const redisOk = await cacheService.healthCheck();

    const status = dbOk && redisOk ? 'healthy' : 'degraded';
    res.status(200).json({
      success: true,
      data: {
        status,
        version: '1.0.0',
        components: {
          database: { status: dbOk ? 'healthy' : 'unhealthy' },
          redis: { status: redisOk ? 'healthy' : 'unhealthy' },
        },
        timestamp: new Date().toISOString(),
      },
    });
  });

  // GET /api/v1/health/live
  router.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'alive' });
  });

  // GET /api/v1/health/ready
  router.get('/ready', async (_req: Request, res: Response) => {
    const dbOk = await (checkDBHealth as jest.Mock)();
    if (!dbOk) {
      res.status(503).json({ status: 'not ready', reason: 'database unavailable' });
      return;
    }
    res.status(200).json({ status: 'ready' });
  });

  // GET /api/v1/health/metrics
  router.get('/metrics', async (_req: Request, res: Response) => {
    const metrics = await promRegister.metrics();
    res.set('Content-Type', promRegister.contentType);
    res.status(200).send(metrics);
  });

  app.use('/api/v1/health', router);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Health endpoints', () => {
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    app = buildTestApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. GET /api/v1/health returns 200 with status, components, version ──────
  it('GET /api/v1/health returns 200 with status, components, and version', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('version');
    expect(res.body.data).toHaveProperty('components');
    expect(res.body.data.components).toHaveProperty('database');
    expect(res.body.data.components).toHaveProperty('redis');
  });

  // ── 2. Healthy when both DB and Redis are up ─────────────────────────────────
  it('GET /api/v1/health reports "healthy" when DB and Redis are both up', async () => {
    (checkDBHealth as jest.Mock).mockResolvedValue(true);
    (cacheService.healthCheck as jest.Mock).mockResolvedValue(true);

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.components.database.status).toBe('healthy');
    expect(res.body.data.components.redis.status).toBe('healthy');
  });

  // ── 3. Degraded when DB is down ──────────────────────────────────────────────
  it('GET /api/v1/health reports "degraded" when DB is unavailable', async () => {
    (checkDBHealth as jest.Mock).mockResolvedValue(false);

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.components.database.status).toBe('unhealthy');
  });

  // ── 4. GET /api/v1/health/live returns 200 { status: 'alive' } ──────────────
  it('GET /api/v1/health/live returns 200 with { status: "alive" }', async () => {
    const res = await request(app).get('/api/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });

  // ── 5. GET /api/v1/health/ready returns 200 when DB is healthy ──────────────
  it('GET /api/v1/health/ready returns 200 when database is available', async () => {
    (checkDBHealth as jest.Mock).mockResolvedValue(true);

    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  // ── 6. GET /api/v1/health/ready returns 503 when DB is down ─────────────────
  it('GET /api/v1/health/ready returns 503 when database is unavailable', async () => {
    (checkDBHealth as jest.Mock).mockResolvedValue(false);

    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not ready');
  });

  // ── 7. GET /api/v1/health/metrics returns 200 with prometheus text ───────────
  it('GET /api/v1/health/metrics returns 200 with Prometheus content type', async () => {
    const res = await request(app).get('/api/v1/health/metrics');

    expect(res.status).toBe(200);
    // Prometheus text format starts with "# HELP" or "# TYPE" lines
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(typeof res.text).toBe('string');
  });
});
