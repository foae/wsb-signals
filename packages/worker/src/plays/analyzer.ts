/**
 * The `PlayAnalyzer` seam (P2/P3, plays-plan §4/§5) — the ONLY file that imports the Vercel AI
 * SDK. Pipeline code depends on this interface; tests inject a fake; a provider swap (OpenAI →
 * Anthropic/Google/local baseURL) is config + one factory branch, same pattern as
 * `Source`/`MarketData`. Two calls: `extract` (vision, P2) and `interpret` (text-only over the
 * assembled evidence, P3 — the herd gate arrives as `allowHerd`, decided DETERMINISTICALLY by the
 * caller from the evidence block, never in here).
 *
 * The AI SDK was chosen over a hand-rolled OpenAI-compatible client for its zod structured outputs
 * (`generateObject`), image inputs, and provider-agnosticism (plan §4 rationale). Verified at
 * install (2026-08-18): `ai@7` + zod 4 work together; the schema is `.nullable()` throughout
 * because OpenAI strict structured outputs reject `.optional()`.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { APICallError, generateObject, type LanguageModel } from 'ai'
import { fetch as undiciFetch } from 'undici'
import { z } from 'zod'

import { log } from '../logger'
import { CodexAuth } from './codex-auth'
import type { PlayEvidence } from './evidence'
import { LlmExtractionSchema, sanitizeRawExtraction, type LlmExtraction } from './extraction'
import {
  buildInterpretationSchema, parseInterpretation, type LlmInterpretation,
} from './interpretation'
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT, extractUserPrompt } from './prompts/extract'
import { INTERPRET_PROMPT_VERSION, INTERPRET_SYSTEM_PROMPT, interpretUserPrompt } from './prompts/interpret'
import type { PlayExtraction } from './validate'

export interface AnalyzerImage {
  data: Buffer
  /** e.g. `image/jpeg` — whatever `images.ts` re-encoded to. */
  mediaType: string
}

export interface PlayText {
  title: string | null
  selftext: string | null
  flair: string | null
  /** ISO date the post was created — the model's anchor for resolving M/DD expiry years (prompt v2). */
  postedAt?: string | null
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

export interface InterpretRequest {
  text: PlayText
  /** The VALIDATED extraction (`play_extractions.output`) — the model interprets the validated
   *  positions, not its own earlier raw output. */
  extraction: PlayExtraction
  /** The assembled evidence block — serialized into the prompt verbatim; the caller stores the
   *  same object on the interpretation row (invariant P2). */
  evidence: PlayEvidence
  /** The structural herd gate (invariant P4), decided by the CALLER from the deterministic
   *  evidence: false = `herd-following` is not even in the category enum sent to the model. */
  allowHerd: boolean
}

export interface InterpretResult {
  interpretation: LlmInterpretation
  usage: AnalyzerUsage
  model: string
  /** `${INTERPRET_PROMPT_VERSION}/${INTERPRET_SCHEMA_VERSION}` — taxonomy is versioned separately. */
  promptVersion: string
}

export interface PlayAnalyzer {
  /** `signal` aborts the in-flight call (worker shutdown) — an un-abortable extract would outlive
   *  the compose stop_grace_period into a SIGKILL: paid but unrecorded, re-charged on restart. */
  extract(images: AnalyzerImage[], text: PlayText, opts?: { signal?: AbortSignal }): Promise<ExtractResult>
  /** Text-only structured call (P3). Same abort semantics as `extract`. */
  interpret(req: InterpretRequest, opts?: { signal?: AbortSignal }): Promise<InterpretResult>
}

/** Per-call ceiling even without a shutdown: a hung provider must not pin the queue tick. */
const LLM_CALL_TIMEOUT_MS = 180_000

/** True when the provider REJECTED the request without billing it — 400 invalid request, 401 bad
 *  key, 403 missing scope (both seen live at the P2 gate). The caller may drop the attempt's cost
 *  reservation; anything ambiguous stays metered (fail-closed). Lives here because the seam is the
 *  only file allowed to know provider error types. */
const UNBILLED_STATUSES = new Set([400, 401, 403])
export function isUnbilledRejection(e: unknown): boolean {
  if (APICallError.isInstance(e) && e.statusCode != null && UNBILLED_STATUSES.has(e.statusCode)) return true
  return e instanceof CodexApiError && UNBILLED_STATUSES.has(e.statusCode)
}

export interface AiAnalyzerOptions {
  provider: string
  extractModel: string
  interpretModel: string
  maxOutputTokens: number
  apiKey: string
}

/** The AI-SDK implementation. One structured-output call per stage; no retries here — the queue's
 *  attempt/backoff machinery owns retry policy (a hidden in-seam retry would double-spend silently). */
export class AiSdkAnalyzer implements PlayAnalyzer {
  private readonly extractLm: LanguageModel
  private readonly interpretLm: LanguageModel
  private readonly maxOutputTokens: number

