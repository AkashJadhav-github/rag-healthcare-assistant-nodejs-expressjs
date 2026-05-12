import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';

import { config } from './config/config';
import logger, { httpLogStream } from './utils/logger';
import { globalErrorHandler, NotFoundError } from './utils/errors';
import {
  httpRequestDuration,
  httpRequestsInFlight,
} from './services/metrics.service';

// Route modules
import authRoutes from './api/routes/auth.routes';
import knowledgeRoutes from './api/routes/knowledge.routes';
import adminRoutes from './api/routes/admin.routes';
import healthRoutes from './api/routes/health.routes';

// ---------------------------------------------------------------------------
// App instance
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Security headers (helmet)
// ---------------------------------------------------------------------------

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // relax for API usage
  })
);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman, server-to-server)
      if (!origin) return callback(null, true);
      if (config.ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      logger.warn('CORS: blocked request from disallowed origin', { origin });
      callback(new Error(`CORS policy: origin "${origin}" is not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 86400, // 24 h preflight cache
  })
);

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

app.use(compression());

// ---------------------------------------------------------------------------
// Request ID middleware
// ---------------------------------------------------------------------------

app.use((req: Request, res: Response, next: NextFunction): void => {
  const requestId =
    (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// ---------------------------------------------------------------------------
// HTTP access logging (Morgan → Winston)
// ---------------------------------------------------------------------------

if (config.NODE_ENV !== 'test') {
  app.use(
    morgan(
      ':method :url :status :res[content-length] - :response-time ms',
      { stream: httpLogStream }
    )
  );
}

// ---------------------------------------------------------------------------
// Prometheus HTTP metrics middleware
// ---------------------------------------------------------------------------

app.use((req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  httpRequestsInFlight.inc({ method: req.method });

  res.on('finish', () => {
    const durationSeconds = (Date.now() - start) / 1000;
    // Normalise route for label cardinality (use base path segment)
    const route = req.route?.path ?? req.path;

    httpRequestDuration.observe(
      { method: req.method, route, statusCode: String(res.statusCode) },
      durationSeconds
    );
    httpRequestsInFlight.dec({ method: req.method });
  });

  next();
});

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Trust proxy (required for accurate IP behind load balancer / nginx)
// ---------------------------------------------------------------------------

app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const API_BASE = `/api/${config.API_VERSION}`;

app.use(`${API_BASE}/auth`,      authRoutes);
app.use(`${API_BASE}/knowledge`, knowledgeRoutes);
app.use(`${API_BASE}/admin`,     adminRoutes);
app.use(`${API_BASE}/health`,    healthRoutes);

// ---------------------------------------------------------------------------
// 404 handler for unknown routes
// ---------------------------------------------------------------------------

app.use((_req: Request, _res: Response, next: NextFunction): void => {
  next(new NotFoundError('The requested endpoint does not exist'));
});

// ---------------------------------------------------------------------------
// Global error handler (must be registered LAST)
// ---------------------------------------------------------------------------

app.use(globalErrorHandler);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
export { app };
