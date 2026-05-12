import { Prisma } from '@prisma/client';
import prisma from '../db/postgres';
import { pineconeService } from '../services/pinecone.service';
import { embeddingService } from './embeddings';
import { queryEnhancer } from './queryEnhancer';
import { createLogger } from '../utils/logger';

const log = createLogger('HybridRetriever');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  similarityScore: number;
  pageNumber?: number;
  section?: string;
}

// Internal rank entry used during RRF fusion
interface RankedResult {
  result: RetrievalResult;
  semanticRank?: number;
  keywordRank?: number;
}

// Raw row returned by the pg_trgm $queryRaw call
interface TrgmRow {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  page_number: number | null;
  section: string | null;
  similarity: number;
}

// ---------------------------------------------------------------------------
// HybridRetriever
// ---------------------------------------------------------------------------

export class HybridRetriever {
  // ── Configuration ──────────────────────────────────────────────────────────

  /** RRF smoothing constant — standard value is 60 */
  private readonly RRF_K = 60;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Full hybrid retrieval pipeline:
   *  1. Expand abbreviations + add synonyms via MedicalQueryEnhancer
   *  2. Semantic search via Pinecone
   *  3. Keyword search via PostgreSQL pg_trgm
   *  4. Reciprocal Rank Fusion to merge the two ranked lists
   */
  async retrieve(
    query: string,
    topK = 5,
    documentIds?: string[],
  ): Promise<RetrievalResult[]> {
    // Step 1 — enhance the query
    const { enhancedQuery } = queryEnhancer.enhance(query);

    log.debug('HybridRetriever.retrieve', {
      originalQuery: query,
      enhancedQuery,
      topK,
      documentIds,
    });

    // Step 2 — embed the enhanced query
    let queryEmbedding: number[];
    try {
      queryEmbedding = await embeddingService.embedText(enhancedQuery);
    } catch (err) {
      log.error('Failed to embed query for retrieval', { error: (err as Error).message });
      queryEmbedding = await embeddingService.embedText(query); // Fallback to original
    }

    // Steps 3 & 4 — run both searches in parallel
    const fetchSize = topK * 3; // Fetch more than needed for better RRF coverage
    const [semanticResults, keywordResults] = await Promise.allSettled([
      this.semanticSearch(queryEmbedding, fetchSize, documentIds),
      this.keywordSearch(enhancedQuery, fetchSize, documentIds),
    ]);

    const semantic =
      semanticResults.status === 'fulfilled' ? semanticResults.value : [];
    const keyword =
      keywordResults.status === 'fulfilled' ? keywordResults.value : [];

    if (semanticResults.status === 'rejected') {
      log.warn('Semantic search failed', { error: semanticResults.reason });
    }
    if (keywordResults.status === 'rejected') {
      log.warn('Keyword search failed', { error: keywordResults.reason });
    }

    // Step 5 — RRF fusion and return top-K
    const fused = this.reciprocalRankFusion(semantic, keyword, this.RRF_K);

    log.info('Hybrid retrieval complete', {
      semanticCount: semantic.length,
      keywordCount: keyword.length,
      fusedCount: fused.length,
      returnedCount: Math.min(topK, fused.length),
    });

    return fused.slice(0, topK);
  }

  // ── Semantic search (Pinecone) ─────────────────────────────────────────────

  /**
   * Query Pinecone for the nearest-neighbour chunks using the provided embedding.
   * When `documentIds` is supplied, restricts results to those documents.
   */
  async semanticSearch(
    queryEmbedding: number[],
    topK: number,
    documentIds?: string[],
  ): Promise<RetrievalResult[]> {
    const filter: Record<string, unknown> | undefined =
      documentIds && documentIds.length > 0
        ? { documentId: { $in: documentIds } }
        : undefined;

    const matches = await pineconeService.queryVectors(queryEmbedding, topK, filter);

    return matches.map((m) => ({
      chunkId: m.id,
      documentId: String(m.metadata['documentId'] ?? ''),
      documentTitle: String(m.metadata['documentTitle'] ?? 'Unknown Document'),
      content: String(m.metadata['content'] ?? ''),
      similarityScore: m.score,
      pageNumber:
        m.metadata['pageNumber'] != null
          ? Number(m.metadata['pageNumber'])
          : undefined,
      section:
        m.metadata['section'] != null ? String(m.metadata['section']) : undefined,
    }));
  }

