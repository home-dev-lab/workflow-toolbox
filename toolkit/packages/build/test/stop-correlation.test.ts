// stop-correlation.test.ts — the pure discriminator wt-arc-watch.mjs uses to tell a stale-but-
// idle transcript apart from a stale-but-never-tracked one, before deciding whether to emit STALE.
// Fixtures reproduce REAL record shapes measured on 2026-08-02 (cards 1832820166895863516 and
// 1829924641678820839), never invented data.

import { describe, it, expect } from 'vitest'
// stop-correlation.mjs lives at plugin/bin/lib/ -- a shipped plugin script outside this package's
// include/rootDir (and outside the whole toolkit/ TS project), so it has no declaration file TS
// can resolve. A co-located sibling .d.ts and an ambient `declare module` augmentation were both
// tried and rejected by tsc for this out-of-project case (TS2665: "resolves to an untyped module,
// which cannot be augmented"). Narrow, explicit suppression of the one resulting diagnostic
// (TS7016, implicit any) is the standard escape for importing a real plain-JS module with no
// declarations -- the runtime behavior is exercised directly by every test below, so an `any`
// import here costs no real type safety within this file.
// @ts-expect-error TS7016 -- stop-correlation.mjs has no declaration file (see note above)
import { hasRecordedStop, lastStopTimestamps } from '../../../../plugin/bin/lib/stop-correlation.mjs'

const ms = (iso: string) => Date.parse(iso)

describe('hasRecordedStop — real record shapes, timestamp-aware', () => {
  it('matches on the explicit NAME when a recent stop record carries it correctly (teammate spawn shape)', () => {
    const stops = new Map([['s-twg-codemap', '2026-07-31T13:33:11.019Z']])
    const modifiedAt = ms('2026-07-31T13:33:11.019Z')
    expect(hasRecordedStop(stops, { name: 's-twg-codemap', agentType: 'general-purpose' }, modifiedAt)).toBe(true)
  })

  // FAILS if the agentType fallback is removed — reproduces the real s-fence-125 incident: the
  // spawn's explicit name is "s-fence-125" but every stop record for it carries
  // name:"general-purpose" (the underlying subagent_type), because SubagentStop's agent_type
  // field reports the type, not the name, for a plain non-teammate Agent-tool spawn.
  it('REAL INCIDENT (s-fence-125): matches via the agentType fallback, at the recorded timestamp', () => {
    const stops = new Map([['general-purpose', '2026-08-02T11:43:13.649Z']]) // exactly the real journal's last stop
    const meta = { name: 's-fence-125', agentType: 'general-purpose' }
    const modifiedAt = ms('2026-08-02T11:43:13.649Z') // transcript's last write ~= the final stop
    expect(hasRecordedStop(stops, meta, modifiedAt)).toBe(true)
  })

  // The negative case the whole card exists to preserve: a transcript whose agent genuinely never
  // produced ANY matching stop record must stay UNMATCHED — this is what lets the caller still
  // emit STALE for a real silent-death candidate.
  it('NEGATIVE CASE: no match when neither name nor agentType appears among stop records', () => {
    const stops = new Map([['some-other-agent', '2026-08-02T10:00:00.000Z']])
    const meta = { name: 'truly-silent-worker', agentType: 'Explore' }
    expect(hasRecordedStop(stops, meta, Date.now())).toBe(false)
  })

  it('returns false, never throws, when meta is missing entirely (transcript with no sibling meta.json)', () => {
    const stops = new Map([['whatever', '2026-08-02T10:00:00.000Z']])
    expect(hasRecordedStop(stops, null, Date.now())).toBe(false)
    expect(hasRecordedStop(stops, undefined, Date.now())).toBe(false)
  })

  it('returns false when meta has neither a name nor an agentType (degenerate but must not throw)', () => {
    const stops = new Map([['whatever', '2026-08-02T10:00:00.000Z']])
    expect(hasRecordedStop(stops, {}, Date.now())).toBe(false)
  })

  // ⚠⚠ THE REGRESSION THIS REWRITE EXISTS TO PREVENT — caught before shipping, via a bench that
  // proved a single agent produces ONE stop record PER TURN, not one per agent lifetime. A
  // discriminator matching on "any past stop, ever" would wrongly suppress an agent that stopped
  // cleanly long ago and then died mid-turn on a MUCH LATER turn. The old stop (turn 3) must NOT
  // account for a transcript that has since gone silent again (turn 7, no stop this time).
  it('MULTI-TURN-THEN-DIE: an OLD stop record (an earlier, already-resumed turn) does NOT account for a LATER silence', () => {
    const stops = new Map([['long-lived-worker', '2026-08-02T10:00:00.000Z']]) // turn 3's clean stop, hours ago
    const meta = { name: 'long-lived-worker', agentType: 'general-purpose' }
    // The transcript kept growing after that stop (turn 4, 5, 6 happened), then went silent again
    // much later (turn 7, mid-generation, no stop this time) — modifiedAt reflects THAT silence.
    const modifiedAt = ms('2026-08-02T14:30:00.000Z')
    expect(hasRecordedStop(stops, meta, modifiedAt)).toBe(false)
  })

  it('a stop record a few seconds AFTER modifiedAt still matches — no cap on the forward direction', () => {
    const stops = new Map([['worker', '2026-08-02T14:30:05.000Z']])
    const modifiedAt = ms('2026-08-02T14:30:00.000Z')
    expect(hasRecordedStop(stops, { name: 'worker' }, modifiedAt)).toBe(true)
  })

  // Even a MUCH later stop still accounts for the silence — a later stop only ever makes
  // suppression more justified, whatever the gap.
  it('a stop record MINUTES after modifiedAt still matches — forward direction is uncapped', () => {
    const stops = new Map([['worker', '2026-08-02T14:45:00.000Z']])
    const modifiedAt = ms('2026-08-02T14:30:00.000Z')
    expect(hasRecordedStop(stops, { name: 'worker' }, modifiedAt)).toBe(true)
  })

  // ⚠⚠⚠ THE ASYMMETRIC-TOLERANCE REGRESSION — caught by an independent measurement AFTER the
  // first (symmetric ±60s) version of this fix had already been built. Measured across 325 real
  // (stop, mtime) pairs: forward skew maxes at +0.7s (pure ordering slack), but backward "skew"
  // reaches -46.4s and is mostly NOT skew at all — it is the agent being RESUMED and writing MORE
  // transcript after that stop, i.e. the multi-turn-then-die shape with a gap measured in seconds
  // instead of hours. A symmetric 60s window would have silently re-admitted this exact case.
  it('a stop record 30s BEFORE modifiedAt does NOT match — beyond the tiny backward tolerance, likely a stale resumed-turn stop, not flush skew', () => {
    const stops = new Map([['worker', '2026-08-02T14:29:30.000Z']]) // 30s before modifiedAt
    const modifiedAt = ms('2026-08-02T14:30:00.000Z')
    expect(hasRecordedStop(stops, { name: 'worker' }, modifiedAt)).toBe(false)
  })

  it('a stop record 1s BEFORE modifiedAt still matches — within the small backward tolerance for genuine flush-ordering skew', () => {
    const stops = new Map([['worker', '2026-08-02T14:29:59.000Z']]) // 1s before modifiedAt
    const modifiedAt = ms('2026-08-02T14:30:00.000Z')
    expect(hasRecordedStop(stops, { name: 'worker' }, modifiedAt)).toBe(true)
  })
})

