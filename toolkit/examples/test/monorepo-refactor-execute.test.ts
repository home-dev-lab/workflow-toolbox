// monorepo-refactor-execute.test.ts — end-to-end composition test for the
// monorepo-refactor-execute workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime, BEST_MODEL } from '@workflow-toolbox/runtime'
import wf from '../monorepo-refactor-execute.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  goal: 'Reduce duplication across packages',
  plan: {
    planTitle: 'Monorepo Refactor Plan v1',
    steps: [
      { order: 1, file: 'packages/core/src/index.ts', action: 'Extract shared utilities', rationale: 'Reduce duplication' },
      { order: 2, file: 'packages/ui/src/Button.tsx', action: 'Move to shared package', rationale: 'Avoid api-drift' },
    ],
  },
}

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing uses UNIQUE phrases from the execute workflow prompts — in priority order:
 *   1. Checker:   "verify the change exists" (checkStage unique phrase)
 *   2. Executor:  "apply the change" (executeStage unique phrase)
 */
function makeHappyPathRuntime(): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Check stage — verifies the change exists in the worktree
      if (p.includes('verify the change exists') || p.includes('verified:') || p.includes('evidence')) {
        return { verified: true, evidence: 'Diff shows the expected changes applied correctly' }
      }

      // (2) Execute stage — applies the change
      if (p.includes('apply the change') || p.includes('filestouched') || p.includes('done:')) {
        return {
          done: true,
          filesTouched: ['packages/core/src/index.ts'],
          note: 'Successfully extracted shared utilities',
        }
      }

      // Fallback
      return { done: false, filesTouched: [], note: 'Unknown agent' }
    },
  })
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('monorepo-refactor-execute workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('monorepo-refactor-execute')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Execute', 'Check', 'Report'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation (L3 boundary re-validation)
// ---------------------------------------------------------------------------

describe('monorepo-refactor-execute parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/goal|plan|input/i)
  })

  it('throws an actionable error for missing goal', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ plan: VALID_INPUT.plan }))
    ).rejects.toThrow(/goal/i)
  })

  it('throws an actionable error for missing plan', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Reduce duplication' }))
    ).rejects.toThrow(/plan/i)
  })

  it('throws an actionable error for missing plan.steps', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Reduce duplication', plan: { planTitle: 'Plan' } }))
    ).rejects.toThrow(/steps/i)
  })

  it('throws an actionable error for empty plan.steps', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Reduce duplication', plan: { planTitle: 'Plan', steps: [] } }))
    ).rejects.toThrow(/steps/i)
  })

  it('throws an actionable error for missing plan.planTitle', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({
        goal: 'Reduce duplication',
        plan: { steps: [{ order: 1, file: 'x.ts', action: 'do it', rationale: 'because' }] }
      }))
    ).rejects.toThrow(/planTitle/i)
  })

  it('accepts valid JSON-encoded object arg', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result).toBeDefined()
    expect(result).toHaveProperty('goal')
  })

  it('accepts pruned-but-valid steps (L3 boundary: human pruned steps, that is the point)', async () => {
    const rt = makeHappyPathRuntime()
    // Human reviewer pruned from 2 steps to 1 — still valid
    const prunedInput = {
      goal: 'Reduce duplication',
      plan: {
        planTitle: 'Pruned Plan',
        steps: [
          { order: 1, file: 'packages/core/src/index.ts', action: 'Extract utilities', rationale: 'Reduce duplication' },
        ],
      },
    }
    const result = await wf.run(rt, JSON.stringify(prunedInput))
    expect(result).toBeDefined()
    expect(result).toHaveProperty('succeeded')
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — executed + verified steps
// ---------------------------------------------------------------------------

describe('monorepo-refactor-execute happy path', () => {
  it('returns the correct final report shape', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // Top-level shape
    expect(result).toHaveProperty('goal')
    expect(result).toHaveProperty('planTitle')
    expect(result).toHaveProperty('steps')
    expect(result).toHaveProperty('succeeded')
    expect(result).toHaveProperty('failed')
    expect(result).toHaveProperty('dropped')
    expect(result).toHaveProperty('warnings')

    // goal and planTitle echoed
    expect(result.goal).toBe('Reduce duplication across packages')
    expect(result.planTitle).toBe('Monorepo Refactor Plan v1')

    // steps is an array
    expect(Array.isArray(result.steps)).toBe(true)

    // counts are numbers
    expect(typeof result.succeeded).toBe('number')
    expect(typeof result.failed).toBe('number')
    expect(typeof result.dropped).toBe('number')
  })

  it('counts executed+verified steps as succeeded', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // Both steps executed (done:true) and verified (verified:true)
    expect(result.succeeded).toBe(VALID_INPUT.plan.steps.length)
    expect(result.failed).toBe(0)
    expect(result.dropped).toBe(0)
  })

  it('step records have the correct shape', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    for (const step of result.steps) {
      expect(step).toHaveProperty('order')
      expect(step).toHaveProperty('file')
      expect(step).toHaveProperty('action')
      expect(step).toHaveProperty('executed')
      expect(step).toHaveProperty('verified')
      expect(typeof step.executed).toBe('boolean')
      expect(typeof step.verified).toBe('boolean')
    }
  })

  it('records Execute and Check phases', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(rt.phases).toContain('Execute')
    expect(rt.phases).toContain('Check')
  })

  it('spawns agents (executor + checker per step)', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    // 2 steps × 2 agents (executor + checker) = at least 4
    expect(rt.agentsSpawned).toBeGreaterThanOrEqual(VALID_INPUT.plan.steps.length * 2)
  })

  it('runs every executor (mutating agent) with worktree isolation — arch §8 Risk', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    // The pedagogical centerpiece of this example: parallel MUTATING agents
    // MUST be isolated. This regression-guards the option actually being
    // passed (a comment alone once shipped without the real option).
    const executors = rt.calls.filter((c) => c.opts?.phase === 'Execute')
    expect(executors.length).toBe(VALID_INPUT.plan.steps.length)
    for (const call of executors) {
      expect(call.opts?.isolation).toBe('worktree')
    }
    // Checkers are read-only — they must NOT pay the worktree overhead
    const checkers = rt.calls.filter((c) => c.opts?.phase === 'Check')
    for (const call of checkers) {
      expect(call.opts?.isolation).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: executeModel knob — cost/quota tiering of the per-step executor
// (mutating) agent, while the fresh-evidence checker (defence layer 2) stays
// pinned to BEST_MODEL regardless of the session model. Mirrors dev-implement's
// implementerModel / dev-review-fix's fixerModel.
// ---------------------------------------------------------------------------
describe('monorepo-refactor-execute executeModel knob', () => {
  const executors = (rt: FakeRuntime) => rt.calls.filter((c) => c.opts?.phase === 'Execute')
  const checkers = (rt: FakeRuntime) => rt.calls.filter((c) => c.opts?.phase === 'Check')

  it('defaults the executor to sonnet when executeModel is omitted', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))
    const execs = executors(rt)
    expect(execs.length).toBeGreaterThan(0)
    for (const c of execs) expect(c.opts?.model).toBe('sonnet')
  })

  it('pins the fresh-evidence checker to BEST_MODEL', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))
    const checks = checkers(rt)
    expect(checks.length).toBeGreaterThan(0)
    for (const c of checks) expect(c.opts?.model).toBe(BEST_MODEL)
  })

  it('honours an explicit executeModel override on the executor only', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ ...VALID_INPUT, executeModel: 'opus' }))
    for (const c of executors(rt)) expect(c.opts?.model).toBe('opus')
    for (const c of checkers(rt)) expect(c.opts?.model).toBe(BEST_MODEL)
  })

  it('accepts "inherit" as an executeModel', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ ...VALID_INPUT, executeModel: 'inherit' }))
    const execs = executors(rt)
    expect(execs.length).toBeGreaterThan(0)
    for (const c of execs) expect(c.opts?.model).toBe('inherit')
  })

  it('rejects an empty-string executeModel', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, executeModel: '' })),
    ).rejects.toThrow(/executeModel/i)
  })

  it('rejects a non-string executeModel', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, executeModel: 123 })),
    ).rejects.toThrow(/executeModel/i)
  })
})

