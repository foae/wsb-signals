import { describe, expect, it } from 'vitest'

import {
  buildInterpretationSchema, CATEGORIES, MAX_TAGS, parseInterpretation, sanitizeRawInterpretation,
  SUMMARY_MAX_LEN, TLDR_MAX_LEN,
} from '../src/plays/interpretation'

// P3 schema semantics: the herd category gate is STRUCTURAL (invariant P4) and free-text length
// pins are repaired pre-parse, never allowed to burn a paid interpretation (the P2 `notes` lesson).

const valid = {
  thesis: 'Bought far-OTM calls.', outcome: 'They printed 10x.', context: null,
  category: 'high-risk-high-reward', tags: ['far-otm', 'gain-porn'],
  summary: 'A deliberate lottery ticket that hit.', tldr: 'Lottery ticket printed.', confidence: 0.7,
}

describe('buildInterpretationSchema — the structural herd gate (invariant P4)', () => {
  it('herd-following parses ONLY when allowed', () => {
    const herd = { ...valid, category: 'herd-following' }
    expect(() => buildInterpretationSchema(true).parse(herd)).not.toThrow()
    expect(() => buildInterpretationSchema(false).parse(herd)).toThrow()
    // every other category parses either way
    for (const c of CATEGORIES.filter((c) => c !== 'herd-following')) {
      expect(() => buildInterpretationSchema(false).parse({ ...valid, category: c })).not.toThrow()
    }
  })

  it('tags are lowercased; confidence is bounded', () => {
    const out = buildInterpretationSchema(true).parse({ ...valid, tags: ['Far-OTM'] })
    expect(out.tags).toEqual(['far-otm'])
    expect(() => buildInterpretationSchema(true).parse({ ...valid, confidence: 1.5 })).toThrow()
  })
})

describe('sanitizeRawInterpretation — truncation repair, never a burned call', () => {
  it('truncates overlong free text and reports what it repaired', () => {
    const { value, repaired } = sanitizeRawInterpretation({
      ...valid,
      summary: 'x'.repeat(SUMMARY_MAX_LEN + 500),
      tldr: 'y'.repeat(TLDR_MAX_LEN + 10),
    })
    expect(repaired).toHaveLength(2)
    expect(() => buildInterpretationSchema(true).parse(value)).not.toThrow()
    expect((value as { summary: string }).summary).toHaveLength(SUMMARY_MAX_LEN)
  })

  it('drops non-string tags, truncates long ones, caps the array', () => {
    const { value, repaired } = sanitizeRawInterpretation({
      ...valid,
      tags: [42, 'ok', 'z'.repeat(80), ...Array.from({ length: 10 }, (_, i) => `t${i}`)],
    })
    const tags = (value as { tags: string[] }).tags
    expect(tags).toHaveLength(MAX_TAGS)
    expect(tags[0]).toBe('ok')
    expect(tags[1]).toHaveLength(30)
    expect(repaired.length).toBeGreaterThanOrEqual(3) // dropped + truncated + capped
  })

  it('non-objects pass through untouched (the parse will fail them loudly)', () => {
    expect(sanitizeRawInterpretation('garbage')).toEqual({ value: 'garbage', repaired: [] })
  })
})

describe('parseInterpretation — the shared gate both analyzer impls ride', () => {
  it('strips herd TAGS below threshold (the machine-consumed leak path), synonyms included', () => {
    const { value, repaired } = parseInterpretation(
      { ...valid, tags: ['herd', 'meme-stock', 'crowd-following', 'bandwagon'] }, false)
    expect(value.tags).toEqual(['meme-stock'])
    expect(repaired.some((r) => r.includes('herd'))).toBe(true)
  })

  it('keeps herd tags when the gate is open', () => {
    const { value } = parseInterpretation({ ...valid, tags: ['herd'] }, true)
    expect(value.tags).toEqual(['herd'])
  })

  it('an out-of-enum category still hard-fails — repair never invents a valid label', () => {
    expect(() => parseInterpretation({ ...valid, category: 'yolo-genius' }, true)).toThrow()
  })
})
