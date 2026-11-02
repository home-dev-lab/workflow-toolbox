import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as completeness from './quota-window-completeness.mjs'

const { hasCompleteWindows, WATCHED_WINDOW_KEYS } = completeness

for (const [label, optional] of [
  ['missing five-hour key', {}],
  ['null five-hour window', { five_hour: null }],
  ['null five-hour pct', { five_hour: { pct: null, resets_at: null } }],
]) {
  test(`a numeric seven-day window is complete with ${label}`, () => {
    assert.equal(hasCompleteWindows({ ...optional, seven_day: { pct: 38 } }), true,
      'seven-day data must be complete when five-hour data is absent or null')
  })
}

test('missing or unusable seven-day data is incomplete despite numeric optional data', () => {
  for (const required of [{}, { seven_day: null }, { seven_day: { pct: null } }, { seven_day: { pct: NaN } }]) {
    assert.equal(hasCompleteWindows({ five_hour: { pct: 95 }, ...required }), false,
      'optional data must not make an unusable seven-day reading healthy')
  }
})

test('every optional window fails to establish health on its own', () => {
  const requiredKeys = completeness.REQUIRED_WINDOW_KEYS ?? ['seven_day']
  const optionalKeys = WATCHED_WINDOW_KEYS.filter((key) => !requiredKeys.includes(key))
  assert.ok(optionalKeys.length > 0, 'the optional-window invariant must not be vacuous')
  for (const key of optionalKeys) {
    for (const pct of [null, 95]) {
      const windows = Object.fromEntries(WATCHED_WINDOW_KEYS.map((windowKey) => [windowKey, { pct: null }]))
      windows[key] = { pct }
      assert.equal(hasCompleteWindows(windows), false, `${key} alone must never establish health`)
    }
  }
})

test('both numeric windows, including zero usage, remain complete', () => {
  assert.equal(hasCompleteWindows({ five_hour: { pct: 0 }, seven_day: { pct: 0 } }), true)
})

test('invalid containers and empty readings remain incomplete', () => {
  for (const windows of [null, undefined, [], {}, 'invalid']) {
    assert.equal(hasCompleteWindows(windows), false)
  }
})
