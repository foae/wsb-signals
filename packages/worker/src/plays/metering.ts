/**
 * Fail-closed LLM cost metering (P2, plays-plan §4; invariant P6):
 *
 *  - **Per-model prices live in config** (`[plays.llm.prices]`, $/Mtok). A ZERO or MISSING price
 *    for the configured model REFUSES dispatch — the shipped `0.0` placeholders deliberately park
 *    the queue until real prices are set; they never mean "free". A $0 meter makes the daily cap
 *    literally inert (all four external design reviewers flagged this independently).
 *  - **The daily counter is summed from today's `cost_usd` rows in the DB** — an in-memory counter
 *    re-opens the cap on every restart. UTC day.
 *  - **Pre-dispatch enforcement reserves the worst case** (estimated input tokens + the full
 *    configured `max_output_tokens`); the actual cost reconciles after the call from real usage.
 */
import { and, gte, isNotNull } from 'drizzle-orm'

import { playExtractions, playInterpretations } from '@wsb/shared'

import type { LlmPrices, PlaysLlmConfig } from '../config'
import type { Db } from '../db'

/** Rough-but-conservative input estimate: OpenAI vision bills detail-high images by 512px tiles;
 *  a tall ≤1600px screenshot can hit ~8 tiles (base 85 + 8 × 170 ≈ 1445) — reserve 1600 so the
 *  "worst case" actually is one. The fixed term covers the system prompt AND the generated JSON
 *  schema AND the user framing (~4.5k chars combined → ~1.2k tokens; reserve 2500 with headroom).
 *  Both were under-reserved in the first cut — flagged by review round 1 (invariant P6). */
const TOKENS_PER_IMAGE = 1600
const SYSTEM_PROMPT_TOKENS = 2500

export function estimateInputTokens(imageCount: number, textChars: number): number {
  return SYSTEM_PROMPT_TOKENS + imageCount * TOKENS_PER_IMAGE + Math.ceil(textChars / 4)
}

/** The configured model's prices — null when missing OR non-positive (fail closed, never "free"). */
export function usablePrices(llm: PlaysLlmConfig, model: string): LlmPrices | null {
  const p = llm.prices[model]
  if (!p || !(p.input > 0) || !(p.output > 0)) return null
  return p
}

export function costUsd(prices: LlmPrices, tokensIn: number, tokensOut: number): number {
  return (tokensIn * prices.input + tokensOut * prices.output) / 1_000_000
}

/** Today's (UTC) realized spend, summed across BOTH LLM tables from the DB — restart-proof. */
export async function todaySpendUsd(db: Db, now: number = Date.now()): Promise<number> {
  const utcMidnightMs = Math.floor(now / 86_400_000) * 86_400_000
  let total = 0
  for (const table of [playExtractions, playInterpretations]) {
    const rows = await db.select({ cost: table.costUsd }).from(table)
      .where(and(gte(table.runAt, utcMidnightMs), isNotNull(table.costUsd)))
    total += rows.reduce((s, r) => s + (r.cost ?? 0), 0)
  }
  return total
}

export type DispatchDecision =
  | { ok: true; prices: LlmPrices; reservedUsd: number }
  | { ok: false; reason: 'no-price' | 'budget'; detail: string }

/** Pre-dispatch gate: price must be usable AND today's spend + the worst-case reservation must fit
 *  the daily budget. The caller queues the play and logs loudly on refusal — never drops it. */
export async function canDispatch(
  db: Db, llm: PlaysLlmConfig, model: string, estInputTokens: number, now: number = Date.now(),
): Promise<DispatchDecision> {
  const prices = usablePrices(llm, model)
  if (!prices) {
    return {
      ok: false, reason: 'no-price',
      detail: `no usable price for "${model}" in [plays.llm.prices] — zero/missing price refuses dispatch (invariant P6)`,
    }
  }
  const reservedUsd = costUsd(prices, estInputTokens, llm.maxOutputTokens)
  const spent = await todaySpendUsd(db, now)
  if (spent + reservedUsd > llm.dailyBudgetUsd) {
    return {
      ok: false, reason: 'budget',
      detail: `daily budget: spent $${spent.toFixed(4)} + reserve $${reservedUsd.toFixed(4)} > cap $${llm.dailyBudgetUsd}`,
    }
  }
  return { ok: true, prices, reservedUsd }
}
