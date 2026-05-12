import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const log = createLogger('ValidationMiddleware');

// ---------------------------------------------------------------------------
// validateRequest
// ---------------------------------------------------------------------------

/**
 * Express middleware factory that validates `req.body` against a Zod schema.
 *
 * On success: the body is replaced with the parsed (coerced) value from Zod.
 * On failure: throws `ValidationError` with a human-readable error string
 *             derived from Zod's issue list.
 *
 * @example
 * router.post('/login', validateRequest(loginSchema), authController.login);
 */
export function validateRequest<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (result.success) {
      // Replace body with coerced/defaulted values produced by Zod
      req.body = result.data;
      return next();
    }

    const error = result.error as ZodError;

    // Format Zod issues into a single readable string and a field map
    const details = formatZodErrors(error);

    log.debug('Request body validation failed', {
      path: req.path,
      method: req.method,
      errors: details,
    });

    next(new ValidationError(details));
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a ZodError into a concise, human-readable string.
 *
 * Example output:
 *   "query: String must contain at least 3 character(s); maxSources: Expected number"
 */
function formatZodErrors(error: ZodError): string {
  return error.errors
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '_root';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

export default validateRequest;
