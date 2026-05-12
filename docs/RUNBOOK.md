# Operations Runbook

## Alert Response Procedures

### HighQueryLatency (p95 > 2 s for 2 min) — Warning

**Immediate checks:**
```bash
# Check running pod count
kubectl get pods -n healthcare-rag -l app=rag-api

# Check HPA status
kubectl describe hpa rag-api-hpa -n healthcare-rag

# View recent slow queries in Kibana
# Query: service:"rag-healthcare-assistant" AND latencyMs:>2000

# Check Pinecone latency via Prometheus
# promql: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="rag-api"}[5m]))
```

**Remediation:**
1. If HPA is at max replicas → scale Pinecone index or enable query result caching.
2. If cache hit rate < 40% → warm the cache or increase Redis TTL.
3. If OpenAI is slow → check OpenAI status page; consider switching to Anthropic.

---

### CriticalQueryLatency (p95 > 5 s for 1 min) — Critical

**Page on-call engineer immediately.**

```bash
# Force a pod rollout to clear any stuck requests
kubectl rollout restart deployment/rag-api -n healthcare-rag

# Disable AI generation as a last resort (return cached only)
kubectl set env deployment/rag-api ENABLE_GENERATION=false -n healthcare-rag

# Restore generation once latency stabilises
kubectl set env deployment/rag-api ENABLE_GENERATION=true -n healthcare-rag
```

---

### HighErrorRate (5xx > 5% for 2 min) — Warning

```bash
# Check pod logs for exceptions
kubectl logs -l app=rag-api -n healthcare-rag --tail=200 | grep '"level":"error"'

# Kibana query for 5xx errors
# Query: service:"rag-healthcare-assistant" AND level:error AND http.status_code:>=500

# Check recent deployment
kubectl rollout history deployment/rag-api -n healthcare-rag
```

**If a bad deployment caused the spike:**
```bash
kubectl rollout undo deployment/rag-api -n healthcare-rag
kubectl rollout status deployment/rag-api -n healthcare-rag --timeout=120s
```

---

### DatabaseDown (PostgreSQL target down 1 min) — Critical

```bash
# Check StatefulSet pod
kubectl get pod postgres-0 -n healthcare-rag

# View PostgreSQL logs
kubectl logs postgres-0 -n healthcare-rag --tail=100

# Attempt connection test
kubectl exec -it postgres-0 -n healthcare-rag -- \
  pg_isready -U raguser -d ragdb

# Restart if stuck
kubectl delete pod postgres-0 -n healthcare-rag
# StatefulSet will recreate it automatically
```

---

### RedisDown (Redis target down 1 min) — Warning

```bash
# Check Redis pod
kubectl get pod redis-0 -n healthcare-rag
kubectl logs redis-0 -n healthcare-rag --tail=50

# Test connectivity
kubectl exec -it redis-0 -n healthcare-rag -- redis-cli ping

# Restart if needed (cache is non-persistent for query cache — safe to restart)
kubectl delete pod redis-0 -n healthcare-rag
```

---

### APIDown (rag-api target down 1 min) — Critical

```bash
# Check all API pods
kubectl get pods -n healthcare-rag -l app=rag-api

# Check deployment events
kubectl describe deployment rag-api -n healthcare-rag

# Check ingress
kubectl describe ingress rag-api-ingress -n healthcare-rag

# Force rollout
kubectl rollout restart deployment/rag-api -n healthcare-rag
```

---

## Scaling Operations

### Manual scale-up during a known high-traffic event

```bash
kubectl scale deployment/rag-api --replicas=10 -n healthcare-rag
```

### Temporarily pause HPA (e.g., during maintenance)

```bash
kubectl annotate hpa rag-api-hpa \
  autoscaling.alpha.kubernetes.io/current-metrics=null \
  -n healthcare-rag
```

### Re-enable HPA

```bash
kubectl annotate hpa rag-api-hpa \
  autoscaling.alpha.kubernetes.io/current-metrics- \
  -n healthcare-rag
```

---

## Triggering a Re-index

Re-indexing is needed when:
- New documents are uploaded but not appearing in search results.
- The Pinecone index was corrupted or accidentally deleted.
- The embedding model has been changed and all chunks need re-embedding.

```bash
# Via API (requires Admin JWT)
curl -X POST https://api.healthcare.example.com/api/v1/admin/reindex \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace": "default", "confirm": true}'

# Monitor job progress (check application logs)
kubectl logs -l app=rag-api -n healthcare-rag -f | grep '"action":"reindex"'
```

---

## Log Queries (Elasticsearch / Kibana)

### Find all errors in the last hour
```
service:"rag-healthcare-assistant" AND level:error AND @timestamp:[now-1h TO now]
```

### Find slow queries (> 3 seconds)
```
service:"rag-healthcare-assistant" AND action:"rag_query" AND latencyMs:>3000
```

### Find PHI access events (audit trail)
```
service:"rag-healthcare-assistant" AND action:"phi_access" AND @timestamp:[now-24h TO now]
```

### Find failed login attempts
```
service:"rag-healthcare-assistant" AND action:"login_failed" AND @timestamp:[now-1h TO now]
```

### Kibana Dashboard URL
`http://kibana.healthcare-rag.svc.cluster.local:5601/app/discover`

---

## HIPAA Incident Response

If a PHI breach is suspected:

1. **Immediately notify** the HIPAA Privacy Officer and CISO.
2. **Preserve evidence** — do NOT restart pods or clear logs until forensics are complete:
   ```bash
   # Take a log snapshot
   kubectl logs -l app=rag-api -n healthcare-rag --since=24h > /tmp/api-logs-$(date +%Y%m%d).txt
   ```
3. **Identify affected records** — query the audit log index in Kibana:
   ```
   service:"rag-healthcare-assistant" AND (level:warn OR level:error)
   AND message:"PHI" AND @timestamp:[<incident_start> TO <incident_end>]
   ```
4. **Isolate if necessary** — if active exfiltration is suspected, scale API to 0:
   ```bash
   kubectl scale deployment/rag-api --replicas=0 -n healthcare-rag
   ```
5. **Document** all actions taken with timestamps for the breach notification report.
6. **Notify affected individuals** within 60 days per HIPAA Breach Notification Rule.

---

## Performance Tuning

### Check Pinecone index stats
```bash
curl -X GET "https://controller.<environment>.pinecone.io/databases/healthcare-knowledge" \
  -H "Api-Key: $PINECONE_API_KEY"
```

### Check Redis cache hit rate
```bash
kubectl exec redis-0 -n healthcare-rag -- redis-cli info stats | grep keyspace_hits
kubectl exec redis-0 -n healthcare-rag -- redis-cli info stats | grep keyspace_misses
# Hit rate = hits / (hits + misses)
```

### Check PostgreSQL slow queries
```bash
kubectl exec postgres-0 -n healthcare-rag -- \
  psql -U raguser -d ragdb -c \
  "SELECT query, mean_exec_time, calls FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

### Prometheus queries for performance review

**p95 query latency:**
```
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="rag-api",route="/api/v1/knowledge/ask"}[5m]))
```

**Cache hit rate:**
```
rate(cache_hits_total{job="rag-api"}[5m]) / (rate(cache_hits_total{job="rag-api"}[5m]) + rate(cache_misses_total{job="rag-api"}[5m]))
```

**Request rate:**
```
rate(http_requests_total{job="rag-api"}[1m])
```
