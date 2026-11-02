// Unit locks for the plan-window contract of quota-window-completeness.mjs: which probe window
// values STATE a window is not part of the plan, and which are a silently dropped window.
import { describe, expect, it } from 'vitest'
import {
  hasCompleteWindows,
  isStatedAbsentWindow,
  missingWindows,
  planWindowChanges,
  windowsAbsentFromPlan,
  windowsInWords,
} from '../../../../plugin/bin/lib/quota-window-completeness.mjs'

const RESET = '2026-11-06T04:00:00.000Z'

describe('isStatedAbsentWindow', () => {
  it('only the literal null states the window is absent', () => {
    expect(isStatedAbsentWindow(null)).toBe(true)
  })

  // An object, however empty it looks, says the window exists and its reading is unusable
  // (cross-family review 2026-11-02: these shapes used to pass as plan absence).
  it.each([
    ['the empty window a probe emits for a window it lost', { pct: null, resets_at: null }],
    ['the empty window with pctRaw null', { pct: null, pctRaw: null, resets_at: null }],
    ['a null pct contradicted by a numeric pctRaw', { pct: null, pctRaw: 94, resets_at: null }],
    ['an empty window with no reset key', { pct: null }],
    ['undefined (the probe said nothing)', undefined],
    ['an object with no pct key', {}],
    ['a non-number pct', { pct: 'high', resets_at: null }],
    ['a reset time with no percentage', { pct: null, resets_at: RESET }],
    ['a string', 'none'],
    ['an array', []],
    ['a real reading', { pct: 0, resets_at: RESET }],
  ])('%s does not', (_label, value) => {
    expect(isStatedAbsentWindow(value)).toBe(false)
  })
})

describe('windowsAbsentFromPlan', () => {
  it('names five_hour only when the probe states it absent', () => {
    expect(windowsAbsentFromPlan({ five_hour: { pct: null, resets_at: null }, seven_day: { pct: 40 } })).toEqual([])
    expect(windowsAbsentFromPlan({ five_hour: { pct: null, pctRaw: 94, resets_at: null }, seven_day: { pct: 40 } })).toEqual([])
    expect(windowsAbsentFromPlan({ five_hour: null, seven_day: { pct: 40 } })).toEqual(['five_hour'])
    expect(windowsAbsentFromPlan({ seven_day: { pct: 40 } })).toEqual([])
    expect(windowsAbsentFromPlan(null)).toEqual([])
  })

  it('never names seven_day: a plan is managed by its weekly window', () => {
    expect(windowsAbsentFromPlan({ five_hour: { pct: 3 }, seven_day: null })).toEqual([])
  })
})

describe('missingWindows and hasCompleteWindows', () => {
  it('a window stated absent is not missing; any other gap still is', () => {
    expect(missingWindows({ seven_day: { pct: 40 } }, ['five_hour'])).toEqual([])
    expect(missingWindows({ seven_day: { pct: 40 } })).toEqual(['five_hour'])
    expect(missingWindows({}, ['five_hour'])).toEqual(['seven_day'])
    expect(missingWindows(null)).toEqual(['five_hour', 'seven_day'])
    expect(hasCompleteWindows({ seven_day: { pct: 40 } }, undefined, ['five_hour'])).toBe(true)
    expect(hasCompleteWindows({ seven_day: { pct: 40 } })).toBe(false)
  })
})

describe('planWindowChanges and windowsInWords', () => {
  it('reports a window leaving and rejoining the plan', () => {
    expect(planWindowChanges([], ['five_hour'])).toEqual({ left: ['five_hour'], returned: [] })
    expect(planWindowChanges(['five_hour'], [])).toEqual({ left: [], returned: ['five_hour'] })
    expect(planWindowChanges(['five_hour'], ['five_hour'])).toEqual({ left: [], returned: [] })
  })

  it('names windows in words', () => {
    expect(windowsInWords(['five_hour'])).toBe('the 5-hour window')
    expect(windowsInWords(['five_hour', 'seven_day'])).toBe('the 5-hour and 7-day windows')
  })
})
