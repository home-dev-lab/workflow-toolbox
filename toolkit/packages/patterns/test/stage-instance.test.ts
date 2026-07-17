// stage-instance.test.ts — the per-invocation stage-salting helper.
//
// claimStageInstance(rt, pattern, stageKey?) claims a discriminator ONCE per
// pattern invocation on a given `rt` object (WeakMap-keyed on identity), and
// stageBuilder(stage, salt) builds the shared per-call-site stage/label
// string every pattern call site uses for BOTH the rt.agent label and
// makeRecord's stage (the load-bearing coupling invariant, card #1816036725248493168).

import { describe, it, expect } from 'vitest'
import { claimStageInstance, stageBuilder } from '../src/stage-instance.js'

describe('claimStageInstance — auto counter (no stageKey)', () => {
  it('first invocation on a fresh rt is bare (salt === "")', () => {
    const rt = {}
    const { salt, warning } = claimStageInstance(rt, 'classifyAndAct')
    expect(salt).toBe('')
    expect(warning).toBeUndefined()
  })

  it('second invocation of the SAME pattern on the SAME rt gets " #2"', () => {
    const rt = {}
    const first = claimStageInstance(rt, 'classifyAndAct')
    const second = claimStageInstance(rt, 'classifyAndAct')
    expect(first.salt).toBe('')
    expect(second.salt).toBe(' #2')
  })

  it('third invocation gets " #3"', () => {
    const rt = {}
    claimStageInstance(rt, 'classifyAndAct')
    claimStageInstance(rt, 'classifyAndAct')
    const third = claimStageInstance(rt, 'classifyAndAct')
    expect(third.salt).toBe(' #3')
  })

  it('counters are PER-PATTERN on the same rt — a different pattern starts bare', () => {
    const rt = {}
    claimStageInstance(rt, 'classifyAndAct')
    claimStageInstance(rt, 'classifyAndAct')
    const other = claimStageInstance(rt, 'generateAndFilter')
    expect(other.salt).toBe('')
  })

  it('distinct rt objects are isolated (WeakMap keyed on identity) — both stay bare', () => {
    const rtA = {}
    const rtB = {}
    const a = claimStageInstance(rtA, 'classifyAndAct')
    const b = claimStageInstance(rtB, 'classifyAndAct')
    expect(a.salt).toBe('')
    expect(b.salt).toBe('')
  })

  it('is deterministic: the same sequential invocation sequence on two fresh rts yields identical salts', () => {
    const run = (rt: object): string[] => [
      claimStageInstance(rt, 'classifyAndAct').salt,
      claimStageInstance(rt, 'classifyAndAct').salt,
      claimStageInstance(rt, 'generateAndFilter').salt,
      claimStageInstance(rt, 'classifyAndAct').salt,
    ]
    const first = run({})
    const second = run({})
    expect(first).toEqual(second)
    expect(first).toEqual(['', ' #2', '', ' #3'])
  })
})

describe('claimStageInstance — explicit stageKey', () => {
  it('a valid stageKey always salts " #<key>", regardless of invocation order', () => {
    const rt = {}
    const result = claimStageInstance(rt, 'adversarialVerification', 'security')
    expect(result.salt).toBe(' #security')
    expect(result.warning).toBeUndefined()
  })

  it('a valid stageKey on the FIRST invocation still salts (never bare)', () => {
    const rt = {}
    const result = claimStageInstance(rt, 'adversarialVerification', 'correctness')
    expect(result.salt).toBe(' #correctness')
  })

  it('an explicit stageKey does NOT consume/advance the auto counter for that pattern', () => {
    const rt = {}
    claimStageInstance(rt, 'adversarialVerification', 'security')
    const autoNext = claimStageInstance(rt, 'adversarialVerification')
    // The keyed claim never touched the auto counter, so the next unkeyed
    // claim is still the pattern's first auto invocation on this rt.
    expect(autoNext.salt).toBe('')
  })

  it('accepts the full whitelist charset: letters, digits, underscore, dot, hyphen, up to 32 chars', () => {
    const rt = {}
    const key = 'A-z_0.9-key'
    const result = claimStageInstance(rt, 'scoreAndRank', key)
    expect(result.salt).toBe(` #${key}`)
    expect(result.warning).toBeUndefined()
  })

  it('rejects an empty stageKey — warns and falls back to the auto counter', () => {
    const rt = {}
    const result = claimStageInstance(rt, 'planAndExecute', '')
    expect(result.salt).toBe('')
    expect(result.warning).toMatch(/stageKey/)
  })

  it('rejects a stageKey containing ":" — warns and falls back to the auto counter', () => {
    const rt = {}
    const result = claimStageInstance(rt, 'planAndExecute', 'bad:key')
    expect(result.salt).toBe('')
    expect(result.warning).toMatch(/stageKey/)
  })

  it('rejects a stageKey containing the loop marker " ⟲" — warns and falls back', () => {
    const rt = {}
    const result = claimStageInstance(rt, 'planAndExecute', 'bad ⟲1')
    expect(result.salt).toBe('')
    expect(result.warning).toMatch(/stageKey/)
  })

  it('rejects a stageKey with leading/trailing whitespace — warns and falls back', () => {
    const rt = {}
    const result = claimStageInstance(rt, 'planAndExecute', ' key ')
    expect(result.salt).toBe('')
    expect(result.warning).toMatch(/stageKey/)
  })

  it('rejects a stageKey over 32 chars — warns and falls back', () => {
    const rt = {}
    const key = 'a'.repeat(33)
    const result = claimStageInstance(rt, 'planAndExecute', key)
    expect(result.salt).toBe('')
    expect(result.warning).toMatch(/stageKey/)
  })

  it('a rejected stageKey still falls back through the auto counter (2nd rejected call gets " #2")', () => {
    const rt = {}
    claimStageInstance(rt, 'planAndExecute', 'bad:key')
    const second = claimStageInstance(rt, 'planAndExecute', 'also:bad')
    expect(second.salt).toBe(' #2')
  })
})

describe('stageBuilder', () => {
  it('bare salt: stg() returns the plain STAGE; stg(suffix) returns STAGE:suffix', () => {
    const stg = stageBuilder('classifyAndAct', '')
    expect(stg()).toBe('classifyAndAct')
    expect(stg('classify:0')).toBe('classifyAndAct:classify:0')
  })

  it('numeric salt: appends TERMINALLY after the suffix', () => {
    const stg = stageBuilder('classifyAndAct', ' #2')
    expect(stg()).toBe('classifyAndAct #2')
    expect(stg('classify:0')).toBe('classifyAndAct:classify:0 #2')
  })

  it('key salt: appends TERMINALLY after the suffix', () => {
    const stg = stageBuilder('adversarialVerification', ' #security')
    expect(stg('verify:0:1')).toBe('adversarialVerification:verify:0:1 #security')
  })

  it('two calls to stg() with the same suffix are byte-identical (single-computation coupling)', () => {
    const stg = stageBuilder('scoreAndRank', ' #2')
    const a = stg('score:0:impact')
    const b = stg('score:0:impact')
    expect(a).toBe(b)
  })
})
