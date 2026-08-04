import { describe, expect, it } from 'vitest'
import { reducedLenses } from '../src/reduced-lenses.js'

describe('reducedLenses', () => {
  it('returns the first 3 entries of a 4-entry list in order', () => {
    expect(reducedLenses(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c'])
  })

  it('returns a 3-entry list unchanged', () => {
    const lenses = ['a', 'b', 'c'] as const
    expect(reducedLenses(lenses)).toBe(lenses)
  })

  it('returns a list shorter than keep unchanged and does not pad it', () => {
    const lenses = ['a', 'b'] as const
    const reduced = reducedLenses(lenses, 3)

    expect(reduced).toBe(lenses)
    expect(reduced).toEqual(['a', 'b'])
  })

  it('does not alias or mutate the input when reduction happens', () => {
    const lenses = ['a', 'b', 'c', 'd']
    const reduced = reducedLenses(lenses)

    expect(reduced).toEqual(['a', 'b', 'c'])
    expect(reduced).not.toBe(lenses)
    expect(lenses).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps nothing when keep is 0 — a meaningful budget, not an error', () => {
    expect(reducedLenses(['a', 'b', 'c', 'd'], 0)).toEqual([])
  })

  // ⚠ Without a guard, `slice(0, -1)` silently means "drop the LAST entry", so a negative keep
  // returns a plausible list instead of failing. `reducedLenses(list, -1)` returned the first
  // three of four — indistinguishable from a correct reduction, and wrong for any other length.
  // A negative budget is a programming error; the package already throws immediately on invalid
  // construction (`makeBudgetedShape`) rather than deferring, so this follows that convention.
  it('throws on a negative keep instead of silently dropping from the end', () => {
    expect(() => reducedLenses(['a', 'b', 'c', 'd'], -1)).toThrow(/negative/i)
  })

  it('observes that the real 4-entry category lists currently drop maintainability while docs stays unchanged', () => {
    const categories = {
      bugfix: ['root-cause', 'regression-risk', 'test-coverage', 'maintainability'],
      feature: ['correctness', 'security', 'api-design', 'maintainability'],
      refactor: ['behavioral-equivalence', 'test-coverage', 'readability', 'maintainability'],
      config: ['correctness', 'security', 'blast-radius', 'maintainability'],
      docs: ['accuracy', 'completeness', 'clarity'],
    } as const

    expect(reducedLenses(categories.bugfix)).toEqual(['root-cause', 'regression-risk', 'test-coverage'])
    expect(reducedLenses(categories.feature)).toEqual(['correctness', 'security', 'api-design'])
    expect(reducedLenses(categories.refactor)).toEqual(['behavioral-equivalence', 'test-coverage', 'readability'])
    expect(reducedLenses(categories.config)).toEqual(['correctness', 'security', 'blast-radius'])
    expect(reducedLenses(categories.docs)).toBe(categories.docs)

    expect(categories.bugfix[3]).toBe('maintainability')
    expect(categories.feature[3]).toBe('maintainability')
    expect(categories.refactor[3]).toBe('maintainability')
    expect(categories.config[3]).toBe('maintainability')
  })
})
