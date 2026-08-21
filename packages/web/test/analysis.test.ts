import { describe, expect, it } from 'vitest'

import {
  AnalysisBusyError, AnalysisInputError, MAX_DOSSIER_RANGE_SECONDS, TickerDossierQuerySchema,
  analysisCatalog, resolveDossierRange, withAnalysisSlot,
} from '../server/utils/analysis'

describe('analysis discovery and ranges', () => {
  it('publishes the stable capabilities and mandatory caveats', () => {
    const catalog = analysisCatalog()
    expect(catalog.schemaVersion).toBe('analysis-v1')
    expect(catalog.capabilities).toMatchObject({
      tickerDossier: true,
      playAudit: true,
      directPgExport: true,
      outcomeMarks: false,
    })
    expect(catalog.limits.concurrentReads).toBe(2)
    expect(catalog.limits.retryAfterSeconds).toBe(15)
    expect(catalog.caveats['selection-bias']).toContain('self-selected')
    expect(catalog.caveats['no-ticker-win-rate']).toContain('Never aggregate')
  })

  it('uses [from,to), defaults to seven days, and rejects broad or inverted reads', () => {
    const now = 2_000_000_000
    expect(resolveDossierRange({}, now)).toEqual({ from: now - 7 * 86_400, to: now })
    expect(() => resolveDossierRange({ from: now, to: now }, now)).toThrow(AnalysisInputError)
    expect(() => resolveDossierRange({ from: 1, to: 1 + MAX_DOSSIER_RANGE_SECONDS + 1 }, now))
      .toThrow(/180 days/)
    expect(TickerDossierQuerySchema.safeParse({ from: '1787184000000' }).success).toBe(false)
  })

  it('caps concurrent agent reads so the UI retains database capacity', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withAnalysisSlot(() => gate)
    const second = withAnalysisSlot(() => gate)

    await expect(withAnalysisSlot(async () => undefined)).rejects.toBeInstanceOf(AnalysisBusyError)
    release()
    await Promise.all([first, second])
    await expect(withAnalysisSlot(async () => 'available')).resolves.toBe('available')
  })
})
