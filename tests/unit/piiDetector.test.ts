/**
 * Unit tests for PIIDetector
 */

import { PIIDetector } from '../../src/rag/piiDetector';

describe('PIIDetector', () => {
  let detector: PIIDetector;

  beforeEach(() => {
    detector = new PIIDetector();
  });

  // ── 1. SSN 123-45-6789 is masked ────────────────────────────────────────────
  it('masks SSN in standard dashed format (123-45-6789)', () => {
    const input = 'Patient SSN is 123-45-6789 per intake form.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('123-45-6789');
    expect(maskedText).toContain('[SSN REDACTED]');
  });

  // ── 2. Phone number 555-867-5309 is masked ──────────────────────────────────
  it('masks US phone number in dashed format (555-867-5309)', () => {
    const input = 'Please call the patient at 555-867-5309 to confirm the appointment.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('555-867-5309');
    expect(maskedText).toContain('[PHONE REDACTED]');
  });

  // ── 3. Email john.doe@gmail.com is masked ────────────────────────────────────
  it('masks email address (john.doe@gmail.com)', () => {
    const input = 'Send discharge summary to john.doe@gmail.com before Friday.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('john.doe@gmail.com');
    expect(maskedText).toContain('[EMAIL REDACTED]');
  });

  // ── 4. Clean medical text has no PHI found ───────────────────────────────────
  it('clean clinical text does not trigger PHI detection', () => {
    const input =
      'Hypertension is managed with ACE inhibitors and lifestyle modifications. ' +
      'Metformin is first-line therapy for type 2 diabetes mellitus. ' +
      'Monitor renal function annually with eGFR.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(false);
    expect(maskedText).toBe(input);
  });

  // ── 5. ZIP code 12345 is masked when labelled ────────────────────────────────
  it('masks ZIP code when prefixed with "ZIP" label', () => {
    const input = 'Patient residence ZIP 12345 recorded in chart.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('ZIP 12345');
    expect(maskedText).toContain('[ZIP REDACTED]');
  });

  // ── 6. containsPHI returns true for text with SSN ───────────────────────────
  it('containsPHI returns true when text contains an SSN', () => {
    const input = 'SSN: 987-65-4321 — verify identity before proceeding.';
    expect(detector.containsPHI(input)).toBe(true);
  });

  // ── 7. containsPHI returns false for clean clinical text ────────────────────
  it('containsPHI returns false for clean clinical text', () => {
    const input =
      'Diagnosis: essential hypertension (I10). ' +
      'Plan: initiate lisinopril 10 mg daily. Follow up in 4 weeks.';
    expect(detector.containsPHI(input)).toBe(false);
  });

  // ── 8. maskQuery removes SSN from query ────────────────────────────────────
  it('maskQuery returns a clean query string with SSN removed', () => {
    const query = 'What are the treatment options for patient SSN 321-54-9876?';
    const masked = detector.maskQuery(query);

    expect(masked).not.toContain('321-54-9876');
    expect(masked).toContain('[SSN REDACTED]');
  });

  // ── 9. DOB pattern masked ────────────────────────────────────────────────────
  it('masks date of birth when labelled with "DOB:" prefix', () => {
    const input = 'Patient DOB: 03/15/1982 — admitted for elective procedure.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('03/15/1982');
  });

  // ── 10. NPI masked ───────────────────────────────────────────────────────────
  it('masks National Provider Identifier (NPI) when prefixed with "NPI"', () => {
    const input = 'Prescribing physician NPI: 1234567890 — order verified.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('1234567890');
    expect(maskedText).toContain('[NPI REDACTED]');
  });

  // ── 11. Email in a query is masked ───────────────────────────────────────────
  it('maskQuery masks email address inside a natural-language query', () => {
    const query = 'Send lab results to dr.smith@hospital.org immediately.';
    const masked = detector.maskQuery(query);

    expect(masked).not.toContain('dr.smith@hospital.org');
    expect(masked).toContain('[EMAIL REDACTED]');
  });

  // ── 12. scanPHI returns audit summary ────────────────────────────────────────
  it('scanPHI returns a summary with pattern names and match counts', () => {
    const input =
      'SSN 111-22-3333 and email test@example.com — two PHI items.';
    const summary = detector.scanPHI(input);

    expect(Array.isArray(summary)).toBe(true);
    expect(summary.length).toBeGreaterThan(0);

    const patternNames = summary.map((s) => s.patternName);
    expect(patternNames).toContain('SSN');
    expect(patternNames).toContain('EMAIL');

    for (const entry of summary) {
      expect(entry.matchCount).toBeGreaterThan(0);
    }
  });

  // ── 13. Multiple PHI types in single string ──────────────────────────────────
  it('masks multiple PHI types (SSN + phone + email) in a single string', () => {
    const input =
      'Patient SSN 444-55-6666 can be reached at 212-555-0123 or via test@clinic.org.';
    const { maskedText, phiFound } = detector.maskPHI(input);

    expect(phiFound).toBe(true);
    expect(maskedText).not.toContain('444-55-6666');
    expect(maskedText).not.toContain('212-555-0123');
    expect(maskedText).not.toContain('test@clinic.org');
  });

  // ── 14. Empty string returns phiFound false ──────────────────────────────────
  it('maskPHI on empty string returns phiFound: false and unchanged text', () => {
    const { maskedText, phiFound } = detector.maskPHI('');
    expect(phiFound).toBe(false);
    expect(maskedText).toBe('');
  });
});
