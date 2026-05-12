import { get_encoding, TiktokenEncoding } from 'tiktoken';
import { createLogger } from '../utils/logger';

const log = createLogger('MedicalTextChunker');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ChunkResult {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  pageNumber?: number;
  section?: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

const SECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Abstract',               pattern: /^\s*abstract\s*$/i },
  { label: 'Introduction',           pattern: /^\s*introduction\s*$/i },
  { label: 'Background',             pattern: /^\s*background\s*$/i },
  { label: 'Methods',                pattern: /^\s*(methods?|methodology|materials\s+and\s+methods?)\s*$/i },
  { label: 'Results',                pattern: /^\s*results?\s*$/i },
  { label: 'Discussion',             pattern: /^\s*discussion\s*$/i },
  { label: 'Conclusion',             pattern: /^\s*conclusions?\s*$/i },
  { label: 'References',             pattern: /^\s*references?\s*$/i },
  { label: 'Diagnosis',              pattern: /^\s*diagnosis\s*$/i },
  { label: 'Treatment',              pattern: /^\s*(treatment|therapy|management\s+and\s+treatment)\s*$/i },
  { label: 'Guidelines',             pattern: /^\s*guidelines?\s*$/i },
  { label: 'Protocol',               pattern: /^\s*protocols?\s*$/i },
  { label: 'Clinical Presentation',  pattern: /^\s*clinical\s+presentation\s*$/i },
  { label: 'Management',             pattern: /^\s*management\s*$/i },
  { label: 'Pathophysiology',        pattern: /^\s*pathophysiology\s*$/i },
  { label: 'Epidemiology',           pattern: /^\s*epidemiology\s*$/i },
];

/**
 * Medical abbreviations that should NOT be treated as sentence-ending periods.
 * Expanded to cover the most common clinical / academic abbreviations.
 */
const MEDICAL_ABBREVIATIONS = new Set([
  // Titles / honorifics
  'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Rev', 'Lt', 'Sgt', 'Cpl',
  // Latin / common academic
  'vs', 'etc', 'eg', 'ie', 'al', 'et', 'fig', 'Fig',
  // Clinical measurements
  'mg', 'mcg', 'kg', 'lb', 'mL', 'dL', 'mmHg', 'bpm', 'IU', 'mEq',
  // Dosing / pharmacology
  'q', 'qd', 'bid', 'tid', 'qid', 'prn', 'po', 'IV', 'IM', 'SC', 'SQ',
  'SL', 'PR', 'OD', 'OS', 'OU', 'AU', 'AS', 'AD',
  // Laboratory / diagnostic
  'WBC', 'RBC', 'Hgb', 'Hct', 'MCV', 'MCH', 'MCHC', 'plt', 'INR',
  'PT', 'PTT', 'BUN', 'Cr', 'Na', 'K', 'Cl', 'HCO',
  // General medical
  'approx', 'est', 'avg', 'max', 'min', 'std', 'ref',
  // Time
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  // Anatomical
  'ant', 'post', 'lat', 'med', 'sup', 'inf',
  // Numeric ordinals ending with period
  'No', 'Vol', 'pp', 'ed',
]);

// ---------------------------------------------------------------------------
// MedicalTextChunker
// ---------------------------------------------------------------------------

