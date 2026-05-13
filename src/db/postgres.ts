import { Prisma, PrismaClient } from '@prisma/client';
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

// Forward Prisma query events to Winston at appropriate log levels.
// `prisma as any` is required because $on overloads are conditional on the
// log config generic — lost when the variable is typed as plain PrismaClient.
/* eslint-disable @typescript-eslint/no-explicit-any */
(prisma as any).$on('query', (e: Prisma.QueryEvent) => {
  log.debug('Prisma query', {
    query: e.query,
    params: e.params,
    duration: `${e.duration}ms`,
  });
});

(prisma as any).$on('info', (e: Prisma.LogEvent) => {
  log.info('Prisma info', { message: e.message });
});

(prisma as any).$on('warn', (e: Prisma.LogEvent) => {
  log.warn('Prisma warning', { message: e.message });
});

(prisma as any).$on('error', (e: Prisma.LogEvent) => {
  log.error('Prisma error', { message: e.message });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

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
