import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../db/postgres';
import { cacheService } from '../../services/cache.service';
import {
  verifyPassword,
  createAccessToken,
  createRefreshToken,
  verifyRefreshToken,
} from '../../utils/security';
import {
  asyncHandler,
  AuthError,
  ValidationError,
  RateLimitError,
} from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import { config } from '../../config/config';

const log = createLogger('AuthController');

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  username: z.string().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'refresh_token is required'),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum failed login attempts before temporary lockout */
const MAX_LOGIN_ATTEMPTS = 5;
/** Lockout window in seconds */
const LOCKOUT_WINDOW_SECONDS = 15 * 60; // 15 minutes

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/login
 *
 * Validates credentials, enforces a Redis-backed brute-force counter, issues
 * access + refresh JWTs, and updates `lastLogin` on the user record.
 */
export const login = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    // Validate body
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      );
    }

    const { username: email, password } = parseResult.data;

    // ── Brute-force protection via Redis ─────────────────────────────────
    const attemptKey = `login_attempts:${email}`;
    const attempts = await cacheService.get<number>(attemptKey);

    if (attempts !== null && attempts >= MAX_LOGIN_ATTEMPTS) {
      const remaining = await cacheService.ttl(attemptKey);
      log.warn('Login blocked — too many failed attempts', { email });
      throw new RateLimitError(
        `Account temporarily locked due to too many failed login attempts. ` +
          `Please try again in ${Math.ceil(remaining / 60)} minutes.`,
        remaining * 1000
      );
    }

    // ── Find user ─────────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        hashedPassword: true,
        role: true,
        isActive: true,
        isVerified: true,
      },
    });

    // ── Verify password (constant-time path for non-existent users) ───────
    const passwordValid =
      user !== null && (await verifyPassword(password, user.hashedPassword));

    if (!user || !passwordValid) {
      // Increment failure counter
      const newCount = await cacheService.increment(attemptKey, LOCKOUT_WINDOW_SECONDS);
      log.warn('Failed login attempt', { email, attempts: newCount });
      throw new AuthError('Invalid email or password');
    }

    if (!user.isActive) {
      throw new AuthError('Account is deactivated. Please contact an administrator.');
    }

    // ── Clear failure counter on success ──────────────────────────────────
    await cacheService.delete(attemptKey);

    // ── Issue tokens ──────────────────────────────────────────────────────
    const accessToken = createAccessToken(user.id, user.role);
    const refreshToken = createRefreshToken(user.id);

    // ── Update lastLogin ──────────────────────────────────────────────────
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    log.info('User logged in', { userId: user.id, role: user.role });

    // Parse expires_in from JWT_EXPIRES_IN (e.g. "15m" → 900)
    const expiresIn = parseExpiresIn(config.JWT_EXPIRES_IN);

    res.status(200).json({
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
        },
      },
    });
  }
);

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/logout
 *
 * Deletes the user's session cache keys and logs the event.
 * Requires `authenticateJWT`.
 */
export const logout = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const userId = req.user!.id;

    // Delete all session keys for this user
    await cacheService.deletePattern(`session:${userId}:*`);
    // Also clear any query caches scoped to the user
    // (optional — uncomment if per-user cache isolation is desired)
    // await cacheService.deletePattern(`query:${userId}:*`);

    log.info('User logged out', { userId });

    res.status(200).json({
      success: true,
      data: { message: 'Logged out successfully' },
    });
  }
);

// ---------------------------------------------------------------------------
// getMe
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/auth/me
 *
 * Returns the full profile of the currently authenticated user.
 * Requires `authenticateJWT`.
 */
export const getMe = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        department: true,
        isActive: true,
        isVerified: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new AuthError('User not found');
    }

    res.status(200).json({
      success: true,
      data: { user },
    });
  }
);

// ---------------------------------------------------------------------------
// refreshToken (bonus — needed for token rotation)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/refresh
 *
 * Accepts a refresh token and issues a new access token.
 */
export const refreshToken = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const parseResult = refreshSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('refresh_token is required');
    }

    const { refresh_token } = parseResult.data;
    const payload = verifyRefreshToken(refresh_token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub as string },
      select: { id: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new AuthError('User account not found or deactivated');
    }

    const accessToken = createAccessToken(user.id, user.role);
    const expiresIn = parseExpiresIn(config.JWT_EXPIRES_IN);

    res.status(200).json({
      success: true,
      data: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
      },
    });
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a string like "15m", "1h", "7d" to seconds.
 * Defaults to 900 (15 min) for unrecognised formats.
 */
function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 900;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default:  return 900;
  }
}
