// auto-effort.test.ts — TEST-LOCK for card #1809425610812949851: the DECIDED
// auto-effort form. Deterministic signals decide only the clear extremes; ONE
// batched best-model triage call scores the rest ("when unsure, score UP");
// every failure direction resolves UP to the caller's fallback; verifiers are
// out of scope by contract (callers never route them through this).

import { describe, it, expect } from 'vitest'
import { FakeRuntime, BEST_MODEL } from '@workflow-toolbox/runtime'
import { autoSelectEffort, deterministicEffortOf } from '../src/auto-effort.js'
import type { EffortWorkItem } from '../src/auto-effort.js'

const item = (id: string, signals: EffortWorkItem['signals'] = {}): EffortWorkItem => ({
  id,
  brief: `work item ${id}`,
  signals,
})

// ---------------------------------------------------------------------------
// Tier 1 — deterministic rules
// ---------------------------------------------------------------------------

describe('deterministicEffortOf', () => {
  it('routes the clearly-large extremes to xhigh', () => {
    expect(deterministicEffortOf({ filesTouched: 8 })).toBe('xhigh')
    expect(deterministicEffortOf({ filesTouched: 3, diffLines: 400 })).toBe('xhigh')
  })

  it('routes clearly-small, fully-known items to medium', () => {
    expect(deterministicEffortOf({ filesTouched: 1, diffLines: 20 })).toBe('medium')
    expect(deterministicEffortOf({ filesTouched: 2, specChars: 300 })).toBe('medium')
  })

  it('a new file vetoes the small rule (creation is never clearly trivial)', () => {
    expect(deterministicEffortOf({ filesTouched: 1, newFiles: 1, diffLines: 20 })).toBeNull()
  })

  it('leaves the middle and the unknown to judgment (null)', () => {
    expect(deterministicEffortOf({ filesTouched: 4, diffLines: 120 })).toBeNull()
    expect(deterministicEffortOf({})).toBeNull()
    // small file count but NO size signal at all → judgment, not medium
    expect(deterministicEffortOf({ filesTouched: 1 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// autoSelectEffort — orchestration
// ---------------------------------------------------------------------------

describe('autoSelectEffort', () => {
  it('resolves fully deterministic worklists with ZERO agent spawns', async () => {
    const rt = new FakeRuntime()
    const result = await autoSelectEffort(rt, [
      item('small', { filesTouched: 1, diffLines: 10 }),
      item('large', { filesTouched: 12 }),
    ], { fallback: 'high' })

    expect(result.efforts).toEqual({ small: 'medium', large: 'xhigh' })
    expect(result.decidedBy).toEqual({ small: 'deterministic', large: 'deterministic' })
    expect(result.spawns).toBe(0)
    expect(rt.calls).toHaveLength(0)
  })

  it('sends ONE batched triage call (best model, high effort) for all undecided items', async () => {
    const rt = new FakeRuntime({
      responses: [{
        scores: [
          { id: 'a', score: 2, reason: 'simple' },
          { id: 'b', score: 4, reason: 'intricate' },
          { id: 'c', score: 5, reason: 'architecture' },
        ],
      }],
    })
    const result = await autoSelectEffort(rt, [item('a'), item('b'), item('c')], { fallback: 'high' })

    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]?.opts?.model).toBe(BEST_MODEL)
    expect(rt.calls[0]?.opts?.effort).toBe('high')
    expect(rt.calls[0]?.prompt).toContain('WHEN UNSURE, SCORE UP')
    // TEST-LOCK (measured live, run wf_4b35df09-227): the id must be
    // JSON-quoted with signals on their OWN line — an id with inline signal
    // text got echoed whole by the triage model, failed the match, and the
    // scored item silently fell back to the fallback tier.
    expect(rt.calls[0]?.prompt).toContain('- id: "a"')
    expect(rt.calls[0]?.prompt).toContain('Echo each "id" EXACTLY')
    expect(result.efforts).toEqual({ a: 'medium', b: 'high', c: 'xhigh' })
    expect(result.decidedBy['a']).toBe('triage')
    expect(result.spawns).toBe(1)
  })

  it('mixes tiers: deterministic items never reach the triage prompt', async () => {
    const rt = new FakeRuntime({
      responses: [{ scores: [{ id: 'mid', score: 3, reason: 'ordinary' }] }],
    })
    const result = await autoSelectEffort(rt, [
      item('tiny', { filesTouched: 1, specChars: 100 }),
      item('mid', { filesTouched: 4 }),
    ], { fallback: 'high' })

    expect(rt.calls[0]?.prompt).not.toContain('- id: "tiny"')
    expect(result.efforts).toEqual({ tiny: 'medium', mid: 'high' })
  })

  it('fails UP: omitted ids, out-of-range scores, unknown ids, and a dead triage all land on fallback', async () => {
    const rt = new FakeRuntime({
      responses: [{
        scores: [
          { id: 'kept', score: 1, reason: 'fine' },
          { id: 'ghost', score: 2, reason: 'hallucinated id' },
          { id: 'broken', score: 9, reason: 'out of range' },
        ],
      }],
    })
    const result = await autoSelectEffort(rt, [item('kept'), item('omitted'), item('broken')], { fallback: 'high' })

    expect(result.efforts).toEqual({ kept: 'medium', omitted: 'high', broken: 'high' })
    expect(result.decidedBy['omitted']).toBe('fallback')
    expect(result.decidedBy['broken']).toBe('fallback')
    expect(result.warnings.join(' ')).toContain('unknown or duplicate id "ghost"')
    expect(result.warnings.join(' ')).toContain('omitted item "omitted"')
    expect(result.warnings.join(' ')).toContain('out of range')
  })

  it('fails UP when the triage call (and its salvage) dies entirely', async () => {
    const rt = new FakeRuntime({ responses: [null, null] }) // native + salvage respawn
    const result = await autoSelectEffort(rt, [item('x')], { fallback: 'high' })

    expect(result.efforts).toEqual({ x: 'high' })
    expect(result.decidedBy['x']).toBe('fallback')
    expect(result.warnings.join(' ')).toContain('triage call failed')
    expect(result.spawns).toBe(2) // salvage respawn counted honestly
  })

  it('rejects duplicate item ids synchronously', async () => {
    const rt = new FakeRuntime()
    await expect(autoSelectEffort(rt, [item('a'), item('a')], { fallback: 'high' }))
      .rejects.toThrow(/duplicate item id/)
  })
})