// ---------------------------------------------------------------------------
// Test: checker contradicts executor — defence layer 2
// (executor says done:true but checker says verified:false → step counted failed)
// ---------------------------------------------------------------------------

describe('monorepo-refactor-execute checker contradicts executor', () => {
  it('counts step as failed when checker refutes executor self-report', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // Checker: contradicts executor
        if (p.includes('verify the change exists') || p.includes('verified:') || p.includes('evidence')) {
          return { verified: false, evidence: 'Diff does not contain expected changes — executor misreported' }
        }

        // Executor: claims done (but it is lying)
        if (p.includes('apply the change') || p.includes('filestouched') || p.includes('done:')) {
          return {
            done: true,
            filesTouched: ['packages/core/src/index.ts'],
            note: 'Done (self-report)',
          }
        }

        return { done: false, filesTouched: [], note: 'Unknown' }
      },
    })

    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // All steps should be failed (executor says done, checker says not verified)
    expect(result.failed).toBe(VALID_INPUT.plan.steps.length)
    expect(result.succeeded).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Test: null executor result → dropped
// ---------------------------------------------------------------------------

describe('monorepo-refactor-execute null executor', () => {
  it('counts step as dropped when executor returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // Checker — won't be reached for null executor, but keep for completeness
        if (p.includes('verify the change exists') || p.includes('verified:') || p.includes('evidence')) {
          return { verified: true, evidence: 'OK' }
        }

        // Executor: returns null (agent dies mid-reasoning)
        if (p.includes('apply the change') || p.includes('filestouched') || p.includes('done:')) {
          return null
        }

        return null
      },
    })

    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // Null executor → step is dropped, not failed
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.succeeded).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Test: JSON-encoded string args
// ---------------------------------------------------------------------------

describe('monorepo-refactor-execute JSON-encoded string args', () => {
  it('handles input delivered as JSON-encoded string (runtime delivery format)', async () => {
    const rt = makeHappyPathRuntime()
    // The runtime delivers args as JSON.stringify(input)
    const encoded = JSON.stringify(VALID_INPUT)
    const result = await wf.run(rt, encoded)
    expect(result).toHaveProperty('goal')
    expect(result.goal).toBe('Reduce duplication across packages')
  })
})
