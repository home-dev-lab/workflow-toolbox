// backlog-triage.test.ts — end-to-end composition test for the backlog-triage
// workflow (the scoreAndRank "targeting machine"). FakeRuntime with an onAgent
// handler routing on prompt content. TDD: written alongside the composition.

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../backlog-triage.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TriagedShape = {
  goal: string
  candidatesIn: number
  triaged: ReadonlyArray<{ item: string; score: number; scores: number[]; plan: string | null; firstStep: string | null }>
  notDeepDived: number
}

/** Score keyed off the fenced candidate tag: alpha → 5 (⇒25), beta → 3 (⇒9), gamma → 1 (⇒1). */
function scoreFor(prompt: string): number {
  if (prompt.includes('<candidate>alpha</candidate>')) return 5
  if (prompt.includes('<candidate>beta</candidate>')) return 3
  return 1
}

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing (most-specific first):
 *   1. Scoring sweep — impact prompt ("advances the goal") or tractability
 *      prompt ("cheaply and safely"); score keyed off the fenced candidate tag.
 *   2. Deep-dive — "concrete action plan for it" → { plan, firstStep }, unless
 *      `deadDeepDiveFor` matches the item (returns null = a dead agent).
 */
function makeRuntime(deadDeepDiveFor?: string): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt

      // (1) Scoring sweep (both dimensions land here)
      if (p.includes('advances the goal') || p.includes('cheaply and safely')) {
        return { score: scoreFor(p), reason: 'test score' }
      }

      // (2) Deep-dive premium agent
      if (p.includes('concrete action plan for it')) {
        if (deadDeepDiveFor !== undefined && p.includes(`<item>${deadDeepDiveFor}</item>`)) {
          return null // simulate a dead deep-dive agent
        }
        return { plan: 'Concrete plan for the item', firstStep: 'Do the first thing' }
      }

      // Fallback (should not be hit on the happy path)
      return { score: 1, reason: 'fallback' }
    },
  })
}

const HAPPY_ARGS = {
  goal: 'biggest reliability wins for the least effort',
  candidates: ['alpha', 'beta', 'gamma'],
  topK: 2,
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('backlog-triage workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('backlog-triage')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map((p) => p.title)
    expect(titles).toEqual(['Triage', 'Deep-dive'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('backlog-triage parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    await expect(wf.run(makeRuntime(), undefined)).rejects.toThrow(/object|goal/)
  })

  it('throws for empty goal', async () => {
    await expect(wf.run(makeRuntime(), JSON.stringify({ goal: '', candidates: ['x'] }))).rejects.toThrow(/goal/)
  })

  it('throws for empty candidates array', async () => {
    await expect(wf.run(makeRuntime(), JSON.stringify({ goal: 'g', candidates: [] }))).rejects.toThrow(/candidates/)
  })

  it('throws for a non-string candidate', async () => {
    await expect(wf.run(makeRuntime(), JSON.stringify({ goal: 'g', candidates: ['ok', 42] }))).rejects.toThrow(/candidates\[1\]/)
  })

  it('throws for a non-positive topK', async () => {
    await expect(wf.run(makeRuntime(), JSON.stringify({ goal: 'g', candidates: ['x'], topK: 0 }))).rejects.toThrow(/topK/)
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — full composition
// ---------------------------------------------------------------------------

describe('backlog-triage happy path', () => {
  it('keeps only the top-K survivors, ranked, and deep-dives them', async () => {
    const result = await wf.run(makeRuntime(), JSON.stringify(HAPPY_ARGS)) as TriagedShape

    expect(result.goal).toBe(HAPPY_ARGS.goal)
    expect(result.candidatesIn).toBe(3)

    // topK = 2 → exactly two survivors, the rest deliberately not deep-dived.
    expect(result.triaged).toHaveLength(2)
    expect(result.notDeepDived).toBe(1)

    // Ranked descending by impact × tractability: alpha (25) before beta (9).
    expect(result.triaged.map((t) => t.item)).toEqual(['alpha', 'beta'])
    expect(result.triaged[0]!.score).toBe(25)
    expect(result.triaged[1]!.score).toBe(9)

    // Each survivor carries its premium deep-dive plan.
    for (const t of result.triaged) {
      expect(t.plan).toBe('Concrete plan for the item')
      expect(t.firstStep).toBe('Do the first thing')
      expect(t.scores).toHaveLength(2)
    }
  })

  it('keeps all candidates when topK exceeds the set (no error, nothing cut)', async () => {
    const result = await wf.run(makeRuntime(), JSON.stringify({ ...HAPPY_ARGS, topK: 10 })) as TriagedShape
    expect(result.triaged).toHaveLength(3)
    expect(result.notDeepDived).toBe(0)
  })

  it('keeps a survivor with a null plan when its deep-dive agent dies (never fabricates)', async () => {
    // The top survivor (alpha) gets a dead deep-dive agent.
    const result = await wf.run(makeRuntime('alpha'), JSON.stringify(HAPPY_ARGS)) as TriagedShape

    // Both survivors stay listed; notDeepDived stays itemsIn − itemsOut (1),
    // unaffected by the deep-dive failure (the survivor is NOT recounted as cut).
    expect(result.triaged).toHaveLength(2)
    expect(result.notDeepDived).toBe(1)

    const alpha = result.triaged.find((t) => t.item === 'alpha')!
    expect(alpha.plan).toBeNull()
    expect(alpha.firstStep).toBeNull()
    expect(alpha.score).toBe(25) // triage score preserved even though the plan failed

    const beta = result.triaged.find((t) => t.item === 'beta')!
    expect(beta.plan).toBe('Concrete plan for the item')
  })
})
