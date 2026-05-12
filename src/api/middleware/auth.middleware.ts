import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../../utils/security';
import { AuthError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const log = createLogger('AuthMiddleware');

// ---------------------------------------------------------------------------
// Augment Express Request to carry the authenticated user
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: string;
        email: string;
      };
    }
  }
}

// ---------------------------------------------------------------------------
// authenticateJWT
// ---------------------------------------------------------------------------

/**
 * Reads the `Authorization: Bearer <token>` header, verifies the JWT, and
 * attaches the decoded user payload to `req.user`.
 *
 * Throws `AuthError` (401) when:
 *  - The Authorization header is absent or malformed
 *  - The token is invalid, expired, or not an access token
 */
export function authenticateJWT(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return next(new AuthError('Authorization header is missing'));
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return next(
      new AuthError('Authorization header must use Bearer scheme: "Bearer <token>"')
    );
  }

  const token = parts[1];

  if (!token) {
    return next(new AuthError('Bearer token is empty'));
  }

  try {
    const payload = verifyAccessToken(token);

    req.user = {
      id: payload.sub as string,
      role: payload.role,
      email: (payload as { email?: string }).email ?? '',
    };

    log.debug('JWT authenticated', {
      userId: req.user.id,
      role: req.user.role,
      path: req.path,
    });

    next();
  } catch (err) {
    // verifyAccessToken already throws AuthError with a descriptive message
    log.warn('JWT authentication failed', {
      error: err instanceof Error ? err.message : String(err),
      path: req.path,
      ip: req.ip,
    });
    next(err);
  }
}

export default authenticateJWT;
