import { describe, it, expect } from 'vitest'
import { FakeRuntime, DIGEST_PREFIX, parseDigest } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord, emitDigest, collectTrail } from '../src/envelope.js'
import type { TrailRecord, PatternResult } from '../src/envelope.js'

describe('warn', () => {
  it('pushes the message into the warnings array', () => {
    const rt = new FakeRuntime()
    const warnings: string[] = []
    warn(rt, warnings, 'something went wrong')
    expect(warnings).toEqual(['something went wrong'])
  })

  it('logs the message via rt.log()', () => {
    const rt = new FakeRuntime()
    const warnings: string[] = []
    warn(rt, warnings, 'also logged live')
    expect(rt.logs).toEqual(['also logged live'])
  })

  it('pushes AND logs multiple messages independently', () => {
    const rt = new FakeRuntime()
    const warnings: string[] = []
    warn(rt, warnings, 'first')
    warn(rt, warnings, 'second')
    expect(warnings).toEqual(['first', 'second'])
    expect(rt.logs).toEqual(['first', 'second'])
  })
})

describe('applyCap', () => {
  it('returns all items and truncated=0 when cap is undefined', () => {
    const items = [1, 2, 3]
    const result = applyCap(items, undefined)
    expect(result.kept).toEqual([1, 2, 3])
    expect(result.truncated).toBe(0)
  })

  it('returns all items and truncated=0 when cap >= items.length', () => {
    const items = ['a', 'b', 'c']
    expect(applyCap(items, 3).kept).toEqual(['a', 'b', 'c'])
    expect(applyCap(items, 3).truncated).toBe(0)
    expect(applyCap(items, 10).kept).toEqual(['a', 'b', 'c'])
    expect(applyCap(items, 10).truncated).toBe(0)
  })

  it('keeps only the first cap items and reports truncated count', () => {
    const items = [1, 2, 3, 4, 5]
    const result = applyCap(items, 3)
    expect(result.kept).toEqual([1, 2, 3])
    expect(result.truncated).toBe(2)
  })

  it('throws synchronously when cap < 1', () => {
    expect(() => applyCap([1, 2], 0)).toThrow()
    expect(() => applyCap([1, 2], -1)).toThrow()
  })

  it('works with empty array', () => {
    const result = applyCap([], 5)
    expect(result.kept).toEqual([])
    expect(result.truncated).toBe(0)
  })

  it('cap=1 keeps only the first item', () => {
    const result = applyCap(['a', 'b', 'c'], 1)
    expect(result.kept).toEqual(['a'])
    expect(result.truncated).toBe(2)
  })
})

describe('emitDigest', () => {
  it('logs exactly one parseable digest line via rt.log()', () => {
    const rt = new FakeRuntime()
    emitDigest(rt, { stage: 'fanOutAndSynthesize', counts: { tasks: 3, completed: 2 } })
    expect(rt.logs.length).toBe(1)
    expect(rt.logs[0]!.startsWith(DIGEST_PREFIX)).toBe(true)
    expect(parseDigest(rt.logs[0]!)).toEqual({ stage: 'fanOutAndSynthesize', counts: { tasks: 3, completed: 2 } })
  })

  it('round-trips taken/notTaken/output through the shared grammar', () => {
    const rt = new FakeRuntime()
    emitDigest(rt, { stage: 'classifyAndAct', taken: ['bug'], notTaken: ['feature', 'question'], output: 'ok' })
    expect(parseDigest(rt.logs[0]!)).toEqual({
      stage: 'classifyAndAct',
      taken: ['bug'],
      notTaken: ['feature', 'question'],
      output: 'ok',
    })
  })

  it('round-trips phase when the caller passes one', () => {
    const rt = new FakeRuntime()
    emitDigest(rt, { stage: 'tournament', phase: 'Compete', counts: { attempts: 2 } })
    expect(parseDigest(rt.logs[0]!)).toEqual({ stage: 'tournament', phase: 'Compete', counts: { attempts: 2 } })
  })

  it('omits phase when the caller does not pass one', () => {
    const rt = new FakeRuntime()
    emitDigest(rt, { stage: 'tournament', counts: { attempts: 0 } })
    expect(parseDigest(rt.logs[0]!)).toEqual({ stage: 'tournament', counts: { attempts: 0 } })
    expect(rt.logs[0]).not.toContain('"phase"')
  })
})

// ---------------------------------------------------------------------------
// TrailRecord — type shape tests
// ---------------------------------------------------------------------------

