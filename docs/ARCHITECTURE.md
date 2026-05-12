# System Architecture

## Overview

The RAG Healthcare Knowledge Assistant is a horizontally scalable REST API that combines semantic
vector search (Pinecone) with relational storage (PostgreSQL) and in-memory caching (Redis) to
provide sub-second answers to clinical queries while enforcing HIPAA safeguards on every request.

---

## System Diagram

```
                         ┌─────────────────────────────────────────────────────┐
                         │                   AWS / EKS Cluster                  │
                         │                                                       │
  ┌───────────┐  HTTPS   │  ┌─────────────────┐                                 │
  │  Clients  │─────────►│  │   Load Balancer  │                                 │
  │ (Browser/ │          │  │ (ALB / nginx)    │                                 │
  │  Mobile)  │          │  └────────┬─────────┘                                 │
  └───────────┘          │           │  port 443 → 3000                          │
                         │           ▼                                            │
                         │  ┌─────────────────────────────────────────┐          │
                         │  │          Express API  (3 replicas)       │          │
                         │  │                                          │          │
                         │  │  auth middleware → RBAC → rate-limit     │          │
                         │  │         │                                │          │
                         │  │         ▼                                │          │
                         │  │  ┌──────────────────────────────────┐   │          │
                         │  │  │          RAG Pipeline             │   │          │
                         │  │  │                                   │   │          │
                         │  │  │  PIIDetector (mask PHI)           │   │          │
                         │  │  │       │                           │   │          │
                         │  │  │  QueryEnhancer (abbr/synonyms)    │   │          │
                         │  │  │       │                           │   │          │
                         │  │  │  Embeddings (OpenAI ada-002)      │   │          │
                         │  │  │       │                           │   │          │
                         │  │  │  Retrieval (hybrid RRF)           │   │          │
                         │  │  │       │                           │   │          │
                         │  │  │  Generation (GPT-4 / Claude)      │   │          │
                         │  │  └──────────────────────────────────┘   │          │
                         │  └──────────┬───────────────────────────────┘          │
                         │             │                                           │
                         │   ┌─────────┴──────────┬──────────────────┐           │
                         │   ▼                     ▼                  ▼           │
                         │  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  │
                         │  │  Pinecone  │  │  PostgreSQL  │  │    Redis     │  │
                         │  │ (vectors,  │  │ (users,      │  │ (cache,      │  │
                         │  │  namespaces│  │  history,    │  │  rate-limit, │  │
                         │  │  per tenant│  │  audit logs) │  │  sessions)   │  │
                         │  └────────────┘  └──────────────┘  └──────────────┘  │
                         │                                                         │
                         │  ┌──────────────────────────────────────────────────┐  │
                         │  │               Observability Stack                 │  │
                         │  │  Prometheus + Grafana │ ELK Stack │ Jaeger        │  │
                         │  └──────────────────────────────────────────────────┘  │
                         └─────────────────────────────────────────────────────────┘
```

---

## Component Table

| Component | Technology | Purpose |
|---|---|---|
| API Server | Express 4 / TypeScript | REST endpoints, middleware chain |
| Auth | JWT (jsonwebtoken) + bcrypt | Stateless auth + secure password storage |
| RAG Pipeline | LangChain + custom modules | Orchestrates chunking → embed → retrieve → generate |
| PHI Guard | PIIDetector (regex patterns) | HIPAA-mandated PHI masking before LLM calls |
| Query Enhancer | MedicalQueryEnhancer | Abbreviation expansion + synonym injection |
| Text Chunker | MedicalTextChunker + tiktoken | Semantic chunking with overlap and section detection |
| Vector Store | Pinecone | ANN search over medical knowledge embeddings |
| Relational DB | PostgreSQL 16 + Prisma | Users, query history, document metadata, audit log |
| Cache | Redis 7 (ioredis) | Query cache, embedding cache, rate-limit counters |
| Metrics | prom-client | Prometheus exposition format |
| Logging | Winston + ELK Stack | Structured JSON logs shipped to Elasticsearch |
| Tracing | dd-trace / Jaeger | Distributed request tracing |
| CI/CD | GitHub Actions | Test, build, push, deploy |
| Orchestration | Kubernetes + HPA | Auto-scaling from 3 → 20 replicas |

---

