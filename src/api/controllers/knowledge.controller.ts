import path from 'path';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../db/postgres';
import { cacheService, CacheService } from '../../services/cache.service';
import { ragPipeline } from '../../rag/pipeline';
import { ingestionService } from '../../rag/ingestion';
import { sanitizeQuery } from '../../utils/security';
import { asyncHandler, ValidationError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import { config, MAX_DOCUMENT_SIZE_BYTES } from '../../config/config';

const log = createLogger('KnowledgeController');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'];
const UPLOAD_DIR = '/tmp/healthcare_uploads';
const CACHE_TTL_SECONDS = 30 * 60; // 30 minutes

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const askSchema = z.object({
  query: z.string().min(3, 'Query must be at least 3 characters').max(2000, 'Query must not exceed 2000 characters'),
  sessionId: z.string().optional(),
  maxSources: z.number().int().min(1).max(20).default(5),
  includeSources: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Multer configuration
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (err) {
      cb(err as Error, UPLOAD_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_DOCUMENT_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new ValidationError(
          `File type ".${ext}" is not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`
        )
      );
    }
  },
});

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/knowledge/ask
 *
 * Accepts a natural-language query, runs it through the RAG pipeline (with
 * Redis caching), persists QueryLog + QuerySource records, and returns a
 * structured `AskResponse`.
 */
