import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { createLogger } from '../../utils/logger';

const log = createLogger('RateLimitMiddleware');

const API_WINDOW_MS = 60 * 1000; // 1 minute
const API_MAX_REQUESTS = 60;
const AUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_MAX_REQUESTS = 10;

// ---------------------------------------------------------------------------
// Shared rate-limit response handler
// ---------------------------------------------------------------------------

function rateLimitHandler(req: Request, res: Response): void {
  log.warn('Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
  });

  res.status(429).json({
    success: false,
    error: {
      code: 'RATE_LIMIT_ERROR',
      detail: 'Rate limit exceeded. Please wait before making additional requests.',
    },
  });
}

// ---------------------------------------------------------------------------
// apiLimiter — general endpoints: 60 requests per minute per IP
// ---------------------------------------------------------------------------

export const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: API_MAX_REQUESTS,
  standardHeaders: true,  // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false,   // Disable the `X-RateLimit-*` headers
  keyGenerator: (req: Request): string => {
    // Prefer X-Forwarded-For when behind a proxy (e.g. nginx, ALB)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return first?.trim() ?? req.ip ?? 'unknown';
    }
    return req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
  skip: (req: Request): boolean => {
    // Skip rate limiting for health checks
    return req.path.startsWith('/api/v1/health');
  },
});

// ---------------------------------------------------------------------------
// authLimiter — auth endpoints: 10 requests per 5 minutes per IP
// ---------------------------------------------------------------------------

export const authLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: AUTH_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return first?.trim() ?? req.ip ?? 'unknown';
    }
    return req.ip ?? 'unknown';
  },
  handler: (req: Request, res: Response): void => {
    log.warn('Auth rate limit exceeded', {
      ip: req.ip,
      path: req.path,
    });

    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_ERROR',
        detail: 'Too many authentication attempts. Please wait 5 minutes before trying again.',
      },
    });
  },
});

export default { apiLimiter, authLimiter };
