/**
 * Integration tests — Auth endpoints
 *
 * POST /api/v1/auth/login
 * GET  /api/v1/auth/me
 */

// ---------------------------------------------------------------------------
// Mocks — must come before any src/ imports
// ---------------------------------------------------------------------------

// Shared mock user record used across tests
const MOCK_USER = {
  id: 'user-uuid-1234',
  email: 'dr.alice@hospital.org',
  username: 'dr.alice',
  fullName: 'Dr. Alice Chen',
  hashedPassword: '$2a$12$mockHashedPasswordValue.notreal',
  role: 'PHYSICIAN',
  isActive: true,
  isVerified: true,
  department: 'Cardiology',
  lastLogin: new Date('2026-05-10T09:00:00Z'),
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2026-05-10T09:00:00Z'),
};

// Prisma mock — factory must not reference const variables (hoisting issue).
// __esModule: true is required so the esModuleInterop helper uses .default correctly.
jest.mock('../../src/db/postgres', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
  checkDBHealth: jest.fn().mockResolvedValue(true),
}));

// Cache mock — no brute-force lockout in tests by default
const mockCacheService = {
  get: jest.fn().mockResolvedValue(null),         // no existing attempt counter
  increment: jest.fn().mockResolvedValue(1),
  delete: jest.fn().mockResolvedValue(true),
  deletePattern: jest.fn().mockResolvedValue(0),
  ttl: jest.fn().mockResolvedValue(-2),
  healthCheck: jest.fn().mockResolvedValue(true),
};

jest.mock('../../src/services/cache.service', () => ({
  cacheService: mockCacheService,
  CacheService: jest.fn(),
}));

// bcrypt mock — control password verification outcome
const mockVerifyPassword = jest.fn();
jest.mock('bcryptjs', () => ({
  compare: (...args: unknown[]) => mockVerifyPassword(...args),
  hash: jest.fn().mockResolvedValue('$2a$12$mockHash'),
}));

// Config mock — avoids needing a real .env
jest.mock('../../src/config/config', () => ({
  config: {
    PORT: 3000,
    NODE_ENV: 'test',
    API_VERSION: 'v1',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    PINECONE_API_KEY: 'test-key',
    PINECONE_ENVIRONMENT: 'us-east1-gcp',
    PINECONE_INDEX_NAME: 'healthcare-knowledge',
    OPENAI_API_KEY: 'test-key',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-ada-002',
    OPENAI_LLM_MODEL: 'gpt-4',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_MODEL: 'claude-3-5-sonnet-20241022',
    LLM_PROVIDER: 'openai',
    EMBEDDING_PROVIDER: 'openai',
    JWT_SECRET: 'test-jwt-secret-at-least-32-chars-long-ok!!',
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
// Minimal test app factory
// ---------------------------------------------------------------------------

import express, { Router, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import prisma from '../../src/db/postgres';
import { login, getMe } from '../../src/api/controllers/auth.controller';
import { globalErrorHandler } from '../../src/utils/errors';

const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-ok!!';

/** Minimal JWT auth middleware for integration tests */
function testAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: { code: 'AUTH_ERROR', message: 'Authentication required' } });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: 'rag-healthcare-assistant',
      audience: 'rag-healthcare-api',
    }) as { sub: string; role: string; type: string };

    if (payload.type !== 'access') {
      res.status(401).json({ success: false, error: { code: 'AUTH_ERROR', message: 'Expected an access token' } });
      return;
    }

    // Attach user info to request
    (req as Request & { user: { id: string; role: string; email: string } }).user = {
      id: payload.sub,
      role: payload.role,
      email: '',
    };
    next();
  } catch {
    res.status(401).json({ success: false, error: { code: 'AUTH_ERROR', message: 'Invalid token' } });
  }
}

