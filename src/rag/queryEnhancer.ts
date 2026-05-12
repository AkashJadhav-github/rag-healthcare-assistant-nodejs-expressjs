import { createLogger } from '../utils/logger';

const log = createLogger('MedicalQueryEnhancer');

// ---------------------------------------------------------------------------
// Medical abbreviation expansion map (60+ entries)
// ---------------------------------------------------------------------------

const ABBREVIATION_MAP: Record<string, string> = {
  // Cardiovascular
  'HTN':    'hypertension',
  'MI':     'myocardial infarction',
  'CAD':    'coronary artery disease',
  'CHF':    'congestive heart failure',
  'HF':     'heart failure',
  'AF':     'atrial fibrillation',
  'AFib':   'atrial fibrillation',
  'DVT':    'deep vein thrombosis',
  'PE':     'pulmonary embolism',
  'VTE':    'venous thromboembolism',
  'ACS':    'acute coronary syndrome',
  'STEMI':  'ST-elevation myocardial infarction',
  'NSTEMI': 'non-ST-elevation myocardial infarction',
  'UA':     'unstable angina',
  'PCI':    'percutaneous coronary intervention',
  'CABG':   'coronary artery bypass graft',
  'EF':     'ejection fraction',
  'LVEF':   'left ventricular ejection fraction',

  // Metabolic / Endocrine
  'T2DM':  'type 2 diabetes mellitus',
  'T1DM':  'type 1 diabetes mellitus',
  'DM':    'diabetes mellitus',
  'DKA':   'diabetic ketoacidosis',
  'HHS':   'hyperosmolar hyperglycemic state',
  'HbA1c': 'glycated hemoglobin A1c',
  'FBG':   'fasting blood glucose',
  'BMI':   'body mass index',
  'MetS':  'metabolic syndrome',

  // Pulmonary / Respiratory
  'COPD':  'chronic obstructive pulmonary disease',
  'ARDS':  'acute respiratory distress syndrome',
  'OSA':   'obstructive sleep apnea',
  'TB':    'tuberculosis',
  'PFT':   'pulmonary function test',
  'FEV1':  'forced expiratory volume in one second',
  'FVC':   'forced vital capacity',
  'O2':    'oxygen',
  'SpO2':  'oxygen saturation',
  'CPAP':  'continuous positive airway pressure',
  'BiPAP': 'bilevel positive airway pressure',

  // Renal
  'CKD':   'chronic kidney disease',
  'AKI':   'acute kidney injury',
  'ESRD':  'end-stage renal disease',
  'GFR':   'glomerular filtration rate',
  'eGFR':  'estimated glomerular filtration rate',
  'BUN':   'blood urea nitrogen',

  // Neurological
  'CVA':   'cerebrovascular accident',
  'TIA':   'transient ischemic attack',
  'MS':    'multiple sclerosis',
  'PD':    'Parkinson disease',
  'AD':    'Alzheimer disease',
  'ICP':   'intracranial pressure',
  'LOC':   'loss of consciousness',

  // Gastrointestinal
  'GI':    'gastrointestinal',
  'GERD':  'gastroesophageal reflux disease',
  'IBD':   'inflammatory bowel disease',
  'IBS':   'irritable bowel syndrome',
  'PUD':   'peptic ulcer disease',
  'LFT':   'liver function test',
  'HCV':   'hepatitis C virus',
  'HBV':   'hepatitis B virus',
  'NAFLD': 'non-alcoholic fatty liver disease',

  // Oncology
  'NHL':   'non-Hodgkin lymphoma',
  'HL':    'Hodgkin lymphoma',
  'CLL':   'chronic lymphocytic leukemia',
  'AML':   'acute myeloid leukemia',
  'ALL':   'acute lymphoblastic leukemia',

  // Pharmacology / general
  'ACE':   'angiotensin-converting enzyme',
  'ARB':   'angiotensin receptor blocker',
  'NSAID': 'non-steroidal anti-inflammatory drug',
  'OTC':   'over-the-counter',
  'IV':    'intravenous',
  'IM':    'intramuscular',
  'PO':    'oral',
  'SQ':    'subcutaneous',
  'PRN':   'as needed',
  'QD':    'once daily',
  'BID':   'twice daily',
  'TID':   'three times daily',
  'QID':   'four times daily',

  // Diagnostic / Laboratory
  'CBC':   'complete blood count',
  'CMP':   'comprehensive metabolic panel',
  'BMP':   'basic metabolic panel',
  'ECG':   'electrocardiogram',
  'EKG':   'electrocardiogram',
  'MRI':   'magnetic resonance imaging',
  'CT':    'computed tomography',
  'US':    'ultrasound',
  'CXR':   'chest X-ray',
  'EEG':   'electroencephalogram',
  'EMG':   'electromyography',

  // General / other
  'SOB':   'shortness of breath',
  'DOE':   'dyspnea on exertion',
  'CP':    'chest pain',
  'N/V':   'nausea and vomiting',
  'URI':   'upper respiratory infection',
  'UTI':   'urinary tract infection',
  'STI':   'sexually transmitted infection',
  'BMD':   'bone mineral density',
  'ROM':   'range of motion',
  'ADL':   'activities of daily living',
  'ICU':   'intensive care unit',
  'ED':    'emergency department',
  'OR':    'operating room',
  'Dx':    'diagnosis',
  'Tx':    'treatment',
  'Hx':    'history',
  'Sx':    'symptoms',
  'Rx':    'prescription',
  'PMH':   'past medical history',
  'FH':    'family history',
  'SH':    'social history',
  'ROS':   'review of systems',
  'HPI':   'history of present illness',
  'CC':    'chief complaint',
};

