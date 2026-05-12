import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.middleware';
import { requirePermission, Permission } from '../middleware/rbac.middleware';
import { auditLog, AuditAction } from '../middleware/audit.middleware';
import { reindex, createUser, getStats } from '../controllers/admin.controller';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/admin/reindex
// Requires REINDEX permission; audit-logged
// ---------------------------------------------------------------------------
router.post(
  '/reindex',
  authenticateJWT,
  requirePermission(Permission.REINDEX),
  auditLog(AuditAction.REINDEX),
  reindex
);

// ---------------------------------------------------------------------------
// POST /api/v1/admin/users
// Requires MANAGE_USERS permission; audit-logged
// ---------------------------------------------------------------------------
router.post(
  '/users',
  authenticateJWT,
  requirePermission(Permission.MANAGE_USERS),
  auditLog(AuditAction.USER_CREATE),
  createUser
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/stats
// Requires full ADMIN permission
// ---------------------------------------------------------------------------
router.get(
  '/stats',
  authenticateJWT,
  requirePermission(Permission.ADMIN),
  getStats
);

export default router;
