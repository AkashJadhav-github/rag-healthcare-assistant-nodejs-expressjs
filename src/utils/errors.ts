import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from './logger';

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/**
 * AppError is the root of every intentional application error.
 * Set isOperational = true for errors that are expected and handled gracefully
 * (validation failures, auth failures, etc.).
 * Set isOperational = false for programmer errors or unrecoverable failures.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    // Maintain a proper prototype chain for instanceof checks after transpile
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

// ---------------------------------------------------------------------------
// Specific error classes
// ---------------------------------------------------------------------------

/** 400 Bad Request — invalid input, schema violations */
export class ValidationError extends AppError {
  public readonly fields?: Record<string, string[]>;

  constructor(
    message: string = 'Validation failed',
    fields?: Record<string, string[]>
  ) {
    super(message, 400, true);
    this.fields = fields;
  }
}

/** 401 Unauthorized — missing or invalid credentials */
export class AuthError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, true);
  }
}

/** 403 Forbidden — authenticated but not permitted */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, true);
  }
}

/** 404 Not Found */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, true);
  }
}

/** 409 Conflict — duplicate resource etc. */
export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, true);
  }
}

/** 429 Too Many Requests */
export class RateLimitError extends AppError {
  public readonly retryAfterMs?: number;

  constructor(
    message: string = 'Too many requests — please try again later',
    retryAfterMs?: number
  ) {
    super(message, 429, true);
    this.retryAfterMs = retryAfterMs;
  }
}

/** 503 Service Unavailable — downstream dependency down */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service temporarily unavailable') {
    super(message, 503, true);
  }
}

// ---------------------------------------------------------------------------
// Serialised error shape sent to clients
// ---------------------------------------------------------------------------

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string[]>;
    retryAfterMs?: number;
    requestId?: string;
  };
}

// ---------------------------------------------------------------------------
// Helper: format a ZodError into field-level messages
// ---------------------------------------------------------------------------

function formatZodError(err: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of err.errors) {
    const key = issue.path.join('.') || '_root';
    if (!fields[key]) fields[key] = [];
    fields[key].push(issue.message);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Global error handler middleware
// ---------------------------------------------------------------------------

/**
 * Must be registered LAST in Express middleware chain:
 *   app.use(globalErrorHandler);
 */
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const requestId = (req.headers['x-request-id'] as string) ?? undefined;

  // ── Zod validation errors ───────────────────────────────────────────────
  if (err instanceof ZodError) {
    const fields = formatZodError(err);
    const body: ErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        fields,
        requestId,
      },
    };
    res.status(400).json(body);
    return;
  }

  // ── Known operational AppError subclasses ───────────────────────────────
  if (err instanceof AppError && err.isOperational) {
    const body: ErrorResponse = {
      success: false,
      error: {
        code: err.name.toUpperCase().replace(/ERROR$/, '_ERROR'),
        message: err.message,
        requestId,
      },
    };

    if (err instanceof ValidationError && err.fields) {
      body.error.fields = err.fields;
    }

    if (err instanceof RateLimitError && err.retryAfterMs !== undefined) {
      body.error.retryAfterMs = err.retryAfterMs;
      res.setHeader('Retry-After', Math.ceil(err.retryAfterMs / 1000));
    }

    res.status(err.statusCode).json(body);
    return;
  }

  // ── Unknown / programmer errors ─────────────────────────────────────────
  // Log full stack trace — these are bugs, not user errors
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId,
    userId: (req as Request & { userId?: string }).userId,
  });

  const isProd = process.env.NODE_ENV === 'production';

  const body: ErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: isProd
        ? 'An unexpected error occurred. Please try again later.'
        : err.message,
      requestId,
    },
  };

  res.status(500).json(body);
}

// ---------------------------------------------------------------------------
// Catch-all for unhandled async route errors (wrapper utility)
// ---------------------------------------------------------------------------

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

/**
 * Wrap an async Express handler so unhandled rejections are forwarded to
 * the global error handler instead of crashing the process.
 *
 * @example
 * router.get('/query', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