## Data Flow — Query Path

```
1. Client sends POST /api/v1/knowledge/ask  { query: "HTN management" }
2. Auth middleware validates Bearer JWT, attaches req.user
3. RBAC middleware checks user role has QUERY permission
4. Rate-limit middleware checks Redis counter (per user + per IP)
5. PIIDetector scans query — masks any SSN/phone/email before proceeding
6. CacheService checks Redis for cached answer (SHA-256 keyed by userId:query)
   → Cache HIT  → return cached response immediately (< 5 ms)
   → Cache MISS → continue pipeline
7. QueryEnhancer expands abbreviations (HTN → hypertension) + appends synonyms
8. EmbeddingService calls OpenAI text-embedding-ada-002 to generate query vector
9. Retrieval: hybrid search
   a. Vector search: Pinecone ANN top-k neighbours in user's namespace
   b. Keyword search: Postgres full-text search (tsvector)
   c. RRF fusion: reciprocal rank fusion merges both result lists
10. Generation: GPT-4 (or Claude) receives retrieved context + sanitised query
11. Response stored in Redis cache (TTL 1 hour)
12. Query logged to PostgreSQL (user_id, question, answer_summary, latency_ms)
13. Audit event written (PHI access log)
14. Response returned to client { answer, sources, latency_ms }
```

## Data Flow — Ingestion Path

```
1. Admin uploads file via POST /api/v1/knowledge/ingest  (multipart/form-data)
2. File type validated (PDF, DOCX, TXT) + size checked (≤ 50 MB)
3. Text extracted (pdf-parse / mammoth for DOCX)
4. MedicalTextChunker splits text into overlapping chunks (1000 tokens / 200 overlap)
5. Section detection labels chunks with headings (Treatment, Diagnosis, etc.)
6. EmbeddingService batches chunks → OpenAI ada-002 → float32 vectors
7. Vectors + metadata upserted to Pinecone in the tenant's namespace
8. Document record inserted to PostgreSQL (filename, hash, chunk_count, status)
9. BullMQ job marks ingestion complete; admin notified
```

---

## Security Architecture

| Layer | Mechanism |
|---|---|
| Transport | TLS 1.2+ enforced by nginx ingress |
| Authentication | JWT HS256 with 15-min expiry; refresh token rotation |
| Authorisation | RBAC — role checked per route via middleware |
| PHI at rest | AES-256-GCM (ENCRYPTION_KEY from secrets) |
| PHI in transit | Masked by PIIDetector before any external API call |
| Prompt injection | PROMPT_INJECTION_PATTERNS strip jailbreak strings |
| Brute force | Redis-backed failed-login counter, 15-min lockout |
| Rate limiting | Per-IP + per-user sliding window (100 req / 15 min) |
| Container | Non-root user, read-only FS where possible, CAP_DROP ALL |
| Secrets | Kubernetes Secrets (recommended: External Secrets Operator) |

---

## Scalability Strategy

| Axis | Mechanism |
|---|---|
| API horizontal scale | Kubernetes Deployment + HPA (3 → 20 pods, CPU 70% / Mem 80%) |
| Vector search scale | Pinecone managed service — scales independently |
| Database scale | PostgreSQL read replicas for read-heavy workloads |
| Cache scale | Redis Cluster mode or ElastiCache |
| Embedding cache | Redis caches ada-002 vectors (TTL 24 h) |
| Multi-tenancy | Pinecone namespaces — one namespace per organisation |

---

## Failure Scenarios

| Scenario | Behaviour | Recovery |
|---|---|---|
| Pinecone unavailable | Returns 503 with retry-after header | Automatic retry with exponential backoff |
| PostgreSQL down | /health/ready returns 503 — K8s stops routing traffic | Pod restarts; connection pool reconnects |
| Redis down | Cache disabled — requests served without caching; rate-limit fails open | ioredis retryStrategy reconnects automatically |
| OpenAI rate-limited | 429 propagated to client with Retry-After | Client retries; exponential backoff in SDK |
| Single pod crash | HPA maintains minimum 3 replicas; rolling update maxUnavailable 0 | K8s restarts failed pod; traffic shifted to healthy pods |
| Deployment failure | CD pipeline rollback step restores previous ReplicaSet | kubectl rollout undo automatically triggered |
