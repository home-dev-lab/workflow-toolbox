// normalize-args.test.ts — unit tests for normalizeArgs (RED → GREEN)
//
// normalizeArgs is the raw-argument adapter used by defineWorkflow.run().
// The runtime delivers string args JSON-encoded (e.g. '"hello"' for the
// string hello), so JSON.parse is tried first; on failure the string is
// returned unchanged for tolerance of plain (non-encoded) strings.

import { describe, it, expect } from 'vitest'
import { normalizeArgs } from '../src/define-workflow.js'

describe('normalizeArgs', () => {
  // -------------------------------------------------------------------------
  // undefined passthrough (no args supplied)
  // -------------------------------------------------------------------------
  it('returns undefined when input is undefined', () => {
    expect(normalizeArgs(undefined)).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // string inputs — JSON-parse first, fall back to raw string
  // -------------------------------------------------------------------------
  it('parses a JSON-encoded string to the inner string value', () => {
    // The runtime delivers the string "hello" as '"hello"' (with quotes)
    expect(normalizeArgs('"hello"')).toBe('hello')
  })

  it('parses a JSON object string to a plain object', () => {
    expect(normalizeArgs('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses a JSON array string to an array', () => {
    expect(normalizeArgs('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('parses a JSON number string to a number', () => {
    expect(normalizeArgs('42')).toBe(42)
  })

  it('parses a JSON boolean string to a boolean', () => {
    expect(normalizeArgs('true')).toBe(true)
  })

  it('returns null literal from JSON null string', () => {
    expect(normalizeArgs('null')).toBeNull()
  })

  it('returns the raw string unchanged when JSON.parse fails', () => {
    // 'not json' is not valid JSON
    expect(normalizeArgs('not json')).toBe('not json')
  })

  it('returns a plain (unquoted) string unchanged when JSON.parse fails', () => {
    // A bare string without quotes is not valid JSON — return as-is
    expect(normalizeArgs('hello world')).toBe('hello world')
  })

  // -------------------------------------------------------------------------
  // non-string values — pass through by reference/value
  // -------------------------------------------------------------------------
  it('passes an object through unchanged by reference', () => {
    const obj = { x: 42 }
    expect(normalizeArgs(obj)).toBe(obj)
  })

  it('passes null through unchanged', () => {
    expect(normalizeArgs(null)).toBeNull()
  })

  it('passes a number through unchanged', () => {
    expect(normalizeArgs(99)).toBe(99)
  })

  it('passes an array through unchanged by reference', () => {
    const arr = [1, 2, 3]
    expect(normalizeArgs(arr)).toBe(arr)
  })

  it('passes false through unchanged', () => {
    expect(normalizeArgs(false)).toBe(false)
  })
})
