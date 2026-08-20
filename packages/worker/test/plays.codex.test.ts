import { describe, expect, it } from 'vitest'

import { CodexApiError, isUnbilledRejection, parseCodexSse, strictifyJsonSchema } from '../src/plays/analyzer'

// The Codex subscription path (P2, 2026-08-19): SSE parsing + wire-schema strictification, pinned
// against the shapes observed in the live probe. Auth/refresh is exercised live, not here.

describe('parseCodexSse', () => {
  const sse = [
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"type":"reasoning"}}',
    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"{\\"a\\":1"}]}}',
    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"}"}]}}',
    // observed live: response.completed carries usage but an EMPTY output array
    'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":3920,"output_tokens":264}}}',
    '',
  ].join('\n')

  it('collects output_text from message items and usage from response.completed', () => {
    expect(parseCodexSse(sse)).toEqual({ text: '{"a":1}', inputTokens: 3920, outputTokens: 264 })
  })

  it('ignores junk lines; missing usage is null, not 0 (a $0 meter is the enemy)', () => {
    expect(parseCodexSse('data: not-json\n\ndata: {"type":"noise"}\n'))
      .toEqual({ text: '', inputTokens: null, outputTokens: null })
  })

  it('a response.failed event throws (stage-crash path, not silent empty output)', () => {
    expect(() => parseCodexSse('data: {"type":"response.failed","error":"boom"}\n')).toThrow(CodexApiError)
  })
})

describe('strictifyJsonSchema', () => {
  it('forces additionalProperties:false + full required on every object; strips constraint keywords', () => {
    const out = strictifyJsonSchema({
      $schema: 'x',
      type: 'object',
      properties: {
        t: { type: 'string', minLength: 1, maxLength: 12 },
        nested: { type: 'object', properties: { q: { type: 'number', exclusiveMinimum: 0 } } },
      },
      required: ['t'], // partial — must become full
    }) as Record<string, unknown>
    expect(out.additionalProperties).toBe(false)
    expect(out.required).toEqual(['t', 'nested'])
    expect(out.$schema).toBeUndefined()
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.t!.minLength).toBeUndefined()
    // `pattern` SURVIVES — it's the only machine-readable format signal for the ISO dates.
    const withPattern = strictifyJsonSchema({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', minLength: 1 }) as Record<string, unknown>
    expect(withPattern.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$')
    expect(withPattern.minLength).toBeUndefined()
    expect(props.nested!.additionalProperties).toBe(false)
    expect((props.nested!.properties as Record<string, Record<string, unknown>>).q!.exclusiveMinimum).toBeUndefined()
  })
})

describe('isUnbilledRejection covers Codex errors', () => {
  it('401/403 CodexApiError is unbilled; 500 is not', () => {
    expect(isUnbilledRejection(new CodexApiError('no', 403))).toBe(true)
    expect(isUnbilledRejection(new CodexApiError('no', 401))).toBe(true)
    expect(isUnbilledRejection(new CodexApiError('bad param', 400))).toBe(true)
    expect(isUnbilledRejection(new CodexApiError('boom', 500))).toBe(false)
    expect(isUnbilledRejection(new Error('x'))).toBe(false)
  })
})

describe('writeAuthFile', () => {
  it('merges the openai-codex key into an existing file without dropping other keys, atomically', async () => {
    const { writeAuthFile } = await import('../src/plays/codex-auth')
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    const path = join(dir, 'auth.json')
    writeFileSync(path, JSON.stringify({ 'other-provider': { keep: true }, 'openai-codex': { access: 'old' } }))
    const auth = { access: 'new', refresh: 'r', expires: 123, accountId: 'acc' }
    await writeAuthFile(path, auth)
    const out = JSON.parse(readFileSync(path, 'utf8'))
    expect(out['openai-codex']).toEqual(auth)
    expect(out['other-provider']).toEqual({ keep: true })
  })
  it('creates the file when absent; a garbage file is replaced, not crashed on', async () => {
    const { writeAuthFile } = await import('../src/plays/codex-auth')
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    const fresh = join(dir, 'new.json')
    const auth = { access: 'a', refresh: 'r', expires: 1, accountId: 'x' }
    await writeAuthFile(fresh, auth)
    expect(JSON.parse(readFileSync(fresh, 'utf8'))['openai-codex']).toEqual(auth)
    const garbage = join(dir, 'garbage.json')
    writeFileSync(garbage, 'not json')
    await writeAuthFile(garbage, auth)
    expect(JSON.parse(readFileSync(garbage, 'utf8'))['openai-codex']).toEqual(auth)
  })
})

describe('CodexAnalyzer pre-dispatch auth failures', () => {
  it('an unusable auth file surfaces as an UNBILLED CodexApiError 401 — no request was dispatched', async () => {
    const { CodexAnalyzer, CodexApiError, isUnbilledRejection } = await import('../src/plays/analyzer')
    const analyzer = new CodexAnalyzer({
      model: 'gpt-5.6-sol', maxOutputTokens: 4096,
      authFile: '/nonexistent/path/auth.json',
      fetchImpl: () => { throw new Error('must not dispatch') },
    } as never)
    const err = await analyzer.extract([], { title: 't', selftext: null, flair: null }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodexApiError)
    expect((err as InstanceType<typeof CodexApiError>).statusCode).toBe(401)
    expect(isUnbilledRejection(err)).toBe(true)
  })
})