describe('lastStopTimestamps — builds the lookup map from already-parsed journal records', () => {
  it('collects the LATEST timestamp per name, from t:"stop" records only, ignoring spawn/out/nudged/ack', () => {
    const records = [
      { t: 'spawn', name: 'spawned-not-stopped', at: '2026-08-02T10:00:00.000Z' },
      { t: 'stop', name: 'general-purpose', agentId: 'aa877ce816e0c2b0f', at: '2026-08-02T11:42:57.492Z' },
      { t: 'stop', name: 'general-purpose', agentId: 'aa877ce816e0c2b0f', at: '2026-08-02T11:43:13.649Z' },
      { t: 'out', name: 'general-purpose', at: '2026-08-02T11:43:08.206Z' },
      { t: 'ack', name: 'acked-agent', at: '2026-08-02T12:00:00.000Z' },
    ]
    const m = lastStopTimestamps(records)
    expect(m.get('general-purpose')).toBe('2026-08-02T11:43:13.649Z') // the LATER of the two stops
    expect(m.has('spawned-not-stopped')).toBe(false)
    expect(m.has('acked-agent')).toBe(false)
    expect(m.size).toBe(1)
  })

  it('skips malformed stop records (missing/empty name or at) without throwing', () => {
    const records = [{ t: 'stop' }, { t: 'stop', name: '' }, { t: 'stop', name: null }, { t: 'stop', name: 'x' }]
    expect(lastStopTimestamps(records).size).toBe(0)
  })
})

// -------------------------------------------------------------------------------------------
// LIVE-LABELLED CASE — reproduces the real idle-between-turns transcript observed 2026-08-02:
// agent a1f5eb82662eb4d75 (the wave's own orchestrator) produced a legitimate SubagentStop at
// 14:56:36, then went quiet for ~21 minutes before its next turn at 15:18 -- the arc watcher's
// live STALE alert at ~15:10 landed inside that gap. hasRecordedStop must say "matched" for this
// transcript at that moment, because a real, TIME-RELEVANT stop record already accounts for it.
// -------------------------------------------------------------------------------------------
describe('hasRecordedStop — live labelled idle-between-turns case (2026-08-02)', () => {
  it('the orchestrator transcript, silent inside a legitimate idle gap, is recognized as accounted for', () => {
    const stops = lastStopTimestamps([
      { t: 'stop', name: 'pilot-orchestrator', agentId: 'a1f5eb82662eb4d75', at: '2026-08-02T14:56:36.046Z' },
    ])
    // The transcript's last write is ~= the stop timestamp; the STALE check happens ~14 min later
    // (14 min after 14:56:36), well past the ordinary poll interval but the stop's OWN timestamp
    // is what is compared against modifiedAt, not "now".
    const modifiedAt = ms('2026-08-02T14:56:36.046Z')
    expect(hasRecordedStop(stops, { name: 'pilot-orchestrator', agentType: 'pilot-orchestrator' }, modifiedAt)).toBe(true)
  })
})

// -------------------------------------------------------------------------------------------
// LIVE-LABELLED CASE — the accidental real kill (2026-08-02, disposable headless bench,
// session 84972b04-9139-496f-96c0-d0106603f1ae): an agent died mid-generation to a content-filter
// API error. Its journal holds exactly ONE record (the spawn) — no stop, no nudged, nothing.
// hasRecordedStop must say "NOT accounted for" so the caller still emits STALE.
// -------------------------------------------------------------------------------------------
describe('hasRecordedStop — live labelled genuine-death case (2026-08-02 accidental API-error kill)', () => {
  it('an agent with NO stop record at all is never accounted for, whatever meta it carries', () => {
    const stops = lastStopTimestamps([]) // the real journal for that session has zero stop records
    const meta = { name: null, agentType: 'general-purpose' } // real shape: untrackable/unnamed spawn
    expect(hasRecordedStop(stops, meta, Date.now())).toBe(false)
  })
})
