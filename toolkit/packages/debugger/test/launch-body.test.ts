// launch-body.test.ts — unit tests for the PURE launch-request body builder (card
// #1820589984604750931): `wt-observe launch` must send the requester's cwd so the observe
// server can attribute the delegated run to the REQUESTING project's timeline bucket
// instead of the generic "Delegated" one (server side shipped separately — POST /api/launch
// accepts an optional `requesterCwd`, non-empty string when present, 400 otherwise).
// Same posture as launch-enable-state.test.ts: the pure decision is unit-tested here; the
// cmdLaunch wiring (process.cwd() at the call site) is exercised by typecheck + the
// build-freshness gate on the shipped bins.

import { describe, expect, it } from 'vitest'
import { buildLaunchBody, safeRequesterCwd, resolveLaunchTimeoutMs, LAUNCH_DEFAULT_TIMEOUT_MS } from '../src/launch-body.js'

describe('buildLaunchBody', () => {
  it('includes script and requesterCwd, omits args when undefined', () => {
    expect(buildLaunchBody('wt-smoke.js', undefined, '/home/user/proj')).toEqual({
      script: 'wt-smoke.js',
      requesterCwd: '/home/user/proj',
    })
  })

  it('includes args when provided (even falsy JSON values)', () => {
    expect(buildLaunchBody('wf.js', { a: 1 }, '/p')).toEqual({ script: 'wf.js', args: { a: 1 }, requesterCwd: '/p' })
    expect(buildLaunchBody('wf.js', null, '/p')).toEqual({ script: 'wf.js', args: null, requesterCwd: '/p' })
    expect(buildLaunchBody('wf.js', false, '/p')).toEqual({ script: 'wf.js', args: false, requesterCwd: '/p' })
  })

  it('omits requesterCwd when empty — the server 400s an empty string, absent is the compatible degrade', () => {
    expect(buildLaunchBody('wf.js', undefined, '')).toEqual({ script: 'wf.js' })
  })

  it('omits requesterCwd when whitespace-only — trimmed emptiness is the same degenerate case', () => {
    expect(buildLaunchBody('wf.js', undefined, '   ')).toEqual({ script: 'wf.js' })
  })

  it('keeps a real cwd verbatim (no trimming of meaningful paths)', () => {
    expect(buildLaunchBody('wf.js', undefined, '/a b/c')).toEqual({ script: 'wf.js', requesterCwd: '/a b/c' })
  })
})

// TEST-LOCK for the pr-review findings on 98d77bc (bundle review): the
// cwd-throw branch must be executable in tests, and the degradation must be
// LOUD (a diagnostic note), never silent.
describe('safeRequesterCwd', () => {
  it('passes a resolvable cwd through with no note', () => {
    expect(safeRequesterCwd(() => '/home/user/proj')).toEqual({ cwd: '/home/user/proj', note: null })
  })

  it('degrades a throwing cwd to "" (omitted by buildLaunchBody) WITH a diagnostic note', () => {
    const out = safeRequesterCwd(() => { throw new Error('ENOENT: deleted cwd') })
    expect(out.cwd).toBe('')
    expect(out.note).toContain('requesterCwd unavailable')
    expect(out.note).toContain('Delegated bucket')
    // and the composed body indeed omits the field
    expect(buildLaunchBody('wf.js', undefined, out.cwd)).toEqual({ script: 'wf.js' })
  })
})

// TEST-LOCK for card #1821667078139020890 — the hard 30s /api/launch cap left no knob, so
// a slow server-side spawn under concurrent load aborted the request. The pure timeout
// resolver is unit-tested here; the cmdLaunch wiring (flag/env at the call site + the
// honest timeout message) is exercised by typecheck + the build-freshness gate on the bins.
describe('resolveLaunchTimeoutMs', () => {
  it('defaults to 30s when neither the flag nor the env is set', () => {
    expect(resolveLaunchTimeoutMs(undefined, undefined)).toBe(LAUNCH_DEFAULT_TIMEOUT_MS)
    expect(resolveLaunchTimeoutMs(undefined, undefined)).toBe(30_000)
  })

  it('the --launch-timeout-s flag (seconds) wins and is converted to ms', () => {
    expect(resolveLaunchTimeoutMs('90', undefined)).toBe(90_000)
    expect(resolveLaunchTimeoutMs('90', '5000')).toBe(90_000) // flag beats env
  })

  it('falls back to OBSERVE_LAUNCH_TIMEOUT_MS (ms) when there is no flag', () => {
    expect(resolveLaunchTimeoutMs(undefined, '120000')).toBe(120_000)
  })

  it('ignores a non-positive or non-numeric value (never a 0/NaN that would abort instantly)', () => {
    expect(resolveLaunchTimeoutMs('0', undefined)).toBe(30_000)
    expect(resolveLaunchTimeoutMs('-5', undefined)).toBe(30_000)
    expect(resolveLaunchTimeoutMs('abc', undefined)).toBe(30_000)
    expect(resolveLaunchTimeoutMs('abc', '60000')).toBe(60_000) // a bad flag still lets the env through
    expect(resolveLaunchTimeoutMs(undefined, '0')).toBe(30_000)
    expect(resolveLaunchTimeoutMs(undefined, 'nope')).toBe(30_000)
  })
})
