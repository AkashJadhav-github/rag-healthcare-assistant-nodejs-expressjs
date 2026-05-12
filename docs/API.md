# API Reference

Base URL: `https://api.healthcare.example.com/api/v1`

All authenticated endpoints require:
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

---

## Authentication

### POST /auth/login

Authenticate and receive JWT tokens.

**Request:**
```json
{
  "username": "dr.alice@hospital.org",
  "password": "SecurePassword123!"
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "token_type": "Bearer",
    "expires_in": 900,
    "user": {
      "id": "uuid-here",
      "email": "dr.alice@hospital.org",
      "username": "dr.alice",
      "fullName": "Dr. Alice Chen",
      "role": "PHYSICIAN"
    }
  }
}
```

**Response 401:**
```json
{
  "success": false,
  "error": {
    "code": "AUTH_ERROR",
    "message": "Invalid email or password"
  }
}
```

---

### GET /auth/me

Get the current user's profile. Requires Bearer token.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid-here",
      "email": "dr.alice@hospital.org",
      "username": "dr.alice",
      "fullName": "Dr. Alice Chen",
      "role": "PHYSICIAN",
      "department": "Cardiology",
      "isActive": true,
      "isVerified": true,
      "lastLogin": "2026-05-12T08:30:00.000Z",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  }
}
```

---

## Knowledge

### POST /knowledge/ask

Query the RAG knowledge base. Requires Bearer token.

**Request:**
```json
{
  "query": "What is the first-line treatment for hypertension?",
  "includeHistory": false,
  "maxResults": 5
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "answer": "First-line treatment for hypertension (HTN) includes...",
    "sources": [
      {
        "content": "Thiazide diuretics are recommended as first-line agents...",
        "score": 0.92,
        "pageNumber": 4,
        "section": "Treatment",
        "documentName": "clinical_guidelines.txt"
      }
    ],
    "queryId": "qry-uuid-here",
    "latencyMs": 1240,
    "cached": false
  }
}
```

---

### POST /knowledge/ingest

Upload and ingest a document. Requires Admin role.

**Request:** `multipart/form-data`
- `file`: The document file (PDF, DOCX, or TXT; max 50 MB)
- `namespace`: (optional) Pinecone namespace (defaults to `default`)
- `tags`: (optional) comma-separated tags

**Response 202:**
```json
{
  "success": true,
  "data": {
    "documentId": "doc-uuid-here",
    "filename": "hypertension_guidelines_2026.pdf",
    "status": "processing",
    "chunksQueued": 0,
    "message": "Document queued for processing"
  }
}
```

---

### GET /knowledge/history

Retrieve the authenticated user's query history.

**Query params:** `page` (default 1), `limit` (default 20, max 100)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "history": [
      {
        "id": "qry-uuid",
        "query": "What is the treatment for T2DM?",
        "answerSummary": "Treatment includes metformin as first-line...",
        "latencyMs": 980,
        "createdAt": "2026-05-11T14:22:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "totalPages": 3
    }
  }
}
```

---

## Admin

### POST /admin/reindex

Trigger a full re-indexing of all documents. Requires Admin role.

**Request:**
```json
{
  "namespace": "default",
  "confirm": true
}
```

**Response 202:**
```json
{
  "success": true,
  "data": {
    "jobId": "job-uuid-here",
    "status": "queued",
    "message": "Re-indexing job queued successfully"
  }
}
```

---

### GET /admin/stats

System statistics. Requires Admin role.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "users": { "total": 142, "active": 138 },
    "documents": { "total": 27, "totalChunks": 4821 },
    "queries": {
      "total": 18920,
      "last24h": 342,
      "avgLatencyMs": 1150,
      "cacheHitRate": 0.64
    },
    "pinecone": {
      "vectorCount": 4821,
      "namespace": "default"
    }
  }
}
```

---

## Health

### GET /health

Full health check with component status.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "1.0.0",
    "components": {
      "database": { "status": "healthy", "latencyMs": 3 },
      "redis": { "status": "healthy", "latencyMs": 1 }
    },
    "timestamp": "2026-05-12T10:00:00.000Z"
  }
}
```

### GET /health/live

Kubernetes liveness probe.

**Response 200:**
```json
{ "status": "alive" }
```

### GET /health/metrics

Prometheus metrics exposition (text/plain; version=0.0.4).

**Response 200:** Prometheus text format — see prom-client documentation.

---

## Error Codes

| HTTP Status | Code | Description |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid request body or query parameters |
| 401 | `AUTH_ERROR` | Missing, expired, or invalid JWT |
| 403 | `FORBIDDEN_ERROR` | Authenticated but lacking required role |
| 404 | `NOT_FOUND_ERROR` | Resource does not exist |
| 409 | `CONFLICT_ERROR` | Duplicate resource (e.g., email already registered) |
| 429 | `RATE_LIMIT_ERROR` | Too many requests; `retryAfterMs` field included |
| 503 | `SERVICE_UNAVAILABLE_ERROR` | Downstream dependency (Pinecone, DB) unreachable |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected server error |

All error responses follow the shape:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "fields": { "fieldName": ["validation message"] },
    "retryAfterMs": 60000,
    "requestId": "x-request-id-value"
  }
}
```
