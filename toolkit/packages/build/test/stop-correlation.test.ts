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
import { hasRecordedStop, lastStopTimestamps, lastRealRecordTimestampMs } from '../../../../plugin/bin/lib/stop-correlation.mjs'

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

  // ⚠⚠⚠ RAW-AGENT-ID CORRELATION — the fourth correction, flagged by an independent review AFTER
  // this file already shipped (pilot-orchestrator brief B9): this module reproduced, one card
  // over, the exact defect card 1832820166895863516 fixed. A stop record's `name` field can carry
  // neither the spawn's explicit name NOR its agentType — but the raw `agentId` still matches the
  // transcript filename's own id (`agent-<rawId>.jsonl`, verified directly against the real
  // journal: `agent-a013def19e5877298.jsonl` <-> `{"t":"stop","agentId":"a013def19e5877298",...}`).
  // FAILS before the raw-id lookup is added: neither `name` nor `agentType` matches "an-unrelated-
  // internal-label", so hasRecordedStop had no way to find this stop record at all.
  it('RAW-ID CORRELATION: matches via the raw agentId when neither name nor agentType appears among stop records', () => {
    const stops = new Map([['an-unrelated-internal-label', '2026-08-02T11:43:13.649Z']])
    const rawId = 'aa877ce816e0c2b0f' // the real s-fence-125 raw id, present on both spawn.child and stop.agentId
    stops.set(rawId, '2026-08-02T11:43:13.649Z') // lastStopTimestamps must key by agentId too — see its own test below
    const meta = { name: 's-fence-125', agentType: 'general-purpose' } // neither key is in the map above
    const modifiedAt = ms('2026-08-02T11:43:13.649Z')
    expect(hasRecordedStop(stops, meta, modifiedAt, rawId)).toBe(true)
  })

  it('RAW-ID CORRELATION: still returns false when the raw id ALSO does not match anything (true negative preserved)', () => {
    const stops = new Map([['some-other-agent', '2026-08-02T10:00:00.000Z']])
    const meta = { name: 'truly-silent-worker', agentType: 'Explore' }
    expect(hasRecordedStop(stops, meta, Date.now(), 'a-raw-id-with-no-matching-stop')).toBe(false)
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

// -------------------------------------------------------------------------------------------
// lastRealRecordTimestampMs — card 1832940311869917034 (2026-08-02). Root cause, found by
// delegated forensics (not guessed): the "second cluster" of large backward gaps (5.99s-46.3s)
// that wrongly triggered STALE on cleanly-finished agents was NEVER a flush-delay-vs-tolerance
// problem. It was the ANCHOR itself being polluted: wt-arc-watch.mjs's prior lastRecordTimestampMs
// took the MAX timestamp across every JSONL line in a transcript, including `type:"observer-ref"`
// heartbeat records that a PAIRED pilot-watchdog agent (the `observer:` pairing) writes into the
// SAME transcript file on its own independent polling cadence -- no `uuid`, `parentUuid`, `role`,
// or `message`, i.e. not part of the assistant/user turn chain at all. Scanned across one real
// session's 105 stop-matched agents: 51/51 agents whose naive gap fell in 5.89s-46.3s had
// `observer-ref` as the transcript's literal last record, and every one collapsed to -0.4s..0.0s
// (comfortably inside the EXISTING 1000ms BACKWARD_TOLERANCE_MS) once observer-ref is excluded.
// Confirmed directly for the two agents the card cites: agent `ad976496919625efe` (stop
// 17:57:04.713Z, real last record 17:57:04.641Z, gap -0.072s) and agent `a585e7a53340c178e` (stop
// 18:22:41.919Z, real last record 18:22:41.787Z, gap -0.132s). The constant was never
// miscalibrated -- the anchor was reading the wrong record.
describe('lastRealRecordTimestampMs — excludes observer-ref heartbeat noise from the anchor', () => {
  // Real shape (card 1832940311869917034): stop at 17:57:04.713Z, real content at 17:57:04.641Z,
  // followed by two watchdog heartbeats at 17:57:07.496Z and 17:57:15.994Z -- the OLD anchor
  // (max over every line) picked the LATER heartbeat, producing an 11.3s false gap.
  it('CLEAN FINISH WITH TRAILING OBSERVER-REF: picks the real content record, not the later heartbeat', () => {
    const records = [
      { type: 'assistant', message: { role: 'assistant' }, uuid: 'a1', parentUuid: 'root', timestamp: '2026-08-02T17:57:04.641Z' },
      { type: 'observer-ref', agentId: 'ad976496919625efe', observerTaskId: 'ot1', observerAgentType: 'pilot-watchdog', timestamp: '2026-08-02T17:57:07.496Z' },
      { type: 'observer-ref', agentId: 'ad976496919625efe', observerTaskId: 'ot1', observerAgentType: 'pilot-watchdog', timestamp: '2026-08-02T17:57:15.994Z' },
    ]
    expect(lastRealRecordTimestampMs(records)).toBe(ms('2026-08-02T17:57:04.641Z'))
  })

  it('NO OBSERVER-REF AT ALL: behaves exactly like a plain max-timestamp scan (backward-compatible)', () => {
    const records = [
      { type: 'user', message: { role: 'user' }, uuid: 'u1', timestamp: '2026-08-02T10:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant' }, uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-02T10:00:05.000Z' },
    ]
    expect(lastRealRecordTimestampMs(records)).toBe(ms('2026-08-02T10:00:05.000Z'))
  })

  it('ALL RECORDS ARE OBSERVER-REF: returns null (an agent with no real content at all -- caller falls back to mtime)', () => {
    const records = [
      { type: 'observer-ref', agentId: 'x', observerTaskId: 'y', observerAgentType: 'pilot-watchdog', timestamp: '2026-08-02T10:00:00.000Z' },
    ]
    expect(lastRealRecordTimestampMs(records)).toBeNull()
  })

  // ⚠⚠ THE CASE THAT PROVES THIS FIX DOES NOT REOPEN THE MULTI-TURN-THEN-DIE HOLE. observer-ref
  // noise must never mask a genuinely LATER real turn: this uses MAX-over-non-observer-ref
  // records (not "walk backward from the end and stop at the first non-observer-ref line"),
  // specifically because the delegated forensics could not rule out observer-ref appearing
  // interleaved rather than strictly trailing. A backward-walk would have been fooled by an
  // observer-ref record sitting AFTER a stale real record but BEFORE a fresher one further back
  // in a differently-ordered log; max-over-filtered is order-independent and cannot make that
  // mistake.
  it('OBSERVER-REF NEVER MASKS A GENUINELY LATER REAL TURN, even interleaved', () => {
    const records = [
      { type: 'assistant', message: { role: 'assistant' }, uuid: 'a1', parentUuid: 'root', timestamp: '2026-08-02T10:00:00.000Z' }, // turn 3's clean text
      { type: 'observer-ref', agentId: 'x', observerTaskId: 'y', observerAgentType: 'pilot-watchdog', timestamp: '2026-08-02T10:00:05.000Z' }, // heartbeat, mid-gap
      { type: 'assistant', message: { role: 'assistant' }, uuid: 'b1', parentUuid: 'a1', timestamp: '2026-08-02T14:30:00.000Z' }, // turn 7, mid-generation, never stopped
      { type: 'observer-ref', agentId: 'x', observerTaskId: 'y', observerAgentType: 'pilot-watchdog', timestamp: '2026-08-02T14:30:03.000Z' }, // heartbeat, trailing
    ]
    expect(lastRealRecordTimestampMs(records)).toBe(ms('2026-08-02T14:30:00.000Z'))
  })

  it('skips malformed/missing timestamp fields without throwing, and ignores non-string/short values', () => {
    const records = [
      { type: 'assistant', timestamp: '2026-08-02T10:00:00.000Z' },
      { type: 'observer-ref' }, // no timestamp at all
      null,
      { type: 'assistant', timestamp: 123 }, // wrong type
      { type: 'assistant', timestamp: 'short' }, // too short to be a real ISO string
    ]
    expect(lastRealRecordTimestampMs(records)).toBe(ms('2026-08-02T10:00:00.000Z'))
  })

  it('empty record list returns null', () => {
    expect(lastRealRecordTimestampMs([])).toBeNull()
  })
})

// -------------------------------------------------------------------------------------------
// END-TO-END: hasRecordedStop, fed the OBSERVER-REF-CORRECTED anchor, reproduces both real
// card-cited agents as accounted-for (no STALE), and the discriminating mid-turn-death case
// still correctly reports NOT accounted for (STALE) even in the presence of observer-ref noise.
// -------------------------------------------------------------------------------------------
describe('hasRecordedStop + lastRealRecordTimestampMs — end-to-end, real card-cited shapes', () => {
  it('REAL CASE (card 1832940311869917034, agent ad976496919625efe): accounted for once the anchor excludes observer-ref', () => {
    const stops = lastStopTimestamps([{ t: 'stop', name: 'pilot', agentId: 'ad976496919625efe', at: '2026-08-02T17:57:04.713Z' }])
    const records = [
      { type: 'assistant', timestamp: '2026-08-02T17:57:04.641Z' },
      { type: 'observer-ref', timestamp: '2026-08-02T17:57:07.496Z' },
      { type: 'observer-ref', timestamp: '2026-08-02T17:57:15.994Z' },
    ]
    const anchorMs = lastRealRecordTimestampMs(records)
    expect(hasRecordedStop(stops, { name: 'pilot', agentType: 'pilot' }, anchorMs, 'ad976496919625efe')).toBe(true)
  })

  it('REAL CASE (card 1832940311869917034, agent a585e7a53340c178e): accounted for once the anchor excludes observer-ref', () => {
    const stops = lastStopTimestamps([{ t: 'stop', name: 'pilot', agentId: 'a585e7a53340c178e', at: '2026-08-02T18:22:41.919Z' }])
    const records = [
      { type: 'assistant', timestamp: '2026-08-02T18:22:41.787Z' },
      { type: 'observer-ref', timestamp: '2026-08-02T18:22:41.113Z' },
      { type: 'observer-ref', timestamp: '2026-08-02T18:22:49.050Z' },
    ]
    const anchorMs = lastRealRecordTimestampMs(records)
    expect(hasRecordedStop(stops, { name: 'pilot', agentType: 'pilot' }, anchorMs, 'a585e7a53340c178e')).toBe(true)
  })

  // THE DISCRIMINATING CASE — proves the fix does not silence genuine mid-turn deaths that
  // happen to have observer-ref noise trailing them too.
  it('MID-TURN DEATH WITH OBSERVER-REF NOISE: still NOT accounted for -- STALE must still fire', () => {
    const stops = lastStopTimestamps([{ t: 'stop', name: 'pilot', agentId: 'dead-agent-1', at: '2026-08-02T10:00:00.000Z' }]) // turn 3's clean stop, hours ago
    const records = [
      { type: 'assistant', timestamp: '2026-08-02T10:00:00.000Z' }, // turn 3, matches the stop
      { type: 'observer-ref', timestamp: '2026-08-02T10:00:05.000Z' }, // watchdog heartbeat mid-gap
      { type: 'assistant', timestamp: '2026-08-02T14:30:00.000Z' }, // turn 7, mid-generation, never stopped -- the real silence
      { type: 'observer-ref', timestamp: '2026-08-02T14:30:03.000Z' }, // watchdog heartbeat after the death too
    ]
    const anchorMs = lastRealRecordTimestampMs(records)
    expect(hasRecordedStop(stops, { name: 'pilot', agentType: 'pilot' }, anchorMs, 'dead-agent-1')).toBe(false)
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
  })

  // RAW-ID CORRELATION (card 1832820166895863516's fix, extended here on B9's finding): the map
  // is ALSO keyed by agentId, at the SAME latest timestamp as the name key — a caller that only
  // has the raw id (wt-arc-watch.mjs, from the transcript filename) can look it up directly,
  // without needing the name/agentType meta at all.
  it('ALSO keys by agentId, at the same latest timestamp as the name key', () => {
    const records = [
      { t: 'stop', name: 'general-purpose', agentId: 'aa877ce816e0c2b0f', at: '2026-08-02T11:42:57.492Z' },
      { t: 'stop', name: 'general-purpose', agentId: 'aa877ce816e0c2b0f', at: '2026-08-02T11:43:13.649Z' },
    ]
    const m = lastStopTimestamps(records)
    expect(m.get('aa877ce816e0c2b0f')).toBe('2026-08-02T11:43:13.649Z')
    expect(m.get('general-purpose')).toBe(m.get('aa877ce816e0c2b0f'))
  })

  it('a stop record with an agentId but no usable name still gets its agentId keyed', () => {
    const records = [{ t: 'stop', agentId: 'a-raw-id-only', at: '2026-08-02T11:43:13.649Z' }]
    const m = lastStopTimestamps(records)
    expect(m.get('a-raw-id-only')).toBe('2026-08-02T11:43:13.649Z')
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