export const ask = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const parseResult = askSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')
      );
    }

    const { query, sessionId, maxSources, includeSources } = parseResult.data;
    if (!req.user) throw new Error('Unauthorized');
    const userId = req.user.id;
    const resolvedSessionId = sessionId ?? uuidv4();

    // ── Sanitize query (strip prompt-injection patterns) ──────────────────
    const sanitizedQuery = sanitizeQuery(query);

    // ── Check Redis cache ─────────────────────────────────────────────────
    const finalCacheKey = CacheService.makeQueryKey(sanitizedQuery, userId);

    type CachedAskResponse = {
      queryId: string;
      answer: string;
      sources: unknown[];
      confidenceScore: number;
      latencyMs: number;
      wasCached: boolean;
      modelUsed: string;
    };

    const cached = await cacheService.get<CachedAskResponse>(finalCacheKey);

    if (cached) {
      log.info('Cache hit for query', { userId, cacheKey: finalCacheKey });
      res.status(200).json({
        success: true,
        data: { ...cached, wasCached: true },
      });
      return;
    }

    // ── Run RAG pipeline ──────────────────────────────────────────────────
    const startTime = Date.now();
    const result = await ragPipeline.query(sanitizedQuery, maxSources, userId);
    const latencyMs = Date.now() - startTime;

    const queryId = uuidv4();

    // ── Persist QueryLog ──────────────────────────────────────────────────
    try {
      const queryHash = createHash('sha256').update(sanitizedQuery).digest('hex');

      const queryLog = await prisma.queryLog.create({
        data: {
          id: queryId,
          userId,
          sessionId: resolvedSessionId,
          queryText: sanitizedQuery,
          queryHash,
          responseText: result.answer,
          confidenceScore: result.confidenceScore,
          latencyMs,
          llmModel: result.modelUsed,
          retrievalCount: result.sources.length,
          wasCached: false,
          metadata: {},
        },
      });

      // ── Persist QuerySource records ──────────────────────────────────────
      if (result.sources.length > 0) {
        const sourcesToCreate = result.sources
          .filter((s) => s.documentId)
          .map((source, index) => ({
            queryId: queryLog.id,
            documentId: source.documentId,
            documentTitle: source.documentTitle ?? 'Unknown',
            chunkContent: source.content ?? '',
            similarityScore: source.similarityScore ?? 0,
            rank: index + 1,
            pageNumber: source.pageNumber ?? null,
            section: source.section ?? null,
          }));

        if (sourcesToCreate.length > 0) {
          await prisma.querySource.createMany({ data: sourcesToCreate });
        }
      }
    } catch (dbErr) {
      // DB failure should NOT fail the response — log and continue
      log.error('Failed to persist QueryLog', {
        userId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    // ── Build response ────────────────────────────────────────────────────
    const sources = includeSources
      ? result.sources.map((s) => ({
          documentId: s.documentId,
          documentTitle: s.documentTitle,
          content: s.content,
          score: s.similarityScore,
          pageNumber: s.pageNumber,
          section: s.section,
        }))
      : [];

    const responseData: CachedAskResponse = {
      queryId,
      answer: result.answer,
      sources,
      confidenceScore: result.confidenceScore,
      latencyMs,
      wasCached: false,
      modelUsed: result.modelUsed,
    };

    // ── Cache result ──────────────────────────────────────────────────────
    await cacheService.set(finalCacheKey, responseData, CACHE_TTL_SECONDS);

    log.info('Query processed', {
      userId,
      queryId,
      latencyMs,
      sourceCount: result.sources.length,
      cached: false,
    });

    res.status(200).json({
      success: true,
      data: responseData,
    });
  }
);

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/knowledge/ingest
 *
 * Accepts a file upload (multipart/form-data), creates a `Document` record
 * in PENDING state, triggers background processing via `setImmediate`, and
 * returns immediately with the document ID.
 */
export const ingest = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    if (!req.file) {
      throw new ValidationError('No file uploaded. Please attach a file.');
    }

    const file = req.file;
    const ext = path.extname(file.originalname).replace('.', '').toLowerCase();

    // Double-check extension (multer fileFilter already does this, but be safe)
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      // Clean up temp file
      await fs.unlink(file.path).catch(() => null);
      throw new ValidationError(
        `File type ".${ext}" is not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`
      );
    }

    // Double-check file size
    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      await fs.unlink(file.path).catch(() => null);
      throw new ValidationError(
        `File size ${(file.size / 1024 / 1024).toFixed(1)} MB exceeds the ` +
          `maximum allowed size of ${config.MAX_DOCUMENT_SIZE_MB} MB`
      );
    }

    if (!req.user) throw new Error('Unauthorized');
    const userId = req.user.id;
    const title = (req.body.title as string | undefined) ?? path.basename(file.originalname, path.extname(file.originalname));
    const category = (req.body.category as string | undefined) ?? 'OTHER';

    // ── Create Document record (PENDING) ──────────────────────────────────
    const document = await prisma.document.create({
      data: {
        title,
        filename: file.originalname,
        fileType: ext,
        fileSize: BigInt(file.size),
        category: category as never,
        status: 'PENDING',
        uploadedById: userId,
        metadata: {},
      },
    });

    log.info('Document record created, queuing ingestion', {
      documentId: document.id,
      filename: file.originalname,
      fileType: ext,
      fileSize: file.size,
      userId,
    });

    // ── Trigger background processing ─────────────────────────────────────
    setImmediate(async () => {
      const filePath = file.path;

      try {
        // Mark as PROCESSING
        await prisma.document.update({
          where: { id: document.id },
          data: { status: 'PROCESSING' },
        });

        const chunkCount = await ingestionService.ingest(
          document.id,
          filePath,
          ext,
          title
        );

        // Mark as INDEXED
        await prisma.document.update({
          where: { id: document.id },
          data: {
            status: 'INDEXED',
            chunkCount,
            indexedAt: new Date(),
          },
        });

        log.info('Document ingestion complete', {
          documentId: document.id,
          chunkCount,
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        log.error('Document ingestion failed', {
          documentId: document.id,
          error: errorMessage,
        });

        await prisma.document
          .update({
            where: { id: document.id },
            data: {
              status: 'FAILED',
              errorMessage,
            },
          })
          .catch((dbErr) => {
            log.error('Failed to update document status to FAILED', {
              documentId: document.id,
              dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
            });
          });
      } finally {
        // Remove the temp file regardless of success/failure
        await fs.unlink(filePath).catch(() => null);
      }
    });

    res.status(202).json({
      success: true,
      data: {
        documentId: document.id,
        title,
        status: 'pending',
        message:
          'Document received and queued for processing. ' +
          'Check the document status endpoint for progress.',
      },
    });
  }
);

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/knowledge/history
 *
 * Returns paginated QueryLog entries for the authenticated user.
 *
 * Query params:
 *  - page     (default: 1)
 *  - pageSize (default: 20, max: 100)
 */
export const getHistory = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    if (!req.user) throw new Error('Unauthorized');
    const userId = req.user.id;

    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt((req.query.pageSize as string) ?? '20', 10))
    );
    const skip = (page - 1) * pageSize;

    const [total, logs] = await Promise.all([
      prisma.queryLog.count({ where: { userId } }),
      prisma.queryLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          sessionId: true,
          queryText: true,
          responseText: true,
          confidenceScore: true,
          latencyMs: true,
          llmModel: true,
          retrievalCount: true,
          wasCached: true,
          createdAt: true,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.status(200).json({
      success: true,
      data: {
        items: logs,
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      },
    });
  }
);
