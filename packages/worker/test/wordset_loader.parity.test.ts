import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { loadWordset } from '../src/extract'

// Loader parity on the REAL committed wordlists: the TS `loadWordset` must parse the same files to the
// same set as Python `_load_wordset` (fixtures/wordset_loader.json). Guards the whitespace-split /
// comment-strip landmine. symbols.txt is derived/gitignored, so it's out of scope.
interface LoaderFixture {
  [key: string]: { path: string; count: number; tokens: string[] }
}

const fx: LoaderFixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/wordset_loader.json', import.meta.url), 'utf8'),
)

describe('wordset loader parity (B3)', () => {
  for (const [name, entry] of Object.entries(fx)) {
    it(`${name} (${entry.path}) parses to the oracle set`, () => {
      const content = readFileSync(new URL(`../../../${entry.path}`, import.meta.url), 'utf8')
      const parsed = [...loadWordset(content)].sort() // ASCII tokens → JS sort == Python sorted()
      expect(parsed).toEqual(entry.tokens)
      expect(parsed.length).toBe(entry.count)
    })
  }
})
