// transcript-usage.test.ts — unit tests for the PURE per-agent transcript usage parser.
//
// parseTranscriptUsage(jsonl) sums one agent transcript's billed token usage. The hard
// part (proven against a real transcript: 9 assistant lines / 5 distinct message.id, the
// same id streamed with output_tokens growing 4→134) is DEDUP BY message.id — keep the
// final (max-output) snapshot per id, then sum across DISTINCT ids. Naive line-summing
// double-counts. Input/cache values are stable within an id, so max-output co-selects the
// right input/cache. Tolerant by contract: malformed/non-assistant/usage-less lines are
// skipped, an empty transcript yields zeros, and it never throws.

import { describe, it, expect } from 'vitest'
import { parseTranscriptUsage, emptyUsage, addUsage } from '../src/transcript-usage.js'

/** Build one assistant transcript line with a usage block. */
function line(
  id: string | null,
  u: { i?: number; o?: number; cr?: number; cc?: number; nested?: boolean },
): string {
  const usage: Record<string, unknown> = {
    input_tokens: u.i ?? 0,
    output_tokens: u.o ?? 0,
    cache_read_input_tokens: u.cr ?? 0,
    cache_creation_input_tokens: u.cc ?? 0,
  }
  // The real SDK usage block carries BOTH the scalar AND a nested object — assert we read
  // the scalar, never the object.
  if (u.nested) usage['cache_creation'] = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 999 }
  const message: Record<string, unknown> = { usage }
  if (id !== null) message['id'] = id
  return JSON.stringify({ type: 'assistant', message })
}

describe('parseTranscriptUsage — dedup by message.id', () => {
  it('keeps the final (max-output) snapshot per id, summing across distinct ids', () => {
    const jsonl = [
      line('m1', { i: 100, o: 4, cr: 10, cc: 5 }), // streaming snapshot (not final)
      line('m1', { i: 100, o: 134, cr: 10, cc: 5 }), // final snapshot of the SAME message
      line('m2', { i: 200, o: 50, cr: 20, cc: 8 }),
    ].join('\n')
    expect(parseTranscriptUsage(jsonl)).toEqual({
      inputTokens: 300, // 100 + 200 (m1 counted once, not 100+100)
      outputTokens: 184, // 134 + 50 (the 4 snapshot dropped)
      cacheReadTokens: 30,
      cacheCreationTokens: 13,
    })
  })

  it('treats id-less lines as distinct (older SDK) — never collapses them together', () => {
    const jsonl = [line(null, { i: 5, o: 5 }), line(null, { i: 5, o: 5 })].join('\n')
    expect(parseTranscriptUsage(jsonl)).toMatchObject({ inputTokens: 10, outputTokens: 10 })
  })
})

describe('parseTranscriptUsage — schema details', () => {
  it('reads the scalar cache_creation_input_tokens, IGNORING the nested cache_creation object', () => {
    const r = parseTranscriptUsage(line('m1', { cc: 7, nested: true }))
    expect(r.cacheCreationTokens).toBe(7) // the scalar, not 999 from the nested object
  })
})

describe('parseTranscriptUsage — tolerance (never throws)', () => {
  it('skips malformed, non-assistant, and usage-less lines; sums only valid usage', () => {
    const jsonl = [
      '{ not json',
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'no-usage' } }),
      '',
      line('real', { i: 12, o: 3, cr: 4, cc: 1 }),
    ].join('\n')
    expect(parseTranscriptUsage(jsonl)).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheCreationTokens: 1,
    })
  })

  it('returns zeros for an empty / whitespace-only transcript', () => {
    expect(parseTranscriptUsage('')).toEqual(emptyUsage())
    expect(parseTranscriptUsage('\n  \n')).toEqual(emptyUsage())
  })

  it('coerces non-numeric usage fields to 0 rather than throwing', () => {
    const bad = JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 'lots' } } })
    expect(parseTranscriptUsage(bad)).toEqual(emptyUsage())
  })
})

describe('emptyUsage / addUsage', () => {
  it('emptyUsage is all-zero', () => {
    expect(emptyUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('addUsage sums field-wise without mutating its inputs', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }
    const b = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 }
    expect(addUsage(a, b)).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 })
    expect(a).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }) // unmutated
  })
})
