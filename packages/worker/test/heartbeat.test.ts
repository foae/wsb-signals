import { describe, expect, it } from 'vitest'

import { heartbeatVerdict } from '../src/heartbeat-core'
import { ArcticShiftSource } from '../src/ingest'
import { startMockArctic } from './helpers/mockArctic'

// ---------------------------------------------------------------------------
// Pure unit tests for heartbeatVerdict
// ---------------------------------------------------------------------------

const THRESHOLD = 1800 // 30 min, for readability

describe('heartbeatVerdict', () => {
  it('both null → code 2 (NO-DATA)', () => {
    const v = heartbeatVerdict(null, null, THRESHOLD)
    expect(v.code).toBe(2)
    expect(v.status).toBe('NO-DATA')
  })

  it('both fresh (lags < threshold) → code 0 (OK)', () => {
    const v = heartbeatVerdict(300, 600, THRESHOLD)
    expect(v.code).toBe(0)
    expect(v.status).toBe('OK')
  })

  it('both stale (lags > threshold) → code 1 (STALE)', () => {
    const v = heartbeatVerdict(7200, 5400, THRESHOLD)
    expect(v.code).toBe(1)
    expect(v.status).toBe('STALE')
  })

  it('one missing, one fresh → code 2 (NO-DATA; one kind cannot mask the other)', () => {
    const v = heartbeatVerdict(null, 300, THRESHOLD)
    expect(v.code).toBe(2)
    expect(v.status).toBe('NO-DATA')
  })

  it('one missing, one stale → code 2 (NO-DATA takes precedence)', () => {
    const v = heartbeatVerdict(null, 7200, THRESHOLD)
    expect(v.code).toBe(2)
    expect(v.status).toBe('NO-DATA')
  })

  it('exactly at threshold (lag == threshold) → code 0 (Python uses <=)', () => {
    const v = heartbeatVerdict(THRESHOLD, THRESHOLD, THRESHOLD)
    expect(v.code).toBe(0)
    expect(v.status).toBe('OK')
  })

  it('detail includes comment/post minutes and threshold', () => {
    const v = heartbeatVerdict(120, 300, THRESHOLD)
    // 120s = 2.0 min, 300s = 5.0 min, 1800s = 30 min
    expect(v.detail).toBe('comment=2.0 min, post=5.0 min; threshold=30 min')
  })

  it('detail uses ? placeholders for null lags', () => {
    const v = heartbeatVerdict(null, 300, THRESHOLD)
    expect(v.detail).toMatch(/^comment=\?/)
    expect(v.detail).toContain(', post=5.0 min')
  })
})

// ---------------------------------------------------------------------------
// newestItemLag tests with mocked fetch
// ---------------------------------------------------------------------------

const NOW = 1_704_070_800

describe('ArcticShiftSource.newestItemLag', () => {
  it('empty data array → null', async () => {
    const mock = await startMockArctic({
      posts: [{ status: 200, data: [] }],
      comments: [{ status: 200, data: [] }],
    })
    try {
      const src = new ArcticShiftSource(mock.baseUrl, 'wallstreetbets')
      const lag = await src.newestItemLag('comments', NOW)
      expect(lag).toBeNull()
    } finally {
      await mock.close()
    }
  })

  it('non-200 status → null', async () => {
    const mock = await startMockArctic({
      posts: [{ status: 503, data: [] }],
      comments: [{ status: 503, data: [] }],
    })
    try {
      const src = new ArcticShiftSource(mock.baseUrl, 'wallstreetbets')
      const lag = await src.newestItemLag('comments', NOW)
      expect(lag).toBeNull()
    } finally {
      await mock.close()
    }
  })

  it('fresh item → small positive lag given injected now', async () => {
    const createdUtc = NOW - 120 // 2 minutes before NOW
    const mock = await startMockArctic({
      posts: [{ status: 200, data: [{ id: 'x1', created_utc: createdUtc }] }],
      comments: [{ status: 200, data: [{ id: 'x2', created_utc: createdUtc }] }],
    })
    try {
      const src = new ArcticShiftSource(mock.baseUrl, 'wallstreetbets')
      const lag = await src.newestItemLag('comments', NOW)
      expect(lag).toBe(120)
    } finally {
      await mock.close()
    }
  })

  it('network error → null', async () => {
    const mock = await startMockArctic({
      posts: [{ error: 'network' }],
      comments: [{ error: 'network' }],
    })
    try {
      const src = new ArcticShiftSource(mock.baseUrl, 'wallstreetbets')
      const lag = await src.newestItemLag('comments', NOW)
      expect(lag).toBeNull()
    } finally {
      await mock.close()
    }
  })
})