  constructor(private readonly opts: AiAnalyzerOptions) {
    if (opts.provider !== 'openai') {
      throw new Error(`[plays.llm].provider "${opts.provider}" not wired — add its factory branch in analyzer.ts`)
    }
    const openai = createOpenAI({ apiKey: opts.apiKey })
    this.extractLm = openai(opts.extractModel)
    this.interpretLm = openai(opts.interpretModel)
    this.maxOutputTokens = opts.maxOutputTokens
  }

  async extract(images: AnalyzerImage[], text: PlayText, opts?: { signal?: AbortSignal }): Promise<ExtractResult> {
    const timeout = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS)
    // KNOWN ASYMMETRY: this path has no `sanitizeRawExtraction` hook — `generateObject` validates
    // the raw zod schema internally, so the phantom-date/overlong-notes repairs that protect the
    // codex path do not run here. Dormant while codex is the live provider; wiring the repair in
    // means catching NoObjectGeneratedError and re-parsing its `text` through the sanitizer.
    const result = await generateObject({
      model: this.extractLm,
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
      model: this.opts.extractModel,
      promptVersion: EXTRACT_PROMPT_VERSION,
    }
  }

  async interpret(req: InterpretRequest, opts?: { signal?: AbortSignal }): Promise<InterpretResult> {
    const timeout = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS)
    const result = await generateObject({
      model: this.interpretLm,
      schema: buildInterpretationSchema(req.allowHerd),
      maxOutputTokens: this.maxOutputTokens,
      maxRetries: 0, // same rule as extract: the queue owns retry policy
      abortSignal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      system: INTERPRET_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: interpretUserPrompt({
            title: req.text.title, selftext: req.text.selftext, flair: req.text.flair,
            postedAt: req.text.postedAt ?? null, extraction: req.extraction, evidence: req.evidence,
          }),
        }],
      }],
    })
    // Re-run the shared gate (sanitize is a no-op on already-valid output; the herd-TAG strip is
    // the part generateObject cannot do) so P4 enforcement can't drift between the two impls.
    const { value, repaired } = parseInterpretation(result.object, req.allowHerd)
    if (repaired.length) log.warn({ repaired }, 'interpret: non-critical fields repaired')
    return {
      interpretation: value,
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
      model: this.opts.interpretModel,
      promptVersion: INTERPRET_PROMPT_VERSION,
    }
  }
}

// ── Codex subscription implementation (user decision 2026-08-19) ────────────────────────────────────
//
// Rides the ChatGPT-subscription OAuth (established by `codex-login`, self-refreshed — see
// codex-auth.ts) against the Codex
// backend — probed live 2026-08-19: strict `json_schema` structured outputs AND `input_image` both
// work on gpt-5.6-luna. The backend dialect differs from the platform Responses API just enough
// that @ai-sdk/openai can't be pointed at it (SSE-only, `instructions`, header set), so this is a
// small hand-rolled client behind the SAME seam. NOTE: metering under a subscription is NOTIONAL —
// no marginal dollars move; the configured prices exist to bound VOLUME via the daily cap.

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'

export class CodexApiError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'CodexApiError'
  }
}

/** OpenAI strict mode needs `additionalProperties: false` + full `required` on every object, and
 *  rejects some constraint keywords zod emits — zod re-validates the parsed response anyway, so the
 *  wire schema only has to GUIDE the model, never to be the enforcer. */
export function strictifyJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictifyJsonSchema)
  if (node == null || typeof node !== 'object') return node
  const obj = { ...(node as Record<string, unknown>) }
  // `pattern` deliberately survives: OpenAI strict mode enforces it, and it is the only
  // machine-readable format signal for the ISO dates (live luna failure without it, 2026-08-19).
  for (const k of ['minLength', 'maxLength', 'minimum', 'maximum',
    'exclusiveMinimum', 'exclusiveMaximum', '$schema']) delete obj[k]
  if (obj.type === 'object' && obj.properties != null && typeof obj.properties === 'object') {
    obj.additionalProperties = false
    obj.required = Object.keys(obj.properties as Record<string, unknown>)
  }
  for (const [k, v] of Object.entries(obj)) obj[k] = k === 'required' ? v : strictifyJsonSchema(v)
  return obj
}

interface SseEvent { type?: string; [k: string]: unknown }

