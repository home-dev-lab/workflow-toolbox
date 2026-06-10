// dev-implement.test.ts — end-to-end composition test for the dev-implement workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../dev-implement.workflow.js'

// ---------------------------------------------------------------------------
// Fixtures — a valid approved PlanArtifact (the dev-plan handoff contract).
// NOTE: tasks are listed in NON-topological order (T2 before T1) on purpose:
// the workflow must execute them in dependency order regardless of list order.
// ---------------------------------------------------------------------------

const ARTIFACT = {
  goal: 'Add input validation to the CLI',
  context: {
    projectDir: '.',
    testCommand: 'pnpm test',
    buildCommand: 'pnpm build',
    conventions: 'TypeScript strict; vitest; small pure modules',
  },
  tasks: [
    {
      id: 'T2',
      title: 'Wire validate() into the CLI entry',
      intent: 'Call validate() before dispatch so bad input fails fast.',
      files: [{ path: 'src/cli.ts', status: 'existing', role: 'integration point' }],
      contracts: 'cli main() exits non-zero and prints the validation error on bad input',
      testPlan: 'Write a failing CLI test for the bad-input path first.',
      doneCriteria: ['CLI bad-input test passes'],
      dependsOn: ['T1'],
    },
    {
      id: 'T1',
      title: 'Add validate() helper',
      intent: 'Create a pure validation helper so the CLI can reject malformed args early.',
      files: [{ path: 'src/validate.ts', status: 'new', role: 'implementation' }],
      contracts: 'export function validate(raw: unknown): { ok: boolean; error?: string }',
      testPlan: 'Write a failing test asserting validate(null) returns ok: false first.',
      doneCriteria: ['validate() unit tests pass'],
      dependsOn: [],
    },
  ],
  risks: [],
  outOfScope: ['Refactoring the existing dispatch logic'],
}

const VALID_INPUT = { artifact: ARTIFACT }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing uses UNIQUE phrases from the actual workflow prompts — in priority order:
 *   1. Check agent: "independently verify by running" (fresh-evidence checker)
 *   2. Red agent:   "write the failing tests first"
 *   3. Green agent: "make the failing tests pass"
 * Order matters: check most-specific first to avoid cross-matching.
 */
function makeRuntime(overrides?: {
  check?: (prompt: string, callIndex: number) => unknown
  red?: (prompt: string) => unknown
  green?: (prompt: string) => unknown
}): FakeRuntime {
  let checkCalls = 0
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Check stage — independent fresh-evidence verification
      if (p.includes('independently verify by running')) {
        const i = checkCalls++
        if (overrides?.check) return overrides.check(prompt, i)
        return { green: true, evidence: 'Test suite passed: 12/12', failureSummary: '' }
      }

      // (2) Red stage — write the failing tests
      if (p.includes('write the failing tests first')) {
        if (overrides?.red) return overrides.red(prompt)
        return { written: true, testFiles: ['test/validate.test.ts'], note: 'Added failing test' }
      }

      // (3) Green stage — implement until tests pass
      if (p.includes('make the failing tests pass')) {
        if (overrides?.green) return overrides.green(prompt)
        return { done: true, filesTouched: ['src/validate.ts'], note: 'Implemented validate()' }
      }

      // Fallback
      return { note: 'unrouted' }
    },
  })
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('dev-implement workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('dev-implement')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Implement', 'Check', 'Report'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput — L3 re-validation of the (possibly human-edited) artifact
// ---------------------------------------------------------------------------

describe('dev-implement parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/artifact|input/i)
  })

  it('throws for a missing artifact object', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, JSON.stringify({}))).rejects.toThrow(/artifact/i)
  })

  it('throws for an artifact with an empty goal', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ artifact: { ...ARTIFACT, goal: '' } }))
    ).rejects.toThrow(/goal/i)
  })

  it('throws for an artifact with empty tasks', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ artifact: { ...ARTIFACT, tasks: [] } }))
    ).rejects.toThrow(/tasks/i)
  })

  it('throws for a task missing a handoff field (intent)', async () => {
    const rt = makeRuntime()
    const broken = {
      ...ARTIFACT,
      tasks: [{ ...ARTIFACT.tasks[1], intent: undefined }],
    }
    await expect(wf.run(rt, JSON.stringify({ artifact: broken }))).rejects.toThrow(/intent/i)
  })

  it('throws for duplicate task ids (human edit gone wrong)', async () => {
    const rt = makeRuntime()
    const broken = {
      ...ARTIFACT,
      tasks: [ARTIFACT.tasks[1], { ...ARTIFACT.tasks[0], id: 'T1' }],
    }
    await expect(wf.run(rt, JSON.stringify({ artifact: broken }))).rejects.toThrow(/duplicate|unique/i)
  })

  it('throws for a dependsOn reference to a pruned task (human edit gone wrong)', async () => {
    const rt = makeRuntime()
    const broken = { ...ARTIFACT, tasks: [ARTIFACT.tasks[0]] } // T2 kept, its dep T1 pruned
    await expect(wf.run(rt, JSON.stringify({ artifact: broken }))).rejects.toThrow(/unknown|reference/i)
  })

  it('throws for a dependency cycle introduced by hand-editing', async () => {
    const rt = makeRuntime()
    const broken = {
      ...ARTIFACT,
      tasks: [
        { ...ARTIFACT.tasks[1], dependsOn: ['T2'] },
        { ...ARTIFACT.tasks[0], dependsOn: ['T1'] },
      ],
    }
    await expect(wf.run(rt, JSON.stringify({ artifact: broken }))).rejects.toThrow(/cycle/i)
  })

  it('rejects mutation: "worktree" with a clear not-yet-implemented error', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ artifact: ARTIFACT, mutation: 'worktree' }))
    ).rejects.toThrow(/not yet implemented/i)
  })

  it('rejects an unknown mutation value', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ artifact: ARTIFACT, mutation: 'parallel' }))
    ).rejects.toThrow(/mutation/i)
  })

  it('accepts mutation: "sequential" explicitly', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify({ artifact: ARTIFACT, mutation: 'sequential' }))
    expect(result).toHaveProperty('succeeded')
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — sequential TDD over both tasks
// ---------------------------------------------------------------------------

