import OpenAI from 'openai';
import { config } from '../config/config';
import { cacheService, CacheService } from '../services/cache.service';
import { createLogger } from '../utils/logger';

const log = createLogger('EmbeddingService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = 'text-embedding-ada-002';
const EMBEDDING_DIMENSION = 1536;
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

// ---------------------------------------------------------------------------
// Fallback local embedding (average word-hash vectors)
// ---------------------------------------------------------------------------

/**
 * Deterministic hash for a single character code — produces a float in [-1, 1].
 */
function hashChar(code: number, seed: number): number {
  let h = seed ^ code;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff * 2 - 1;
}

/**
 * Produce a pseudo-embedding for a single word by hashing each character.
 * The output dimension matches EMBEDDING_DIMENSION.
 */
function wordVector(word: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    for (let d = 0; d < EMBEDDING_DIMENSION; d++) {
      vec[d] += hashChar(code, d + 1);
    }
  }
  return vec;
}

/**
 * Compute a local average-word-vector embedding as a fallback when no
 * OpenAI API key is available. This is NOT suitable for production use
 * but allows tests / offline development to proceed without API calls.
 */
function localEmbed(text: string): number[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return new Array<number>(EMBEDDING_DIMENSION).fill(0);
  }

  const sum = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (const word of words) {
    const wv = wordVector(word);
    for (let d = 0; d < EMBEDDING_DIMENSION; d++) {
      sum[d] += wv[d];
    }
  }

  // Normalise to unit length
  const raw = sum.map((v) => v / words.length);
  const norm = Math.sqrt(raw.reduce((acc, v) => acc + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private readonly hasApiKey: boolean;

  constructor() {
    this.hasApiKey = Boolean(config.OPENAI_API_KEY);

    if (this.hasApiKey) {
      this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      log.info('EmbeddingService initialised with OpenAI', { model: EMBEDDING_MODEL });
    } else {
      log.warn(
        'OPENAI_API_KEY not set — EmbeddingService will use local fallback embeddings. ' +
        'These are not suitable for production retrieval quality.'
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate (or retrieve from cache) an embedding for a single text string.
   *
   * @param text     The text to embed
   * @param useCache Whether to check / populate the Redis cache (default: true)
   */
  async embedText(text: string, useCache = true): Promise<number[]> {
    const normalized = text.trim();

    if (normalized.length === 0) {
      return new Array<number>(EMBEDDING_DIMENSION).fill(0);
    }

    // ── Cache lookup ────────────────────────────────────────────────────────
    if (useCache) {
      const cacheKey = CacheService.makeEmbeddingKey(normalized);
      const cached = await cacheService.get<number[]>(cacheKey);

      if (cached !== null) {
        log.debug('Embedding cache hit', { textLength: normalized.length });
        return cached;
      }
    }

    // ── Generate embedding ──────────────────────────────────────────────────
    let embedding: number[];

    if (this.openai) {
      embedding = await this.callOpenAI(normalized);
    } else {
      embedding = localEmbed(normalized);
    }

    // ── Cache store ─────────────────────────────────────────────────────────
    if (useCache) {
      const cacheKey = CacheService.makeEmbeddingKey(normalized);
      await cacheService.set(cacheKey, embedding, CACHE_TTL_SECONDS);
    }

    return embedding;
  }

  /**
   * Embed multiple texts in parallel, splitting into batches to respect
   * OpenAI's input token limits.
   *
   * @param texts     Array of texts to embed
   * @param batchSize Maximum number of texts per API call (default: 20)
   */
  async embedBatch(texts: string[], batchSize = 20): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      // Process each item in the batch; if caching is on, individual cache
      // hits avoid redundant API calls inside the batch.
      const batchResults = await Promise.all(
        batch.map((text) => this.embedText(text, true))
      );

      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }

      log.debug('Embedding batch complete', {
        batchStart: i,
        batchSize: batch.length,
        total: texts.length,
      });
    }

    return results;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async callOpenAI(text: string): Promise<number[]> {
    try {
      const response = await this.openai!.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
        encoding_format: 'float',
      });

      const embedding = response.data[0]?.embedding;

      if (!embedding || embedding.length === 0) {
        throw new Error('OpenAI returned an empty embedding');
      }

      log.debug('OpenAI embedding generated', {
        textLength: text.length,
        dimension: embedding.length,
      });

      return embedding;
    } catch (err) {
      log.error('OpenAI embedding call failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ── Dimension accessor ─────────────────────────────────────────────────────

  get dimension(): number {
    return EMBEDDING_DIMENSION;
  }

  get usingFallback(): boolean {
    return !this.hasApiKey;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const embeddingService = new EmbeddingService();

export default embeddingService;
