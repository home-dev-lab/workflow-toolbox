import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@dwt/runtime'
import { warn, applyCap, makeRecord } from '../src/envelope.js'
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
