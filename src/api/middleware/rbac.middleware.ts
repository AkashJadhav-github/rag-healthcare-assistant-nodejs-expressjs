import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, AuthError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const log = createLogger('RBACMiddleware');

// ---------------------------------------------------------------------------
// Permission enum
// ---------------------------------------------------------------------------

export enum Permission {
  QUERY            = 'QUERY',
  INGEST           = 'INGEST',
  VIEW_HISTORY     = 'VIEW_HISTORY',
  VIEW_ALL_HISTORY = 'VIEW_ALL_HISTORY',
  REINDEX          = 'REINDEX',
  MANAGE_USERS     = 'MANAGE_USERS',
  VIEW_AUDIT       = 'VIEW_AUDIT',
  DELETE_DOCUMENTS = 'DELETE_DOCUMENTS',
  ADMIN            = 'ADMIN',
}

// ---------------------------------------------------------------------------
// Role → Permission map
// ---------------------------------------------------------------------------

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  VIEWER: [
    Permission.QUERY,
    Permission.VIEW_HISTORY,
  ],
  CLINICIAN: [
    Permission.QUERY,
    Permission.VIEW_HISTORY,
    Permission.INGEST,
  ],
  RESEARCHER: [
    Permission.QUERY,
    Permission.VIEW_HISTORY,
    Permission.INGEST,
    Permission.VIEW_ALL_HISTORY,
  ],
  ADMIN: [
    Permission.QUERY,
    Permission.INGEST,
    Permission.VIEW_HISTORY,
    Permission.VIEW_ALL_HISTORY,
    Permission.REINDEX,
    Permission.MANAGE_USERS,
    Permission.VIEW_AUDIT,
    Permission.DELETE_DOCUMENTS,
    Permission.ADMIN,
  ],
};

// ---------------------------------------------------------------------------
// hasPermission — pure helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the given role includes the requested permission.
 */
export function hasPermission(role: string, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role.toUpperCase()];
  if (!granted) return false;
  return granted.includes(permission);
}

// ---------------------------------------------------------------------------
// requirePermission — middleware factory
// ---------------------------------------------------------------------------

/**
 * Express middleware factory that enforces a required permission.
 *
 * Must be used AFTER `authenticateJWT` so that `req.user` is populated.
 *
 * @example
 * router.post('/ingest', authenticateJWT, requirePermission(Permission.INGEST), handler);
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AuthError('Authentication required'));
    }

    const { id: userId, role } = req.user;

    if (!hasPermission(role, permission)) {
      log.warn('Permission denied', {
        userId,
        role,
        requiredPermission: permission,
        path: req.path,
        method: req.method,
      });
      return next(
        new ForbiddenError(
          `Role "${role}" does not have the "${permission}" permission`
        )
      );
    }

    log.debug('Permission granted', {
      userId,
      role,
      permission,
      path: req.path,
    });

    next();
  };
}

export default requirePermission;
