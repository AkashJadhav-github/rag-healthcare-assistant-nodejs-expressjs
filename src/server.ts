// ---------------------------------------------------------------------------
// Datadog APM — must be initialised BEFORE any other imports
// ---------------------------------------------------------------------------

if (process.env.DATADOG_API_KEY) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('dd-trace').init({
      service: 'rag-healthcare-assistant',
      env: process.env.NODE_ENV ?? 'development',
      version: process.env.npm_package_version ?? '1.0.0',
      logInjection: true,
    });
  } catch {
    // dd-trace is an optional dep; fail silently if not installed
  }
}

// ---------------------------------------------------------------------------
// Core imports (after tracer init)
// ---------------------------------------------------------------------------

import http from 'http';
import app from './app';
import { connectDB, disconnectDB } from './db/postgres';
import prisma from './db/postgres';
import { cacheService } from './services/cache.service';
import { config } from './config/config';
import logger from './utils/logger';
import { hashPassword } from './utils/security';

// Pinecone service — initialised during startup
import { pineconeService } from './services/pinecone.service';

// ---------------------------------------------------------------------------
// Server instance
// ---------------------------------------------------------------------------

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  logger.info('Starting RAG Healthcare Assistant server...', {
    env: config.NODE_ENV,
    port: config.PORT,
    version: process.env.npm_package_version ?? '1.0.0',
  });

  // ── 1. Connect to PostgreSQL ─────────────────────────────────────────────
  await connectDB();

  // ── 2. Initialise Pinecone vector store ──────────────────────────────────
  try {
    await pineconeService.initialize();
    logger.info('Pinecone initialised');
  } catch (err) {
    logger.error('Pinecone initialisation failed — vector search unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal in dev; fatal in prod
    if (config.NODE_ENV === 'production') throw err;
  }

  // ── 3. Warm up Redis connection ──────────────────────────────────────────
  try {
    await cacheService.connect();
    const alive = await cacheService.healthCheck();
    if (alive) {
      logger.info('Redis connection healthy');
    } else {
      logger.warn('Redis health check returned false — cache may be unavailable');
    }
  } catch (err) {
    logger.error('Redis connection failed — caching unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal: the app can run degraded without Redis
  }

  // ── 4. Seed admin user if not present ────────────────────────────────────
  await seedAdminUser();

  // ── 5. Listen ────────────────────────────────────────────────────────────
  server.listen(config.PORT, () => {
    logger.info('Server is listening', {
      port: config.PORT,
      env: config.NODE_ENV,
      pid: process.pid,
    });
  });
}

// ---------------------------------------------------------------------------
// Admin seed
// ---------------------------------------------------------------------------

async function seedAdminUser(): Promise<void> {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = config;

  try {
    const existing = await prisma.user.findUnique({
      where: { email: ADMIN_EMAIL },
    });

    if (existing) {
      logger.debug('Admin user already exists — skipping seed', {
        email: ADMIN_EMAIL,
      });
      return;
    }

    const hashedPassword = await hashPassword(ADMIN_PASSWORD);

    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        username: 'admin',
        fullName: 'System Administrator',
        hashedPassword,
        role: 'ADMIN',
        isActive: true,
        isVerified: true,
      },
    });

    logger.info('Admin user seeded', { email: ADMIN_EMAIL });
  } catch (err) {
    logger.error('Failed to seed admin user', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal: admin may already exist with a different username
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — initiating graceful shutdown...`);

  // Stop accepting new connections
  server.close(async (err) => {
    if (err) {
      logger.error('Error closing HTTP server', {
        error: err.message,
      });
    } else {
      logger.info('HTTP server closed');
    }

    try {
      await disconnectDB();
      logger.info('PostgreSQL disconnected');
    } catch (dbErr) {
      logger.error('Error disconnecting PostgreSQL', {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    try {
      await cacheService.disconnect();
      logger.info('Redis disconnected');
    } catch (cacheErr) {
      logger.error('Error disconnecting Redis', {
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    logger.info('Graceful shutdown complete');
    process.exit(err ? 1 : 0);
  });

  // Force-exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Unhandled rejection / exception safety net
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise),
  });
  // In production, crash fast — let the orchestrator restart the pod
  if (config.NODE_ENV === 'production') {
    gracefulShutdown('unhandledRejection');
  }
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  gracefulShutdown('uncaughtException');
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

start().catch((err) => {
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Export server for integration tests
// ---------------------------------------------------------------------------

export default server;
export { server };