export class MedicalTextChunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly enc: ReturnType<typeof get_encoding>;

  constructor(chunkSize = 1000, chunkOverlap = 200) {
    if (chunkOverlap >= chunkSize) {
      throw new Error('chunkOverlap must be less than chunkSize');
    }
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;

    try {
      this.enc = get_encoding('cl100k_base' as TiktokenEncoding);
    } catch (err) {
      log.error('Failed to load tiktoken encoding', { error: (err as Error).message });
      throw err;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Chunk a plain text string. Optionally tag every chunk with a page number.
   */
  chunk(text: string, pageNumber?: number): ChunkResult[] {
    const sentences = this.splitIntoSentences(text);
    return this.buildChunks(sentences, pageNumber);
  }

  /**
   * Chunk multiple pages and return a flat array of ChunkResults with correct
   * page-number attribution.
   */
  chunkByPages(pages: Array<{ text: string; pageNumber: number }>): ChunkResult[] {
    const results: ChunkResult[] = [];
    let globalIndex = 0;

    for (const page of pages) {
      const pageChunks = this.chunk(page.text, page.pageNumber);
      for (const c of pageChunks) {
        results.push({ ...c, chunkIndex: globalIndex++ });
      }
    }

    return results;
  }

  // ── Sentence splitting ─────────────────────────────────────────────────────

  /**
   * Split text on sentence boundaries while respecting medical abbreviations.
   *
   * Strategy:
   *  1. Replace known abbreviation periods with a placeholder so they are
   *     not split on.
   *  2. Split on sentence-ending punctuation (. ! ?) followed by whitespace
   *     and an uppercase letter (or end-of-string).
   *  3. Restore placeholders.
   */
  private splitIntoSentences(text: string): string[] {
    // Normalise whitespace
    let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Protect known abbreviations: "Dr. Smith" → "Dr<ABBR>Smith"
    const PLACEHOLDER = '\x00ABBR\x00';
    for (const abbr of MEDICAL_ABBREVIATIONS) {
      // Word-boundary before abbr, period, space (not start of new sentence)
      const re = new RegExp(`\\b(${escapeRegex(abbr)})\\.\\s`, 'g');
      normalized = normalized.replace(re, `$1${PLACEHOLDER}`);
    }

    // Also protect numeric lists: "1. First item" — single digit/letter followed by period+space
    normalized = normalized.replace(/(\b\d{1,2})\.\s/g, `$1${PLACEHOLDER}`);

    // Split on sentence-terminating punctuation
    // Matches: ". " or "! " or "? " followed by uppercase OR end-of-string / newline
    const rawSentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z\n])|(?<=[.!?])\n+|\n+(?=[A-Z])/);

    // Restore placeholders and trim
    const sentences = rawSentences
      .map((s) => s.replace(new RegExp(escapeRegex(PLACEHOLDER), 'g'), '. ').trim())
      .filter((s) => s.length > 0);

    return sentences;
  }

  // ── Chunk assembly ─────────────────────────────────────────────────────────

  private buildChunks(sentences: string[], pageNumber?: number): ChunkResult[] {
    const chunks: ChunkResult[] = [];
    let chunkIndex = 0;
    let currentTokens: number[] = [];
    let currentSection: string | undefined;

    const flush = (): void => {
      if (currentTokens.length === 0) return;

      const content = this.enc.decode(new Uint32Array(currentTokens));
      const text = Buffer.from(content).toString('utf-8').trim();
      if (text.length === 0) return;

      chunks.push({
        content: text,
        chunkIndex: chunkIndex++,
        tokenCount: currentTokens.length,
        pageNumber,
        section: currentSection,
        metadata: {
          chunkSize: this.chunkSize,
          chunkOverlap: this.chunkOverlap,
          ...(pageNumber !== undefined ? { pageNumber } : {}),
          ...(currentSection ? { section: currentSection } : {}),
        },
      });
    };

    for (const sentence of sentences) {
      // Detect section headings
      const detectedSection = this.detectSection(sentence);
      if (detectedSection) {
        currentSection = detectedSection;
      }

      const sentenceTokens = Array.from(this.enc.encode(sentence + ' '));

      // If a single sentence is longer than chunkSize, split it hard
      if (sentenceTokens.length > this.chunkSize) {
        flush();
        const subChunks = this.hardSplit(sentenceTokens, pageNumber, currentSection, chunkIndex);
        for (const sc of subChunks) {
          chunks.push({ ...sc, chunkIndex: chunkIndex++ });
        }
        currentTokens = [];
        continue;
      }

      // If adding this sentence would exceed chunkSize, flush first
      if (currentTokens.length + sentenceTokens.length > this.chunkSize) {
        flush();
        // Start next chunk with overlap from the end of the previous chunk
        const overlapStart = Math.max(0, currentTokens.length - this.chunkOverlap);
        currentTokens = currentTokens.slice(overlapStart);
      }

      currentTokens.push(...sentenceTokens);
    }

    // Flush remaining tokens
    flush();

    return chunks;
  }

  /**
   * Hard-split a token array that is wider than chunkSize, producing
   * overlapping sub-chunks. Returns chunks WITHOUT setting chunkIndex
   * (caller assigns it).
   */
  private hardSplit(
    tokens: number[],
    pageNumber?: number,
    section?: string,
    startIndex = 0,
  ): ChunkResult[] {
    const results: ChunkResult[] = [];
    let offset = 0;
    let localIndex = startIndex;

    while (offset < tokens.length) {
      const slice = tokens.slice(offset, offset + this.chunkSize);
      const content = Buffer.from(this.enc.decode(new Uint32Array(slice))).toString('utf-8').trim();

      if (content.length > 0) {
        results.push({
          content,
          chunkIndex: localIndex++,
          tokenCount: slice.length,
          pageNumber,
          section,
          metadata: {
            chunkSize: this.chunkSize,
            chunkOverlap: this.chunkOverlap,
            hardSplit: true,
            ...(pageNumber !== undefined ? { pageNumber } : {}),
            ...(section ? { section } : {}),
          },
        });
      }

      // Advance by (chunkSize - overlap) so next window overlaps correctly
      offset += this.chunkSize - this.chunkOverlap;
    }

    return results;
  }

  // ── Section detection ──────────────────────────────────────────────────────

  private detectSection(sentence: string): string | undefined {
    const trimmed = sentence.trim();
    for (const { label, pattern } of SECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return label;
      }
    }
    return undefined;
  }

  // ── Token counting helper (public for external use) ────────────────────────

  countTokens(text: string): number {
    return this.enc.encode(text).length;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Free the tiktoken WASM instance. Call when the chunker is no longer needed
   * to avoid WebAssembly memory leaks in long-running processes.
   */
  free(): void {
    try {
      this.enc.free();
    } catch {
      // Ignore — may already be freed
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const medicalTextChunker = new MedicalTextChunker();

export default medicalTextChunker;
