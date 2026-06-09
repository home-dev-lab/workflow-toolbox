// serialize-meta.test.ts — unit tests for serializeMeta (RED → GREEN → REFACTOR)
//
// serializeMeta walks a WorkflowMeta value and:
//   1. Rejects any non-JSON-pure value (functions, undefined, symbols, bigint,
//      class instances including Date) with path-qualified actionable errors.
//   2. Returns `export const meta = ${JSON.stringify(meta, null, 2)}` for valid input.
//
// Tests run before the implementation exists — they will fail (RED) until
// src/bundle.ts is written.

import { describe, it, expect } from 'vitest'

// serializeMeta is exported from bundle.ts (Node-side only)
import { serializeMeta } from '../src/bundle.js'

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('serializeMeta — valid meta', () => {
  it('round-trips a minimal valid meta', () => {
    const meta = { name: 'my-workflow', description: 'Does things' }
    const result = serializeMeta(meta)
    expect(result).toMatch(/^export const meta = \{/)
    const parsed = JSON.parse(result.replace('export const meta = ', ''))
    expect(parsed).toEqual(meta)
  })

  it('round-trips meta with phases array', () => {
    const meta = {
      name: 'my-workflow',
      description: 'Does things',
      phases: [{ title: 'Run', detail: 'Details here' }],
    }
    const result = serializeMeta(meta)
    const parsed = JSON.parse(result.replace('export const meta = ', ''))
    expect(parsed).toEqual(meta)
  })

  it('output starts with "export const meta = {"', () => {
    const meta = { name: 'wf', description: 'x' }
    expect(serializeMeta(meta)).toMatch(/^export const meta = \{/)
  })

  it('allows null values (null is JSON-pure)', () => {
    // null is valid JSON — no throw
    const meta = { name: 'wf', description: 'x', whenToUse: null as unknown as string }
    expect(() => serializeMeta(meta)).not.toThrow()
  })

  it('allows nested objects and arrays', () => {
    const meta = {
      name: 'wf',
      description: 'test',
      phases: [{ title: 'A' }, { title: 'B', model: 'haiku' }],
    }
    const result = serializeMeta(meta)
    expect(result).toContain('"phases"')
    expect(result).toContain('"title": "A"')
  })

  it('allows finite numbers', () => {
    const meta = { name: 'wf', description: 'x', extra: 42 as unknown } as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).not.toThrow()
  })

  it('allows booleans', () => {
    const meta = { name: 'wf', description: 'x', flag: true as unknown } as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Rejection cases — all must include the path in the error message
// ---------------------------------------------------------------------------

describe('serializeMeta — rejects non-JSON-pure values', () => {
  it('rejects function value with path-qualified message', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      fn: () => 'hello',
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.fn/)
  })

  it('rejects undefined property value with path-qualified message', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      undef: undefined,
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.undef/)
  })

  it('rejects Date instance with path-qualified message', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      createdAt: new Date(),
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.createdAt/)
  })

  it('rejects bigint value with path-qualified message', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      big: BigInt(999),
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.big/)
  })

  it('rejects symbol value with path-qualified message', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      sym: Symbol('test'),
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.sym/)
  })

  it('rejects nested function with nested path in message', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      phases: [{ title: 'Run', compute: () => 42 }],
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.phases\[0\]\.compute/)
  })

  it('rejects NaN (not a finite number)', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      val: NaN,
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.val/)
  })

  it('rejects Infinity (not a finite number)', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      val: Infinity,
    } as unknown as Parameters<typeof serializeMeta>[0]
    expect(() => serializeMeta(meta)).toThrow(/meta\.val/)
  })

  it('error message is actionable (mentions the type)', () => {
    const meta = {
      name: 'wf',
      description: 'x',
      fn: () => 'hello',
    } as unknown as Parameters<typeof serializeMeta>[0]
    try {
      serializeMeta(meta)
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect(String(e)).toMatch(/function/)
    }
  })
})