function buildTestApp() {
  const app = express();
  app.use(express.json());

  const router = Router();
  router.post('/login', login);
  router.get('/me', testAuthMiddleware, getMe);

  app.use('/api/v1/auth', router);
  app.use(globalErrorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth endpoints', () => {
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildTestApp();

    // Restore default update mock after clearAllMocks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.update.mockResolvedValue(MOCK_USER);

    // Default: cache has no previous failed attempts
    mockCacheService.get.mockResolvedValue(null);
    mockCacheService.increment.mockResolvedValue(1);
    mockCacheService.delete.mockResolvedValue(true);
    mockCacheService.ttl.mockResolvedValue(-2);
  });

  // ── 1. Wrong password returns 401 ─────────────────────────────────────────
  it('POST /api/v1/auth/login with wrong password returns 401', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.findUnique
      .mockResolvedValue({
        ...MOCK_USER,
        select: undefined,
      });
    mockVerifyPassword.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'dr.alice@hospital.org', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/invalid email or password/i);
  });

  // ── 2. Unknown email returns 401 ──────────────────────────────────────────
  it('POST /api/v1/auth/login with unknown email returns 401', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.findUnique
      .mockResolvedValue(null);
    mockVerifyPassword.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'nobody@nowhere.com', password: 'anypassword' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // ── 3. Correct credentials return 200 with tokens ─────────────────────────
  it('POST /api/v1/auth/login with correct credentials returns 200 with tokens', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.findUnique
      .mockResolvedValue(MOCK_USER);
    mockVerifyPassword.mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.update
      .mockResolvedValue({ ...MOCK_USER, lastLogin: new Date() });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'dr.alice@hospital.org', password: 'CorrectPass123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('access_token');
    expect(res.body.data).toHaveProperty('refresh_token');
    expect(res.body.data.token_type).toBe('Bearer');
    expect(res.body.data.user.email).toBe('dr.alice@hospital.org');
  });

  // ── 4. GET /auth/me without token returns 401 ─────────────────────────────
  it('GET /api/v1/auth/me without Authorization header returns 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // ── 5. GET /auth/me with valid token returns 200 with user profile ─────────
  it('GET /api/v1/auth/me with valid token returns 200 with user profile', async () => {
    // Create a valid JWT as the test middleware will verify
    const validToken = jwt.sign(
      { sub: MOCK_USER.id, role: MOCK_USER.role, type: 'access' },
      JWT_SECRET,
      { expiresIn: '15m', issuer: 'rag-healthcare-assistant', audience: 'rag-healthcare-api' }
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.findUnique
      .mockResolvedValue(MOCK_USER);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data.user.email).toBe(MOCK_USER.email);
    expect(res.body.data.user.role).toBe(MOCK_USER.role);
  });

  // ── 6. GET /auth/me with expired token returns 401 ────────────────────────
  it('GET /api/v1/auth/me with expired token returns 401', async () => {
    // Sign with -1s so it is immediately expired
    const expiredToken = jwt.sign(
      { sub: MOCK_USER.id, role: MOCK_USER.role, type: 'access' },
      JWT_SECRET,
      { expiresIn: -1, issuer: 'rag-healthcare-assistant', audience: 'rag-healthcare-api' }
    );

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  // ── 7. Login with missing password field returns 400 (validation error) ───
  it('POST /api/v1/auth/login with missing password returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'dr.alice@hospital.org' });

    // Controller uses Zod validation → 400 ValidationError
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── 8. Login with invalid email format returns 400 ────────────────────────
  it('POST /api/v1/auth/login with invalid email format returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'not-an-email', password: 'SomePassword1!' });

    expect(res.status).toBe(400);
  });

  // ── 9. Deactivated user returns 401 ──────────────────────────────────────
  it('POST /api/v1/auth/login for deactivated account returns 401', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).user.findUnique
      .mockResolvedValue({ ...MOCK_USER, isActive: false });
    mockVerifyPassword.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'dr.alice@hospital.org', password: 'CorrectPass123!' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/deactivated/i);
  });
});
