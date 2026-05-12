import { Pinecone, Index, RecordMetadata } from '@pinecone-database/pinecone';
import { config } from '../config/config';
import { createLogger } from '../utils/logger';

const log = createLogger('PineconeService');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PineconeMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface UpsertVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PineconeService
// ---------------------------------------------------------------------------

export class PineconeService {
  private client: Pinecone | null = null;
  private index: Index<RecordMetadata> | null = null;
  private readonly indexName: string;
  private readonly namespace: string;
  private initialised = false;

  constructor(namespace = 'default') {
    this.indexName = config.PINECONE_INDEX_NAME;
    this.namespace = namespace;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Connect to Pinecone and resolve (or create) the target index.
   * Must be called once at application startup before any other method.
   */
  async initialize(): Promise<void> {
    if (this.initialised) return;

    try {
      this.client = new Pinecone({
        apiKey: config.PINECONE_API_KEY,
      });

      // Check if the index exists; create it if it does not
      const { indexes } = await this.client.listIndexes();
      const exists = indexes?.some((idx) => idx.name === this.indexName) ?? false;

      if (!exists) {
        log.info(`Pinecone index "${this.indexName}" not found — creating…`);
        await this.client.createIndex({
          name: this.indexName,
          dimension: 1536, // text-embedding-ada-002 output dimension
          metric: 'cosine',
          spec: {
            serverless: {
              cloud: 'aws',
              region: config.PINECONE_ENVIRONMENT,
            },
          },
          waitUntilReady: true,
        });
        log.info(`Pinecone index "${this.indexName}" created successfully`);
      } else {
        log.info(`Pinecone index "${this.indexName}" found`);
      }

      this.index = this.client.index(this.indexName);
      this.initialised = true;

      log.info('PineconeService initialised', {
        indexName: this.indexName,
        namespace: this.namespace,
      });
    } catch (err) {
      log.error('Failed to initialise PineconeService', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      throw err;
    }
  }

  // ── Write operations ───────────────────────────────────────────────────────

  /**
   * Upsert a batch of vectors into the configured namespace.
   * Pinecone recommends batches of up to 100 vectors; this method respects
   * that limit automatically.
   */
  async upsertVectors(vectors: UpsertVector[]): Promise<void> {
    this.ensureInitialised();

    const BATCH_SIZE = 100;
    const ns = this.index!.namespace(this.namespace);

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);

      try {
        await ns.upsert(
          batch.map((v) => ({
            id: v.id,
            values: v.values,
            metadata: v.metadata as RecordMetadata,
          }))
        );

        log.debug('Pinecone upsert batch', {
          batchStart: i,
          batchSize: batch.length,
          namespace: this.namespace,
        });
      } catch (err) {
        log.error('Pinecone upsert failed', {
          batchStart: i,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    log.info('Pinecone upsert complete', {
      totalVectors: vectors.length,
      namespace: this.namespace,
    });
  }

  /**
   * Query the index for the `topK` nearest vectors to the given embedding.
   * An optional Pinecone metadata filter can be passed to restrict results.
   */
  async queryVectors(
    embedding: number[],
    topK: number,
    filter?: object,
  ): Promise<PineconeMatch[]> {
    this.ensureInitialised();

    try {
      const ns = this.index!.namespace(this.namespace);

      const response = await ns.query({
        vector: embedding,
        topK,
        includeMetadata: true,
        includeValues: false,
        ...(filter ? { filter } : {}),
      });

      const matches: PineconeMatch[] = (response.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score ?? 0,
        metadata: (m.metadata ?? {}) as Record<string, unknown>,
      }));

      log.debug('Pinecone query complete', {
        topK,
        resultCount: matches.length,
        namespace: this.namespace,
      });

      return matches;
    } catch (err) {
      log.error('Pinecone query failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Delete vectors by their IDs from the configured namespace.
   */
  async deleteVectors(ids: string[]): Promise<void> {
    this.ensureInitialised();

    if (ids.length === 0) return;

    try {
      const ns = this.index!.namespace(this.namespace);
      await ns.deleteMany(ids);

      log.info('Pinecone vectors deleted', {
        count: ids.length,
        namespace: this.namespace,
      });
    } catch (err) {
      log.error('Pinecone deleteVectors failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Delete ALL vectors in a given namespace (multi-tenant isolation).
   */
  async deleteNamespace(namespace: string): Promise<void> {
    this.ensureInitialised();

    try {
      const ns = this.index!.namespace(namespace);
      await ns.deleteAll();

      log.info('Pinecone namespace deleted', { namespace });
    } catch (err) {
      log.error('Pinecone deleteNamespace failed', {
        namespace,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  // ── Read / metadata operations ─────────────────────────────────────────────

  /**
   * Return index statistics and configuration from Pinecone.
   */
  async describeIndex(): Promise<object> {
    this.ensureInitialised();

    try {
      const stats = await this.index!.describeIndexStats();
      return stats as unknown as object;
    } catch (err) {
      log.error('Pinecone describeIndex failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Fetch specific vectors by ID (useful for deduplication checks).
   */
  async fetchVectors(ids: string[]): Promise<Record<string, unknown>> {
    this.ensureInitialised();

    try {
      const ns = this.index!.namespace(this.namespace);
      const result = await ns.fetch(ids);
      return result as unknown as Record<string, unknown>;
    } catch (err) {
      log.error('Pinecone fetch failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ── Namespace helpers ──────────────────────────────────────────────────────

  /**
   * Return a scoped copy of this service bound to a different namespace.
   * Useful for per-tenant or per-document isolation.
   */
  withNamespace(namespace: string): PineconeService {
    const scoped = new PineconeService(namespace);
    // Share the already-initialised client and index
    scoped.client = this.client;
    scoped.index = this.index;
    scoped.initialised = this.initialised;
    return scoped;
  }

  // ── Health check ───────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.describeIndex();
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private ensureInitialised(): void {
    if (!this.initialised || !this.index) {
      throw new Error(
        'PineconeService is not initialised. Call initialize() before using this service.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const pineconeService = new PineconeService();

export default pineconeService;
