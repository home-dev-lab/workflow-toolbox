import { describe, it, expect } from 'vitest'
import { DIGEST_PREFIX, LOOP_STAGE, LOOP_ITER_MARKER, isLoopIterLabel, formatDigest, parseDigest } from '../src/digest.js'
import type { PhaseDigest } from '../src/digest.js'

describe('formatDigest / parseDigest — round-trip', () => {
  it('round-trips a full digest (all fields)', () => {
    const d: PhaseDigest = {
      stage: 'classifyAndAct',
      output: 'routed to bug-report',
      taken: ['bug-report'],
      notTaken: ['feature-request', 'question'],
      counts: { in: 1, out: 1, dropped: 0 },
    }
    expect(parseDigest(formatDigest(d))).toEqual(d)
  })

  it('round-trips a minimal digest (stage only)', () => {
    const d: PhaseDigest = { stage: 'fanOutAndSynthesize' }
    expect(parseDigest(formatDigest(d))).toEqual(d)
  })

  it('round-trips a digest carrying phase', () => {
    const d: PhaseDigest = { stage: 'tournament', phase: 'Compete', counts: { attempts: 2 } }
    expect(parseDigest(formatDigest(d))).toEqual(d)
  })

  it('omits absent fields entirely (no null/undefined keys in the line)', () => {
    const line = formatDigest({ stage: 'tournament', output: 'winner: attempt-2' })
    expect(line).toBe(`${DIGEST_PREFIX} {"stage":"tournament","output":"winner: attempt-2"}`)
  })

  it('omits phase when absent, includes it right after stage when present', () => {
    const withoutPhase = formatDigest({ stage: 'tournament', output: 'winner: attempt-2' })
    expect(withoutPhase).not.toContain('"phase"')
    const withPhase = formatDigest({ stage: 'tournament', phase: 'Compete', output: 'winner: attempt-2' })
    expect(withPhase).toBe(`${DIGEST_PREFIX} {"stage":"tournament","phase":"Compete","output":"winner: attempt-2"}`)
  })

  it('is deterministic — fixed key order regardless of construction order', () => {
    const a = formatDigest({ stage: 's', counts: { x: 1 }, output: 'o', taken: ['t'] })
    const b = formatDigest({ stage: 's', output: 'o', taken: ['t'], counts: { x: 1 } })
    expect(a).toBe(b)
  })

  it('is deterministic for nested counts — keys sorted regardless of insertion order', () => {
    const a = formatDigest({ stage: 's', counts: { kept: 3, dropped: 5, generated: 8 } })
    const b = formatDigest({ stage: 's', counts: { generated: 8, dropped: 5, kept: 3 } })
    expect(a).toBe(b)
    // and it still round-trips to the same semantic value
    expect(parseDigest(a)).toEqual({ stage: 's', counts: { kept: 3, dropped: 5, generated: 8 } })
  })
})

