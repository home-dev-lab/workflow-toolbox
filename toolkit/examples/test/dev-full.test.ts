// dev-full.test.ts — end-to-end composition test for the dev-full workflow.
// Children are scripted via FakeRuntime's `workflows` record (keyed by the
// scriptPath STRING for {scriptPath} refs); dev-full itself spawns no agents.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../dev-full.workflow.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCRIPT_PATHS = {
  plan: '/repo/toolkit/workflows/dev-plan.js',
  implement: '/repo/toolkit/workflows/dev-implement.js',
  reviewFix: '/repo/toolkit/workflows/dev-review-fix.js',
}

const VALID_INPUT = {
  goal: 'Add input validation to the CLI',
  projectDir: '/repo',
  scriptPaths: SCRIPT_PATHS,
}

// The PlanArtifact the scripted plan child returns (dev-plan handoff contract).
const ARTIFACT = {
  goal: 'Add input validation to the CLI',
  context: {
    projectDir: '/repo',
    testCommand: 'pnpm test',
    buildCommand: 'pnpm build',
    conventions: 'TypeScript strict; vitest; small pure modules',
  },
  tasks: [
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
    {
      id: 'T2',
      title: 'Wire validate() into the CLI entry',
      intent: 'Call validate() before dispatch so bad input fails fast.',
      files: [
        { path: 'src/cli.ts', status: 'existing', role: 'integration point' },
        { path: 'src/validate.ts', status: 'existing', role: 'callee' },
      ],
      contracts: 'cli main() exits non-zero and prints the validation error on bad input',
      testPlan: 'Write a failing CLI test for the bad-input path first.',
      doneCriteria: ['CLI bad-input test passes'],
      dependsOn: ['T1'],
    },
  ],
  risks: [],
  outOfScope: ['Refactoring the existing dispatch logic'],
}

// The same artifact with every task declaring NO files — drives the
// empty-derivation gate (abort without diffCommand, proceed with it).
const ARTIFACT_NO_FILES = {
  ...ARTIFACT,
  tasks: ARTIFACT.tasks.map((t) => ({ ...t, files: [] })),
}

const PLAN_OUTPUT = {
  artifact: ARTIFACT,
  rejected: [],
  stats: { discover: { itemsIn: 1, itemsOut: 1, agentsSpawned: 2, dropped: 0, truncated: false } },
  warnings: [],
}

const IMPLEMENT_OUTPUT = {
  goal: ARTIFACT.goal,
  tasks: [
    { id: 'T1', title: 'Add validate() helper', status: 'succeeded', iterations: 1, evidence: 'Test suite passed: 12/12' },
    { id: 'T2', title: 'Wire validate() into the CLI entry', status: 'succeeded', iterations: 2, evidence: 'Test suite passed: 14/14' },
  ],
  succeeded: 2,
  failed: 0,
  skipped: 0,
  stats: { T1: { itemsIn: 1, itemsOut: 1, agentsSpawned: 0, dropped: 0, truncated: false } },
  warnings: [],
}

