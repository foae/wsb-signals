import { describe, expect, it } from 'vitest'

import { parseArgs, parseEpoch } from '../src/analysis/client'
import { exportRecordToCsv, mapExportRow } from '../src/analysis/plays-export'

describe('analysis CLI contracts', () => {
  it('parses ISO/epoch times and keeps boolean flags out of positional arguments', () => {
    expect(parseEpoch('2026-08-20', '--from')).toBe(1_787_184_000)
    expect(parseEpoch('1787184000', '--from')).toBe(1_787_184_000)
    expect(() => parseEpoch('20260820', '--from')).toThrow(/2010-01-01/)
    expect(() => parseEpoch('1787184000000', '--from')).toThrow(/2100-01-01/)
    const parsed = parseArgs(['--', 'ticker', 'NVDA', '--from', '2026-08-20', '--pretty'])
    expect(parsed.positionals).toEqual(['ticker', 'NVDA'])
    expect(parsed.options.get('from')).toBe('2026-08-20')
    expect(parsed.options.get('pretty')).toBe(true)
  })

  it('maps joined rows without losing stored evidence and quotes JSON CSV cells', () => {
    const record = mapExportRow({
      id: 'abc1', created_utc: '1787184000', analysis_anchor_utc: '1787184000',
      analysis_anchor_basis: 'post_time', range_utc: '1787184000',
      published_at: '1787184100', title: 'calls, then moon', selftext: '=2+2',
      tags: ['options'], interpretation_run_at: '1787184123456',
      interpretation_evidence: { evidence_version: 'evidence-v1', anchor_utc: 1787184000 },
      marks: null, links: [],
    })

    expect(record).toMatchObject({
      id: 'abc1', createdUtc: 1_787_184_000, anchorUtc: 1_787_184_000,
      anchorBasis: 'post_time', publishedAt: 1_787_184_100,
      interpretation: {
        runAt: 1_787_184_123_456,
        evidence: { evidence_version: 'evidence-v1', anchor_utc: 1_787_184_000 },
      },
      outcome: { status: 'tracking_not_implemented', marks: null, links: [] },
    })
    const csv = exportRecordToCsv(record)
    expect(csv).toContain('"calls, then moon"')
    expect(csv).toContain('"[""options""]"')
    expect(csv).toContain("'=2+2")
  })
})
