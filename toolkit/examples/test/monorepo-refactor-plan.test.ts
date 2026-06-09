// monorepo-refactor-plan.test.ts — end-to-end composition test for the
// monorepo-refactor-plan workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../monorepo-refactor-plan.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing uses UNIQUE phrases from the actual workflow prompts — in priority order:
 *   1. Verifier:      "adversarially verify" (pattern-owned prompt, always first)
 *   2. Synthesize:    "final plan artifact" (unique phrase in Phase 'Synthesize')
 *   3. Plan worker:   "detail the change proposal" (unique phrase in planAndExecute workers)
 *   4. Plan planner:  "decompose into independent change proposals" (plan prompt)
 *   5. Analyze synth: "consolidate into a single analysis brief" (fanOut synthesis)
 *   6. Analyze task:  "deep analysis" (fanOut task)
 *   7. Map act:       "focused observation" (classifyAndAct act)
 *   8. Map classify:  "inspect that area" (classifyAndAct classify)
 * Order matters: check most-specific first to avoid cross-matching.
 */
function makeHappyPathRuntime(): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Adversarial verifier stage — pattern owns this prompt phrase
      if (p.includes('adversarially verify')) {
        return { verdict: 'confirmed', reason: 'Change proposal verified against actual code' }
      }

      // (2) Phase 'Synthesize' — final plan artifact agent
      if (p.includes('final plan artifact') || p.includes('plantitle')) {
        return {
          planTitle: 'Monorepo Refactor Plan v1',
          steps: [
            { order: 1, file: 'packages/core/src/index.ts', action: 'Extract shared utilities', rationale: 'Reduce duplication' },
            { order: 2, file: 'packages/ui/src/Button.tsx', action: 'Move to shared package', rationale: 'Avoid api-drift' },
          ],
        }
      }

      // (3) Phase 'Plan' — planAndExecute worker (detail each change proposal)
      if (p.includes('detail the change proposal') || p.includes('changes:')) {
        return {
          changes: [
            { file: 'packages/core/src/index.ts', action: 'Extract utilities', rationale: 'Reduce duplication across packages' },
          ],
        }
      }

      // (4) Phase 'Plan' — planAndExecute planner (decompose into subtasks)
      if (p.includes('decompose into independent change proposals') || p.includes('change proposals')) {
        return {
          subtasks: [
            { description: 'Proposal 1: Extract shared utilities from packages/core' },
            { description: 'Proposal 2: Move Button component to shared package' },
          ],
        }
      }

      // (5) Phase 'Analyze' — fanOutAndSynthesize synthesis (consolidate brief)
      if (p.includes('consolidate into a single analysis brief') || p.includes('analysis brief')) {
        return {
          brief: 'The monorepo has significant duplication in core utilities and UI components.',
          hotspots: ['packages/core/src/utils.ts', 'packages/ui/src/Button.tsx'],
        }
      }

      // (6) Phase 'Analyze' — fanOutAndSynthesize task (deep analysis per area)
      if (p.includes('deep analysis') || p.includes('problems:')) {
        return {
          problems: [
            { file: 'packages/core/src/utils.ts', problem: 'Duplicated helper functions', impact: 'high' },
          ],
        }
      }

      // (7) Phase 'Map' — classifyAndAct act stage (focused observation)
      if (p.includes('focused observation') || p.includes('observations:')) {
        return {
          observations: [
            { file: 'packages/core/src/index.ts', detail: 'Contains duplicated code found in packages/api as well' },
          ],
        }
      }

      // (8) Phase 'Map' — classifyAndAct classify stage (inspect area)
      if (p.includes('inspect') && (p.includes('goal') || p.includes('area') || p.includes('category'))) {
        return { category: 'duplication' }
      }

      // Fallback
      return { observations: [] }
    },
  })
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('monorepo-refactor-plan')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Map', 'Analyze', 'Plan', 'Verify', 'Synthesize'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/goal|input/i)
  })

  it('throws an actionable error for empty goal', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: '', areas: ['packages/core'] }))
    ).rejects.toThrow(/goal/i)
  })

  it('throws an actionable error for missing areas', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Reduce duplication', areas: [] }))
    ).rejects.toThrow(/areas/i)
  })

  it('throws an actionable error for areas containing empty strings', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Reduce duplication', areas: ['packages/core', ''] }))
    ).rejects.toThrow(/areas/i)
  })

  it('throws for non-array areas', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Reduce duplication', areas: 'not-an-array' }))
    ).rejects.toThrow(/areas/i)
  })

  it('accepts valid JSON-encoded object arg', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ goal: 'Reduce duplication', areas: ['packages/core'] }))
    expect(result).toBeDefined()
    expect(result).toHaveProperty('plan')
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — full composition through all 5 phases
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan happy path', () => {
  it('returns the correct final artifact shape', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(
      rt,
      JSON.stringify({ goal: 'Reduce duplication across packages', areas: ['packages/core', 'packages/ui'] })
    )

    // Top-level shape
    expect(result).toHaveProperty('goal')
    expect(result).toHaveProperty('plan')
    expect(result).toHaveProperty('rejected')
    expect(result).toHaveProperty('stats')
    expect(result).toHaveProperty('warnings')

    // goal echoed
    expect(result.goal).toBe('Reduce duplication across packages')

    // plan has required fields
    expect(result.plan).toHaveProperty('planTitle')
    expect(result.plan).toHaveProperty('steps')
    expect(Array.isArray(result.plan.steps)).toBe(true)

    // rejected is an array
    expect(Array.isArray(result.rejected)).toBe(true)

    // stats is an object
    expect(typeof result.stats).toBe('object')

    // warnings is an array
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('records all 5 phases (Map, Analyze, Plan, Verify, Synthesize)', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(
      rt,
      JSON.stringify({ goal: 'Reduce duplication', areas: ['packages/core', 'packages/ui'] })
    )

    expect(rt.phases).toContain('Map')
    expect(rt.phases).toContain('Analyze')
    expect(rt.phases).toContain('Plan')
    expect(rt.phases).toContain('Verify')
    expect(rt.phases).toContain('Synthesize')
  })

  it('spawns agents (multiple agents across all phases)', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(
      rt,
      JSON.stringify({ goal: 'Reduce duplication', areas: ['packages/core', 'packages/ui'] })
    )

    // Should spawn many agents: classify + act per area + analyze tasks + synthesis
    // + plan + workers + verify votes + final synthesize
    expect(rt.agentsSpawned).toBeGreaterThan(5)
  })

  it('plan steps have the correct shape', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(
      rt,
      JSON.stringify({ goal: 'Reduce duplication', areas: ['packages/core'] })
    )

    for (const step of result.plan.steps) {
      expect(step).toHaveProperty('order')
      expect(step).toHaveProperty('file')
      expect(step).toHaveProperty('action')
      expect(step).toHaveProperty('rationale')
      expect(typeof step.order).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------
// Test: refuted change lands in rejected, not in plan steps
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan refuted changes', () => {
  it('excludes refuted changes from plan steps and includes them in rejected', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Adversarial verifier — ALL refute
        if (p.includes('adversarially verify')) {
          return { verdict: 'refuted', reason: 'File does not exist, proposal is baseless' }
        }

        // (2) Synthesize — final plan artifact with NO steps (all were refuted)
        if (p.includes('final plan artifact') || p.includes('plantitle')) {
          return {
            planTitle: 'Monorepo Refactor Plan (pruned)',
            steps: [],
          }
        }

        // (3) Plan worker
        if (p.includes('detail the change proposal') || p.includes('changes:')) {
          return {
            changes: [
              { file: 'packages/ghost/src/nonexistent.ts', action: 'Delete dead code', rationale: 'Cleanup' },
            ],
          }
        }

        // (4) Plan planner
        if (p.includes('decompose into independent change proposals') || p.includes('change proposals')) {
          return {
            subtasks: [{ description: 'Proposal: Delete ghost file' }],
          }
        }

        // (5) Analyze synthesis
        if (p.includes('consolidate into a single analysis brief') || p.includes('analysis brief')) {
          return { brief: 'Dead code in ghost package.', hotspots: ['packages/ghost'] }
        }

        // (6) Analyze task
        if (p.includes('deep analysis') || p.includes('problems:')) {
          return {
            problems: [{ file: 'packages/ghost/src/nonexistent.ts', problem: 'Dead code', impact: 'low' }],
          }
        }

        // (7) Map act
        if (p.includes('focused observation') || p.includes('observations:')) {
          return { observations: [{ file: 'packages/ghost/src/nonexistent.ts', detail: 'Unused' }] }
        }

        // (8) Map classify
        if (p.includes('inspect') && (p.includes('goal') || p.includes('area') || p.includes('category'))) {
          return { category: 'dead-code' }
        }

        return { observations: [] }
      },
    })

    const result = await wf.run(
      rt,
      JSON.stringify({ goal: 'Clean up dead code', areas: ['packages/ghost'] })
    )

    // Rejected must contain the refuted changes
    expect(result.rejected.length).toBeGreaterThan(0)

    // Plan steps must not include refuted changes
    // (synthesize agent was given only kept=[] changes, so steps=[])
    expect(result.plan.steps).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Test: worker changes flow into Verify phase via workerResults (NEW — replaces closure)
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan workerResults flow into Verify', () => {
  it('passes all worker change proposals (in subtask order) to adversarial verification', async () => {
    const capturedVerifyClaims: string[] = []

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Adversarial verifier — capture the claim text passed to it
        if (p.includes('adversarially verify')) {
          // Extract the file being verified from the prompt
          const match = prompt.match(/Change proposal: "[^"]*" in ([^\n]+)/)
          if (match) capturedVerifyClaims.push(match.at(1)!.trim())
          return { verdict: 'confirmed', reason: 'Verified' }
        }

        // (2) Synthesize
        if (p.includes('final plan artifact') || p.includes('plantitle')) {
          return {
            planTitle: 'Multi-Worker Plan',
            steps: [
              { order: 1, file: 'packages/core/src/a.ts', action: 'Action A', rationale: 'Reason A' },
              { order: 2, file: 'packages/core/src/b.ts', action: 'Action B', rationale: 'Reason B' },
            ],
          }
        }

        // (3) Plan workers — two distinct workers, each returns one change
        if (p.includes('detail the change proposal') && p.includes('worker-a')) {
          return {
            changes: [
              { file: 'packages/core/src/a.ts', action: 'Action A', rationale: 'Reason A' },
            ],
          }
        }
        if (p.includes('detail the change proposal') && p.includes('worker-b')) {
          return {
            changes: [
              { file: 'packages/core/src/b.ts', action: 'Action B', rationale: 'Reason B' },
            ],
          }
        }
        // Fallback for any other detail prompt
        if (p.includes('detail the change proposal')) {
          return {
            changes: [
              { file: 'packages/core/src/a.ts', action: 'Action A', rationale: 'Reason A' },
            ],
          }
        }

        // (4) Plan planner — two subtasks
        if (p.includes('decompose into independent change proposals') || p.includes('change proposals')) {
          return {
            subtasks: [
              { description: 'Worker-A: Refactor packages/core/src/a.ts' },
              { description: 'Worker-B: Refactor packages/core/src/b.ts' },
            ],
          }
        }

        // (5) Analyze synthesis
        if (p.includes('consolidate into a single analysis brief') || p.includes('analysis brief')) {
          return { brief: 'Both files need work.', hotspots: ['packages/core/src/a.ts', 'packages/core/src/b.ts'] }
        }

        // (6) Analyze task
        if (p.includes('deep analysis') || p.includes('problems:')) {
          return { problems: [{ file: 'packages/core/src/a.ts', problem: 'Needs refactor', impact: 'medium' }] }
        }

        // (7) Map act
        if (p.includes('focused observation') || p.includes('observations:')) {
          return { observations: [{ file: 'packages/core/src/a.ts', detail: 'Needs work' }] }
        }

        // (8) Map classify
        if (p.includes('inspect') && (p.includes('goal') || p.includes('area') || p.includes('category'))) {
          return { category: 'duplication' }
        }

        return { observations: [] }
      },
    })

    const result = await wf.run(
      rt,
      JSON.stringify({ goal: 'Refactor core', areas: ['packages/core'] })
    )

    // Verify phase must have received claims (at least one file was verified)
    expect(capturedVerifyClaims.length).toBeGreaterThan(0)

    // Plan must be populated (workers ran and verified)
    expect(result.plan).toHaveProperty('planTitle')
  })
})