/** Collect the final output text + usage from a Codex SSE body. The `response.completed` event's
 *  own `output` array arrives EMPTY (observed live) — the text lives in `response.output_item.done`
 *  message items, so both event kinds are read. */
export function parseCodexSse(body: string): { text: string; inputTokens: number | null; outputTokens: number | null } {
  let text = ''
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    let ev: SseEvent
    try { ev = JSON.parse(line.slice(6)) as SseEvent } catch { continue }
    if (ev.type === 'response.output_item.done') {
      const item = ev.item as { type?: string; content?: { type?: string; text?: string }[] } | undefined
      if (item?.type === 'message') {
        for (const part of item.content ?? []) if (part.type === 'output_text' && part.text) text += part.text
      }
    } else if (ev.type === 'response.completed') {
      const usage = (ev.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage
      inputTokens = usage?.input_tokens ?? null
      outputTokens = usage?.output_tokens ?? null
    } else if (ev.type === 'response.failed' || ev.type === 'error') {
      throw new CodexApiError(`codex response failed: ${JSON.stringify(ev).slice(0, 300)}`, 500)
    }
  }
  return { text, inputTokens, outputTokens }
}

export interface CodexAnalyzerOptions {
  extractModel: string
  interpretModel: string
  maxOutputTokens: number
  authFile: string
  fetchImpl?: typeof undiciFetch
}

type CodexContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

export class CodexAnalyzer implements PlayAnalyzer {
  private readonly auth: CodexAuth
  private readonly extractWireSchema: unknown
  /** Both herd-gate variants, precomputed — the enum differs per call (invariant P4). */
  private readonly interpretWireSchemas: Record<'herd' | 'noHerd', unknown>

  constructor(private readonly opts: CodexAnalyzerOptions) {
    this.auth = new CodexAuth(opts.authFile)
    this.extractWireSchema = strictifyJsonSchema(z.toJSONSchema(LlmExtractionSchema, { io: 'input' }))
    this.interpretWireSchemas = {
      herd: strictifyJsonSchema(z.toJSONSchema(buildInterpretationSchema(true) as z.ZodType, { io: 'input' })),
      noHerd: strictifyJsonSchema(z.toJSONSchema(buildInterpretationSchema(false) as z.ZodType, { io: 'input' })),
    }
  }

