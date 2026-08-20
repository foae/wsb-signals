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
      extractModel: 'gpt-5.6-sol', interpretModel: 'gpt-5.6-luna', maxOutputTokens: 4096,
      authFile: '/nonexistent/path/auth.json',
      fetchImpl: () => { throw new Error('must not dispatch') },
    } as never)
    const err = await analyzer.extract([], { title: 't', selftext: null, flair: null }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodexApiError)
    expect((err as InstanceType<typeof CodexApiError>).statusCode).toBe(401)
    expect(isUnbilledRejection(err)).toBe(true)
  })
})

describe('CodexAnalyzer.interpret wire contract (P3)', () => {
  const interpretation = {
    thesis: 'Bought calls.', outcome: 'It printed.', context: null,
    category: 'high-risk-high-reward', tags: ['far-otm'], summary: 'A far-OTM call bet that hit.',
    tldr: 'Far-OTM calls printed.', confidence: 0.8,
  }
  const sseFor = (obj: unknown): string => [
    `data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":${
      JSON.stringify(JSON.stringify(obj))}}]}}`,
    'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":2000,"output_tokens":300}}}',
    '',
  ].join('\n')

  const run = async (allowHerd: boolean, body = interpretation): Promise<{ req: Record<string, unknown>; result: Awaited<ReturnType<InstanceType<typeof import('../src/plays/analyzer').CodexAnalyzer>['interpret']>> }> => {
    const { CodexAnalyzer } = await import('../src/plays/analyzer')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'codex-interpret-'))
    const authFile = join(dir, 'auth.json')
    // A far-future access token so credentials() never tries to refresh over the network.
    writeFileSync(authFile, JSON.stringify({
      'openai-codex': { access: 'tok', refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'acc' },
    }))
    let req: Record<string, unknown> = {}
    const analyzer = new CodexAnalyzer({
      extractModel: 'gpt-5.6-sol', interpretModel: 'gpt-5.6-luna', maxOutputTokens: 4096, authFile,
      fetchImpl: (async (_url: unknown, init: { body: string }) => {
        req = JSON.parse(init.body) as Record<string, unknown>
        return { status: 200, text: async () => sseFor(body) }
      }) as never,
    })
    const result = await analyzer.interpret({
      text: { title: 'YOLO', selftext: null, flair: 'Gain', postedAt: '2026-08-20' },
      extraction: { positions: [] } as never,
      evidence: { evidence_version: 'evidence-v1' } as never,
      allowHerd,
    })
    return { req, result }
  }

  it('text-only input, interpret model, and the herd-INCLUSIVE enum when allowHerd', async () => {
    const { req, result } = await run(true)
    expect(req.model).toBe('gpt-5.6-luna')
    const input = req.input as Array<{ content: Array<{ type: string }> }>
    expect(input[0]!.content.every((c) => c.type === 'input_text')).toBe(true) // never images
    const format = (req.text as { format: { name: string; schema: unknown } }).format
    expect(format.name).toBe('play_interpretation')
    const categoryEnum = (format.schema as { properties: { category: { enum: string[] } } }).properties.category.enum
    expect(categoryEnum).toContain('herd-following')
    expect(result.interpretation.category).toBe('high-risk-high-reward')
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 300 })
    expect(result.model).toBe('gpt-5.6-luna')
  })

  it('the enum EXCLUDES herd-following below threshold (invariant P4, structural), and a stray herd tag is stripped', async () => {
    const { req, result } = await run(false, { ...interpretation, tags: ['far-otm', 'herd-following'] })
    const format = (req.text as { format: { schema: unknown } }).format
    const categoryEnum = (format.schema as { properties: { category: { enum: string[] } } }).properties.category.enum
    expect(categoryEnum).not.toContain('herd-following')
    expect(result.interpretation.tags).toEqual(['far-otm'])
  })

  it('a herd-following CATEGORY sneaking past a below-threshold gate fails the parse (stage crash, never published)', async () => {
    const err = await run(false, { ...interpretation, category: 'herd-following' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodexApiError)
    expect(String(err)).toContain('unparseable structured output')
  })
})
