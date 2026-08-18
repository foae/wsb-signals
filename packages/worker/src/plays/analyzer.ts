/**
 * The `PlayAnalyzer` seam (P2, plays-plan §4) — the ONLY file that imports the Vercel AI SDK.
 * Pipeline code depends on this interface; tests inject a fake; a provider swap (OpenAI →
 * Anthropic/Google/local baseURL) is config + one factory branch, same pattern as
 * `Source`/`MarketData`. `interpret(evidence)` joins the interface at P3 with its evidence type —
 * declaring it now with a placeholder type would just be drift waiting to happen.
 *
 * The AI SDK was chosen over a hand-rolled OpenAI-compatible client for its zod structured outputs
 * (`generateObject`), image inputs, and provider-agnosticism (plan §4 rationale). Verified at
 * install (2026-08-18): `ai@7` + zod 4 work together; the schema is `.nullable()` throughout
 * because OpenAI strict structured outputs reject `.optional()`.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { generateObject, type LanguageModel } from 'ai'

import { LlmExtractionSchema, type LlmExtraction } from './extraction'
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT, extractUserPrompt } from './prompts/extract'

export interface AnalyzerImage {
  data: Buffer
  /** e.g. `image/jpeg` — whatever `images.ts` re-encoded to. */
  mediaType: string
}

export interface PlayText {
  title: string | null
  selftext: string | null
  flair: string | null
}

export interface AnalyzerUsage {
  inputTokens: number | null
  outputTokens: number | null
}

export interface ExtractResult {
  extraction: LlmExtraction
  usage: AnalyzerUsage
  model: string
  /** `${promptVersion}/${schemaVersion}` — the exact contract this output satisfied. */
  promptVersion: string
}

export interface PlayAnalyzer {
  /** `signal` aborts the in-flight call (worker shutdown) — an un-abortable extract would outlive
   *  the compose stop_grace_period into a SIGKILL: paid but unrecorded, re-charged on restart. */
  extract(images: AnalyzerImage[], text: PlayText, opts?: { signal?: AbortSignal }): Promise<ExtractResult>
}

/** Per-call ceiling even without a shutdown: a hung provider must not pin the queue tick. */
const EXTRACT_TIMEOUT_MS = 180_000

export interface AiAnalyzerOptions {
  provider: string
  model: string
  maxOutputTokens: number
  apiKey: string
}

/** The AI-SDK implementation. One structured-output call per extract; no retries here — the queue's
 *  attempt/backoff machinery owns retry policy (a hidden in-seam retry would double-spend silently). */
export class AiSdkAnalyzer implements PlayAnalyzer {
  private readonly model: LanguageModel
  private readonly modelId: string
  private readonly maxOutputTokens: number

  constructor(opts: AiAnalyzerOptions) {
    if (opts.provider !== 'openai') {
      throw new Error(`[plays.llm].provider "${opts.provider}" not wired — add its factory branch in analyzer.ts`)
    }
    this.model = createOpenAI({ apiKey: opts.apiKey })(opts.model)
    this.modelId = opts.model
    this.maxOutputTokens = opts.maxOutputTokens
  }

  async extract(images: AnalyzerImage[], text: PlayText, opts?: { signal?: AbortSignal }): Promise<ExtractResult> {
    const timeout = AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
    const result = await generateObject({
      model: this.model,
      schema: LlmExtractionSchema,
      maxOutputTokens: this.maxOutputTokens,
      // The AI SDK DEFAULTS to 2 hidden retries — three provider attempts per "one" metered call.
      // Zero here, always: the queue's attempt/backoff owns retry policy (review round 1).
      maxRetries: 0,
      abortSignal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: extractUserPrompt(text) },
          ...images.map((img) => ({ type: 'image' as const, image: img.data, mediaType: img.mediaType })),
        ],
      }],
    })
    return {
      extraction: result.object,
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
      model: this.modelId,
      promptVersion: EXTRACT_PROMPT_VERSION,
    }
  }
}
