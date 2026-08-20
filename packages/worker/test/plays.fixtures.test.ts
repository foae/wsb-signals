import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LlmExtractionSchema } from '../src/plays/extraction'

/** Offline lint of the hand-labeled eval answer keys (review 2026-08-20): before this, the 36
 *  committed keys were parsed only inside the paid `plays-eval` CLI — a malformed key survived CI
 *  and surfaced mid-run after earlier cases had already spent money. */
const fixturesDir = join(__dirname, '..', '..', '..', 'fixtures', 'plays')
const cases = readdirSync(fixturesDir).filter((d) => statSync(join(fixturesDir, d)).isDirectory())

describe('fixtures/plays answer keys', () => {
  it('has a usable case count (≥30 per the gate; sanity-bound the walk itself)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
  })
  it.each(cases)('%s: expected.json parses against LlmExtractionSchema; post.json carries the eval contract', (name) => {
    const expected = JSON.parse(readFileSync(join(fixturesDir, name, 'expected.json'), 'utf8'))
    expect(() => LlmExtractionSchema.parse(expected)).not.toThrow()
    const post = JSON.parse(readFileSync(join(fixturesDir, name, 'post.json'), 'utf8'))
    expect(post).toHaveProperty('title')
    expect(post).toHaveProperty('flair')
    // The expiry-year anchor: production always sends the post date (queue.ts); an eval without it
    // measures the model on a contract production never uses (review 2026-08-20, 3-model consensus).
    expect(post.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
