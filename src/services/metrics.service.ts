import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { createLogger } from '../utils/logger';

const log = createLogger('MetricsService');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Dedicated Prometheus registry for the application.
 * Using a custom registry (rather than the global default) avoids collisions
 * in test environments where multiple instances may be created.
 */
export const register = new Registry();

register.setDefaultLabels({
  app: 'rag-healthcare-assistant',
  env: process.env.NODE_ENV ?? 'development',
});

// Collect default Node.js process metrics (memory, CPU, event loop lag, etc.)
collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/**
 * Total number of RAG queries executed.
 * Labels:
 *  - status  : 'success' | 'error'
 *  - cached  : 'true' | 'false'
 */
export const ragQueriesTotal = new Counter({
  name: 'rag_queries_total',
  help: 'Total number of RAG queries executed',
  labelNames: ['status', 'cached'] as const,
  registers: [register],
});

/**
 * Total number of document ingestion jobs triggered.
 * Labels:
 *  - status   : 'success' | 'error'
 *  - fileType : 'pdf' | 'docx' | 'txt' | 'md' | 'unknown'
 */
export const ragIngestTotal = new Counter({
  name: 'rag_ingest_total',
  help: 'Total number of document ingestion jobs',
  labelNames: ['status', 'fileType'] as const,
  registers: [register],
});

/**
 * Total number of authentication attempts.
 * Labels:
 *  - status : 'success' | 'failure' | 'blocked'
 */
export const ragAuthTotal = new Counter({
  name: 'rag_auth_total',
  help: 'Total number of authentication attempts',
  labelNames: ['status'] as const,
  registers: [register],
});

/**
 * Total number of application errors by type.
 * Labels:
 *  - errorType : 'ValidationError' | 'AuthError' | 'ForbiddenError' |
 *                'NotFoundError' | 'RateLimitError' | 'InternalServerError' | ...
 */
export const ragErrorsTotal = new Counter({
  name: 'rag_errors_total',
  help: 'Total number of application errors',
  labelNames: ['errorType'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** End-to-end RAG query latency in seconds */
export const ragQueryLatency = new Histogram({
  name: 'rag_query_latency_seconds',
  help: 'End-to-end RAG query latency in seconds',
  labelNames: ['cached'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 7.5, 10],
  registers: [register],
});

/** Embedding generation latency in seconds */
export const ragEmbeddingLatency = new Histogram({
  name: 'rag_embedding_latency_seconds',
  help: 'Embedding generation latency in seconds',
  labelNames: ['provider'] as const,
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

/** Vector retrieval (Pinecone query) latency in seconds */
export const ragRetrievalLatency = new Histogram({
  name: 'rag_retrieval_latency_seconds',
  help: 'Vector retrieval latency in seconds',
  labelNames: [] as const,
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

/** LLM generation latency in seconds */
export const ragLlmLatency = new Histogram({
  name: 'rag_llm_latency_seconds',
  help: 'LLM generation latency in seconds',
  labelNames: ['model', 'provider'] as const,
  buckets: [0.5, 1, 2, 3, 5, 7.5, 10, 15, 30],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** Number of distinct active users (issued an access token in the last hour) */
export const ragActiveUsers = new Gauge({
  name: 'rag_active_users',
  help: 'Number of currently active users',
  labelNames: [] as const,
  registers: [register],
});

/** Number of documents with INDEXED status in the database */
export const ragDocumentsIndexed = new Gauge({
  name: 'rag_documents_indexed',
  help: 'Number of documents currently indexed',
  labelNames: [] as const,
  registers: [register],
});

/** Approximate total number of chunks/vectors in the vector store */
export const ragVectorStoreChunks = new Gauge({
  name: 'rag_vector_store_chunks',
  help: 'Approximate total number of vectors in the vector store',
  labelNames: [] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// HTTP request metrics (populated by Express middleware in app.ts)
// ---------------------------------------------------------------------------

/** HTTP request duration histogram */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'statusCode'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/** HTTP requests in-flight */
export const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  labelNames: ['method'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Initialisation log
// ---------------------------------------------------------------------------

log.info('Prometheus metrics initialised', {
  metrics: [
    'rag_queries_total',
    'rag_ingest_total',
    'rag_auth_total',
    'rag_errors_total',
    'rag_query_latency_seconds',
    'rag_embedding_latency_seconds',
    'rag_retrieval_latency_seconds',
    'rag_llm_latency_seconds',
    'rag_active_users',
    'rag_documents_indexed',
    'rag_vector_store_chunks',
    'http_request_duration_seconds',
    'http_requests_in_flight',
  ],
});

export default register;