describe('parseDigest — tolerant, never throws', () => {
  it('returns null for a non-digest narrator line', () => {
    expect(parseDigest('Evidence gathered: 3/4')).toBeNull()
  })

  it('returns null for a non-string input', () => {
    expect(parseDigest(123 as unknown as string)).toBeNull()
    expect(parseDigest(null as unknown as string)).toBeNull()
  })

  it('returns null when the body after the prefix is not JSON', () => {
    expect(parseDigest(`${DIGEST_PREFIX} {not json`)).toBeNull()
  })

  it('returns null when the payload is not an object', () => {
    expect(parseDigest(`${DIGEST_PREFIX} ["a"]`)).toBeNull()
    expect(parseDigest(`${DIGEST_PREFIX} "x"`)).toBeNull()
    expect(parseDigest(`${DIGEST_PREFIX} 42`)).toBeNull()
  })

  it('returns null when stage is missing or empty', () => {
    expect(parseDigest(`${DIGEST_PREFIX} {"output":"o"}`)).toBeNull()
    expect(parseDigest(`${DIGEST_PREFIX} {"stage":""}`)).toBeNull()
    expect(parseDigest(`${DIGEST_PREFIX} {"stage":5}`)).toBeNull()
  })

  it('drops malformed optional fields but keeps stage', () => {
    // taken not an array of strings; counts has a non-number → both dropped, stage survives
    expect(parseDigest(`${DIGEST_PREFIX} {"stage":"s","taken":[1,2],"counts":{"a":"b"}}`)).toEqual({
      stage: 's',
    })
  })

  it('drops a non-string or empty-string phase but keeps stage', () => {
    expect(parseDigest(`${DIGEST_PREFIX} {"stage":"s","phase":5}`)).toEqual({ stage: 's' })
    expect(parseDigest(`${DIGEST_PREFIX} {"stage":"s","phase":""}`)).toEqual({ stage: 's' })
  })

  it('tolerates leading/trailing whitespace around the line', () => {
    expect(parseDigest(`   ${DIGEST_PREFIX} {"stage":"s"}  `)).toEqual({ stage: 's' })
  })
})

  it('drops a counts record containing a NEGATIVE value (corrupt/hand-edited journal guard)', () => {
    const line = `${DIGEST_PREFIX}${JSON.stringify({ stage: 'verify', counts: { confirmed: 2, refuted: -1 } })}`
    const d = parseDigest(line)
    expect(d).not.toBeNull()
    expect(d?.stage).toBe('verify')
    expect(d?.counts).toBeUndefined()
  })

describe('loopUntilDone attribution constants + isLoopIterLabel', () => {
  it('pins the shared literals (the pattern and observe both import these)', () => {
    // If either drifts, loopUntilDone's source const / observe's fallback desync — but
    // since both import these, that desync is now a compile break, not a silent one.
    expect(LOOP_STAGE).toBe('loopUntilDone')
    expect(LOOP_ITER_MARKER).toBe(' ⟲')
  })

  it('matches a label carrying the appended iteration marker (… ⟲<n>)', () => {
    expect(isLoopIterLabel(`x${LOOP_ITER_MARKER}1`)).toBe(true)
    // the nested-pattern / caller-scheme shape: prefix survives, marker appended at the end
    expect(isLoopIterLabel('adversarialVerification:verify:0:0 ⟲2')).toBe(true)
    expect(isLoopIterLabel('dev-implement:green:task-1 ⟲10')).toBe(true)
  })

  it('does NOT match the default label or a plain label (no appended marker)', () => {
    expect(isLoopIterLabel('loopUntilDone:iter:1')).toBe(false) // default branch resolves by prefix, not marker
    expect(isLoopIterLabel('classifyAndAct:classify:0')).toBe(false)
    expect(isLoopIterLabel('plain label')).toBe(false)
    expect(isLoopIterLabel('')).toBe(false)
  })

  it('requires the marker AND trailing digits at the very end', () => {
    expect(isLoopIterLabel('x ⟲')).toBe(false) // marker but no digits
    expect(isLoopIterLabel('x ⟲n')).toBe(false) // non-digit tail
    expect(isLoopIterLabel('x ⟲1 (note)')).toBe(false) // marker not at the end
    expect(isLoopIterLabel('x⟲1')).toBe(false) // glyph without the leading space is not the marker
  })

  it('honestly matches any label ending in the marker+digits (in-band by design)', () => {
    // Documented limitation: the marker is encoded in-band in the caller-controlled label,
    // so a caller label that legitimately ends in ' ⟲<digits>' is indistinguishable from a
    // loop iteration. The ⟲ glyph (U+27F2) is distinctive enough that this is acceptable; a
    // collision would only over-attribute the loop's own digest to that phase (still gated by
    // the unambiguous-only fallback in observe), never corrupt a real fact.
    expect(isLoopIterLabel('my custom thing ⟲3')).toBe(true)
  })
})
