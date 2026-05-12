import bcrypt from 'bcryptjs';
import jwt, { SignOptions, JwtPayload } from 'jsonwebtoken';
import { config } from '../config/config';
import { AuthError, ValidationError } from './errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SALT_ROUNDS = 12;

// Prompt-injection patterns — extend as threat model evolves
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|above|prior|all)\s+(instructions?|prompts?|context)/gi,
  /you\s+are\s+now\s+(a|an|the)\s+/gi,
  /act\s+as\s+(a|an|the)\s+/gi,
  /pretend\s+(you\s+are|to\s+be)\s+/gi,
  /forget\s+(everything|all)\s+(you|your)\s+(know|were|have)/gi,
  /\bsystem\s*:\s*/gi,
  /\[system\]/gi,
  /<\|system\|>/gi,
  /\bDAN\b/g,                              // "Do Anything Now" jailbreak
  /\bDeveloper\s+Mode\b/gi,
  /override\s+(safety|content)\s+(filter|guideline|policy)/gi,
  /bypass\s+(safety|content)\s+(filter|guideline|policy)/gi,
  // SQL / NoSQL injection attempts in natural language
  /;\s*(drop|delete|truncate|alter|insert|update)\s+/gi,
  /'\s*(or|and)\s*'?\d+'\s*=\s*'?\d+/gi,
];

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plain-text password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a plain-text password against a bcrypt hash.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// ---------------------------------------------------------------------------
// Password strength validation
// ---------------------------------------------------------------------------

export interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate password strength against HIPAA-aligned requirements:
 * - Minimum 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character
 */
export function validatePasswordStrength(
  password: string
): PasswordStrengthResult {
  const errors: string[] = [];

  if (password.length < 12) {
    errors.push('Password must be at least 12 characters long');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/\d/.test(password)) {
    errors.push('Password must contain at least one digit');
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// JWT payload types
// ---------------------------------------------------------------------------

export interface AccessTokenPayload extends JwtPayload {
  sub: string;       // userId
  role: string;
  type: 'access';
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;       // userId
  type: 'refresh';
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Create a signed access JWT (short-lived).
 */
export function createAccessToken(userId: string, role: string): string {
  const payload: Omit<AccessTokenPayload, 'iat' | 'exp'> = {
    sub: userId,
    role,
    type: 'access',
  };

  const options: SignOptions = {
    expiresIn: config.JWT_EXPIRES_IN as unknown as number,
    issuer: 'rag-healthcare-assistant',
    audience: 'rag-healthcare-api',
  };

  return jwt.sign(payload, config.JWT_SECRET, options);
}

/**
 * Create a signed refresh JWT (long-lived).
 */
export function createRefreshToken(userId: string): string {
  const payload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
    sub: userId,
    type: 'refresh',
  };

  const options: SignOptions = {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN as unknown as number,
    issuer: 'rag-healthcare-assistant',
    audience: 'rag-healthcare-api',
  };

  return jwt.sign(payload, config.JWT_SECRET, options);
}

/**
 * Verify and decode any JWT issued by this service.
 * Throws AuthError for invalid / expired tokens.
 */
export function verifyToken(token: string): AccessTokenPayload | RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'rag-healthcare-assistant',
      audience: 'rag-healthcare-api',
    }) as AccessTokenPayload | RefreshTokenPayload;

    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AuthError('Token has expired');
    }
    if (err instanceof jwt.NotBeforeError) {
      throw new AuthError('Token is not yet valid');
    }
    throw new AuthError('Invalid token');
  }
}

/**
 * Verify a token and assert it is an access token.
 * Throws AuthError if the token is a refresh token or is invalid.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = verifyToken(token);
  if (decoded.type !== 'access') {
    throw new AuthError('Expected an access token');
  }
  return decoded as AccessTokenPayload;
}

/**
 * Verify a token and assert it is a refresh token.
 * Throws AuthError if the token is an access token or is invalid.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = verifyToken(token);
  if (decoded.type !== 'refresh') {
    throw new AuthError('Expected a refresh token');
  }
  return decoded as RefreshTokenPayload;
}

// ---------------------------------------------------------------------------
// Query sanitization
// ---------------------------------------------------------------------------

/**
 * Strip known prompt-injection patterns from a user query.
 * Throws ValidationError if the query is empty after sanitization.
 */
export function sanitizeQuery(query: string): string {
  if (typeof query !== 'string') {
    throw new ValidationError('Query must be a string');
  }

  let sanitized = query.trim();

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    // Reset lastIndex for global patterns (regex reuse safety)
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REMOVED]');
  }

  // Collapse any runs of whitespace that the replacements may have created
  sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();

  if (sanitized.length === 0) {
    throw new ValidationError(
      'Query is empty or contained only disallowed content'
    );
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// Utility: extract Bearer token from Authorization header
// ---------------------------------------------------------------------------

/**
 * Parse "Bearer <token>" from an Authorization header value.
 * Returns null if the header is absent or malformed.
 */
export function extractBearerToken(
  authorizationHeader: string | undefined
): string | null {
  if (!authorizationHeader) return null;
  const parts = authorizationHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1] ?? null;
}
