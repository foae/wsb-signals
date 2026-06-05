import { describe, expect, it } from 'vitest'

// Slice-0 wiring proof: Vitest runs, the shared package resolves, and its inferred types are usable.
// Real parity tests (extract/classify, aggregate) replace this in slices 1–2.
import { mentions } from '@wsb/shared'

describe('worker test wiring', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2)
  })

  it('resolves the shared Drizzle schema', () => {
    // The Drizzle table object carries its SQL name — enough to prove the workspace import path works.
    expect(mentions).toBeDefined()
  })
})
