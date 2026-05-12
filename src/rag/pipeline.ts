import { retriever } from './retrieval';
import { generator } from './generation';
import { piiDetector } from './piiDetector';
import { createLogger } from '../utils/logger';
import type { RetrievalResult } from './retrieval';
import type { GenerationResult } from './generation';

const log = createLogger('RAGPipeline');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RAGResult {
  answer: string;
  sources: RetrievalResult[];
  confidenceScore: number;
  modelUsed: string;
  latencyMs: number;
  phiMasked: boolean;
}

// ---------------------------------------------------------------------------
// RAGPipeline
// ---------------------------------------------------------------------------

export class RAGPipeline {
  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Execute the full RAG pipeline for a user query.
   *
   * Steps:
   *  1. Mask any PHI/PII in the incoming query (HIPAA compliance)
   *  2. Retrieve relevant chunks via hybrid search (semantic + keyword + RRF)
   *  3. Generate a grounded answer via the configured LLM
   *  4. Mask any PHI/PII that may appear in the generated response
   *  5. Return structured result with sources and metadata
   *
   * @param query       The user's natural-language question
   * @param maxSources  Maximum number of source chunks to retrieve (default: 5)
   * @param userId      Optional user ID for audit logging / cache scoping
   * @param documentIds Optional list of document IDs to restrict retrieval to
   */
  async query(
    query: string,
    maxSources = 5,
    userId?: string,
    documentIds?: string[],
  ): Promise<RAGResult> {
    const pipelineStart = Date.now();

    log.info('RAG pipeline started', {
      queryLength: query.length,
      maxSources,
      userId: userId ?? 'anonymous',
      documentIds,
    });

    // ── Step 1: Mask PHI in the incoming query ─────────────────────────────
    let queryPhiFound = false;
    let safeQuery: string;

    try {
      const { maskedText, phiFound } = piiDetector.maskPHI(query);
      safeQuery = maskedText;
      queryPhiFound = phiFound;

      if (phiFound) {
        log.warn('PHI detected in user query and masked before processing', {
          userId: userId ?? 'anonymous',
        });
      }
    } catch (err) {
      log.error('PII masking failed for query — using original query', {
        error: (err as Error).message,
      });
      safeQuery = query;
    }

    // ── Step 2: Retrieve relevant chunks ──────────────────────────────────
    let sources: RetrievalResult[] = [];

    try {
      sources = await retriever.retrieve(safeQuery, maxSources, documentIds);

      log.info('Retrieval complete', {
        sourceCount: sources.length,
        userId: userId ?? 'anonymous',
      });
    } catch (err) {
      log.error('Retrieval failed', {
        error: (err as Error).message,
        userId: userId ?? 'anonymous',
      });
      // Proceed with empty sources — generator will return a "no sources" response
    }

    // ── Step 3: Generate answer ────────────────────────────────────────────
    let generation: GenerationResult;

    try {
      generation = await generator.generate(safeQuery, sources);
    } catch (err) {
      log.error('LLM generation failed', {
        error: (err as Error).message,
        userId: userId ?? 'anonymous',
      });
      // Return a safe error response rather than propagating
      generation = {
        answer:
          'An error occurred while generating the response. Please try again or contact support.\n\n' +
          '---\n**Clinical Disclaimer:** This information is derived from referenced medical literature ' +
          'and is intended for educational and professional reference purposes only.',
        modelUsed: 'error',
        confidenceScore: 0,
        latencyMs: Date.now() - pipelineStart,
      };
    }

    // ── Step 4: Mask PHI in the generated response ─────────────────────────
    let responsePhiFound = false;
    let safeAnswer = generation.answer;

    try {
      const { maskedText, phiFound } = piiDetector.maskPHI(generation.answer);
      safeAnswer = maskedText;
      responsePhiFound = phiFound;

      if (phiFound) {
        log.warn('PHI detected in LLM response and masked before returning', {
          userId: userId ?? 'anonymous',
          modelUsed: generation.modelUsed,
        });
      }
    } catch (err) {
      log.error('PII masking failed for response — using unmasked answer', {
        error: (err as Error).message,
      });
    }

    const totalLatencyMs = Date.now() - pipelineStart;
    const phiMasked = queryPhiFound || responsePhiFound;

    log.info('RAG pipeline complete', {
      totalLatencyMs,
      sourceCount: sources.length,
      modelUsed: generation.modelUsed,
      confidenceScore: generation.confidenceScore,
      phiMasked,
      userId: userId ?? 'anonymous',
    });

    return {
      answer: safeAnswer,
      sources,
      confidenceScore: generation.confidenceScore,
      modelUsed: generation.modelUsed,
      latencyMs: totalLatencyMs,
      phiMasked,
    };
  }

  // ── Health check ───────────────────────────────────────────────────────────

  /**
   * Lightweight pipeline health check.
   * Verifies that the PII detector, retriever, and generator are available.
   */
  async healthCheck(): Promise<{ healthy: boolean; details: Record<string, boolean> }> {
    const details: Record<string, boolean> = {
      piiDetector: false,
      retriever: false,
      generator: false,
    };

    try {
      piiDetector.containsPHI('test');
      details['piiDetector'] = true;
    } catch {
      details['piiDetector'] = false;
    }

    try {
      // A real health check would ping Pinecone; here we verify the module loaded
      details['retriever'] = typeof retriever.retrieve === 'function';
    } catch {
      details['retriever'] = false;
    }

    try {
      details['generator'] = typeof generator.generate === 'function';
    } catch {
      details['generator'] = false;
    }

    const healthy = Object.values(details).every(Boolean);

    return { healthy, details };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const ragPipeline = new RAGPipeline();

export default ragPipeline;
