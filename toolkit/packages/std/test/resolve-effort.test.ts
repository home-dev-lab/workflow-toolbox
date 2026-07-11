import { describe, it, expect } from 'vitest'
import { resolveEffort, resolveVerifierEffort } from '../src/resolve-effort.js'

describe('resolveEffort', () => {
  it('returns stageDefault for undefined/null/"auto"', () => {
    expect(resolveEffort(undefined, 'low')).toBe('low')
    expect(resolveEffort(null, 'medium')).toBe('medium')
    expect(resolveEffort('auto', 'high')).toBe('high')
  })

  it('passes through each valid EffortAlias', () => {
    for (const tier of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolveEffort(tier, 'low')).toBe(tier)
    }
  })

  it('degrades to stageDefault on garbage input (never throws, never reaches the harness)', () => {
    expect(resolveEffort('turbo', 'medium')).toBe('medium')
    expect(resolveEffort(42, 'high')).toBe('high')
    expect(resolveEffort({}, 'low')).toBe('low')
    expect(resolveEffort([], 'low')).toBe('low')
  })

  it("resolves the 'auto' sentinel to EACH role's OWN stage default independently — never a shared/global value", () => {
    // 'auto' means "use THIS role's committed default", not "use some global
    // default" — two roles with different stage defaults must each resolve to
    // their own, from the identical 'auto' input value.
    expect(resolveEffort('auto', 'low')).toBe('low')
    expect(resolveEffort('auto', 'medium')).toBe('medium')
    expect(resolveEffort('auto', 'high')).toBe('high')
    expect(resolveEffort('auto', 'xhigh')).toBe('xhigh')
    expect(resolveEffort('auto', 'max')).toBe('max')
  })
})

describe('resolveVerifierEffort', () => {
  it('resolves normally when the result already meets the floor', () => {
    expect(resolveVerifierEffort('high', 'high')).toBe('high')
    expect(resolveVerifierEffort('xhigh', 'high')).toBe('xhigh')
    expect(resolveVerifierEffort('max', 'high')).toBe('max')
  })

  it('clamps UP to the floor when the resolved tier is below it', () => {
    expect(resolveVerifierEffort('low', 'high')).toBe('high')
    expect(resolveVerifierEffort('medium', 'high')).toBe('high')
    expect(resolveVerifierEffort(undefined, 'low')).toBe('high') // stageDefault below floor too
  })

  it('never lowers below the floor even via an explicit low override', () => {
    expect(resolveVerifierEffort('low', 'xhigh', 'xhigh')).toBe('xhigh')
  })

  it('honors a custom (higher) floor', () => {
    expect(resolveVerifierEffort('high', 'high', 'xhigh')).toBe('xhigh')
    expect(resolveVerifierEffort('max', 'high', 'xhigh')).toBe('max')
  })

  it('falls back the floor itself to "high" when the floor argument is invalid', () => {
    // @ts-expect-error — exercising a garbage floor at runtime (defensive, non-TS caller)
    expect(resolveVerifierEffort('low', 'low', 'not-a-tier')).toBe('high')
  })

  it('defaults the floor to "high" when omitted', () => {
    expect(resolveVerifierEffort('medium', 'medium')).toBe('high')
  })
})
