import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  // ── App ──────────────────────────────────────────────────────────────────
  PORT: z
    .string()
    .default('3000')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().min(1).max(65535)),
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  API_VERSION: z.string().default('v1'),

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().url('REDIS_URL must be a valid connection URL'),

  // ── Pinecone ──────────────────────────────────────────────────────────────
  PINECONE_API_KEY: z.string().min(1, 'PINECONE_API_KEY is required'),
  PINECONE_ENVIRONMENT: z.string().min(1, 'PINECONE_ENVIRONMENT is required'),
  PINECONE_INDEX_NAME: z.string().default('healthcare-knowledge'),

  // ── OpenAI ────────────────────────────────────────────────────────────────
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-ada-002'),
  OPENAI_LLM_MODEL: z.string().default('gpt-4'),

  // ── Anthropic ─────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-3-5-sonnet-20241022'),

  // ── LLM / Embedding provider selection ───────────────────────────────────
  LLM_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),
  EMBEDDING_PROVIDER: z.enum(['openai']).default('openai'),

  // ── Security ──────────────────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex characters (32-byte key)'),

  // ── RAG settings ──────────────────────────────────────────────────────────
  CHUNK_SIZE: z
    .string()
    .default('1000')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),
  CHUNK_OVERLAP: z
    .string()
    .default('200')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().min(0)),
  MAX_RETRIEVAL_DOCS: z
    .string()
    .default('5')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().min(1).max(20)),
  SIMILARITY_THRESHOLD: z
    .string()
    .default('0.75')
    .transform((v) => parseFloat(v))
    .pipe(z.number().min(0).max(1)),
  MAX_DOCUMENT_SIZE_MB: z
    .string()
    .default('50')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z
    .string()
    .default('900000') // 15 minutes
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),
  RATE_LIMIT_MAX: z
    .string()
    .default('100')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),

  // ── Monitoring ────────────────────────────────────────────────────────────
  ENABLE_METRICS: z
    .string()
    .default('true')
    .transform((v) => v === 'true')
    .pipe(z.boolean()),
  ELASTICSEARCH_URL: z.string().url().optional(),
  DATADOG_API_KEY: z.string().optional(),

  // ── Admin bootstrap ───────────────────────────────────────────────────────
  ADMIN_EMAIL: z.string().email('ADMIN_EMAIL must be a valid email'),
  ADMIN_PASSWORD: z
    .string()
    .min(12, 'ADMIN_PASSWORD must be at least 12 characters'),

  // ── CORS ──────────────────────────────────────────────────────────────────
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    ),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const parseResult = configSchema.safeParse(process.env);

if (!parseResult.success) {
  const formatted = parseResult.error.errors
    .map((e) => `  [${e.path.join('.')}] ${e.message}`)
    .join('\n');
  // Use process.stderr directly — logger is not yet initialised at this point
  process.stderr.write(
    `\n[config] FATAL: Invalid environment configuration:\n${formatted}\n\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exported config object (fully typed)
// ---------------------------------------------------------------------------

export const config = parseResult.data;

export type Config = typeof config;

// Convenience derived values
export const isDev = config.NODE_ENV === 'development';
export const isTest = config.NODE_ENV === 'test';
export const isProd = config.NODE_ENV === 'production';

export const MAX_DOCUMENT_SIZE_BYTES = config.MAX_DOCUMENT_SIZE_MB * 1024 * 1024;

export default config;
