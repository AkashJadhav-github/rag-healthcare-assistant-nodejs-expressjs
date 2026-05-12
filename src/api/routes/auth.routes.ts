import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimit.middleware';
import { authenticateJWT } from '../middleware/auth.middleware';
import { auditLog, AuditAction } from '../middleware/audit.middleware';
import { login, logout, getMe, refreshToken } from '../controllers/auth.controller';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// Rate-limited; audit-logged on finish
// ---------------------------------------------------------------------------
router.post(
  '/login',
  authLimiter,
  auditLog(AuditAction.LOGIN),
  login
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// Requires valid JWT; audit-logged on finish
// ---------------------------------------------------------------------------
router.post(
  '/logout',
  authenticateJWT,
  auditLog(AuditAction.LOGOUT),
  logout
);

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me
// Returns the authenticated user's profile
// ---------------------------------------------------------------------------
router.get(
  '/me',
  authenticateJWT,
  getMe
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// Issues a new access token from a refresh token
// ---------------------------------------------------------------------------
router.post(
  '/refresh',
  authLimiter,
  refreshToken
);

export default router;
