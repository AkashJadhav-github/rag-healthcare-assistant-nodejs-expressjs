import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config';
import { createLogger } from '../utils/logger';
import type { RetrievalResult } from './retrieval';

const log = createLogger('LLMGenerator');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface GenerationResult {
  answer: string;
  modelUsed: string;
  confidenceScore: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a highly reliable Healthcare Knowledge Assistant designed for use by medical professionals and researchers.

STRICT RULES — you MUST follow all of these without exception:

1. ONLY use information from the provided context sources. Do NOT draw on your training data to answer medical questions.
2. If the context does not contain enough information to answer the question, say clearly: "The provided sources do not contain sufficient information to answer this question."
3. Cite every factual claim with its source using this exact format: [Source: <Title>, Page <N>] — if a page number is unavailable, use [Source: <Title>].
4. NEVER fabricate, hallucinate, or infer information that is not explicitly stated in the provided context.
5. Always append the following disclaimer at the end of every response:

---
**Clinical Disclaimer:** This information is derived from referenced medical literature and is intended for educational and professional reference purposes only. It does not constitute medical advice. Clinical decisions must be made by qualified healthcare professionals in accordance with individual patient circumstances, institutional guidelines, and current best practices.
---

6. Structure your answers clearly using markdown headings and bullet points where appropriate.
7. When the question involves dosing, procedures, or clinical protocols, explicitly note that recommendations should be verified against current institutional guidelines and regulatory approvals.
8. Maintain a professional, neutral, and evidence-based tone at all times.`;

// ---------------------------------------------------------------------------
// Few-shot examples
// ---------------------------------------------------------------------------

export const FEW_SHOT_EXAMPLES: Array<{ role: 'user' | 'assistant'; content: string }> = [
  {
    role: 'user',
    content:
      'What are the first-line treatment options for type 2 diabetes mellitus according to the provided guidelines?',
  },
  {
    role: 'assistant',
    content: `## First-Line Treatment for Type 2 Diabetes Mellitus

Based on the provided clinical guidelines:

**Lifestyle Modifications (first step):**
- Medical nutrition therapy targeting HbA1c reduction [Source: ADA Standards of Medical Care, Page 12]
- Structured physical activity program: ≥150 minutes/week of moderate-intensity aerobic exercise [Source: ADA Standards of Medical Care, Page 14]
- Weight management for overweight/obese patients [Source: ADA Standards of Medical Care, Page 13]

**Pharmacological First-Line Agent:**
- Metformin is the preferred initial pharmacological agent in the absence of contraindications [Source: ADA Standards of Medical Care, Page 18]
  - Starting dose: 500 mg once or twice daily with meals, titrated to effect
  - Contraindicated in eGFR < 30 mL/min/1.73 m²

**Targets:**
- HbA1c goal: generally < 7% for most non-pregnant adults [Source: ADA Standards of Medical Care, Page 10]

---
**Clinical Disclaimer:** This information is derived from referenced medical literature and is intended for educational and professional reference purposes only. It does not constitute medical advice. Clinical decisions must be made by qualified healthcare professionals in accordance with individual patient circumstances, institutional guidelines, and current best practices.`,
  },
  {
    role: 'user',
    content:
      'What are the diagnostic criteria for hypertensive crisis mentioned in the context?',
  },
  {
    role: 'assistant',
    content: `## Diagnostic Criteria for Hypertensive Crisis

According to the provided sources:

**Definition:**
- Hypertensive crisis is defined as a systolic blood pressure > 180 mmHg and/or diastolic blood pressure > 120 mmHg [Source: ACC/AHA Hypertension Guidelines, Page 45]

**Classification:**

**Hypertensive Urgency:**
- Severe BP elevation (> 180/120 mmHg) WITHOUT acute target organ damage [Source: ACC/AHA Hypertension Guidelines, Page 46]
- May present with severe headache, shortness of breath, epistaxis, or anxiety

**Hypertensive Emergency:**
- Severe BP elevation (> 180/120 mmHg) WITH evidence of acute target organ damage [Source: ACC/AHA Hypertension Guidelines, Page 47]
- Target organs affected may include: brain (hypertensive encephalopathy, stroke), heart (acute MI, acute left ventricular failure), kidneys (acute kidney injury), and aorta (dissection)

**Clinical Note:** Rapid differentiation between urgency and emergency guides immediate management strategy and care setting decisions.

---
**Clinical Disclaimer:** This information is derived from referenced medical literature and is intended for educational and professional reference purposes only. It does not constitute medical advice. Clinical decisions must be made by qualified healthcare professionals in accordance with individual patient circumstances, institutional guidelines, and current best practices.`,
  },
];

// ---------------------------------------------------------------------------
// LLMGenerator
// ---------------------------------------------------------------------------

export class LLMGenerator {
  private openai: OpenAI | null = null;
  private anthropic: Anthropic | null = null;

  constructor() {
    if (config.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    }
    if (config.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }

    log.info('LLMGenerator initialised', {
      provider: config.LLM_PROVIDER,
      openaiAvailable: Boolean(this.openai),
      anthropicAvailable: Boolean(this.anthropic),
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate an answer for `query` grounded in the provided `sources`.
   * Automatically selects the configured LLM provider and falls back to a
   * raw context response when no API keys are configured.
   */
  async generate(
    query: string,
    sources: RetrievalResult[],
    maxTokens = 1024,
  ): Promise<GenerationResult> {
    const startMs = Date.now();

    // If no sources, return a safe default
    if (sources.length === 0) {
      return {
        answer:
          'No relevant sources were found in the knowledge base to answer this query. ' +
          'Please ensure the relevant documents have been ingested, or rephrase your question.\n\n' +
          '---\n**Clinical Disclaimer:** This information is derived from referenced medical literature ' +
          'and is intended for educational and professional reference purposes only.',
        modelUsed: 'none',
        confidenceScore: 0,
        latencyMs: Date.now() - startMs,
      };
    }

    // Choose provider
    let result: GenerationResult;

    if (config.LLM_PROVIDER === 'anthropic' && this.anthropic) {
      result = await this.generateWithAnthropic(query, sources, maxTokens, startMs);
    } else if (this.openai) {
      result = await this.generateWithOpenAI(query, sources, maxTokens, startMs);
    } else {
      // Fallback — return raw retrieved context with a disclaimer
      result = this.rawContextFallback(query, sources, startMs);
    }

    return result;
  }

  // ── OpenAI generation ──────────────────────────────────────────────────────

  private async generateWithOpenAI(
    query: string,
    sources: RetrievalResult[],
    maxTokens: number,
    startMs: number,
  ): Promise<GenerationResult> {
    const messages = this.buildMessages(query, sources);

    try {
      const response = await this.openai!.chat.completions.create({
        model: config.OPENAI_LLM_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1, // Low temperature for factual medical content
      });

      const answer = response.choices[0]?.message?.content ?? 'No response generated.';

      return {
        answer,
        modelUsed: config.OPENAI_LLM_MODEL,
        confidenceScore: this.computeConfidence(sources),
        latencyMs: Date.now() - startMs,
      };
    } catch (err) {
      log.error('OpenAI generation failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ── Anthropic generation ───────────────────────────────────────────────────

  private async generateWithAnthropic(
    query: string,
    sources: RetrievalResult[],
    maxTokens: number,
    startMs: number,
  ): Promise<GenerationResult> {
    const contextBlock = this.buildContext(sources);

    // Anthropic uses a separate system parameter rather than a system message
    const userContent =
      `${contextBlock}\n\n---\n\nQuestion: ${query}`;

    try {
      const response = await this.anthropic!.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          // Inject few-shot examples
          ...FEW_SHOT_EXAMPLES.map((ex) => ({
            role: ex.role as 'user' | 'assistant',
            content: ex.content,
          })),
          { role: 'user', content: userContent },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      const answer = textBlock?.type === 'text' ? textBlock.text : 'No response generated.';

      return {
        answer,
        modelUsed: config.ANTHROPIC_MODEL,
        confidenceScore: this.computeConfidence(sources),
        latencyMs: Date.now() - startMs,
      };
    } catch (err) {
      log.error('Anthropic generation failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ── Fallback ───────────────────────────────────────────────────────────────

  private rawContextFallback(
    query: string,
    sources: RetrievalResult[],
    startMs: number,
  ): GenerationResult {
    log.warn(
      'No LLM API keys configured — returning raw retrieved context as answer.'
    );

    const contextLines = sources.map((s, idx) => {
      const page = s.pageNumber ? `, Page ${s.pageNumber}` : '';
      return `[Source ${idx + 1}: ${s.documentTitle}${page}]\n${s.content}`;
    });

    const answer =
      `Query: ${query}\n\n` +
      `Retrieved Context:\n\n${contextLines.join('\n\n---\n\n')}\n\n` +
      `---\n**Clinical Disclaimer:** This information is derived from referenced medical literature ` +
      `and is intended for educational and professional reference purposes only. ` +
      `It does not constitute medical advice.`;

    return {
      answer,
      modelUsed: 'fallback-raw-context',
      confidenceScore: this.computeConfidence(sources),
      latencyMs: Date.now() - startMs,
    };
  }

  // ── Private builder helpers ─────────────────────────────────────────────────

  /**
   * Build the formatted context block that is injected into the prompt.
   */
  private buildContext(sources: RetrievalResult[]): string {
    const lines: string[] = ['CONTEXT SOURCES:', ''];

    sources.forEach((source, idx) => {
      const page = source.pageNumber ? `, Page ${source.pageNumber}` : '';
      const section = source.section ? ` [${source.section}]` : '';
      lines.push(`--- Source ${idx + 1}: ${source.documentTitle}${page}${section} ---`);
      lines.push(source.content);
      lines.push('');
    });

    return lines.join('\n');
  }

  /**
   * Build the full OpenAI chat message array including system prompt, few-shot
   * examples, context, and the user's question.
   */
  private buildMessages(
    query: string,
    sources: RetrievalResult[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      // Inject few-shot examples
      ...FEW_SHOT_EXAMPLES,
      // Context + question
      {
        role: 'user',
        content: `${this.buildContext(sources)}\n---\n\nQuestion: ${query}`,
      },
    ];

    return messages;
  }

  /**
   * Compute a confidence score [0, 1] from the similarity scores of the
   * retrieved sources. Uses a weighted average skewed toward the top result.
   */
  private computeConfidence(sources: RetrievalResult[]): number {
    if (sources.length === 0) return 0;

    // Weighted average: top result has weight n, second has n-1, etc.
    let weightedSum = 0;
    let totalWeight = 0;

    sources.forEach((s, idx) => {
      const weight = sources.length - idx;
      weightedSum += s.similarityScore * weight;
      totalWeight += weight;
    });

    const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, rawScore));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const generator = new LLMGenerator();

export default generator;
