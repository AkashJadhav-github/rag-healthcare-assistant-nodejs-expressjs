import { Request, Response, NextFunction } from 'express';
import { AuditAction } from '@prisma/client';
import prisma from '../../db/postgres';
import { createLogger } from '../../utils/logger';

export { AuditAction };

const log = createLogger('AuditMiddleware');

// ---------------------------------------------------------------------------
// auditLog — middleware factory
// ---------------------------------------------------------------------------

/**
 * Express middleware factory that writes an `AuditLog` record to PostgreSQL
 * after the response has been sent (using the `res.on('finish')` hook).
 *
 * This is non-blocking — any DB errors are logged but NOT propagated to the
 * client because the response has already been sent.
 *
 * @example
 * router.post('/login', authLimiter, authController.login, auditLog(AuditAction.LOGIN));
 *
 * // Or as a route-level middleware (fires after handler):
 * router.post('/login', [authLimiter, auditLog(AuditAction.LOGIN)], authController.login);
 */
export function auditLog(action: AuditAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Capture the client IP before it potentially changes
    const ipAddress =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ?? req.ip ?? null;

    const userAgent = req.headers['user-agent'] ?? null;
    const requestPath = req.originalUrl ?? req.path;
    const requestMethod = req.method;

    res.on('finish', () => {
      const userId = req.user?.id ?? null;
      const statusCode = res.statusCode;

      // Fire-and-forget — do NOT await in the middleware
      persistAuditLog({
        userId,
        action,
        ipAddress,
        userAgent,
        requestPath,
        requestMethod,
        statusCode,
      }).catch((err) => {
        log.error('Failed to write audit log', {
          action,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    next();
  };
}

// ---------------------------------------------------------------------------
// Internal persistence helper
// ---------------------------------------------------------------------------

interface AuditLogPayload {
  userId: string | null;
  action: AuditAction;
  ipAddress: string | null;
  userAgent: string | null;
  requestPath: string;
  requestMethod: string;
  statusCode: number;
  details?: Record<string, unknown>;
}

async function persistAuditLog(payload: AuditLogPayload): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: payload.userId,
      action: payload.action,
      ipAddress: payload.ipAddress,
      userAgent: payload.userAgent,
      requestPath: payload.requestPath,
      requestMethod: payload.requestMethod,
      statusCode: payload.statusCode,
      details: (payload.details ?? {}) as import('@prisma/client').Prisma.InputJsonValue,
    },
  });

  log.debug('Audit log written', {
    action: payload.action,
    userId: payload.userId,
    path: payload.requestPath,
    status: payload.statusCode,
  });
}

export default auditLog;