  // ── Keyword search (PostgreSQL pg_trgm) ───────────────────────────────────

  /**
   * Use PostgreSQL's pg_trgm extension to perform trigram-similarity keyword
   * search against the `document_chunks` table.
   *
   * Requires the pg_trgm extension and a GIN index on the `content` column:
   *   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   *   CREATE INDEX idx_chunks_content_trgm ON document_chunks USING GIN (content gin_trgm_ops);
   */
  async keywordSearch(
    query: string,
    topK: number,
    documentIds?: string[],
  ): Promise<RetrievalResult[]> {
    try {
      let rows: TrgmRow[];

      if (documentIds && documentIds.length > 0) {
        rows = await prisma.$queryRaw<TrgmRow[]>(
          Prisma.sql`
            SELECT
              dc.id                             AS chunk_id,
              dc.document_id,
              d.title                           AS document_title,
              dc.content,
              dc.page_number,
              dc.section,
              similarity(dc.content, ${query})  AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            WHERE
              dc.document_id = ANY(${documentIds}::uuid[])
              AND similarity(dc.content, ${query}) > 0.1
            ORDER BY similarity DESC
            LIMIT ${topK}
          `
        );
      } else {
        rows = await prisma.$queryRaw<TrgmRow[]>(
          Prisma.sql`
            SELECT
              dc.id                             AS chunk_id,
              dc.document_id,
              d.title                           AS document_title,
              dc.content,
              dc.page_number,
              dc.section,
              similarity(dc.content, ${query})  AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            WHERE similarity(dc.content, ${query}) > 0.1
            ORDER BY similarity DESC
            LIMIT ${topK}
          `
        );
      }

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        documentTitle: row.document_title,
        content: row.content,
        similarityScore: Number(row.similarity),
        pageNumber: row.page_number ?? undefined,
        section: row.section ?? undefined,
      }));
    } catch (err) {
      log.error('pg_trgm keyword search failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ── Reciprocal Rank Fusion ─────────────────────────────────────────────────

  /**
   * Merge two ranked result lists using Reciprocal Rank Fusion.
   *
   * RRF score = Σ 1 / (k + rank_i)
   *
   * Results present in only one list still contribute their RRF score from
   * that list. The merged list is sorted descending by RRF score.
   */
  reciprocalRankFusion(
    semantic: RetrievalResult[],
    keyword: RetrievalResult[],
    k: number,
  ): RetrievalResult[] {
    const scoreMap = new Map<string, RankedResult>();

    // Index semantic results
    for (let i = 0; i < semantic.length; i++) {
      const result = semantic[i];
      scoreMap.set(result.chunkId, {
        result,
        semanticRank: i + 1,
      });
    }

    // Merge keyword results
    for (let i = 0; i < keyword.length; i++) {
      const result = keyword[i];
      const existing = scoreMap.get(result.chunkId);

      if (existing) {
        existing.keywordRank = i + 1;
        // Prefer the higher-scored similarity value between the two sources
        if (result.similarityScore > existing.result.similarityScore) {
          existing.result = result;
          existing.result.similarityScore = (existing.result.similarityScore + result.similarityScore) / 2;
        }
      } else {
        scoreMap.set(result.chunkId, {
          result,
          keywordRank: i + 1,
        });
      }
    }

    // Compute RRF scores and sort
    const ranked = Array.from(scoreMap.values())
      .map((entry) => {
        let rrfScore = 0;
        if (entry.semanticRank !== undefined) rrfScore += 1 / (k + entry.semanticRank);
        if (entry.keywordRank !== undefined)  rrfScore += 1 / (k + entry.keywordRank);
        return { result: entry.result, rrfScore };
      })
      .sort((a, b) => b.rrfScore - a.rrfScore);

    // Replace similarityScore with the normalised RRF score (0–1 range)
    const maxRRF = ranked[0]?.rrfScore ?? 1;
    return ranked.map(({ result, rrfScore }) => ({
      ...result,
      similarityScore: maxRRF > 0 ? rrfScore / maxRRF : 0,
    }));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const retriever = new HybridRetriever();

export default retriever;
