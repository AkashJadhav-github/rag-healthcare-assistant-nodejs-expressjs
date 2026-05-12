import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.middleware';
import { requirePermission, Permission } from '../middleware/rbac.middleware';
import { apiLimiter } from '../middleware/rateLimit.middleware';
import { auditLog, AuditAction } from '../middleware/audit.middleware';
import {
  ask,
  ingest,
  getHistory,
  upload,
} from '../controllers/knowledge.controller';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/knowledge/ask
// Authenticated + QUERY permission + general rate limit
// ---------------------------------------------------------------------------
router.post(
  '/ask',
  authenticateJWT,
  requirePermission(Permission.QUERY),
  apiLimiter,
  auditLog(AuditAction.QUERY),
  ask
);

// ---------------------------------------------------------------------------
// POST /api/v1/knowledge/ingest
// Authenticated + INGEST permission + multer file upload
// ---------------------------------------------------------------------------
router.post(
  '/ingest',
  authenticateJWT,
  requirePermission(Permission.INGEST),
  upload.single('file'),
  auditLog(AuditAction.DOCUMENT_UPLOAD),
  ingest
);

// ---------------------------------------------------------------------------
// GET /api/v1/knowledge/history
// Authenticated + VIEW_HISTORY permission
// ---------------------------------------------------------------------------
router.get(
  '/history',
  authenticateJWT,
  requirePermission(Permission.VIEW_HISTORY),
  getHistory
);

export default router;
