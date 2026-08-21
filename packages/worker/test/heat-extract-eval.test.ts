import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { evaluateHeatExtraction } from '../src/heat-extract-eval'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

describe('labeled heat ticker extraction', () => {
  it('passes the committed precision/recall corpus exactly', () => {
    const result = evaluateHeatExtraction(ROOT)
    expect(result.mismatches).toEqual([])
    expect(result.exactCases).toBe(result.cases)
    expect(result.precision).toBe(1)
    expect(result.recall).toBe(1)
  })
})
