-- =============================================================================
-- Migration 001: Bootstrap — Enable required PostgreSQL extensions
-- =============================================================================
-- Run this migration BEFORE prisma migrate deploy on a fresh database.
-- It activates the two extensions that the schema and application rely on:
--
--   uuid-ossp  — provides gen_random_uuid() used as the default PK generator
--                in every model (Prisma also works with pgcrypto, but
--                uuid-ossp is more universally available on hosted Postgres).
--
--   pg_trgm    — trigram indexing that powers fast ILIKE / similarity()
--                searches on document titles and query text.
-- =============================================================================

-- Enable uuid generation functions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable trigram similarity functions and index support
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =============================================================================
-- GIN trigram indexes
-- These are created here rather than in the Prisma schema because Prisma
-- does not yet expose GIN index type or the gin_trgm_ops operator class.
-- The indexes are safe to create idempotently with IF NOT EXISTS.
-- =============================================================================

-- Allow fast case-insensitive substring search on document titles
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
    ON documents USING GIN (title gin_trgm_ops);

-- Allow fast case-insensitive substring search on query text
CREATE INDEX IF NOT EXISTS idx_query_logs_query_text_trgm
    ON query_logs USING GIN (query_text gin_trgm_ops);

-- =============================================================================
-- Row-level comment annotations for DBA clarity
-- =============================================================================

COMMENT ON TABLE users IS
    'Application users — clinicians, researchers, admins and read-only viewers.';

COMMENT ON TABLE documents IS
    'Healthcare knowledge documents uploaded and indexed into Pinecone.';

COMMENT ON TABLE query_logs IS
    'Audit trail of every RAG query submitted to the assistant.';

COMMENT ON TABLE query_sources IS
    'Vector-retrieval sources cited for each query response.';

COMMENT ON TABLE audit_logs IS
    'Immutable append-only event log for compliance and forensic purposes.';