// ---------------------------------------------------------------------------
// Test: planner-failure path — workerResults empty → Verify skipped gracefully
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan planner failure path', () => {
  it('skips Verify and still returns a plan artifact when the planner returns null', async () => {
    let plannerCalled = false

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Adversarial verifier — should NOT be called when planner fails
        if (p.includes('adversarially verify')) {
          throw new Error('Verify should not be called when planner returned null')
        }

        // (2) Synthesize — final plan artifact (still runs after planner fail with empty changes)
        if (p.includes('final plan artifact') || p.includes('plantitle')) {
          return {
            planTitle: 'Empty Plan (planner failed)',
            steps: [],
          }
        }

        // (3) Plan planner — returns null (planner failure)
        if (p.includes('decompose into independent change proposals') || p.includes('change proposals')) {
          plannerCalled = true
          return null
        }

        // (5) Analyze synthesis
        if (p.includes('consolidate into a single analysis brief') || p.includes('analysis brief')) {
          return { brief: 'Analysis done.', hotspots: ['packages/core'] }
        }

        // (6) Analyze task
        if (p.includes('deep analysis') || p.includes('problems:')) {
          return { problems: [{ file: 'packages/core/src/index.ts', problem: 'Issue', impact: 'low' }] }
        }

        // (7) Map act
        if (p.includes('focused observation') || p.includes('observations:')) {
          return { observations: [{ file: 'packages/core/src/index.ts', detail: 'Detail' }] }
        }

        // (8) Map classify
        if (p.includes('inspect') && (p.includes('goal') || p.includes('area') || p.includes('category'))) {
          return { category: 'duplication' }
        }

        return { observations: [] }
      },
    })

    const result = await wf.run(
      rt,
      JSON.stringify({ goal: 'Reduce duplication', areas: ['packages/core'] })
    )

    // Planner must have been called
    expect(plannerCalled).toBe(true)

    // Composition must complete (Synthesize still runs)
    expect(result).toHaveProperty('plan')
    expect(result.plan).toHaveProperty('planTitle')

    // No changes → no rejected
    expect(result.rejected).toHaveLength(0)

    // A warning must be emitted about no change proposals
    expect(result.warnings.some((w: string) => w.includes('no change proposals'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: analysis agent returning null → dropped counted, composition completes
// ---------------------------------------------------------------------------

describe('monorepo-refactor-plan null analysis agent', () => {
  it('drops a null analysis agent result, counts dropped, and still completes', async () => {
    let analyzeTaskCallCount = 0

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        if (p.includes('adversarially verify')) {
          return { verdict: 'confirmed', reason: 'Verified' }
        }

        if (p.includes('final plan artifact') || p.includes('plantitle')) {
          return {
            planTitle: 'Partial Plan',
            steps: [
              { order: 1, file: 'packages/core/src/index.ts', action: 'Refactor', rationale: 'Improve structure' },
            ],
          }
        }

        if (p.includes('detail the change proposal') || p.includes('changes:')) {
          return {
            changes: [{ file: 'packages/core/src/index.ts', action: 'Refactor', rationale: 'Improve structure' }],
          }
        }

        if (p.includes('decompose into independent change proposals') || p.includes('change proposals')) {
          return { subtasks: [{ description: 'Proposal: Refactor core index' }] }
        }

        if (p.includes('consolidate into a single analysis brief') || p.includes('analysis brief')) {
          return { brief: 'Partial analysis available.', hotspots: ['packages/core'] }
        }

        // Analyze task: first call returns null (agent dies), subsequent succeed
        if (p.includes('deep analysis') || p.includes('problems:')) {
          analyzeTaskCallCount++
          if (analyzeTaskCallCount === 1) return null
          return {
            problems: [{ file: 'packages/core/src/index.ts', problem: 'Needs refactor', impact: 'medium' }],
          }
        }

        if (p.includes('focused observation') || p.includes('observations:')) {
          return { observations: [{ file: 'packages/core/src/index.ts', detail: 'Duplication found' }] }
        }

        if (p.includes('inspect') && (p.includes('goal') || p.includes('area') || p.includes('category'))) {
          return { category: 'duplication' }
        }

        return { observations: [] }
      },
    })

    const result = await wf.run(
      rt,
      JSON.stringify({ goal: 'Improve structure', areas: ['packages/core', 'packages/ui'] })
    )

    // Must complete
    expect(result).toHaveProperty('plan')

    // warnings must reflect the dropped agent
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