const REVIEW_OUTPUT = {
  goal: ARTIFACT.goal,
  suiteGreen: true,
  findings: [],
  tallies: { findings: 0, confirmed: 0, rejected: 0, unverified: 0, fixed: 0, unfixed: 0 },
  stats: { verify: { itemsIn: 0, itemsOut: 0, agentsSpawned: 0, dropped: 0, truncated: false } },
  warnings: [],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChildCalls {
  plan: unknown[]
  implement: unknown[]
  review: unknown[]
}

/**
 * Build a FakeRuntime whose three scripted children record the args they
 * receive and return the fixture outputs (or the override's result).
 * An override that throws simulates a child rejection (bad scriptPath,
 * child parseInput throw, child runtime error).
 */
function makeRuntime(overrides?: {
  plan?: (args: unknown) => unknown
  implement?: (args: unknown) => unknown
  review?: (args: unknown) => unknown
  budgetTotal?: number
}): { rt: FakeRuntime; calls: ChildCalls } {
  const calls: ChildCalls = { plan: [], implement: [], review: [] }
  const rt = new FakeRuntime({
    ...(overrides?.budgetTotal !== undefined ? { budgetTotal: overrides.budgetTotal } : {}),
    workflows: {
      [SCRIPT_PATHS.plan]: (args: unknown) => {
        calls.plan.push(args)
        return overrides?.plan ? overrides.plan(args) : PLAN_OUTPUT
      },
      [SCRIPT_PATHS.implement]: (args: unknown) => {
        calls.implement.push(args)
        return overrides?.implement ? overrides.implement(args) : IMPLEMENT_OUTPUT
      },
      [SCRIPT_PATHS.reviewFix]: (args: unknown) => {
        calls.review.push(args)
        return overrides?.review ? overrides.review(args) : REVIEW_OUTPUT
      },
    },
  })
  return { rt, calls }
}

function run(rt: FakeRuntime, input: unknown): Promise<Record<string, unknown>> {
  return wf.run(rt, JSON.stringify(input)) as unknown as Promise<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

describe('dev-full meta', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('dev-full')
    const titles = wf.meta.phases?.map((p) => p.title)
    expect(titles).toEqual(['Plan', 'Implement', 'Review & Fix', 'Report'])
  })
})

// ---------------------------------------------------------------------------
// parseInput — fail fast (the ONLY throwing surface)
// ---------------------------------------------------------------------------

describe('dev-full parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const { rt } = makeRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/goal|input/i)
  })

  it('throws for an empty goal', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, goal: '' })).rejects.toThrow(/goal/i)
  })

  it('throws for a missing projectDir', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, projectDir: undefined })).rejects.toThrow(/projectDir/i)
  })

  it('throws for missing scriptPaths', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, scriptPaths: undefined })).rejects.toThrow(/scriptPaths/i)
  })

  it('throws for an empty scriptPaths.plan', async () => {
    const { rt } = makeRuntime()
    await expect(
      run(rt, { ...VALID_INPUT, scriptPaths: { ...SCRIPT_PATHS, plan: '' } })
    ).rejects.toThrow(/plan/i)
  })

  it('throws for a missing scriptPaths.reviewFix', async () => {
    const { rt } = makeRuntime()
    await expect(
      run(rt, { ...VALID_INPUT, scriptPaths: { plan: SCRIPT_PATHS.plan, implement: SCRIPT_PATHS.implement } })
    ).rejects.toThrow(/reviewFix/i)
  })

  it('throws for a maxRefutedRatio outside [0,1]', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, maxRefutedRatio: 1.5 })).rejects.toThrow(/maxRefutedRatio/i)
  })

  it('throws for maxIterationsPerTask < 1', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, maxIterationsPerTask: 0 })).rejects.toThrow(/maxIterationsPerTask/i)
  })

  it('throws for maxFixIterations < 1', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, maxFixIterations: 0 })).rejects.toThrow(/maxFixIterations/i)
  })

  it('throws for an empty dimensions array', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, dimensions: [] })).rejects.toThrow(/dimensions/i)
  })

  it('throws for an empty-string diffCommand', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, diffCommand: '' })).rejects.toThrow(/diffCommand/i)
  })

  it('throws for an empty-string implementerModel', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, implementerModel: '' })).rejects.toThrow(/implementerModel/i)
  })

  it('throws for an empty-string fixerModel', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, fixerModel: '' })).rejects.toThrow(/fixerModel/i)
  })

  it('throws for an empty areas array', async () => {
    const { rt } = makeRuntime()
    await expect(run(rt, { ...VALID_INPUT, areas: [] })).rejects.toThrow(/areas/i)
  })
})

// ---------------------------------------------------------------------------
// Happy chain — exact child args (the in-code gate transforms)
// ---------------------------------------------------------------------------

