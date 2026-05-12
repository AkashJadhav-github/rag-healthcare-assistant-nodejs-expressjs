# Architecture Decision Records

## ADR-001: Pinecone over pgvector for vector storage

**Date:** 2025-01-15
**Status:** Accepted

### Context
We needed a vector store capable of sub-100 ms approximate nearest-neighbour (ANN) search over millions of medical knowledge embeddings, with namespace-level multi-tenancy and zero operational overhead.

### Decision
Use Pinecone as the managed vector database rather than the pgvector extension for PostgreSQL.

### Consequences
**Positive:**
- Purpose-built ANN indexing (HNSW) with p99 latency < 50 ms at scale.
- Managed service — no index tuning, vacuum, or HNSW rebuild to operate.
- Pinecone namespaces provide free multi-tenancy (one namespace per hospital/organisation).
- Scales independently of PostgreSQL; vector workload does not contend for DB CPU/RAM.
- Built-in metadata filtering without full-text scan.

**Negative:**
- External dependency adds cost and a potential availability risk.
- Cannot run fully offline / air-gapped without a self-hosted alternative.
- Vendor lock-in — migration to pgvector would require a full re-index.

**Mitigations:** Circuit-breaker pattern around Pinecone calls; fallback to PostgreSQL full-text search when Pinecone is unreachable.

---

## ADR-002: Express over Fastify as the HTTP framework

**Date:** 2025-01-20
**Status:** Accepted

### Context
The team needed to choose between Express 4, Fastify 4, and Hono for the REST API layer.

### Decision
Use Express 4 with TypeScript.

### Consequences
**Positive:**
- Largest ecosystem of middleware (helmet, express-rate-limit, morgan, multer, etc.).
- Highest Stack Overflow / GitHub issue coverage — fastest time to fix bugs.
- All team members have existing Express experience.
- supertest integration tests work seamlessly with Express apps.
- express-validator and Zod both integrate cleanly.

**Negative:**
- Fastify benchmarks ~2× faster on raw throughput for JSON serialisation.
- No built-in schema validation (mitigated by Zod).

**Rationale:** At our expected load (< 500 concurrent users), Express throughput is not the bottleneck; LLM API latency dominates. The ecosystem maturity benefit outweighs the performance difference.

---

## ADR-003: Prisma over raw `pg` driver for database access

**Date:** 2025-01-22
**Status:** Accepted

### Context
Options considered: raw `pg` with hand-written SQL, Knex.js query builder, Drizzle ORM, Prisma ORM.

### Decision
Use Prisma 5 with the `@prisma/client` generated from `schema.prisma`.

### Consequences
**Positive:**
- End-to-end type safety — generated client types match the schema exactly.
- Prisma Migrate provides version-controlled, idempotent schema migrations.
- Prisma Studio gives the ops team a GUI for production data inspection.
- Auto-generated CRUD eliminates boilerplate for User, QueryHistory, Document models.
- Query event hooks allow zero-cost query logging to Winston.

**Negative:**
- `prisma generate` must run at build time (addressed in Dockerfile Stage 2).
- Complex raw SQL (e.g. full-text tsvector queries) bypasses type safety — use `prisma.$queryRaw` with template-literal sanitisation.
- Prisma adds ~5 MB to the Docker image.

---

## ADR-004: TypeScript strict mode enabled

**Date:** 2025-01-23
**Status:** Accepted

### Context
TypeScript offers multiple strictness levels. Healthcare software requires high correctness guarantees.

### Decision
Enable `strict: true` in `tsconfig.json` (covers `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and related flags).

### Consequences
**Positive:**
- Null-dereference bugs caught at compile time — critical for patient safety.
- Explicit `undefined` handling prevents runtime crashes in production.
- Improves IDE auto-complete and refactoring safety.
- Forces documentation of nullable function parameters.

**Negative:**
- Higher upfront typing effort, especially when wrapping third-party libraries with incomplete types.
- Some `@ts-expect-error` comments required for legacy patterns.

**Mitigation:** `@typescript-eslint/no-explicit-any: warn` surfaced in CI — any usage is tracked and reviewed.

---

## ADR-005: Hybrid search with Reciprocal Rank Fusion (RRF)

**Date:** 2025-02-01
**Status:** Accepted

### Context
Pure vector (semantic) search misses exact keyword matches (e.g. drug names, ICD-10 codes). Pure keyword search misses paraphrased queries.

### Decision
Implement hybrid search: run vector ANN (Pinecone) and keyword full-text search (PostgreSQL tsvector) in parallel, then fuse results using Reciprocal Rank Fusion.

### Consequences
**Positive:**
- RRF formula: `score(d) = Σ 1/(k + rank_i(d))` with k=60 is parameter-free and robust.
- Outperforms either search modality alone on medical QA benchmarks.
- Catches both "what is MI" (semantic) and "STEMI protocol" (keyword) queries equally well.
- Graceful degradation: if Pinecone fails, fall back to keyword-only.

**Negative:**
- Two I/O operations per query (Pinecone + Postgres) add ~20–30 ms latency.
- Requires maintaining tsvector column and index in PostgreSQL.

---

## ADR-006: ELK Stack for log aggregation

**Date:** 2025-02-10
**Status:** Accepted

### Context
Need for structured log storage, HIPAA audit trail, and operational dashboards. Options: ELK Stack (self-hosted), Datadog, CloudWatch Logs Insights, Grafana Loki.

### Decision
Use Elasticsearch + Logstash + Kibana (8.x) as the primary log aggregation solution, with optional Datadog integration for APM.

### Consequences
**Positive:**
- Full-text search over logs with Kibana Discover — faster incident investigation.
- Logstash pipeline supports enrichment (tagging error logs, parsing ISO8601 timestamps).
- Self-hosted option satisfies HIPAA data residency requirements.
- PHI audit logs stored in a separate index (`rag-healthcare-audit-*`) with restricted access.

**Negative:**
- Elasticsearch is resource-intensive (512 MB heap minimum).
- Requires Kibana index pattern setup and dashboard creation.

**Mitigation:** Single-node Elasticsearch in development/staging; multi-node with replicas in production.

---

## ADR-007: Pinecone namespaces for multi-tenancy

**Date:** 2025-02-15
**Status:** Accepted

### Context
Multiple hospitals or departments need isolated knowledge bases. Options: separate Pinecone indexes per tenant, namespaces within one index, or metadata-based filtering.

### Decision
Use Pinecone namespaces — one namespace per `organisationId`. All tenants share one Pinecone index.

### Consequences
**Positive:**
- Namespaces provide hard isolation at the query level (Pinecone never leaks cross-namespace results).
- Single index reduces cost (one Pinecone pod vs. N pods for N tenants).
- Namespace creation is instant — no provisioning delay when onboarding a new hospital.
- Namespace deletion purges all vectors atomically — clean offboarding.

**Negative:**
- All tenants share the same index capacity — a single tenant's large knowledge base could consume disproportionate storage.
- Namespace-level metadata filtering is limited — complex per-document ACLs still need PostgreSQL.

**Mitigation:** Monitor Pinecone index stats per namespace; enforce per-tenant vector count quota in the ingestion pipeline.
