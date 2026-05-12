import { createLogger } from '../utils/logger';

const log = createLogger('PIIDetector');

// ---------------------------------------------------------------------------
// Mask tokens — what we replace PHI with in output text
// ---------------------------------------------------------------------------

const MASK = {
  SSN:         '[SSN REDACTED]',
  MRN:         '[MRN REDACTED]',
  PHONE:       '[PHONE REDACTED]',
  EMAIL:       '[EMAIL REDACTED]',
  DATE:        '[DATE REDACTED]',
  ZIP:         '[ZIP REDACTED]',
  IP:          '[IP REDACTED]',
  DOB:         '[DOB REDACTED]',
  NPI:         '[NPI REDACTED]',
  DEA:         '[DEA REDACTED]',
  NAME:        '[NAME REDACTED]',
} as const;

// ---------------------------------------------------------------------------
// PHI pattern definitions
// ---------------------------------------------------------------------------

interface PHIPattern {
  name: keyof typeof MASK;
  /**
   * Pattern used for detection AND replacement.
   * Must use the global (`g`) flag so replaceAll works correctly.
   */
  regex: RegExp;
  mask: string;
}

const PHI_PATTERNS: PHIPattern[] = [
  // ── SSN: 123-45-6789 or 123 45 6789 or 123456789 ────────────────────────
  {
    name: 'SSN',
    regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
    mask: MASK.SSN,
  },

  // ── NPI: 10-digit number prefixed by "NPI" keyword ───────────────────────
  {
    name: 'NPI',
    regex: /\bNPI[:\s#]*\d{10}\b/gi,
    mask: MASK.NPI,
  },

  // ── DEA License: 2 letters + 7 digits (e.g., AB1234563) ─────────────────
  {
    name: 'DEA',
    regex: /\bDEA[:\s#]*[A-Z]{2}\d{7}\b/gi,
    mask: MASK.DEA,
  },

  // ── MRN: "MRN" followed by 6–12 digits ──────────────────────────────────
  {
    name: 'MRN',
    regex: /\b(?:MRN|Medical\s+Record\s+(?:Number|No\.?))[:\s#]*\d{6,12}\b/gi,
    mask: MASK.MRN,
  },

  // ── Standalone 10-digit numbers (catch-all for MRN / patient ID) ─────────
  // Only match if surrounded by word boundaries AND not part of phone number
  {
    name: 'MRN',
    regex: /(?<![+\d(-])\b\d{10}\b(?![)\d-])/g,
    mask: MASK.MRN,
  },

  // ── Phone numbers ────────────────────────────────────────────────────────
  // Covers: +1-800-555-0100, (800) 555-0100, 800.555.0100, 8005550100
  {
    name: 'PHONE',
    regex: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    mask: MASK.PHONE,
  },

  // ── Email addresses ───────────────────────────────────────────────────────
  {
    name: 'EMAIL',
    regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    mask: MASK.EMAIL,
  },

  // ── DOB: explicitly labelled date of birth ───────────────────────────────
  {
    name: 'DOB',
    regex: /\b(?:DOB|Date\s+of\s+Birth|birth(?:day|date)?)[:\s]+\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}/gi,
    mask: MASK.DOB,
  },

  // ── Dates: MM/DD/YYYY, MM-DD-YYYY ────────────────────────────────────────
  {
    name: 'DATE',
    regex: /\b(?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}\b/g,
    mask: MASK.DATE,
  },

  // ── Written dates: January 1, 2020 / Jan. 1, 2020 ───────────────────────
  {
    name: 'DATE',
    regex: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2}\b/gi,
    mask: MASK.DATE,
  },

  // ── ZIP codes: 5 digits or ZIP+4 ─────────────────────────────────────────
  {
    name: 'ZIP',
    regex: /\b(?:ZIP|zip\s*code|postal\s*code)[:\s]*\d{5}(?:-\d{4})?\b/gi,
    mask: MASK.ZIP,
  },
  {
    name: 'ZIP',
    regex: /\b\d{5}-\d{4}\b/g,
    mask: MASK.ZIP,
  },

  // ── IPv4 addresses ────────────────────────────────────────────────────────
  {
    name: 'IP',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    mask: MASK.IP,
  },

  // ── Patient / person name context patterns ───────────────────────────────
  // Matches "Patient: John Smith", "Mr. John Smith", "Dr. Jane Doe", etc.
  {
    name: 'NAME',
    regex: /\b(?:Patient|Mr\.|Mrs\.|Ms\.|Dr\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}/g,
    mask: MASK.NAME,
  },
];

// ---------------------------------------------------------------------------
// PIIDetector
// ---------------------------------------------------------------------------

export class PIIDetector {
  // ── Primary API ────────────────────────────────────────────────────────────

  /**
   * Scan `text` for PHI patterns, replace every match with its corresponding
   * redaction token, and return both the cleaned text and a flag indicating
   * whether any PHI was found.
   */
  maskPHI(text: string): { maskedText: string; phiFound: boolean } {
    if (!text || text.trim().length === 0) {
      return { maskedText: text, phiFound: false };
    }

    let maskedText = text;
    let phiFound = false;

    for (const { regex, mask } of PHI_PATTERNS) {
      // Reset lastIndex because we're reusing compiled regexes with /g flag
      regex.lastIndex = 0;
      const replaced = maskedText.replace(regex, () => {
        phiFound = true;
        return mask;
      });
      maskedText = replaced;
    }

    if (phiFound) {
      log.warn('PHI detected and masked in text', {
        originalLength: text.length,
        maskedLength: maskedText.length,
      });
    }

    return { maskedText, phiFound };
  }

  /**
   * Return true if the text contains any detectable PHI without modifying it.
   */
  containsPHI(text: string): boolean {
    if (!text || text.trim().length === 0) return false;

    for (const { regex } of PHI_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(text)) {
        regex.lastIndex = 0; // Reset after test() advances lastIndex
        return true;
      }
      regex.lastIndex = 0;
    }

    return false;
  }

  /**
   * Mask PHI in a user query string and return only the cleaned query text.
   * Convenience wrapper around maskPHI() for the query path.
   */
  maskQuery(query: string): string {
    const { maskedText, phiFound } = this.maskPHI(query);

    if (phiFound) {
      log.warn('PHI found in user query — query has been sanitised before processing');
    }

    return maskedText;
  }

  // ── Detailed scan (useful for audit logging) ───────────────────────────────

  /**
   * Return all PHI matches found in `text` along with their pattern names.
   * Intended for audit/compliance logging — do NOT log the actual match values
   * in production.
   */
  scanPHI(text: string): Array<{ patternName: string; matchCount: number }> {
    const summary: Array<{ patternName: string; matchCount: number }> = [];

    for (const { name, regex } of PHI_PATTERNS) {
      regex.lastIndex = 0;
      const matches = text.match(regex) ?? [];
      regex.lastIndex = 0;

      if (matches.length > 0) {
        // Merge counts for patterns that share the same name (e.g. two MRN patterns)
        const existing = summary.find((s) => s.patternName === name);
        if (existing) {
          existing.matchCount += matches.length;
        } else {
          summary.push({ patternName: name, matchCount: matches.length });
        }
      }
    }

    return summary;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const piiDetector = new PIIDetector();

export default piiDetector;