describe('dev-full happy chain', () => {
  it('completes end-to-end and surfaces the review verdict', async () => {
    const { rt } = makeRuntime()
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('completed')
    expect(out.reason).toBeNull()
    expect((out.plan as Record<string, unknown>).taskCount).toBe(2)
    expect(out.implement).not.toBeNull()
    expect((out.review as Record<string, unknown>).suiteGreen).toBe(true)
  })

  it('sends the plan child exactly {goal, areas, projectDir}', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, VALID_INPUT)
    expect(calls.plan).toEqual([
      { goal: VALID_INPUT.goal, areas: ['.'], projectDir: '/repo' },
    ])
  })

  it('forwards operator-set areas to the plan child', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, areas: ['src', 'test'] })
    expect((calls.plan[0] as Record<string, unknown>).areas).toEqual(['src', 'test'])
  })

  it('sends the implement child the artifact and OMITS unset passthroughs (child defaults stay canonical)', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, VALID_INPUT)
    expect(calls.implement).toHaveLength(1)
    const sent = calls.implement[0] as Record<string, unknown>
    expect(sent.artifact).toEqual(ARTIFACT)
    expect('mutation' in sent).toBe(false)
    expect('maxIterationsPerTask' in sent).toBe(false)
    expect('implementerModel' in sent).toBe(false)
  })

  it('forwards maxIterationsPerTask to the implement child when the operator set it', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, maxIterationsPerTask: 7 })
    expect((calls.implement[0] as Record<string, unknown>).maxIterationsPerTask).toBe(7)
  })

  it('forwards implementerModel to the implement child when the operator set it', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, implementerModel: 'opus' })
    expect((calls.implement[0] as Record<string, unknown>).implementerModel).toBe('opus')
  })

  it('derives the review child input from the artifact context VERBATIM', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, VALID_INPUT)
    const sent = calls.review[0] as Record<string, unknown>
    expect(sent.projectDir).toBe('/repo')
    expect(sent.testCommand).toBe('pnpm test')
    expect(sent.buildCommand).toBe('pnpm build')
    expect(sent.conventions).toBe('TypeScript strict; vitest; small pure modules')
    expect(sent.goal).toBe(VALID_INPUT.goal)
  })

  it('OMITS dimensions and maxFixIterations from the review input when unset', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, VALID_INPUT)
    const sent = calls.review[0] as Record<string, unknown>
    expect('dimensions' in sent).toBe(false)
    expect('maxFixIterations' in sent).toBe(false)
    expect('fixerModel' in sent).toBe(false)
  })

  it('forwards dimensions and maxFixIterations to the review child when set', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, dimensions: ['correctness'], maxFixIterations: 2 })
    const sent = calls.review[0] as Record<string, unknown>
    expect(sent.dimensions).toEqual(['correctness'])
    expect(sent.maxFixIterations).toBe(2)
  })

  it('forwards fixerModel to the review child when the operator set it', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, fixerModel: 'opus' })
    expect((calls.review[0] as Record<string, unknown>).fixerModel).toBe('opus')
  })

  it('derives changedFiles (deduped) from succeeded AND failed tasks, never skipped ones', async () => {
    const artifact = {
      ...ARTIFACT,
      tasks: [
        ARTIFACT.tasks[0], // T1: src/validate.ts
        ARTIFACT.tasks[1], // T2: src/cli.ts + src/validate.ts (dup with T1)
        {
          ...ARTIFACT.tasks[1],
          id: 'T3',
          title: 'Skipped tail task',
          files: [{ path: 'src/never-touched.ts', status: 'new', role: 'impl' }],
          dependsOn: ['T2'],
        },
      ],
    }
    const { rt, calls } = makeRuntime({
      plan: () => ({ ...PLAN_OUTPUT, artifact }),
      implement: () => ({
        ...IMPLEMENT_OUTPUT,
        tasks: [
          { id: 'T1', title: 't', status: 'succeeded', iterations: 1, evidence: 'ok' },
          { id: 'T2', title: 't', status: 'failed', iterations: 4, evidence: 'red', note: 'failed' },
          { id: 'T3', title: 't', status: 'skipped', iterations: 0, evidence: '', note: 'skipped' },
        ],
        succeeded: 1,
        failed: 1,
        skipped: 1,
      }),
    })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('completed')
    const sent = calls.review[0] as Record<string, unknown>
    expect(sent.changedFiles).toEqual(['src/validate.ts', 'src/cli.ts'])
    expect(sent.diffCommand).toBeNull()
  })

  it('lets an operator-provided diffCommand WIN over derivation', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, diffCommand: 'git diff HEAD~1' })
    const sent = calls.review[0] as Record<string, unknown>
    expect(sent.diffCommand).toBe('git diff HEAD~1')
    expect(sent.changedFiles).toBeNull()
  })

  it('writes per-task status lines and the approximation note into changeSummary when deriving', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, VALID_INPUT)
    const sent = calls.review[0] as Record<string, unknown>
    const summary = sent.changeSummary as string
    expect(summary).toContain('T1 (Add validate() helper): succeeded')
    expect(summary).toContain('T2 (Wire validate() into the CLI entry): succeeded')
    expect(summary.toLowerCase()).toContain('planned files')
  })

  it('omits the approximation note from changeSummary when diffCommand is passed through', async () => {
    const { rt, calls } = makeRuntime()
    await run(rt, { ...VALID_INPUT, diffCommand: 'git diff HEAD~1' })
    const summary = (calls.review[0] as Record<string, unknown>).changeSummary as string
    expect(summary).toContain('T1 (Add validate() helper): succeeded')
    expect(summary.toLowerCase()).not.toContain('planned files')
  })

  it('aggregates child warnings with per-child prefixes', async () => {
    const { rt } = makeRuntime({
      plan: () => ({ ...PLAN_OUTPUT, warnings: ['discover degraded'] }),
      implement: () => ({ ...IMPLEMENT_OUTPUT, warnings: ['budget low'] }),
      review: () => ({ ...REVIEW_OUTPUT, warnings: ['cap truncated'] }),
    })
    const out = await run(rt, VALID_INPUT)
    const warnings = out.warnings as string[]
    expect(warnings).toContain('plan: discover degraded')
    expect(warnings).toContain('implement: budget low')
    expect(warnings).toContain('review: cap truncated')
  })

  it('adds its own approximation warning when changedFiles is derived', async () => {
    const { rt } = makeRuntime()
    const out = await run(rt, VALID_INPUT)
    const warnings = out.warnings as string[]
    expect(warnings.some((w) => w.includes('diffCommand'))).toBe(true)
  })

  it('carries the child stats through, keyed by chain step', async () => {
    const { rt } = makeRuntime()
    const out = await run(rt, VALID_INPUT)
    const stats = out.stats as Record<string, unknown>
    expect(stats.plan).toEqual(PLAN_OUTPUT.stats)
    expect(stats.implement).toEqual(IMPLEMENT_OUTPUT.stats)
    expect(stats.review).toEqual(REVIEW_OUTPUT.stats)
  })

  it('records the four phases in order', async () => {
    const { rt } = makeRuntime()
    await run(rt, VALID_INPUT)
    expect(rt.phases).toEqual(['Plan', 'Implement', 'Review & Fix', 'Report'])
  })
})

