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
    expect(props.nested!.additionalProperties).toBe(false)
    expect((props.nested!.properties as Record<string, Record<string, unknown>>).q!.exclusiveMinimum).toBeUndefined()
  })
})

describe('isUnbilledRejection covers Codex errors', () => {
  it('401/403 CodexApiError is unbilled; 500 is not', () => {
    expect(isUnbilledRejection(new CodexApiError('no', 403))).toBe(true)
    expect(isUnbilledRejection(new CodexApiError('no', 401))).toBe(true)
    expect(isUnbilledRejection(new CodexApiError('boom', 500))).toBe(false)
    expect(isUnbilledRejection(new Error('x'))).toBe(false)
  })
})
