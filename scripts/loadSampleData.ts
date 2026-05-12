/**
 * loadSampleData.ts
 *
 * Authenticates as the admin user and POSTs every *.txt file in sample_data/
 * to the /api/v1/knowledge/ingest endpoint using multipart/form-data.
 *
 * Usage:
 *   npm run load:sample
 *   # or
 *   ts-node scripts/loadSampleData.ts
 *
 * Environment variables (reads from .env automatically):
 *   BASE_URL        — API base URL (default: http://localhost:3000)
 *   ADMIN_EMAIL     — Admin user email
 *   ADMIN_PASSWORD  — Admin user password
 */

import * as path from 'path';
import * as fs from 'fs';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import * as dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL    = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@hospital.org';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD ?? 'AdminPassword123!';
const SAMPLE_DIR  = path.resolve(__dirname, '..', 'sample_data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authenticate(client: AxiosInstance): Promise<string> {
  console.log(`[auth] Logging in as ${ADMIN_EMAIL}...`);

  const res = await client.post('/api/v1/auth/login', {
    username: ADMIN_EMAIL,
    password: ADMIN_PASS,
  });

  const token: string = res.data.data.access_token;
  console.log('[auth] Login successful.');
  return token;
}

async function ingestFile(
  client: AxiosInstance,
  token: string,
  filePath: string
): Promise<void> {
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename,
    contentType: 'text/plain',
  });
  form.append('namespace', 'default');

  console.log(`[ingest] Uploading: ${filename}`);

  const res = await client.post('/api/v1/knowledge/ingest', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  console.log(
    `[ingest] ✓ ${filename} — documentId: ${res.data.data.documentId} | status: ${res.data.data.status}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== RAG Healthcare Sample Data Loader ===');
  console.log(`Target API: ${BASE_URL}`);
  console.log(`Sample data directory: ${SAMPLE_DIR}`);
  console.log('');

  // Verify sample_data directory exists
  if (!fs.existsSync(SAMPLE_DIR)) {
    console.error(`[error] Directory not found: ${SAMPLE_DIR}`);
    process.exit(1);
  }

  // Collect .txt files
  const files = fs
    .readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => path.join(SAMPLE_DIR, f));

  if (files.length === 0) {
    console.warn('[warn] No .txt files found in sample_data/');
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to ingest: ${files.map(path.basename).join(', ')}`);
  console.log('');

  // Create axios client
  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 120_000,  // 2 minutes — ingestion can be slow for large files
  });

  // Authenticate
  const token = await authenticate(client);
  console.log('');

  // Ingest each file sequentially to avoid rate-limiting
  let successCount = 0;
  let failCount = 0;

  for (const filePath of files) {
    try {
      await ingestFile(client, token, filePath);
      successCount++;
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status ?? 'unknown'} — ${JSON.stringify(err.response?.data)}`
        : (err as Error).message;
      console.error(`[error] Failed to ingest ${path.basename(filePath)}: ${msg}`);
      failCount++;
    }

    // Short pause between uploads to be polite to the API
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('');
  console.log(`=== Done. ${successCount} succeeded, ${failCount} failed. ===`);

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[fatal]', err.message ?? err);
  process.exit(1);
});
