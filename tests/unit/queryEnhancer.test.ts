/**
 * Unit tests for MedicalQueryEnhancer
 */

import { MedicalQueryEnhancer, EnhancedQuery } from '../../src/rag/queryEnhancer';

describe('MedicalQueryEnhancer', () => {
  let enhancer: MedicalQueryEnhancer;

  beforeEach(() => {
    enhancer = new MedicalQueryEnhancer();
  });

  // ── 1. expandAbbreviations expands HTN to include hypertension ───────────────
  it('expandAbbreviations replaces HTN with hypertension', () => {
    const result = enhancer.expandAbbreviations('HTN treatment guidelines');
    expect(result).toContain('hypertension');
    expect(result).not.toContain(' HTN ');
  });

  // ── 2. expandAbbreviations expands MI to include myocardial infarction ───────
  it('expandAbbreviations replaces MI with myocardial infarction', () => {
    const result = enhancer.expandAbbreviations('MI management in the ED');
    expect(result).toContain('myocardial infarction');
  });

  // ── 3. addSynonyms adds synonyms for "heart attack" ──────────────────────────
  it('addSynonyms appends clinical synonyms for "heart attack"', () => {
    const result = enhancer.addSynonyms('What are the signs of a heart attack?');
    expect(result).toContain('myocardial infarction');
    // Original term should still be present
    expect(result).toContain('heart attack');
  });

  // ── 4. decomposeQuery splits on "and" for compound questions ─────────────────
  it('decomposeQuery splits compound query on " and " followed by an interrogative', () => {
    const query =
      'What is the dosing for lisinopril and How should it be titrated in CKD?';
    const parts = enhancer.decomposeQuery(query);

    expect(parts.length).toBeGreaterThan(1);
    // Each part should be a non-empty string
    for (const part of parts) {
      expect(part.trim().length).toBeGreaterThan(0);
    }
  });

  // ── 5. enhance returns object with enhancedQuery string and subQueries array ─
  it('enhance returns an object with enhancedQuery (string) and subQueries (array)', () => {
    const result: EnhancedQuery = enhancer.enhance('T2DM management protocol');

    expect(typeof result.enhancedQuery).toBe('string');
    expect(Array.isArray(result.subQueries)).toBe(true);
    expect(result.subQueries.length).toBeGreaterThanOrEqual(1);
  });

  // ── 6. enhance with simple query returns single subQuery ─────────────────────
  it('enhance with a simple query returns a single-element subQueries array', () => {
    const result = enhancer.enhance('What is hypertension?');
    expect(result.subQueries).toHaveLength(1);
  });

  // ── 7. no abbreviations pass through unchanged structure ─────────────────────
  it('query with no known abbreviations passes through expandAbbreviations unchanged', () => {
    const query = 'What is the recommended diet for patients with kidney disease?';
    const result = enhancer.expandAbbreviations(query);
    expect(result).toBe(query);
  });

  // ── 8. expandAbbreviations expands COPD ──────────────────────────────────────
  it('expandAbbreviations replaces COPD with chronic obstructive pulmonary disease', () => {
    const result = enhancer.expandAbbreviations('COPD exacerbation treatment');
    expect(result).toContain('chronic obstructive pulmonary disease');
  });

  // ── 9. expandAbbreviations expands multiple abbreviations ────────────────────
  it('expandAbbreviations handles multiple abbreviations in the same query', () => {
    const result = enhancer.expandAbbreviations('HTN and T2DM comorbidity management');
    expect(result).toContain('hypertension');
    expect(result).toContain('type 2 diabetes mellitus');
  });

  // ── 10. addSynonyms for "stroke" appends cerebrovascular accident ─────────────
  it('addSynonyms appends synonyms for "stroke"', () => {
    const result = enhancer.addSynonyms('How is stroke treated in the acute phase?');
    expect(result).toContain('cerebrovascular accident');
  });

  // ── 11. enhance enhancedQuery contains the expanded abbreviation ──────────────
  it('enhance.enhancedQuery contains expanded abbreviation when input has HTN', () => {
    const result = enhancer.enhance('HTN diagnosis criteria');
    expect(result.enhancedQuery).toContain('hypertension');
  });

  // ── 12. decomposeQuery semicolon separator ────────────────────────────────────
  it('decomposeQuery splits on semicolon separator', () => {
    const query = 'Describe first-line HTN therapy; Explain side effects of ACE inhibitors';
    const parts = enhancer.decomposeQuery(query);
    expect(parts.length).toBeGreaterThan(1);
  });
});
