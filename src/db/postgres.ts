import { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/logger';

const log = createLogger('PostgresDB');

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

declare global {
  // Allow the singleton to survive ts-node-dev hot reloads in development
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: [
      { level: 'query',   emit: 'event' },
      { level: 'info',    emit: 'event' },
      { level: 'warn',    emit: 'event' },
      { level: 'error',   emit: 'event' },
    ],
  });
}

const prisma: PrismaClient =
  globalThis.__prismaClient ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = prisma;
}

// Forward Prisma query events to Winston at appropriate log levels
// (The event types are only available once @prisma/client is generated,
//  so we use `any` to remain portable before the first `prisma generate`.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('query', (e: any) => {
  log.debug('Prisma query', {
    query: e.query,
    params: e.params,
    duration: `${e.duration}ms`,
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('info', (e: any) => {
  log.info('Prisma info', { message: e.message });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('warn', (e: any) => {
  log.warn('Prisma warning', { message: e.message });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('error', (e: any) => {
  log.error('Prisma error', { message: e.message });
});

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Open the database connection pool.
 * Call once at application startup.
 */
export async function connectDB(): Promise<void> {
  try {
    await prisma.$connect();
    log.info('PostgreSQL connected successfully');
  } catch (err) {
    log.error('Failed to connect to PostgreSQL', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Gracefully close the connection pool.
 * Call during application shutdown.
 */
export async function disconnectDB(): Promise<void> {
  try {
    await prisma.$disconnect();
    log.info('PostgreSQL disconnected');
  } catch (err) {
    log.error('Error disconnecting from PostgreSQL', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Perform a lightweight liveness check against PostgreSQL.
 * Returns true when the database is reachable, false otherwise.
 */
export async function checkDBHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    log.error('PostgreSQL health check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export default prisma;