// ---------------------------------------------------------------------------
// Synonym map — maps common lay terms to clinical equivalents (and vice-versa)
// ---------------------------------------------------------------------------

const SYNONYM_MAP: Record<string, string[]> = {
  'heart attack':             ['myocardial infarction', 'cardiac infarction', 'coronary thrombosis'],
  'stroke':                   ['cerebrovascular accident', 'brain attack', 'cerebral infarction'],
  'high blood pressure':      ['hypertension', 'elevated blood pressure'],
  'diabetes':                 ['diabetes mellitus', 'hyperglycemia'],
  'kidney disease':           ['renal disease', 'nephropathy'],
  'kidney failure':           ['renal failure', 'renal insufficiency'],
  'heart failure':            ['cardiac failure', 'congestive heart failure'],
  'lung disease':             ['pulmonary disease', 'respiratory disease'],
  'blood clot':               ['thrombosis', 'thrombus', 'embolism'],
  'chest pain':               ['angina', 'precordial pain', 'thoracic pain'],
  'shortness of breath':      ['dyspnea', 'breathlessness', 'respiratory distress'],
  'infection':                ['sepsis', 'bacteremia', 'infectious disease'],
  'cancer':                   ['malignancy', 'neoplasm', 'carcinoma', 'tumor'],
  'inflammation':             ['inflammatory response', 'inflammatory process'],
  'pain':                     ['nociception', 'algia', 'ache', 'discomfort'],
  'fever':                    ['pyrexia', 'hyperthermia', 'febrile state'],
  'swelling':                 ['edema', 'oedema', 'effusion'],
  'fainting':                 ['syncope', 'loss of consciousness'],
  'seizure':                  ['convulsion', 'epileptic episode'],
  'depression':               ['major depressive disorder', 'depressive illness'],
  'anxiety':                  ['anxiety disorder', 'generalized anxiety'],
  'treatment':                ['therapy', 'management', 'intervention'],
  'diagnosis':                ['clinical diagnosis', 'differential diagnosis'],
  'guideline':                ['clinical guideline', 'practice guideline', 'recommendation'],
};

// ---------------------------------------------------------------------------
// Compound query splitters
// ---------------------------------------------------------------------------

const COMPOUND_SPLIT_PATTERNS: RegExp[] = [
  /\s+and\s+(?=[A-Z]|\bwhat\b|\bhow\b|\bwhen\b|\bwhy\b|\bwhere\b|\bwhich\b)/gi,
  /\s+also\s+(?=\bwhat\b|\bhow\b|\bwhen\b|\bwhy\b|\bwhere\b|\bwhich\b)/gi,
  /\s+additionally[,\s]+/gi,
  /[;]\s+/g,
];

// ---------------------------------------------------------------------------
// MedicalQueryEnhancer
// ---------------------------------------------------------------------------

export interface EnhancedQuery {
  /** Original query with abbreviations expanded and synonyms appended */
  enhancedQuery: string;
  /** Array of sub-queries if the original was a compound question */
  subQueries: string[];
}

export class MedicalQueryEnhancer {
  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Full enhancement pipeline:
   * 1. Expand abbreviations
   * 2. Append medical synonyms
   * 3. Decompose compound questions
   */
  enhance(query: string): EnhancedQuery {
    let enhanced = query.trim();
    enhanced = this.expandAbbreviations(enhanced);
    enhanced = this.addSynonyms(enhanced);
    const subQueries = this.decomposeQuery(query.trim()); // Use original for decomposition

    log.debug('Query enhanced', {
      original: query,
      enhanced,
      subQueryCount: subQueries.length,
    });

    return { enhancedQuery: enhanced, subQueries };
  }

  /**
   * Replace known medical abbreviations in the query with their full forms.
   * Matching is case-sensitive and word-boundary aware.
   */
  expandAbbreviations(query: string): string {
    let result = query;

    for (const [abbr, expansion] of Object.entries(ABBREVIATION_MAP)) {
      // Word-boundary match — avoid replacing substrings inside other words
      const re = new RegExp(`\\b${escapeRegex(abbr)}\\b`, 'g');
      result = result.replace(re, expansion);
    }

    return result;
  }

  /**
   * Detect key terms in the query and append their clinical synonyms so the
   * vector search retrieves relevant documents regardless of terminology.
   * Appended synonyms are parenthesised to keep the base query readable.
   */
  addSynonyms(query: string): string {
    const appendTerms: string[] = [];
    const lowerQuery = query.toLowerCase();

    for (const [term, synonyms] of Object.entries(SYNONYM_MAP)) {
      if (lowerQuery.includes(term)) {
        // Add synonyms that are NOT already present in the query
        const newSynonyms = synonyms.filter(
          (s) => !lowerQuery.includes(s.toLowerCase())
        );
        appendTerms.push(...newSynonyms);
      }
    }

    if (appendTerms.length === 0) return query;

    // Deduplicate
    const unique = [...new Set(appendTerms)];
    return `${query} (${unique.join(', ')})`;
  }

  /**
   * Split a compound question into individual sub-questions.
   * Returns a single-element array when the query is a simple question.
   */
  decomposeQuery(query: string): string[] {
    let parts = [query];

    for (const pattern of COMPOUND_SPLIT_PATTERNS) {
      const next: string[] = [];
      for (const part of parts) {
        const split = part.split(pattern).map((s) => s.trim()).filter((s) => s.length > 0);
        next.push(...split);
      }
      parts = next;
    }

    // Filter out fragments that are clearly not standalone questions (< 5 chars)
    const validParts = parts.filter((p) => p.length >= 5);

    // Always return at least the original query
    return validParts.length > 0 ? validParts : [query];
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

export const queryEnhancer = new MedicalQueryEnhancer();

export default queryEnhancer;
