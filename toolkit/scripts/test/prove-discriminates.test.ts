import { describe, expect, it } from 'vitest'

import {
  MutationDoesNotDiscriminateError,
  proveMutationDiscriminates,
} from '../prove-discriminates.ts'

describe('prove-discriminates', () => {
  it('resolves with both outputs when the baseline and mutated runs differ', async () => {
    await expect(
      proveMutationDiscriminates({
        baseline: () => ({ found: false }),
        mutated: () => ({ found: true }),
      }),
    ).resolves.toEqual({
      baselineOutput: { found: false },
      mutatedOutput: { found: true },
    })
  })

  it('rejects when the proof does not discriminate and avoids saying the mutation passed', async () => {
    const proof = proveMutationDiscriminates({
      baseline: () => ({ found: false }),
      mutated: () => ({ found: false }),
      label: 'staleMinutes:0 mirror',
    })

    await expect(proof).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)
    await expect(proof).rejects.toThrow(/does not discriminate/i)
    await expect(proof).rejects.not.toThrow(/the mutation passed|mutation passed/i)
  })

  it('honors a custom isEqual override in both directions', async () => {
    await expect(
      proveMutationDiscriminates({
        baseline: () => ({ found: false }),
        mutated: () => ({ found: false }),
        isEqual: () => false,
      }),
    ).resolves.toEqual({
      baselineOutput: { found: false },
      mutatedOutput: { found: false },
    })

    await expect(
      proveMutationDiscriminates({
        baseline: () => ({ found: false }),
        mutated: () => ({ found: true }),
        isEqual: () => true,
      }),
    ).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)
  })

  it('supports async baseline and mutated runs for differing and identical outputs', async () => {
    await expect(
      proveMutationDiscriminates({
        baseline: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return { found: false }
        },
        mutated: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return { found: true }
        },
      }),
    ).resolves.toEqual({
      baselineOutput: { found: false },
      mutatedOutput: { found: true },
    })

    await expect(
      proveMutationDiscriminates({
        baseline: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return { found: false }
        },
        mutated: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return { found: false }
        },
      }),
    ).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)
  })

  it('degrades gracefully when default equality cannot JSON.stringify the output', async () => {
    const circular: { found: boolean; self?: unknown } = { found: false }
    circular.self = circular

    await expect(
      proveMutationDiscriminates({
        baseline: () => circular,
        mutated: () => circular,
      }),
    ).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)

    await expect(
      proveMutationDiscriminates({
        baseline: () => 1n,
        mutated: () => 2n,
      }),
    ).resolves.toEqual({
      baselineOutput: 1n,
      mutatedOutput: 2n,
    })
  })

  // The next four cases lock the default comparator against the exact failure directions a
  // naive JSON.stringify comparison has for THIS helper's job: reporting distinct values as
  // "identical" (a false alarm, merely annoying) and — the dangerous direction — reporting
  // semantically-identical values as "different" (which could let a hollow mutation report a
  // clean, wrongly-discriminating pass).

  it('does not collapse NaN into null the way JSON.stringify would', async () => {
    // JSON.stringify(NaN) === JSON.stringify(null) === 'null' — a naive comparator would
    // wrongly call these "identical" and throw. NaN is genuinely distinct from null.
    await expect(
      proveMutationDiscriminates({
        baseline: () => NaN,
        mutated: () => null,
      }),
    ).resolves.toEqual({ baselineOutput: NaN, mutatedOutput: null })

    // Two NaN outputs ARE equal to each other (Object.is(NaN, NaN) === true) — a non-discriminating
    // proof, correctly rejected.
    await expect(
      proveMutationDiscriminates({
        baseline: () => NaN,
        mutated: () => NaN,
      }),
    ).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)
  })

  it('treats differently-ordered object keys as EQUAL, not as a false discrimination', async () => {
    // JSON.stringify preserves key insertion order, so { a: 1, b: 2 } and { b: 2, a: 1 } would
    // serialize differently and a naive comparator would wrongly call this "discriminates" —
    // the dangerous direction for a mutation proof: a hollow mutation whose only visible effect
    // is key ordering would then read as a clean, passing lock.
    await expect(
      proveMutationDiscriminates({
        baseline: () => ({ a: 1, b: 2 }),
        mutated: () => ({ b: 2, a: 1 }),
      }),
    ).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)
  })

  it('compares Map and Set contents structurally, not by JSON.stringify (which flattens both to "{}")', async () => {
    await expect(
      proveMutationDiscriminates({
        baseline: () => new Map([['a', 1]]),
        mutated: () => new Map([['a', 2]]),
      }),
    ).resolves.toEqual({
      baselineOutput: new Map([['a', 1]]),
      mutatedOutput: new Map([['a', 2]]),
    })

    await expect(
      proveMutationDiscriminates({
        baseline: () => new Set([1, 2]),
        mutated: () => new Set([2, 1]),
      }),
    ).rejects.toBeInstanceOf(MutationDoesNotDiscriminateError)
  })

  it('degrades to reference equality (never crashes) on two DIFFERENT circular structures', async () => {
    // Two distinct self-referential objects are not cycle-safe to compare recursively; the
    // documented fallback is reference equality, which reports them as different rather than
    // throwing a stack-overflow error out of the proof itself.
    const circularA: { tag: string; self?: unknown } = { tag: 'a' }
    circularA.self = circularA
    const circularB: { tag: string; self?: unknown } = { tag: 'a' }
    circularB.self = circularB

    await expect(
      proveMutationDiscriminates({
        baseline: () => circularA,
        mutated: () => circularB,
      }),
    ).resolves.toEqual({ baselineOutput: circularA, mutatedOutput: circularB })
  })
})
