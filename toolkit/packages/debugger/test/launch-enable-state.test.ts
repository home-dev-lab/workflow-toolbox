// launch-enable-state.test.ts — unit tests for the PURE parts of the per-source live-launch
// opt-in persistence (card #1812476922312000519, increment B): serialize/parse. The fs-edge
// functions (write/exists/clear) and the observe-cli `stop` wiring are exercised only via
// typecheck + the small CLI change itself — same posture this package already takes for its
// sibling impure state modules (observe-config.ts has no dedicated test file either; only the
// PURE decision/parse functions get unit tests here, per this increment's own scoping).

import { describe, expect, it } from 'vitest'
import { parseLaunchEnableRecord, serializeLaunchEnableRecord } from '../src/launch-enable-state.js'

describe('serializeLaunchEnableRecord / parseLaunchEnableRecord', () => {
  it('round-trips a record', () => {
    const rec = { enabledAt: '2026-07-08T00:00:00.000Z' }
    expect(parseLaunchEnableRecord(serializeLaunchEnableRecord(rec))).toEqual(rec)
  })

  it('parseLaunchEnableRecord returns null on garbage (not JSON)', () => {
    expect(parseLaunchEnableRecord('{not json')).toBeNull()
  })

  it('parseLaunchEnableRecord returns null on a JSON array (not an object)', () => {
    expect(parseLaunchEnableRecord('[1,2,3]')).toBeNull()
  })

  it('parseLaunchEnableRecord returns null when enabledAt is missing', () => {
    expect(parseLaunchEnableRecord('{}')).toBeNull()
  })

  it('parseLaunchEnableRecord returns null when enabledAt is not a string', () => {
    expect(parseLaunchEnableRecord(JSON.stringify({ enabledAt: 12345 }))).toBeNull()
  })
})