describe('TrailRecord — shape', () => {
  it('accepts minimal form with stage and outcome only', () => {
    const rec: TrailRecord = { stage: 'planAndExecute:plan', outcome: 'ok' }
    expect(rec.stage).toBe('planAndExecute:plan')
    expect(rec.outcome).toBe('ok')
    expect(rec.model).toBeUndefined()
    expect(rec.decision).toBeUndefined()
  })

  it('accepts full form with all optional fields', () => {
    const rec: TrailRecord = {
      stage: 'planAndExecute:work:0',
      outcome: 'null',
      model: 'opus',
      decision: 'subtasks=3',
    }
    expect(rec.outcome).toBe('null')
    expect(rec.model).toBe('opus')
    expect(rec.decision).toBe('subtasks=3')
  })

  it('accepts outcome null literal', () => {
    const rec: TrailRecord = { stage: 'somePattern:step', outcome: 'null' }
    expect(rec.outcome).toBe('null')
  })
})

// ---------------------------------------------------------------------------
// makeRecord — factory tests
// ---------------------------------------------------------------------------

describe('makeRecord', () => {
  it('creates a minimal record with stage and outcome only', () => {
    const rec = makeRecord('planAndExecute:plan', true)
    expect(rec.stage).toBe('planAndExecute:plan')
    expect(rec.outcome).toBe('ok')
    expect('model' in rec).toBe(false)
    expect('decision' in rec).toBe(false)
  })

  it('maps ok=false to outcome null', () => {
    const rec = makeRecord('planAndExecute:plan', false)
    expect(rec.outcome).toBe('null')
  })

  it('includes model when provided', () => {
    const rec = makeRecord('adversarialVerification:verify:0:0', true, { model: 'opus' })
    expect(rec.model).toBe('opus')
    expect('decision' in rec).toBe(false)
  })

  it('includes decision when provided', () => {
    const rec = makeRecord('planAndExecute:plan', true, { decision: 'subtasks=3' })
    expect(rec.decision).toBe('subtasks=3')
    expect('model' in rec).toBe(false)
  })

  it('keeps model and decision ABSENT (not undefined-valued) when not provided', () => {
    const rec = makeRecord('somePattern:step', true)
    expect('model' in rec).toBe(false)
    expect('decision' in rec).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PatternResult — trail is required (enforced by tsc)
// ---------------------------------------------------------------------------

describe('PatternResult — trail is required', () => {
  it('rejects PatternResult WITHOUT trail field (compile error)', () => {
    // @ts-expect-error trail is required on PatternResult — object missing it must not type-check
    const result: PatternResult<string> = {
      value: 'hello',
      stats: { itemsIn: 1, itemsOut: 1, agentsSpawned: 1, dropped: 0, truncated: 0 },
      warnings: [],
    }
    expect(result).toBeDefined()
  })

  it('accepts PatternResult WITH trail field', () => {
    const trail: TrailRecord[] = [
      { stage: 'planAndExecute:plan', outcome: 'ok', decision: 'subtasks=2' },
      { stage: 'planAndExecute:work:0', outcome: 'ok' },
    ]
    const result: PatternResult<string> = {
      value: 'hello',
      stats: { itemsIn: 2, itemsOut: 2, agentsSpawned: 2, dropped: 0, truncated: 0 },
      warnings: [],
      trail,
    }
    expect(result.trail).toHaveLength(2)
    expect(trail.at(0)!.stage).toBe('planAndExecute:plan')
  })
})

// ---------------------------------------------------------------------------
// collectTrail — concatenates a composition's per-pattern trails, in order
// ---------------------------------------------------------------------------

describe('collectTrail', () => {
  function fakeResult(trail: TrailRecord[]): PatternResult<null> {
    return { value: null, stats: { itemsIn: 0, itemsOut: 0, agentsSpawned: 0, dropped: 0, truncated: 0 }, warnings: [], trail }
  }

  it('concatenates trails in call order', () => {
    const a = fakeResult([{ stage: 'a:0', outcome: 'ok' }])
    const b = fakeResult([{ stage: 'b:0', outcome: 'ok' }, { stage: 'b:1', outcome: 'null' }])
    expect(collectTrail(a, b)).toEqual([
      { stage: 'a:0', outcome: 'ok' },
      { stage: 'b:0', outcome: 'ok' },
      { stage: 'b:1', outcome: 'null' },
    ])
  })

  it('skips null and undefined entries (a skipped/aborted pattern)', () => {
    const a = fakeResult([{ stage: 'a:0', outcome: 'ok' }])
    const c = fakeResult([{ stage: 'c:0', outcome: 'ok' }])
    expect(collectTrail(a, null, undefined, c)).toEqual([
      { stage: 'a:0', outcome: 'ok' },
      { stage: 'c:0', outcome: 'ok' },
    ])
  })

  it('returns an empty array for an empty call', () => {
    expect(collectTrail()).toEqual([])
  })

  it('returns an empty array when every argument is null/undefined', () => {
    expect(collectTrail(null, undefined)).toEqual([])
  })

  it('does not mutate the source trails', () => {
    const aTrail: TrailRecord[] = [{ stage: 'a:0', outcome: 'ok' }]
    const a = fakeResult(aTrail)
    collectTrail(a)
    expect(aTrail).toHaveLength(1)
  })
})
