import { readFileSync } from 'node:fs'

import type { MentionInsert, RawCommentInsert, RawPostInsert } from '@wsb/shared'
import { describe, expect, it } from 'vitest'

import { DEFAULT_REGEX, TickerExtractor } from '../src/extract'
import type { PollResult } from '../src/ingest'
import { mentionsFromPoll } from '../src/mentions'

// Slice-6 parity gate (porting-spec §3.3 / B3): mentionsFromPoll must reproduce the frozen
// `cli._mentions_from_poll` — bot filter, title+selftext vs body, direction-per-thing, per-thing symbol
// dedup. Compared SORTED by (thing_id, ticker), the B3 boundary (production list order is irrelevant).

type Snake = Record<string, any>

const fx = JSON.parse(readFileSync(new URL('../../../fixtures/mentions/from_poll.json', import.meta.url), 'utf8'))

function buildExtractor(): TickerExtractor {
  return new TickerExtractor(new Set<string>(fx.wordsets.stoplist), {
    regex: DEFAULT_REGEX,
    whitelist: new Set<string>(fx.wordsets.whitelist),
    ambiguous: new Set<string>(fx.wordsets.ambiguous),
  })
}

function pollFromFixture(): PollResult {
  const posts: RawPostInsert[] = fx.posts.map((p: Snake) => ({
    id: p.id, createdUtc: p.created_utc, author: p.author ?? null,
    title: p.title ?? null, selftext: p.selftext ?? null, linkFlairText: p.link_flair_text ?? null,
  }))
  const comments: RawCommentInsert[] = fx.comments.map((c: Snake) => ({
    id: c.id, createdUtc: c.created_utc, author: c.author ?? null, body: c.body ?? null,
  }))
  return { posts, comments, rawPosts: [], newestUtc: null, capped: false, ok: true, postsOk: true }
}

const byThingTicker = (a: { thingId: string; ticker: string }, b: { thingId: string; ticker: string }): number =>
  a.thingId < b.thingId ? -1 : a.thingId > b.thingId ? 1 : a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0

describe('mention assembly parity (B3)', () => {
  it('mentionsFromPoll matches the oracle (sorted by thing_id, ticker)', () => {
    const out = mentionsFromPoll(pollFromFixture(), buildExtractor(), new Set<string>(fx.bots))
    const sorted = [...out].sort(byThingTicker)

    expect(sorted.map((m) => [m.thingId, m.ticker]))
      .toEqual(fx.mentions.map((m: Snake) => [m.thing_id, m.ticker]))

    sorted.forEach((m: MentionInsert, i: number) => {
      const exp: Snake = fx.mentions[i]
      const at = `${exp.thing_id}/${exp.ticker}`
      expect(m.thingType, `${at}.thingType`).toBe(exp.thing_type)
      expect(m.createdUtc, `${at}.createdUtc`).toBe(exp.created_utc)
      expect(m.author ?? null, `${at}.author`).toBe(exp.author ?? null)
      expect(m.flair ?? null, `${at}.flair`).toBe(exp.flair ?? null)
      expect(m.direction, `${at}.direction`).toBe(exp.direction)
    })
  })
})
