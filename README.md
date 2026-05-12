# RAG Healthcare Knowledge Assistant (Node.js / TypeScript / Express)

A production-ready Retrieval-Augmented Generation (RAG) API for healthcare knowledge management,
built on Node.js 20, TypeScript, Express, Pinecone, PostgreSQL, and Redis. Designed with HIPAA
compliance in mind.

---

## Architecture

```
                          ┌─────────────────────────────────────────────┐
                          │            PRODUCTION CLUSTER                 │
                          │                                               │
  ┌──────────┐  HTTPS     │  ┌────────────┐    ┌──────────────────────┐  │
  │  Client  │ ─────────► │  │ Load Bal.  │───►│  Express API (x3)    │  │
  │ Browser/ │            │  │(nginx/ALB) │    │  /api/v1             │  │
  │  Mobile  │            │  └────────────┘    └──────┬───────────────┘  │
  └──────────┘            │                           │                   │
                          │                           ▼                   │
                          │               ┌───────────────────────┐       │
                          │               │    RAG Pipeline        │       │
                          │               │  ┌─────────────────┐  │       │
                          │               │  │  PIIDetector     │  │       │
                          │               │  │  QueryEnhancer   │  │       │
                          │               │  │  MedicalChunker  │  │       │
                          │               │  └─────────────────┘  │       │
                          │               └──────┬────────────────┘       │
                          │                      │                         │
                          │        ┌─────────────┼─────────────┐          │
                          │        ▼             ▼             ▼          │
                          │  ┌──────────┐ ┌──────────┐ ┌──────────┐      │
                          │  │ Pinecone │ │PostgreSQL│ │  Redis   │      │
                          │  │ (Vector) │ │ (Users / │ │ (Cache / │      │
                          │  │          │ │ History) │ │Rate Limit│      │
                          │  └──────────┘ └──────────┘ └──────────┘      │
                          │                                               │
                          │  ┌────────────┐ ┌────────────┐ ┌──────────┐  │
                          │  │ Prometheus │ │ ELK Stack  │ │  Jaeger  │  │
                          │  │ + Grafana  │ │(Logs/Kibana│ │ Tracing  │  │
                          │  └────────────┘ └────────────┘ └──────────┘  │
                          └─────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS |
| Language | TypeScript 5 (strict mode) |
| Framework | Express 4 |
| ORM | Prisma 5 + PostgreSQL 16 |
| Vector DB | Pinecone |
| Cache / Rate-limit | Redis 7 (ioredis) |
| LLM (default) | OpenAI GPT-4 |
| LLM (alternate) | Anthropic Claude 3.5 Sonnet |
| Embeddings | OpenAI text-embedding-ada-002 |
| Auth | JWT (access + refresh) + bcrypt |
| Metrics | prom-client (Prometheus) |
| Logging | Winston + ELK Stack |
| Tracing | Jaeger + dd-trace |
| Tests | Jest + supertest |
| Containers | Docker (multi-stage) + docker-compose |
| Orchestration | Kubernetes (EKS) + HPA |
| CI/CD | GitHub Actions |

---

## Quick Start

**1. Prerequisites:** Node 20+, Docker + Docker Compose, a Pinecone account, OpenAI API key.

**2. Clone and configure:**
```bash
git clone https://github.com/your-org/rag-healthcare-assistant-nodejs-expressjs.git
cd rag-healthcare-assistant-nodejs-expressjs
cp .env.example .env
# Edit .env — fill in PINECONE_API_KEY, OPENAI_API_KEY, JWT_SECRET, ENCRYPTION_KEY
```

**3. Start all infrastructure:**
```bash
docker-compose up -d postgres redis elasticsearch
```

**4. Install, migrate, and seed:**
```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run load:sample   # Loads sample_data/*.txt via the API
```

**5. Start the development server:**
```bash
npm run dev
# API available at http://localhost:3000/api/v1
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/auth/login` | None | Login — returns access + refresh tokens |
| POST | `/api/v1/auth/refresh` | None | Rotate access token using refresh token |
| POST | `/api/v1/auth/logout` | Bearer | Invalidate session |
| GET | `/api/v1/auth/me` | Bearer | Get current user profile |
| POST | `/api/v1/knowledge/ask` | Bearer | Query the RAG knowledge base |
| POST | `/api/v1/knowledge/ingest` | Admin | Upload and ingest a document |
| GET | `/api/v1/knowledge/history` | Bearer | Retrieve query history |
| POST | `/api/v1/admin/reindex` | Admin | Trigger full re-indexing |
| GET | `/api/v1/admin/stats` | Admin | System statistics |
| GET | `/api/v1/health` | None | Full health check (DB + Redis) |
| GET | `/api/v1/health/live` | None | Kubernetes liveness probe |
| GET | `/api/v1/health/ready` | None | Kubernetes readiness probe |
| GET | `/api/v1/health/metrics` | None | Prometheus metrics |

---

## User Roles

| Role | Permissions |
|---|---|
| `ADMIN` | Full access: ingest, reindex, manage users, view stats |
| `PHYSICIAN` | Query knowledge base, view own history |
| `NURSE` | Query knowledge base, view own history |
| `RESEARCHER` | Query knowledge base, view own history |
| `READONLY` | Query knowledge base only |

---

## Running Tests

```bash
# All tests with coverage
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration
```

Coverage thresholds: **Branches 70% | Functions 80% | Lines 80% | Statements 80%**

---

## Performance Targets

| Metric | Target |
|---|---|
| Query latency (p50) | < 800 ms |
| Query latency (p95) | < 2 s |
| Query latency (p99) | < 5 s |
| Ingestion throughput | > 100 pages/min |
| Cache hit rate | > 60% |
| Uptime (SLA) | 99.9% |
| Concurrent users | 500+ |

---

## Security & HIPAA

- **PHI detection and masking** via `PIIDetector` before queries reach the LLM
- **Prompt injection protection** — known jailbreak patterns stripped from all input
- **RBAC** — role-based access control on every route
- **JWT** with short-lived access tokens (15 min) and rotating refresh tokens (7 days)
- **bcrypt** password hashing (12 rounds)
- **Helmet** HTTP security headers on all responses
- **Rate limiting** — per-IP and per-user via Redis sliding window
- **Brute-force lockout** — 5 failed logins triggers a 15-minute account hold
- **AES-256-GCM** encryption for sensitive data at rest
- **TLS** enforced in production via nginx ingress
- **Non-root containers** in Docker and Kubernetes
- **Audit logging** of all PHI access events

---

## Project Structure

```
rag-healthcare-assistant-nodejs-expressjs/
├── src/
│   ├── api/
│   │   ├── controllers/        # auth, knowledge, admin controllers
│   │   └── middleware/         # auth, RBAC, rate-limit, validation, audit
│   ├── config/                 # Zod-validated config from env vars
│   ├── db/
│   │   ├── postgres.ts         # Prisma singleton + health helpers
│   │   └── migrations/         # SQL migration scripts
│   ├── rag/
│   │   ├── chunking.ts         # MedicalTextChunker
│   │   ├── embeddings.ts       # Embedding generation
│   │   ├── generation.ts       # LLM generation (OpenAI / Anthropic)
│   │   ├── ingestion.ts        # Document ingestion pipeline
│   │   ├── piiDetector.ts      # PHI masking (HIPAA)
│   │   ├── pipeline.ts         # End-to-end RAG orchestration
│   │   ├── queryEnhancer.ts    # Medical abbreviation + synonym expansion
│   │   └── retrieval.ts        # Hybrid search (vector + keyword RRF)
│   ├── services/
│   │   ├── cache.service.ts    # Redis CacheService
│   │   └── pinecone.service.ts # Pinecone vector store wrapper
│   └── utils/
│       ├── errors.ts           # Error classes + global error handler
│       ├── logger.ts           # Winston structured logger
│       └── security.ts        # JWT helpers, bcrypt, prompt-injection guard
├── tests/
│   ├── unit/                   # MedicalTextChunker, PIIDetector, QueryEnhancer
│   └── integration/            # Health, Auth supertest suites
├── prisma/
│   └── schema.prisma
├── kubernetes/                 # K8s manifests
├── monitoring/                 # Prometheus, Logstash, alert rules
├── scripts/
│   ├── loadSampleData.ts
│   └── performanceTest.ts
├── sample_data/                # Synthetic medical reference documents
├── docs/                       # Architecture, ADRs, API, Deployment, Runbook
├── .github/workflows/          # CI and CD pipelines
├── Dockerfile                  # Multi-stage production image
├── docker-compose.yml
└── .env.example
```

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Architecture Decision Records](docs/DECISIONS.md)
- [API Reference](docs/API.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Operations Runbook](docs/RUNBOOK.md)