// ---------------------------------------------------------------------------
// Gates — every abort RETURNS (never throws after the first child call)
// ---------------------------------------------------------------------------

describe('dev-full gates', () => {
  it('aborts at plan when the plan child rejects, preserving the error text', async () => {
    const { rt, calls } = makeRuntime({
      plan: () => {
        throw new Error('dev-plan: "goal" must be a non-empty string')
      },
    })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toContain('dev-plan: "goal"')
    expect(out.plan).toBeNull()
    expect(out.implement).toBeNull()
    expect(out.review).toBeNull()
    expect(calls.implement).toHaveLength(0)
  })

  it('aborts at plan on a malformed plan return, naming the missing field', async () => {
    const { rt, calls } = makeRuntime({ plan: () => ({ nope: true }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toMatch(/artifact/i)
    expect(calls.implement).toHaveLength(0)
  })

  it('aborts at plan when the artifact context has an empty testCommand (degraded Discover)', async () => {
    const artifact = { ...ARTIFACT, context: { ...ARTIFACT.context, testCommand: '' } }
    const { rt, calls } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, artifact }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toMatch(/testCommand/)
    expect(out.plan).not.toBeNull() // operator gets the degraded artifact to arbitrate
    expect(calls.implement).toHaveLength(0)
  })

  it('aborts at plan when the artifact context has empty conventions', async () => {
    const artifact = { ...ARTIFACT, context: { ...ARTIFACT.context, conventions: '' } }
    const { rt } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, artifact }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toMatch(/conventions/)
  })

  it('aborts at plan when the refuted ratio exceeds maxRefutedRatio, surfacing the rejected reasons', async () => {
    const rejected = [
      { title: 'dup A', files: [], verdict: 'refuted', reason: 'duplicate of T1' },
      { title: 'dup B', files: [], verdict: 'refuted', reason: 'file does not exist' },
      { title: 'dup C', files: [], verdict: 'refuted', reason: 'criterion uncheckable' },
    ]
    const { rt, calls } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, rejected }) })
    // 3 rejected / (3 + 2 kept) = 0.6 > 0.5 default
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toMatch(/0\.6/)
    expect(out.reason).toMatch(/0\.5/)
    const plan = out.plan as Record<string, unknown>
    expect(plan.rejected).toEqual(rejected)
    expect(plan.artifact).toEqual(ARTIFACT)
    expect(calls.implement).toHaveLength(0)
  })

  it('proceeds when the refuted ratio is exactly at the threshold (strict >)', async () => {
    const rejected = [
      { title: 'dup A', files: [], verdict: 'refuted', reason: 'duplicate' },
      { title: 'dup B', files: [], verdict: 'refuted', reason: 'duplicate' },
    ]
    // 2 rejected / (2 + 2 kept) = 0.5, NOT > 0.5
    const { rt } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, rejected }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('completed')
  })

  it('aborts at implement when the implement child rejects, preserving the plan section', async () => {
    const { rt, calls } = makeRuntime({
      implement: () => {
        throw new Error('dev-implement: artifact tasks have a dependency cycle')
      },
    })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-implement')
    expect(out.reason).toContain('dependency cycle')
    expect((out.plan as Record<string, unknown>).artifact).toEqual(ARTIFACT)
    expect(out.implement).toBeNull()
    expect(out.review).toBeNull()
    expect(calls.review).toHaveLength(0)
  })

  it('aborts at implement on a malformed implement return', async () => {
    const { rt } = makeRuntime({ implement: () => 'not a record' })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-implement')
    expect(out.reason).toMatch(/succeeded|shape/i)
  })

  it('aborts at implement when zero tasks succeeded, preserving the implement report', async () => {
    const { rt, calls } = makeRuntime({
      implement: () => ({
        ...IMPLEMENT_OUTPUT,
        tasks: [
          { id: 'T1', title: 't', status: 'failed', iterations: 4, evidence: 'red', note: 'failed' },
          { id: 'T2', title: 't', status: 'skipped', iterations: 0, evidence: '', note: 'skipped' },
        ],
        succeeded: 0,
        failed: 1,
        skipped: 1,
      }),
    })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-implement')
    expect(out.reason).toMatch(/no task succeeded|0/i)
    expect((out.implement as Record<string, unknown>).failed).toBe(1)
    expect(calls.review).toHaveLength(0)
  })

  it('aborts BEFORE the review child when derivation yields no files and no diffCommand was given', async () => {
    const { rt, calls } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, artifact: ARTIFACT_NO_FILES }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-review')
    expect(out.reason).toMatch(/diffCommand/)
    expect(calls.review).toHaveLength(0)
    expect(out.implement).not.toBeNull()
  })

  it('proceeds on empty derivation when a diffCommand is available', async () => {
    const { rt, calls } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, artifact: ARTIFACT_NO_FILES }) })
    const out = await run(rt, { ...VALID_INPUT, diffCommand: 'git diff HEAD~1' })
    expect(out.outcome).toBe('completed')
    expect(calls.review).toHaveLength(1)
  })

  it('aborts at review when the review child rejects, preserving plan and implement results', async () => {
    const { rt } = makeRuntime({
      review: () => {
        throw new Error('dev-review-fix: "testCommand" must be a non-empty string')
      },
    })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-review')
    expect(out.reason).toContain('testCommand')
    expect((out.plan as Record<string, unknown>).taskCount).toBe(2)
    expect((out.implement as Record<string, unknown>).succeeded).toBe(2)
    expect(out.review).toBeNull()
  })

  it('aborts at review on a malformed review return', async () => {
    const { rt } = makeRuntime({ review: () => 42 })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-review')
    expect(out.reason).toMatch(/shape|record/i)
  })

  it('reports completed even when the review child says the suite is red (verdict surfaced, not gated)', async () => {
    const { rt } = makeRuntime({ review: () => ({ ...REVIEW_OUTPUT, suiteGreen: false }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('completed')
    expect((out.review as Record<string, unknown>).suiteGreen).toBe(false)
  })

  it('fires the degraded-context gate before the refuted-ratio gate when both apply', async () => {
    const artifact = { ...ARTIFACT, context: { ...ARTIFACT.context, testCommand: '' } }
    const rejected = [
      { title: 'dup A', files: [], verdict: 'refuted', reason: 'duplicate' },
      { title: 'dup B', files: [], verdict: 'refuted', reason: 'duplicate' },
      { title: 'dup C', files: [], verdict: 'refuted', reason: 'duplicate' },
    ]
    const { rt } = makeRuntime({ plan: () => ({ ...PLAN_OUTPUT, artifact, rejected }) })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toMatch(/testCommand/)
  })

  it('aborts honestly before any child when the budget is already exhausted', async () => {
    const { rt, calls } = makeRuntime({ budgetTotal: 0 })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('aborted-at-plan')
    expect(out.reason).toMatch(/budget/i)
    expect(calls.plan).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Test: the changedFiles derivation normalizes under-root absolute planned
// paths (same defense as dev-implement — an operator-supplied older dev-plan
// artifact may still carry absolutes; relativizing keeps the review child's
// changedFiles consistent with relative diff-style paths). Idempotent on
// relative paths.
// ---------------------------------------------------------------------------

describe('dev-full changedFiles path normalization', () => {
  it('relativizes under-root absolute planned paths and dedupes across spellings', async () => {
    const artifact = {
      ...ARTIFACT,
      tasks: [
        { ...ARTIFACT.tasks[0], files: [{ path: '/repo/src/validate.ts', status: 'new', role: 'impl' }] },
        ARTIFACT.tasks[1], // declares src/cli.ts + src/validate.ts (relative)
      ],
    }
    const { rt, calls } = makeRuntime({
      plan: () => ({ ...PLAN_OUTPUT, artifact }),
    })
    const out = await run(rt, VALID_INPUT)
    expect(out.outcome).toBe('completed')
    const sent = calls.review[0] as Record<string, unknown>
    expect(sent.changedFiles).toEqual(['src/validate.ts', 'src/cli.ts'])
  })
})
