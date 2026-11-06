// Unit locks for the per-window contract of quota-window-completeness.mjs: a reading is usable when
// it carries at least one window with a numeric percentage (and, for the cache door, every window
// the watcher's previous reading carried); a window without one is only "not reported", never absence.
import { describe, expect, it } from 'vitest'
import * as completeness from '../../../../plugin/bin/lib/quota-window-completeness.mjs'

const { isUsableReading, missingWindows, windowsInWords } = completeness

describe('isUsableReading', () => {
  it('a reading with one numeric window is usable on its own: a missing window never blinds the other', () => {
    expect(isUsableReading({ seven_day: { pct: 40 } })).toBe(true)
    expect(isUsableReading({ five_hour: { pct: 40 } })).toBe(true)
    expect(isUsableReading({ five_hour: { pct: 1 }, seven_day: { pct: 1 } })).toBe(true)
    expect(isUsableReading({ five_hour: { pct: 0 }, seven_day: { pct: 0 } })).toBe(true)
  })

  it.each([
    ['an empty reading', {}],
    ['only an unrelated key', { weekly_scoped: [] }],
    ['null', null],
    ['a string', 'none'],
    ['an array', []],
    ['undefined', undefined],
  ])('%s, with no window at all, is never usable', (_label, windows) => {
    expect(isUsableReading(windows)).toBe(false)
  })

  it('the cache door also requires every window the previous reading carried', () => {
    expect(isUsableReading({ seven_day: { pct: 40 } }, ['five_hour', 'seven_day'])).toBe(false)
    expect(isUsableReading({ seven_day: { pct: 40 } }, ['seven_day'])).toBe(true)
    expect(isUsableReading({ five_hour: { pct: 3 }, seven_day: { pct: 40 } }, ['seven_day'])).toBe(true)
    expect(isUsableReading({}, [])).toBe(false)
  })
})

describe('missingWindows and windowsInWords', () => {
  it('names the watched windows a reading did not carry', () => {
    expect(missingWindows({ seven_day: { pct: 40 } })).toEqual(['five_hour'])
    expect(missingWindows({})).toEqual(['five_hour', 'seven_day'])
    expect(missingWindows(null)).toEqual(['five_hour', 'seven_day'])
    expect(missingWindows({ five_hour: { pct: 1 } }, ['five_hour'])).toEqual([])
  })

  it('says the windows in words', () => {
    expect(windowsInWords(['five_hour'])).toBe('the 5-hour window')
    expect(windowsInWords(['five_hour', 'seven_day'])).toBe('the 5-hour and 7-day windows')
  })
})

describe('no reading-based plan-absence semantics remain', () => {
  // Round 3 (card 1899394115301279304): no source on the reference machine states a window absent,
  // and the host documents omission as also meaning "reset passed". Absence is not decidable from a
  // reading, so the module exports nothing that claims to decide it.
  it.each(['isStatedAbsentWindow', 'windowsAbsentFromPlan', 'planWindowChanges', 'PLAN_OPTIONAL_WINDOW_KEYS', 'hasCompleteWindows'])('%s is gone', (name) => {
    expect(Object.hasOwn(completeness, name)).toBe(false)
  })
})
