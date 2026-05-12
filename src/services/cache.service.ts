import { createHash } from 'crypto';
import Redis, { RedisOptions } from 'ioredis';
import { createLogger } from '../utils/logger';

const log = createLogger('CacheService');

// ---------------------------------------------------------------------------
// Redis connection options
// ---------------------------------------------------------------------------

function buildRedisOptions(): RedisOptions {
  return {
    // Parse connection details from URL but also set sensible defaults
    lazyConnect: true,
    enableOfflineQueue: false,          // Fail-fast when Redis is down
    maxRetriesPerRequest: 3,
    retryStrategy(times: number): number | null {
      if (times > 5) {
        log.error('Redis: exceeded max reconnection attempts');
        return null; // stop retrying
      }
      const delay = Math.min(times * 200, 2000);
      log.warn(`Redis: reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    reconnectOnError(err: Error): boolean {
      // Reconnect on READONLY errors (Redis Sentinel failover)
      return err.message.includes('READONLY');
    },
  };
}

// ---------------------------------------------------------------------------
// CacheService
// ---------------------------------------------------------------------------

export class CacheService {
  private readonly client: Redis;
  private readonly defaultTTL: number = 3600; // 1 hour

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, buildRedisOptions());

    this.client.on('connect', () => {
      log.info('Redis connection established');
    });

    this.client.on('ready', () => {
      log.info('Redis client ready');
    });

    this.client.on('error', (err: Error) => {
      log.error('Redis client error', { error: err.message });
    });

    this.client.on('close', () => {
      log.warn('Redis connection closed');
    });

    this.client.on('reconnecting', () => {
      log.info('Redis reconnecting');
    });

    this.client.on('end', () => {
      log.warn('Redis connection ended — no further reconnection attempts');
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    log.info('Redis disconnected gracefully');
  }

  // ── Core cache operations ─────────────────────────────────────────────────

  /**
   * Retrieve a cached value and deserialise it from JSON.
   * Returns null when the key is absent or has expired.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      log.error('Cache get error', { key, error: (err as Error).message });
      return null;
    }
  }

  /**
   * Serialise value to JSON and store it with an optional TTL (seconds).
   * Falls back to defaultTTL when ttlSeconds is not provided.
   */
  async set(
    key: string,
    value: unknown,
    ttlSeconds: number = this.defaultTTL
  ): Promise<void> {
    try {
      const serialised = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await this.client.setex(key, ttlSeconds, serialised);
      } else {
        await this.client.set(key, serialised);
      }
    } catch (err) {
      log.error('Cache set error', { key, error: (err as Error).message });
    }
  }

  /**
   * Remove a key from the cache.
   * Returns true when the key existed and was deleted, false otherwise.
   */
  async delete(key: string): Promise<boolean> {
    try {
      const deleted = await this.client.del(key);
      return deleted > 0;
    } catch (err) {
      log.error('Cache delete error', { key, error: (err as Error).message });
      return false;
    }
  }

  /**
   * Delete all keys matching a glob pattern (e.g. "query:user:123:*").
   * Returns the number of keys deleted.
   */
  async deletePattern(pattern: string): Promise<number> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return 0;
      return this.client.del(...keys);
    } catch (err) {
      log.error('Cache deletePattern error', {
        pattern,
        error: (err as Error).message,
      });
      return 0;
    }
  }

  /**
   * Check whether a key exists in the cache.
   */
  async exists(key: string): Promise<boolean> {
    try {
      const count = await this.client.exists(key);
      return count > 0;
    } catch (err) {
      log.error('Cache exists error', { key, error: (err as Error).message });
      return false;
    }
  }

  // ── Rate-limiting helpers ─────────────────────────────────────────────────

  /**
   * Atomically increment a counter and set its expiry on first touch.
   * Typical usage: sliding-window rate-limit counters.
   *
   * @param key           Redis key for the counter
   * @param expireSeconds TTL to set when the key is first created (ignored on
   *                      subsequent calls so the window does not reset)
   * @returns             The counter value after incrementing
   */
  async increment(key: string, expireSeconds: number): Promise<number> {
    try {
      const pipeline = this.client.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, expireSeconds, 'NX'); // NX = only set if not exists
      const results = await pipeline.exec();
      // results[0] = [null, count]
      const count = results?.[0]?.[1] as number | null;
      return count ?? 1;
    } catch (err) {
      log.error('Cache increment error', {
        key,
        error: (err as Error).message,
      });
      return 1; // Fail open — don't block on cache error
    }
  }

  /**
   * Return the remaining TTL of a key in seconds.
   * Returns -1 if the key exists but has no TTL, -2 if the key does not exist.
   */
  async ttl(key: string): Promise<number> {
    try {
      return this.client.ttl(key);
    } catch (err) {
      log.error('Cache ttl error', { key, error: (err as Error).message });
      return -2;
    }
  }

  // ── Health check ──────────────────────────────────────────────────────────

  /**
   * Perform a lightweight PING to verify the Redis connection is alive.
   * Returns true on success, false on failure.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (err) {
      log.error('Redis health check failed', {
        error: (err as Error).message,
      });
      return false;
    }
  }

  // ── Key builders (static) ─────────────────────────────────────────────────

  /**
   * Build a deterministic cache key for a user query.
   * The SHA-256 hash ensures consistent key length and hides raw query text.
   *
   * @param query  The raw or sanitised query string
   * @param userId The authenticated user's ID (scopes the cache per-user)
   */
  static makeQueryKey(query: string, userId: string): string {
    const hash = createHash('sha256')
      .update(`${userId}:${query.toLowerCase().trim()}`)
      .digest('hex');
    return `query:${userId}:${hash}`;
  }

  /**
   * Build a deterministic cache key for an embedding vector.
   * Embeddings are expensive — caching them yields significant savings.
   *
   * @param text The text whose embedding will be cached
   */
  static makeEmbeddingKey(text: string): string {
    const hash = createHash('sha256')
      .update(text.toLowerCase().trim())
      .digest('hex');
    return `embedding:${hash}`;
  }

  /**
   * Build a key for caching user session / auth metadata.
   */
  static makeSessionKey(userId: string, sessionId: string): string {
    return `session:${userId}:${sessionId}`;
  }

  /**
   * Build a rate-limit counter key for a given identifier
   * (IP address, userId, or API key).
   */
  static makeRateLimitKey(identifier: string, window: string): string {
    return `ratelimit:${window}:${identifier}`;
  }

  // ── Expose underlying client (escape hatch) ───────────────────────────────

  get redisClient(): Redis {
    return this.client;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const cacheService = new CacheService(REDIS_URL);

export default cacheService;