describe('dev-implement happy path', () => {
  it('returns the deterministic report shape', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.goal).toBe(ARTIFACT.goal)
    expect(Array.isArray(result.tasks)).toBe(true)
    expect(result.tasks.length).toBe(2)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('executes tasks in dependency order, not list order (T1 before T2)', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // The report preserves execution order: T1 (no deps) must come first
    // even though the artifact lists T2 first.
    expect(result.tasks.map((t: { id: string }) => t.id)).toEqual(['T1', 'T2'])
  })

  it('each task report carries id, title, status, iterations and evidence', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    for (const t of result.tasks) {
      expect(typeof t.id).toBe('string')
      expect(typeof t.title).toBe('string')
      expect(t.status).toBe('succeeded')
      expect(t.iterations).toBeGreaterThan(0)
      expect(typeof t.evidence).toBe('string')
      expect(t.evidence.length).toBeGreaterThan(0)
    }
  })

  it('records the Implement, Check and Report phases', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(rt.phases).toContain('Implement')
    expect(rt.phases).toContain('Check')
    expect(rt.phases).toContain('Report')
  })
})

// ---------------------------------------------------------------------------
// Test: failure handling — exhausted loop fails the task, dependents skip
// ---------------------------------------------------------------------------

describe('dev-implement failing task', () => {
  it('fails a task whose checks never pass and SKIPS its dependents', async () => {
    const rt = makeRuntime({
      check: () => ({ green: false, evidence: 'suite red', failureSummary: '2 tests failed: validate(null)' }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    const t2 = result.tasks.find((t: { id: string }) => t.id === 'T2')!
    expect(t1.status).toBe('failed')
    expect(t2.status).toBe('skipped')
    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.succeeded).toBe(0)
    // The last failure must survive into the report — it is the re-run input.
    expect(t1.note).toMatch(/validate\(null\)|failed/i)
    // A failure pushes a warning with the resume hint.
    expect(result.warnings.some((w: string) => /resume/i.test(w))).toBe(true)
  })

  it('recovers when the check goes green on a later iteration', async () => {
    const rt = makeRuntime({
      check: (_p, i) =>
        i === 0
          ? { green: false, evidence: 'suite red', failureSummary: '1 test failed' }
          : { green: true, evidence: 'suite green after fix', failureSummary: '' },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    expect(t1.status).toBe('succeeded')
    expect(t1.iterations).toBeGreaterThan(1)
  })

  it('treats a dead checker (null) as not-green and warns', async () => {
    const rt = makeRuntime({ check: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.succeeded).toBe(0)
    expect(result.failed).toBeGreaterThan(0)
    expect(result.warnings.some((w: string) => /checker/i.test(w))).toBe(true)
  })

  it('still runs the checker when the implementer dies — a prior iteration may pass', async () => {
    const rt = makeRuntime({ green: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // The checker (default: green) is the source of truth, not the dead
    // implementer — both tasks succeed on the working tree's actual state.
    expect(result.succeeded).toBe(2)
    expect(result.warnings.some((w: string) => /implementer/i.test(w))).toBe(true)
  })

  it('survives a dead red agent (null) — warns and keeps iterating', async () => {
    const rt = makeRuntime({ red: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // Red never succeeds → loop exhausts → tasks fail, never throw.
    expect(result.failed + result.skipped).toBe(2)
    expect(result.warnings.some((w: string) => /test-writer|red/i.test(w))).toBe(true)
  })
})
