import { describe, expect, it } from 'vitest'

import { resolveMediaPath } from '../server/utils/media-path'

// The /api/media/** security control (plays-plan §6): strict shape + traversal guard, extracted pure so
// it can be pinned without booting Nitro. The route itself was additionally smoke-tested live at P1.

const ROOT = '/srv/media/plays'

describe('resolveMediaPath', () => {
  it('accepts exactly the shape the worker writes and maps the content type', () => {
    expect(resolveMediaPath(ROOT, 'abc123/0.jpg'))
      .toEqual({ full: '/srv/media/plays/abc123/0.jpg', contentType: 'image/jpeg' })
    expect(resolveMediaPath(ROOT, 'a_B-9/12.webp')?.contentType).toBe('image/webp')
    expect(resolveMediaPath(ROOT, 'x/1.png')?.contentType).toBe('image/png')
    expect(resolveMediaPath(ROOT, 'x/1.gif')?.contentType).toBe('image/gif')
  })

  it('rejects traversal in every spelling', () => {
    expect(resolveMediaPath(ROOT, '../secrets/0.jpg')).toBeNull()
    expect(resolveMediaPath(ROOT, '..%2f..%2fetc%2fpasswd')).toBeNull()
    expect(resolveMediaPath(ROOT, 'abc/../../0.jpg')).toBeNull()
    expect(resolveMediaPath(ROOT, '/etc/passwd')).toBeNull()
    expect(resolveMediaPath(ROOT, 'abc/0.jpg/../1.jpg')).toBeNull()
  })

  it('rejects shapes the worker never writes', () => {
    expect(resolveMediaPath(ROOT, 'abc123/evil.sh')).toBeNull()
    expect(resolveMediaPath(ROOT, 'abc123/0.jpeg')).toBeNull() // worker normalizes jpeg → jpg
    expect(resolveMediaPath(ROOT, 'abc123/0.svg')).toBeNull() // never written; SVG can carry script
    expect(resolveMediaPath(ROOT, 'abc123')).toBeNull()
    expect(resolveMediaPath(ROOT, 'a b/0.jpg')).toBeNull()
    expect(resolveMediaPath(ROOT, 'abc123/0.jpg.exe')).toBeNull()
    expect(resolveMediaPath(ROOT, '')).toBeNull()
  })

  it('rejects everything when the media root is unconfigured', () => {
    expect(resolveMediaPath('', 'abc123/0.jpg')).toBeNull()
  })
})
