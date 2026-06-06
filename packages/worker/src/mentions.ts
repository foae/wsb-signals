/**
 * Mention assembly — TS port of the frozen v0.0.1 `cli._mentions_from_poll` (porting-spec §3.3 / B3).
 * Turns a `PollResult` into the per-(ticker, thing) `Mention` rows the aggregator consumes.
 *
 * Parity-critical details:
 *  - skip bot authors BEFORE extracting (`author in bots`; a null author is never a bot);
 *  - post text = `"{title} {selftext}"`, comment text = `body`;
 *  - direction is classified ONCE per thing and applied to every ticker in it;
 *  - symbols are de-duped WITHIN a thing (`set(extract(text))`) — one mention per (ticker, thing),
 *    the §2.1 grain. (List order is irrelevant downstream; the parity boundary sorts by thing_id,ticker.)
 *  - post mentions carry the post's flair; comment mentions have no flair (null).
 */
import type { MentionInsert } from '@wsb/shared'

import { direction } from './classify'
import type { TickerExtractor } from './extract'
import type { PollResult } from './ingest'

export function mentionsFromPoll(
  poll: PollResult,
  extractor: TickerExtractor,
  bots: ReadonlySet<string>,
): MentionInsert[] {
  const out: MentionInsert[] = []

  for (const p of poll.posts) {
    if (p.author != null && bots.has(p.author)) continue
    const text = `${p.title ?? ''} ${p.selftext ?? ''}`
    const d = direction(text)
    for (const sym of new Set(extractor.extract(text))) {
      out.push({
        ticker: sym, thingId: p.id, thingType: 'post', createdUtc: p.createdUtc,
        author: p.author ?? null, flair: p.linkFlairText ?? null, direction: d,
      })
    }
  }

  for (const c of poll.comments) {
    if (c.author != null && bots.has(c.author)) continue
    const d = direction(c.body)
    for (const sym of new Set(extractor.extract(c.body))) {
      out.push({
        ticker: sym, thingId: c.id, thingType: 'comment', createdUtc: c.createdUtc,
        author: c.author ?? null, flair: null, direction: d,
      })
    }
  }

  return out
}
