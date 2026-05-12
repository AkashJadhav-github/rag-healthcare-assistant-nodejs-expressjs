# Deployment Guide

## Local Development (docker-compose)

### Prerequisites
- Docker 24+ and Docker Compose v2
- Node.js 20 LTS
- A Pinecone account with an API key
- An OpenAI API key

### Steps

```bash
# 1. Clone and configure
git clone https://github.com/your-org/rag-healthcare-assistant-nodejs-expressjs.git
cd rag-healthcare-assistant-nodejs-expressjs
cp .env.example .env
# Edit .env — set PINECONE_API_KEY, OPENAI_API_KEY, JWT_SECRET, ENCRYPTION_KEY

# 2. Start infrastructure services
docker-compose up -d postgres redis

# 3. Install Node dependencies
npm install

# 4. Generate Prisma client and run migrations
npx prisma generate
npx prisma migrate deploy

# 5. Start the API in development mode
npm run dev
# → API running at http://localhost:3000/api/v1

# 6. (Optional) Load sample documents
npm run load:sample

# 7. (Optional) Start full observability stack
docker-compose up -d elasticsearch kibana prometheus grafana jaeger
```

### Verify

```bash
curl http://localhost:3000/api/v1/health/live
# → { "status": "alive" }

curl http://localhost:3000/api/v1/health
# → { "success": true, "data": { "status": "healthy", ... } }
```

---

## AWS EKS Production Deployment

### Prerequisites
- AWS CLI configured with deployment role
- `kubectl` connected to the target EKS cluster
- ECR repository created: `rag-healthcare-nodejs`
- Kubernetes namespace `healthcare-rag` created (or use `namespace.yaml`)
- Secrets populated in AWS Secrets Manager (or injected via External Secrets Operator)

### Step 1: Build and push Docker image

```bash
# Authenticate with ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS \
    --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build production image
docker build -t rag-healthcare-nodejs:latest .

# Tag and push
docker tag rag-healthcare-nodejs:latest \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com/rag-healthcare-nodejs:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/rag-healthcare-nodejs:latest
```

### Step 2: Apply Kubernetes manifests

```bash
kubectl apply -f kubernetes/namespace.yaml
kubectl apply -f kubernetes/configmap.yaml
kubectl apply -f kubernetes/secrets-example.yaml   # Replace with real secrets
kubectl apply -f kubernetes/statefulset-postgres.yaml
kubectl apply -f kubernetes/statefulset-redis.yaml

# Wait for StatefulSets to be ready
kubectl rollout status statefulset/postgres -n healthcare-rag --timeout=120s
kubectl rollout status statefulset/redis -n healthcare-rag --timeout=60s

# Deploy the API
kubectl apply -f kubernetes/deployment.yaml
kubectl apply -f kubernetes/service.yaml
kubectl apply -f kubernetes/hpa.yaml

# Wait for Deployment rollout
kubectl rollout status deployment/rag-api -n healthcare-rag --timeout=300s
```

### Step 3: Run database migrations in-cluster

```bash
kubectl run prisma-migrate \
  --image=<account-id>.dkr.ecr.us-east-1.amazonaws.com/rag-healthcare-nodejs:latest \
  --restart=Never \
  --namespace=healthcare-rag \
  --env-from=configmap/rag-api-config \
  --env-from=secret/rag-api-secrets \
  -- npx prisma migrate deploy

kubectl logs -f prisma-migrate -n healthcare-rag
kubectl delete pod prisma-migrate -n healthcare-rag
```

### Step 4: Verify deployment

```bash
# Check pod status
kubectl get pods -n healthcare-rag -l app=rag-api

# Check HPA
kubectl get hpa rag-api-hpa -n healthcare-rag

# Test health endpoint
INGRESS_IP=$(kubectl get ingress rag-api-ingress -n healthcare-rag \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl https://$INGRESS_IP/api/v1/health/live
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | Runtime environment |
| `PORT` | No | `3000` | HTTP server port |
| `DATABASE_URL` | Yes | — | PostgreSQL connection URL |
| `REDIS_URL` | Yes | — | Redis connection URL |
| `PINECONE_API_KEY` | Yes | — | Pinecone API key |
| `PINECONE_ENVIRONMENT` | Yes | — | Pinecone environment (e.g. `us-east1-gcp`) |
| `PINECONE_INDEX_NAME` | No | `healthcare-knowledge` | Pinecone index name |
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `OPENAI_LLM_MODEL` | No | `gpt-4` | OpenAI model for generation |
| `OPENAI_EMBEDDING_MODEL` | No | `text-embedding-ada-002` | OpenAI embedding model |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key (if LLM_PROVIDER=anthropic) |
| `LLM_PROVIDER` | No | `openai` | `openai` or `anthropic` |
| `JWT_SECRET` | Yes | — | JWT signing secret (≥ 32 chars) |
| `JWT_EXPIRES_IN` | No | `15m` | Access token expiry |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Refresh token expiry |
| `ENCRYPTION_KEY` | Yes | — | 64 hex chars (AES-256 key) |
| `CHUNK_SIZE` | No | `1000` | Tokens per chunk |
| `CHUNK_OVERLAP` | No | `200` | Overlap tokens between chunks |
| `MAX_RETRIEVAL_DOCS` | No | `5` | Top-k documents for retrieval |
| `SIMILARITY_THRESHOLD` | No | `0.75` | Minimum similarity score |
| `ADMIN_EMAIL` | Yes | — | Bootstrap admin email |
| `ADMIN_PASSWORD` | Yes | — | Bootstrap admin password (≥ 12 chars) |
| `RATE_LIMIT_MAX` | No | `100` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | Rate-limit window (ms) |
| `ELASTICSEARCH_URL` | No | — | Elasticsearch URL for log shipping |

---

## Database Backup Commands

```bash
# Create a timestamped PostgreSQL backup
kubectl exec -n healthcare-rag statefulset/postgres -- \
  pg_dump -U raguser -d ragdb -F c -f /tmp/backup.dump

# Copy backup from pod to local machine
kubectl cp healthcare-rag/postgres-0:/tmp/backup.dump \
  ./backups/ragdb-$(date +%Y%m%d-%H%M%S).dump

# Restore from backup
kubectl exec -n healthcare-rag statefulset/postgres -- \
  pg_restore -U raguser -d ragdb -c /tmp/backup.dump

# Automated S3 backup (run as a CronJob)
# See: kubernetes/cronjob-backup.yaml (add separately)
aws s3 cp ./backups/ragdb-latest.dump \
  s3://your-bucket/rag-backups/ragdb-$(date +%Y%m%d).dump \
  --sse aws:kms
```