  /** One SSE structured-output round trip — shared by both stages. */
  private async dispatch(
    stage: 'extract' | 'interpret', model: string, instructions: string, content: CodexContentPart[],
    schemaName: string, wireSchema: unknown, signal: AbortSignal,
  ): Promise<{ raw: string; inputTokens: number | null; outputTokens: number | null }> {
    // Auth acquisition/refresh happens BEFORE any dispatch: its failures (dead refresh token,
    // unreadable file, refresh-endpoint 4xx) are unbilled by definition — surface them as a 401
    // CodexApiError so the queue drops the pre-dispatch cost reservation instead of burning the
    // daily budget on attempts that never reached the provider (review 2026-08-20). Shutdown
    // aborts are unaffected: the queue checks its own signal before classifying the error.
    let accessToken: string, accountId: string
    try {
      ({ accessToken, accountId } = await this.auth.credentials(signal))
    } catch (e) {
      throw new CodexApiError(`codex auth (pre-dispatch): ${String(e).slice(0, 200)}`, 401)
    }
    const fetchImpl = this.opts.fetchImpl ?? undiciFetch

    const res = await fetchImpl(CODEX_URL, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        // Must match the OAuth client's originator: tokens are now granted via codex-login's
        // authorization flow (the Codex CLI's own), not pi's (retired 2026-08-20).
        'originator': 'codex_cli_rs',
        'User-Agent': 'wsb-signals-plays/1.0',
        'OpenAI-Beta': 'responses=experimental',
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        stream: true, // the codex backend is SSE-only
        instructions,
        // NO max_output_tokens: the codex backend 400s on it ("Unsupported parameter", seen live);
        // the configured value still drives the pre-dispatch reservation in metering.ts.
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: wireSchema } },
        include: ['reasoning.encrypted_content'],
      }),
    })
    if (res.status !== 200) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new CodexApiError(`codex ${stage}: status ${res.status} ${detail}`, res.status)
    }
    const { text: raw, inputTokens, outputTokens } = parseCodexSse(await res.text())
    return { raw, inputTokens, outputTokens }
  }

  async extract(images: AnalyzerImage[], text: PlayText, callOpts?: { signal?: AbortSignal }): Promise<ExtractResult> {
    const timeout = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS)
    const signal = callOpts?.signal ? AbortSignal.any([callOpts.signal, timeout]) : timeout
    const { raw, inputTokens, outputTokens } = await this.dispatch(
      'extract', this.opts.extractModel, EXTRACT_SYSTEM_PROMPT,
      [
        { type: 'input_text', text: extractUserPrompt(text) },
        ...images.map((img): CodexContentPart => ({
          type: 'input_image',
          image_url: `data:${img.mediaType};base64,${img.data.toString('base64')}`,
        })),
      ],
      'play_extraction', this.extractWireSchema, signal)
    let extraction: LlmExtraction
    try {
      const { value, repaired } = sanitizeRawExtraction(JSON.parse(raw))
      if (repaired.length) log.warn({ repaired }, 'codex extract: non-marking fields repaired (kept the extraction)')
      extraction = LlmExtractionSchema.parse(value)
    } catch (e) {
      // Malformed despite strict mode — a stage fault (queue attempts/backoff), never silent.
      log.warn({ raw: raw.slice(0, 200), err: String(e).slice(0, 200) }, 'codex extract: output failed schema parse')
      throw new CodexApiError(`codex extract: unparseable structured output: ${String(e).slice(0, 200)}`, 500)
    }
    return {
      extraction,
      usage: { inputTokens, outputTokens },
      model: this.opts.extractModel,
      promptVersion: EXTRACT_PROMPT_VERSION,
    }
  }

  async interpret(req: InterpretRequest, callOpts?: { signal?: AbortSignal }): Promise<InterpretResult> {
    const timeout = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS)
    const signal = callOpts?.signal ? AbortSignal.any([callOpts.signal, timeout]) : timeout
    const { raw, inputTokens, outputTokens } = await this.dispatch(
      'interpret', this.opts.interpretModel, INTERPRET_SYSTEM_PROMPT,
      [{
        type: 'input_text',
        text: interpretUserPrompt({
          title: req.text.title, selftext: req.text.selftext, flair: req.text.flair,
          postedAt: req.text.postedAt ?? null, extraction: req.extraction, evidence: req.evidence,
        }),
      }],
      'play_interpretation', this.interpretWireSchemas[req.allowHerd ? 'herd' : 'noHerd'], signal)
    let interpretation: LlmInterpretation
    try {
      const { value, repaired } = parseInterpretation(JSON.parse(raw), req.allowHerd)
      if (repaired.length) log.warn({ repaired }, 'codex interpret: non-critical fields repaired (kept the interpretation)')
      interpretation = value
    } catch (e) {
      log.warn({ raw: raw.slice(0, 200), err: String(e).slice(0, 200) }, 'codex interpret: output failed schema parse')
      throw new CodexApiError(`codex interpret: unparseable structured output: ${String(e).slice(0, 200)}`, 500)
    }
    return {
      interpretation,
      usage: { inputTokens, outputTokens },
      model: this.opts.interpretModel,
      promptVersion: INTERPRET_PROMPT_VERSION,
    }
  }
}

export interface BuildAnalyzerEnv {
  OPENAI_API_KEY?: string
  CODEX_AUTH_FILE?: string
}

/**
 * The one factory both the worker loop and `plays-eval` use. Providers:
 *  - `openai` — platform API key (`OPENAI_API_KEY`)
 *  - `openai-codex` — ChatGPT-subscription OAuth (`CODEX_AUTH_FILE`, the mounted auth.json;
 *    established once via `codex-login`)
 * Returns undefined (never throws for MISSING credentials) so the queue can rest loudly instead.
 */
export function buildAnalyzer(
  cfg: { provider: string; extractModel: string; interpretModel: string; maxOutputTokens: number },
  env: BuildAnalyzerEnv,
): PlayAnalyzer | undefined {
  if (cfg.provider === 'openai-codex') {
    if (!env.CODEX_AUTH_FILE) {
      log.warn('plays LLM extraction OFF — [plays.llm].provider is openai-codex but CODEX_AUTH_FILE is unset')
      return undefined
    }
    return new CodexAnalyzer({
      extractModel: cfg.extractModel, interpretModel: cfg.interpretModel,
      maxOutputTokens: cfg.maxOutputTokens, authFile: env.CODEX_AUTH_FILE,
    })
  }
  if (cfg.provider === 'openai') {
    if (!env.OPENAI_API_KEY) {
      log.warn('plays LLM extraction OFF — OPENAI_API_KEY missing; plays rest at media_ready until it is set')
      return undefined
    }
    return new AiSdkAnalyzer({
      provider: cfg.provider, extractModel: cfg.extractModel, interpretModel: cfg.interpretModel,
      maxOutputTokens: cfg.maxOutputTokens, apiKey: env.OPENAI_API_KEY,
    })
  }
  throw new Error(`[plays.llm].provider "${cfg.provider}" not wired — add its factory branch in analyzer.ts`)
}
