// Standalone `node --test` locks for quota-window-completeness.mjs, on the per-window contract: a
// reading is usable when it carries at least one watched window. The vitest twin is toolkit/packages/build/test/quota-window-completeness.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUsableReading, missingWindows } from './quota-window-completeness.mjs'

for (const [label, optional] of [
  ['missing five-hour key', {}],
  ['null five-hour window', { five_hour: null }],
  ['null five-hour pct', { five_hour: { pct: null, resets_at: null } }],
]) {
  test(`a numeric seven-day window is usable with ${label}`, () => {
    assert.equal(isUsableReading({ ...optional, seven_day: { pct: 38 } }), true, 'seven-day data must be usable when five-hour data is absent or null')
  })
}

test('both windows, including zero usage, remain usable', () => {
  assert.equal(isUsableReading({ five_hour: { pct: 0 }, seven_day: { pct: 0 } }), true)
  assert.deepEqual(missingWindows({ five_hour: { pct: 0 }, seven_day: { pct: 0 } }), [])
})

test('invalid containers and empty readings are never usable', () => {
  for (const windows of [null, undefined, [], {}, 'invalid']) {
    assert.equal(isUsableReading(windows), false)
  }
})
