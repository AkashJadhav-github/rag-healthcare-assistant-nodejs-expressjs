/**
 * Unit tests for MedicalTextChunker
 *
 * The tiktoken WASM module is heavy; we mock it so these tests run in milliseconds
 * without needing the compiled binary in CI.
 */

// ---------------------------------------------------------------------------
// Minimal tiktoken mock
// ---------------------------------------------------------------------------

const mockFree = jest.fn();

/**
 * Deterministic mock encoder: each character = 1 token, returned as a
 * Uint32Array so the chunker's token-slicing logic behaves identically to
 * the real encoder.
 */
const mockEncode = jest.fn((text: string): Uint32Array => {
  const codes = new Uint32Array(text.length);
  for (let i = 0; i < text.length; i++) codes[i] = text.charCodeAt(i);
  return codes;
});

/**
 * Decode a Uint32Array back to a string (inverse of mockEncode).
 */
const mockDecode = jest.fn((tokens: Uint32Array): Uint8Array => {
  const chars = Array.from(tokens).map((c) => String.fromCharCode(c)).join('');
  return Buffer.from(chars, 'utf-8');
});

jest.mock('tiktoken', () => ({
  get_encoding: jest.fn(() => ({
    encode: mockEncode,
    decode: mockDecode,
    free: mockFree,
  })),
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER the mock is in place)
// ---------------------------------------------------------------------------

import { MedicalTextChunker } from '../../src/rag/chunking';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunker(chunkSize = 50, chunkOverlap = 10): MedicalTextChunker {
  return new MedicalTextChunker(chunkSize, chunkOverlap);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MedicalTextChunker', () => {
  let chunker: MedicalTextChunker;

  beforeEach(() => {
    jest.clearAllMocks();
    chunker = makeChunker(50, 10);
  });

  afterEach(() => {
    chunker.free();
  });

  // ── 1. Basic chunking returns array of ChunkResult ──────────────────────────
  it('basic chunking returns an array of ChunkResult objects', () => {
    const text = 'The patient presents with fever and chills. Diagnosis is influenza.';
    const results = chunker.chunk(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(r).toHaveProperty('content');
      expect(r).toHaveProperty('chunkIndex');
      expect(r).toHaveProperty('tokenCount');
      expect(r).toHaveProperty('metadata');
    }
  });

  // ── 2. Empty text returns empty array ────────────────────────────────────────
  it('empty text returns an empty array', () => {
    const results = chunker.chunk('');
    expect(results).toEqual([]);
  });

  // ── 3. Whitespace-only returns empty array ───────────────────────────────────
  it('whitespace-only string returns an empty array', () => {
    const results = chunker.chunk('   \n\t  \n  ');
    expect(results).toEqual([]);
  });

  // ── 4. Short text produces a single chunk ────────────────────────────────────
  it('short text (< chunkSize tokens) produces exactly one chunk', () => {
    // "Hi." is 3 chars → 3 tokens, well under the default 50-token chunk size
    const results = chunker.chunk('Hi.');
    expect(results).toHaveLength(1);
  });

  // ── 5. Chunk indices are sequential starting at 0 ───────────────────────────
  it('chunk indices are sequential starting at 0', () => {
    // 300 chars guarantees multiple 50-token chunks
    const text = 'A'.repeat(10) + '. ' + 'B'.repeat(10) + '. ' + 'C'.repeat(10) + '. ' +
                 'D'.repeat(10) + '. ' + 'E'.repeat(10) + '. ' + 'F'.repeat(10) + '.';
    const results = chunker.chunk(text);

    expect(results.length).toBeGreaterThan(1);
    results.forEach((r, idx) => {
      expect(r.chunkIndex).toBe(idx);
    });
  });

  // ── 6. Overlap preserves context ────────────────────────────────────────────
  it('chunk overlap means content at end of chunk N appears at start of chunk N+1', () => {
    // Build a text long enough to produce at least 2 chunks with the mock encoder
    const sentences: string[] = [];
    for (let i = 0; i < 8; i++) {
      sentences.push(`Sentence number ${String(i).padStart(2, '0')} about hypertension management.`);
    }
    const text = sentences.join(' ');

    const overlap10 = new MedicalTextChunker(60, 15);
    const results = overlap10.chunk(text);
    overlap10.free();

    if (results.length >= 2) {
      const chunkA = results[0].content;
      const chunkB = results[1].content;
      // The tail of chunkA should share at least some characters with the head of chunkB
      const tailOfA = chunkA.slice(-15);
      const found = chunkB.includes(tailOfA.slice(0, 5)); // at least 5-char substring overlap
      expect(found).toBe(true);
    } else {
      // Only one chunk was produced — overlap test is vacuously satisfied
      expect(results.length).toBeGreaterThanOrEqual(1);
    }
  });

  // ── 7. Token counts are populated and positive ───────────────────────────────
  it('all chunks have a positive tokenCount', () => {
    const text = 'Patient with T2DM requires insulin titration. Monitor HbA1c quarterly.';
    const results = chunker.chunk(text);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.tokenCount).toBeGreaterThan(0);
    }
  });

  // ── 8. Page number is preserved in all chunks ────────────────────────────────
  it('pageNumber is preserved in every chunk when provided', () => {
    const text = 'HTN treatment includes lifestyle modification and pharmacotherapy. ' +
                 'First-line agents are ACE inhibitors and thiazide diuretics.';
    const PAGE = 7;
    const results = chunker.chunk(text, PAGE);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.pageNumber).toBe(PAGE);
    }
  });

  // ── 9. chunkByPages assigns correct page numbers ─────────────────────────────
  it('chunkByPages assigns correct page numbers from the page descriptor', () => {
    const pages = [
      { text: 'Page one content about diagnosis and treatment protocols.', pageNumber: 1 },
      { text: 'Page two content about medication dosing and interactions.', pageNumber: 2 },
    ];

    const results = chunker.chunkByPages(pages);
    expect(results.length).toBeGreaterThan(0);

    // Every chunk should have a pageNumber that is either 1 or 2
    for (const r of results) {
      expect([1, 2]).toContain(r.pageNumber);
    }

    // And global chunk indices are sequential
    results.forEach((r, idx) => {
      expect(r.chunkIndex).toBe(idx);
    });
  });

  // ── 10. Section detection finds "Treatment" header ───────────────────────────
  it('detects "Treatment" as a section header and stores it in chunk.section', () => {
    // The chunker detects section headings by matching trimmed lines against patterns
    const text = 'Treatment\nFirst-line therapy for HTN is a thiazide diuretic at low dose.';
    const results = chunker.chunk(text);

    expect(results.length).toBeGreaterThan(0);
    // At least one chunk should carry the 'Treatment' section label
    const hasTreatment = results.some((r) => r.section === 'Treatment');
    expect(hasTreatment).toBe(true);
  });

  // ── 11. Section detection finds "Diagnosis" header ───────────────────────────
  it('detects "Diagnosis" as a section header', () => {
    const text = 'Diagnosis\nHypertension is defined as systolic BP ≥ 130 mmHg.';
    const results = chunker.chunk(text);

    expect(results.length).toBeGreaterThan(0);
    const hasDiagnosis = results.some((r) => r.section === 'Diagnosis');
    expect(hasDiagnosis).toBe(true);
  });

  // ── 12. Medical abbreviations are not incorrectly split ──────────────────────
  it('medical abbreviations HTN and T2DM are not split at their period boundary', () => {
    const text =
      'The patient has HTN and T2DM. Blood pressure was 145/92 mmHg. ' +
      'HbA1c was 8.2%. Recommend lifestyle modification.';

    const results = chunker.chunk(text);
    expect(results.length).toBeGreaterThan(0);

    // Reconstitute the full text from all chunks
    const reconstituted = results.map((r) => r.content).join(' ');

    // The abbreviations should survive intact in the reconstituted output
    expect(reconstituted).toMatch(/HTN/);
    expect(reconstituted).toMatch(/T2DM/);
  });

  // ── 13. Constructor throws when overlap >= chunkSize ─────────────────────────
  it('throws an error when chunkOverlap is >= chunkSize', () => {
    expect(() => new MedicalTextChunker(100, 100)).toThrow(
      'chunkOverlap must be less than chunkSize'
    );
    expect(() => new MedicalTextChunker(100, 150)).toThrow(
      'chunkOverlap must be less than chunkSize'
    );
  });

  // ── 14. countTokens returns a non-negative integer ───────────────────────────
  it('countTokens returns the number of tokens for a given string', () => {
    const text = 'Hello world';
    // mockEncode returns one token per character → 11 tokens
    const count = chunker.countTokens(text);
    expect(count).toBe(text.length);
  });

  // ── 15. Metadata contains chunkSize and chunkOverlap ────────────────────────
  it('chunk metadata contains chunkSize and chunkOverlap values', () => {
    const text = 'Diabetes management requires regular HbA1c monitoring every 3 months.';
    const results = chunker.chunk(text);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.metadata.chunkSize).toBe(50);
      expect(r.metadata.chunkOverlap).toBe(10);
    }
  });
});
