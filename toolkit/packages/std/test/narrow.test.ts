import { describe, it, expect } from 'vitest'
import { isRecord, numOrNull, strOrNull } from '../src/narrow.js'

describe('narrow', () => {
  it('isRecord excludes arrays, null, and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(3)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })

  it('numOrNull keeps finite numbers only', () => {
    expect(numOrNull(3)).toBe(3)
    expect(numOrNull(0)).toBe(0)
    expect(numOrNull(Number.NaN)).toBe(null)
    expect(numOrNull(Number.POSITIVE_INFINITY)).toBe(null)
    expect(numOrNull('3')).toBe(null)
    expect(numOrNull(null)).toBe(null)
  })

  it('strOrNull keeps strings only (including empty)', () => {
    expect(strOrNull('a')).toBe('a')
    expect(strOrNull('')).toBe('')
    expect(strOrNull(3)).toBe(null)
    expect(strOrNull(null)).toBe(null)
  })
})
