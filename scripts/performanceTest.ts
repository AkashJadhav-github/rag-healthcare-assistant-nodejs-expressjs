/**
 * performanceTest.ts
 *
 * Async load test for the RAG Healthcare API.
 * Authenticates as admin, then fires TOTAL_REQUESTS queries with
 * CONCURRENT_USERS parallelism using a Promise pool.
 * Reports p50 / p95 / p99 latency, throughput, and success rate.
 *
 * Usage:
 *   npm run perf:test
 *   # or
 *   TOTAL_REQUESTS=500 CONCURRENT_USERS=20 ts-node scripts/performanceTest.ts
 *
 * Environment variables:
 *   BASE_URL          — API base URL (default: http://localhost:3000)
 *   ADMIN_EMAIL       — Admin email
 *   ADMIN_PASSWORD    — Admin password
 *   TOTAL_REQUESTS    — Number of queries to send (default: 100)
 *   CONCURRENT_USERS  — Concurrent workers (default: 10)
 */

import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL         = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL ?? 'admin@hospital.org';
const ADMIN_PASS       = process.env.ADMIN_PASSWORD ?? 'AdminPassword123!';
const TOTAL_REQUESTS   = parseInt(process.env.TOTAL_REQUESTS ?? '100', 10);
const CONCURRENT_USERS = parseInt(process.env.CONCURRENT_USERS ?? '10', 10);

// Sample clinical queries to rotate through
const SAMPLE_QUERIES: string[] = [
  'What is the first-line treatment for hypertension?',
  'How should blood pressure targets be set for diabetic patients?',
  'What are the main drug interactions for metformin?',
  'Explain the staging system for chronic kidney disease.',
  'What are the JNC 8 guidelines for hypertension management?',
  'How is T2DM diagnosed according to ADA criteria?',
  'What is the mechanism of action of ACE inhibitors?',
  'Describe the management of hypertensive urgency vs emergency.',
  'What lifestyle changes are recommended for stage 1 hypertension?',
  'How does RAAS blockade affect renal outcomes in CKD?',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueryResult {
  latencyMs: number;
  success: boolean;
  statusCode?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authenticate(client: AxiosInstance): Promise<string> {
  const res = await client.post('/api/v1/auth/login', {
    username: ADMIN_EMAIL,
    password: ADMIN_PASS,
  });
  return res.data.data.access_token;
}

async function runQuery(
  client: AxiosInstance,
  token: string,
  query: string
): Promise<QueryResult> {
  const start = Date.now();
  try {
    const res = await client.post(
      '/api/v1/knowledge/ask',
      { query },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return {
      latencyMs: Date.now() - start,
      success: res.status === 200,
      statusCode: res.status,
    };
  } catch (err) {
    return {
      latencyMs: Date.now() - start,
      success: false,
      statusCode: axios.isAxiosError(err) ? err.response?.status : undefined,
      error: axios.isAxiosError(err)
        ? `HTTP ${err.response?.status ?? 'network_error'}`
        : (err as Error).message,
    };
  }
}

/**
 * Run tasks with bounded concurrency (Promise pool).
 * @param tasks     Array of zero-argument async functions
 * @param concurrency  Max in-flight tasks at once
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const taskIndex = index++;
      const result = await tasks[taskIndex]();
      results[taskIndex] = result;
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

function percentile(sortedLatencies: number[], p: number): number {
  if (sortedLatencies.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedLatencies.length) - 1;
  return sortedLatencies[Math.max(0, idx)];
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== RAG Healthcare Performance Test ===');
  console.log(`API:         ${BASE_URL}`);
  console.log(`Total reqs:  ${TOTAL_REQUESTS}`);
  console.log(`Concurrency: ${CONCURRENT_USERS}`);
  console.log('');

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30_000,
  });

  // Authenticate
  let token: string;
  try {
    console.log('Authenticating...');
    token = await authenticate(client);
    console.log('Authentication successful.');
  } catch (err) {
    console.error('Authentication failed:', (err as Error).message);
    process.exit(1);
  }

  // Build task list
  const tasks = Array.from({ length: TOTAL_REQUESTS }, (_, i) => {
    const query = SAMPLE_QUERIES[i % SAMPLE_QUERIES.length];
    return () => runQuery(client, token, query);
  });

  // Run load test
  console.log(`\nStarting load test: ${TOTAL_REQUESTS} requests at ${CONCURRENT_USERS} concurrency...`);
  const wallStart = Date.now();

  const results = await runWithConcurrency(tasks, CONCURRENT_USERS);

  const wallElapsed = Date.now() - wallStart;

  // Analyse results
  const successes = results.filter((r) => r.success);
  const failures  = results.filter((r) => !r.success);

  const latencies = successes.map((r) => r.latencyMs).sort((a, b) => a - b);

  const p50  = percentile(latencies, 50);
  const p95  = percentile(latencies, 95);
  const p99  = percentile(latencies, 99);
  const avg  = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  const min  = latencies[0] ?? 0;
  const max  = latencies[latencies.length - 1] ?? 0;

  const throughput = (TOTAL_REQUESTS / (wallElapsed / 1000)).toFixed(2);
  const successRate = ((successes.length / TOTAL_REQUESTS) * 100).toFixed(1);

  // Report
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║         PERFORMANCE RESULTS           ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Total requests:   ${String(TOTAL_REQUESTS).padEnd(17)}║`);
  console.log(`║  Successful:       ${String(successes.length).padEnd(17)}║`);
  console.log(`║  Failed:           ${String(failures.length).padEnd(17)}║`);
  console.log(`║  Success rate:     ${(successRate + '%').padEnd(17)}║`);
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Wall time:        ${formatMs(wallElapsed).padEnd(17)}║`);
  console.log(`║  Throughput:       ${(throughput + ' req/s').padEnd(17)}║`);
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Latency (ms) — successful requests  ║`);
  console.log(`║  Min:              ${formatMs(min).padEnd(17)}║`);
  console.log(`║  Average:          ${formatMs(avg).padEnd(17)}║`);
  console.log(`║  p50:              ${formatMs(p50).padEnd(17)}║`);
  console.log(`║  p95:              ${formatMs(p95).padEnd(17)}║`);
  console.log(`║  p99:              ${formatMs(p99).padEnd(17)}║`);
  console.log(`║  Max:              ${formatMs(max).padEnd(17)}║`);
  console.log('╚══════════════════════════════════════╝');

  // Performance target assessment
  console.log('\nPerformance target assessment:');
  console.log(`  p50 < 800ms:  ${p50 < 800 ? 'PASS' : 'FAIL'} (${formatMs(p50)})`);
  console.log(`  p95 < 2s:     ${p95 < 2000 ? 'PASS' : 'FAIL'} (${formatMs(p95)})`);
  console.log(`  p99 < 5s:     ${p99 < 5000 ? 'PASS' : 'FAIL'} (${formatMs(p99)})`);
  console.log(`  Success > 99%: ${parseFloat(successRate) >= 99 ? 'PASS' : 'FAIL'} (${successRate}%)`);

  if (failures.length > 0) {
    console.log('\nFailure breakdown:');
    const byCode: Record<string, number> = {};
    for (const f of failures) {
      const key = f.statusCode ? `HTTP ${f.statusCode}` : (f.error ?? 'unknown');
      byCode[key] = (byCode[key] ?? 0) + 1;
    }
    for (const [code, count] of Object.entries(byCode)) {
      console.log(`  ${code}: ${count}`);
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[fatal]', err.message ?? err);
  process.exit(1);
});
