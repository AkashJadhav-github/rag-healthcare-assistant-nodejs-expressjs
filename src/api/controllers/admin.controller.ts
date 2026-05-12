import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../db/postgres';
import { ingestionService } from '../../rag/ingestion';
import { hashPassword, validatePasswordStrength } from '../../utils/security';
import { asyncHandler, ValidationError, ConflictError, NotFoundError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const log = createLogger('AdminController');

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createUserSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  username: z.string().min(3).max(100),
  fullName: z.string().min(1).max(255),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  role: z.enum(['ADMIN', 'CLINICIAN', 'RESEARCHER', 'VIEWER']).default('VIEWER'),
  department: z.string().max(255).optional(),
});

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/admin/reindex
 *
 * Marks documents as PENDING and triggers background re-ingestion.
 * If `documentId` query param is provided, only that document is re-indexed;
 * otherwise all INDEXED documents are queued.
 */
export const reindex = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const documentId = req.query.documentId as string | undefined;

    let documentsToReindex: Array<{
      id: string;
      filename: string;
      fileType: string;
      title: string;
    }>;

    if (documentId) {
      const doc = await prisma.document.findUnique({
        where: { id: documentId },
        select: { id: true, filename: true, fileType: true, title: true, status: true },
      });

      if (!doc) {
        throw new NotFoundError(`Document with ID "${documentId}" not found`);
      }

      documentsToReindex = [doc];
    } else {
      documentsToReindex = await prisma.document.findMany({
        where: { isActive: true, status: { in: ['INDEXED', 'FAILED'] } },
        select: { id: true, filename: true, fileType: true, title: true },
      });
    }

    if (documentsToReindex.length === 0) {
      res.status(200).json({
        success: true,
        data: {
          status: 'no_op',
          message: 'No documents found to reindex.',
          documentsQueued: 0,
        },
      });
      return;
    }

    // Mark all as PENDING in one batch
    await prisma.document.updateMany({
      where: { id: { in: documentsToReindex.map((d) => d.id) } },
      data: { status: 'PENDING', errorMessage: null },
    });

    log.info('Reindex triggered', {
      triggeredBy: req.user!.id,
      count: documentsToReindex.length,
      documentId: documentId ?? 'all',
    });

    // ── Background re-ingestion ───────────────────────────────────────────
    setImmediate(async () => {
      for (const doc of documentsToReindex) {
        try {
          await prisma.document.update({
            where: { id: doc.id },
            data: { status: 'PROCESSING' },
          });

          // We cannot guarantee the original file still exists on disk;
          // ingestionService.ingest would need to re-fetch from storage.
          // In production, store the file in S3/GCS and reconstruct the path.
          // Here we use the filename as a best-effort path.
          const filePath = `/tmp/healthcare_uploads/${doc.filename}`;

          const chunkCount = await ingestionService.ingest(
            doc.id,
            filePath,
            doc.fileType,
            doc.title
          );

          await prisma.document.update({
            where: { id: doc.id },
            data: {
              status: 'INDEXED',
              chunkCount,
              indexedAt: new Date(),
              errorMessage: null,
            },
          });

          log.info('Reindex complete for document', { documentId: doc.id, chunkCount });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error('Reindex failed for document', { documentId: doc.id, error: errorMessage });

          await prisma.document
            .update({
              where: { id: doc.id },
              data: { status: 'FAILED', errorMessage },
            })
            .catch(() => null);
        }
      }
    });

    res.status(202).json({
      success: true,
      data: {
        status: 'queued',
        message: `${documentsToReindex.length} document(s) queued for reindexing.`,
        documentsQueued: documentsToReindex.length,
      },
    });
  }
);

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/admin/users
 *
 * Creates a new user account. Validates password strength, checks email
 * uniqueness, hashes the password, and returns the sanitised UserResponse.
 */
export const createUser = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const parseResult = createUserSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')
      );
    }

    const { email, username, fullName, password, role, department } = parseResult.data;

    // Password strength validation
    const strengthCheck = validatePasswordStrength(password);
    if (!strengthCheck.valid) {
      throw new ValidationError(strengthCheck.errors.join('; '));
    }

    // Email uniqueness
    const existingByEmail = await prisma.user.findUnique({ where: { email } });
    if (existingByEmail) {
      throw new ConflictError(`A user with email "${email}" already exists`);
    }

    // Username uniqueness
    const existingByUsername = await prisma.user.findUnique({ where: { username } });
    if (existingByUsername) {
      throw new ConflictError(`A user with username "${username}" already exists`);
    }

    const hashedPassword = await hashPassword(password);

    const newUser = await prisma.user.create({
      data: {
        email,
        username,
        fullName,
        hashedPassword,
        role: role as never,
        department,
        isActive: true,
        isVerified: false,
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        department: true,
        isActive: true,
        isVerified: true,
        createdAt: true,
      },
    });

    log.info('User created by admin', {
      newUserId: newUser.id,
      adminId: req.user!.id,
      role,
    });

    res.status(201).json({
      success: true,
      data: { user: newUser },
    });
  }
);

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/stats
 *
 * Returns aggregate statistics: document counts, query counts, active users.
 */
export const getStats = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const [
      totalDocuments,
      indexedDocuments,
      pendingDocuments,
      failedDocuments,
      totalQueries,
      totalUsers,
      activeUsers,
      queriesLast24h,
    ] = await Promise.all([
      prisma.document.count({ where: { isActive: true } }),
      prisma.document.count({ where: { isActive: true, status: 'INDEXED' } }),
      prisma.document.count({ where: { isActive: true, status: 'PENDING' } }),
      prisma.document.count({ where: { isActive: true, status: 'FAILED' } }),
      prisma.queryLog.count(),
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.queryLog.count({
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        documents: {
          total: totalDocuments,
          indexed: indexedDocuments,
          pending: pendingDocuments,
          failed: failedDocuments,
        },
        queries: {
          total: totalQueries,
          last24h: queriesLast24h,
        },
        users: {
          total: totalUsers,
          active: activeUsers,
        },
        generatedAt: new Date().toISOString(),
      },
    });
  }
);
