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
    // Setup + Merge are worktree-mode display groups; sequential runs simply
    // never emit them (unused declared phases are harmless display grouping).
    expect(titles).toEqual(['Setup', 'Implement', 'Check', 'Merge', 'Report'])
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

  // (the v1 'worktree is reserved' rejection test was retired when worktree
  // mode shipped — acceptance is covered in the worktree describe blocks)

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

  it('red prompt carries the no-tests escape hatch (docs-only tasks must not stall)', async () => {
    // Live-run lesson (run wf_673b1f49-5b6): a docs-only task whose testPlan
    // says "no unit tests to write" made the test-writer honestly return
    // written: false every iteration — the loop burned maxIterations on red
    // and NEVER reached green/check. The prompt must tell the agent that
    // "nothing to write" is a SUCCESS (written: true, empty testFiles), so
    // the loop proceeds to implement + check the done criteria.
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const red = rt.calls.find((c) => c.opts?.label === 'dev-implement:red:T1')!
    expect(red.prompt).toMatch(/nothing to write|no tests are needed/i)
    expect(red.prompt).toMatch(/written.*true.*empty|empty.*testFiles/i)
  })

  it('records the Implement, Check and Report phases', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(rt.phases).toContain('Implement')
    expect(rt.phases).toContain('Check')
    expect(rt.phases).toContain('Report')
  })

  it('surfaces REAL per-task agent counts in stats (not the old hard-coded 0)', async () => {
    // Regression guard for the loopUntilDone counting change: each task's
    // envelope stats must report the agents its TDD body spawned through the
    // rt it received (red + green + check per iteration), instead of the
    // pre-change agentsSpawned: 0 — the live-run lesson was that per-task
    // agent counts otherwise only exist in the run journal, not the output.
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    for (const id of ['T1', 'T2']) {
      expect(result.stats[id]!.agentsSpawned).toBeGreaterThan(0)
    }
    // Every agent the run spawned belongs to exactly one task's loop body,
    // so the per-task counts must add up to the runtime's total.
    const counted = result.stats['T1']!.agentsSpawned + result.stats['T2']!.agentsSpawned
    expect(counted).toBe(rt.agentsSpawned)
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

// ---------------------------------------------------------------------------
// Worktree mutation mode (v2): waves of independent tasks run their TDD loops
// in parallel, each in an isolated git worktree, then merge sequentially with
// a per-merge integration check. Conservative policies (user-ratified):
// conflict → merge-failed, integration red → revert + integration-failed,
// failure worktrees KEPT for forensics, machine commits unsigned by default.
// ---------------------------------------------------------------------------

// Two independent tasks + one depending on both → two waves.
const WT_ARTIFACT = {
  goal: 'Add validation helpers',
  context: {
    projectDir: '/repo',
    testCommand: 'pnpm test',
    buildCommand: '',
    conventions: 'TypeScript strict; vitest',
  },
  tasks: [
    {
      id: 'T1',
      title: 'Add validate()',
      intent: 'Pure helper.',
      files: [{ path: 'src/validate.ts', status: 'new', role: 'impl' }],
      contracts: 'export function validate(raw: unknown): boolean',
      testPlan: 'Failing unit test first.',
      doneCriteria: ['unit tests pass'],
      dependsOn: [],
    },
    {
      id: 'T2',
      title: 'Add sanitize()',
      intent: 'Pure helper.',
      files: [{ path: 'src/sanitize.ts', status: 'new', role: 'impl' }],
      contracts: 'export function sanitize(raw: string): string',
      testPlan: 'Failing unit test first.',
      doneCriteria: ['unit tests pass'],
      dependsOn: [],
    },
    {
      id: 'T3',
      title: 'Wire both into the CLI',
      intent: 'Integration point.',
      files: [{ path: 'src/cli.ts', status: 'existing', role: 'integration' }],
      contracts: 'main() validates then sanitizes',
      testPlan: 'Failing CLI test first.',
      doneCriteria: ['CLI tests pass'],
      dependsOn: ['T1', 'T2'],
    },
  ],
  risks: [],
  outOfScope: [],
}

const WT_INPUT = { artifact: WT_ARTIFACT, mutation: 'worktree' }

/**
 * Worktree-mode runtime: routes the SIX new agent kinds plus the three TDD
 * stages. Unique phrases, most-specific-first. The wave-create default parses
 * the task branches out of its own prompt so any wave shape gets all its
 * worktrees "created".
 */
function makeWtRuntime(overrides?: {
  setup?: (prompt: string) => unknown
  create?: (prompt: string, wave: number) => unknown
  prepare?: (prompt: string) => unknown
  finalize?: (prompt: string) => unknown
  merge?: (prompt: string, index: number) => unknown
  integration?: (prompt: string, index: number) => unknown
  revert?: (prompt: string) => unknown
  cleanup?: (prompt: string) => unknown
  red?: (prompt: string) => unknown
  green?: (prompt: string) => unknown
  check?: (prompt: string) => unknown
}): FakeRuntime {
  let createCalls = 0
  let mergeCalls = 0
  let integrationCalls = 0
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()
      if (p.includes('create the isolated git worktrees')) {
        const i = createCalls++
        if (overrides?.create) return overrides.create(prompt, i)
        const ids = [...prompt.matchAll(/wt-task\/(T\d+)/g)].map((m) => m[1])
        return { created: [...new Set(ids)], failures: [], note: 'worktrees added' }
      }
      if (p.includes('prepare the task worktree')) {
        if (overrides?.prepare) return overrides.prepare(prompt)
        return { ok: true, note: 'setup command ran' }
      }
      if (p.includes('verify this is a git repository')) {
        if (overrides?.setup) return overrides.setup(prompt)
        return { isGitRepo: true, headSha: 'base000', note: 'git repo confirmed' }
      }
      if (p.includes('commit the task changes on its task branch')) {
        if (overrides?.finalize) return overrides.finalize(prompt)
        return { committed: true, sha: 'c0ffee1', note: 'committed' }
      }
      if (p.includes('merge the task branch')) {
        const i = mergeCalls++
        if (overrides?.merge) return overrides.merge(prompt, i)
        return { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged clean' }
      }
      if (p.includes('verify the integrated main tree')) {
        const i = integrationCalls++
        if (overrides?.integration) return overrides.integration(prompt, i)
        return { green: true, evidence: 'suite green on main', failureSummary: '' }
      }
      if (p.includes('revert the failed merge')) {
        if (overrides?.revert) return overrides.revert(prompt)
        return { reverted: true, headSha: 'pre0', note: 'reset done' }
      }
      if (p.includes('remove the merged worktrees')) {
        if (overrides?.cleanup) return overrides.cleanup(prompt)
        return { removed: ['all'], failures: [], note: 'cleaned' }
      }
      if (p.includes('independently verify by running')) {
        if (overrides?.check) return overrides.check(prompt)
        return { green: true, evidence: 'Test suite passed: 12/12', failureSummary: '' }
      }
      if (p.includes('write the failing tests first')) {
        if (overrides?.red) return overrides.red(prompt)
        return { written: true, testFiles: ['test/x.test.ts'], note: 'failing tests written' }
      }
      if (p.includes('make the failing tests pass')) {
        if (overrides?.green) return overrides.green(prompt)
        return { done: true, filesTouched: ['src/x.ts'], note: 'implemented' }
      }
      throw new Error(`makeWtRuntime: unrouted prompt: ${prompt.slice(0, 100)}`)
    },
  })
}

function promptIndex(rt: FakeRuntime, needle: string): number {
  return rt.calls.findIndex((c) => c.prompt.includes(needle))
}

describe('dev-implement worktree parseInput', () => {
  it('accepts mutation "worktree" (no longer reserved)', async () => {
    const rt = makeWtRuntime()
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.succeeded).toBe(3)
  })

  it('rejects worktree-only knobs in sequential mode', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ artifact: ARTIFACT, worktreeSetupCommand: 'pnpm install' }))
    ).rejects.toThrow(/worktree/i)
  })

  it('rejects an empty worktreeSetupCommand', async () => {
    const rt = makeWtRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...WT_INPUT, worktreeSetupCommand: '' }))
    ).rejects.toThrow(/worktreeSetupCommand/i)
  })

  it('rejects an empty worktreeRoot and a non-boolean signCommits', async () => {
    const rt = makeWtRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...WT_INPUT, worktreeRoot: '' }))
    ).rejects.toThrow(/worktreeRoot/i)
    await expect(
      wf.run(rt, JSON.stringify({ ...WT_INPUT, signCommits: 'yes' }))
    ).rejects.toThrow(/signCommits/i)
  })
})

describe('dev-implement worktree happy path (two waves)', () => {
  it('runs the full chain: setup, per-wave create, parallel TDD in worktrees, ordered merges, batched cleanup', async () => {
    const rt = makeWtRuntime()
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))

    expect(result.succeeded).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.mergeFailed).toBe(0)
    expect(result.integrationFailed).toBe(0)

    // Worktree paths are the deterministic sibling default; branches are named.
    const t1Red = rt.calls.find((c) => c.prompt.includes('Write the failing tests first') && c.prompt.includes('T1'))
    expect(t1Red?.prompt).toContain('/repo-worktrees/T1')
    const createWave1 = rt.calls.find((c) => c.prompt.includes('create the isolated git worktrees'))
    expect(createWave1?.prompt).toContain('wt-task/T1')
    expect(createWave1?.prompt).toContain('wt-task/T2')
    expect(createWave1?.prompt).not.toContain('wt-task/T3')

    // Machine commits are UNSIGNED by default (signCommits: false).
    const finalize = rt.calls.find((c) => c.prompt.includes('commit the task changes on its task branch'))
    expect(finalize?.prompt).toContain('commit.gpgsign=false')
    const merge = rt.calls.find((c) => c.prompt.includes('merge the task branch'))
    expect(merge?.prompt).toContain('commit.gpgsign=false')

    // Sequential merges in wave order: T1 before T2; integration check after EACH.
    const mergeT1 = promptIndex(rt, 'merge the task branch wt-task/T1')
    const mergeT2 = promptIndex(rt, 'merge the task branch wt-task/T2')
    expect(mergeT1).toBeGreaterThanOrEqual(0)
    expect(mergeT2).toBeGreaterThan(mergeT1)
    const integrations = rt.calls.filter((c) => c.prompt.includes('verify the integrated main tree'))
    expect(integrations.length).toBe(3) // one per merged task

    // Wave-2 worktree (T3) is created AFTER wave-1's merges — it must branch
    // from a HEAD that already contains T1+T2 (its dependencies).
    const createT3 = rt.calls.findIndex((c) => c.prompt.includes('create the isolated git worktrees') && c.prompt.includes('wt-task/T3'))
    expect(createT3).toBeGreaterThan(mergeT2)

    // ONE batched cleanup at the end, listing the merged tasks.
    const cleanups = rt.calls.filter((c) => c.prompt.includes('remove the merged worktrees'))
    expect(cleanups.length).toBe(1)
    expect(cleanups[0]!.prompt).toContain('/repo-worktrees/T3')
  })

  it('honors signCommits: true (no unsign override in machine commits)', async () => {
    const rt = makeWtRuntime()
    await wf.run(rt, JSON.stringify({ ...WT_INPUT, signCommits: true }))
    const finalize = rt.calls.find((c) => c.prompt.includes('commit the task changes on its task branch'))
    expect(finalize?.prompt).not.toContain('commit.gpgsign=false')
  })

  it('runs the verbatim worktreeSetupCommand per task before TDD, and fails the task when it fails', async () => {
    const rt = makeWtRuntime({
      prepare: (prompt) =>
        prompt.includes('/repo-worktrees/T2')
          ? { ok: false, note: 'pnpm install exploded' }
          : { ok: true, note: 'installed' },
    })
    const result = await wf.run(rt, JSON.stringify({ ...WT_INPUT, worktreeSetupCommand: 'pnpm install' }))

    const prepares = rt.calls.filter((c) => c.prompt.includes('prepare the task worktree'))
    expect(prepares.length).toBeGreaterThanOrEqual(2)
    expect(prepares[0]!.prompt).toContain('pnpm install')

    const t2 = result.tasks.find((t: { id: string }) => t.id === 'T2')!
    expect(t2.status).toBe('failed')
    // No TDD spend for the failed-prepare task.
    const t2Red = rt.calls.find((c) => c.prompt.includes('Write the failing tests first') && c.prompt.includes('/repo-worktrees/T2'))
    expect(t2Red).toBeUndefined()
    // T3 depends on T2 → skipped.
    expect(result.tasks.find((t: { id: string }) => t.id === 'T3')!.status).toBe('skipped')
  })

  it('honors a worktreeRoot override', async () => {
    const rt = makeWtRuntime()
    await wf.run(rt, JSON.stringify({ ...WT_INPUT, worktreeRoot: '/scratch/wt' }))
    const t1Red = rt.calls.find((c) => c.prompt.includes('Write the failing tests first') && c.prompt.includes('T1'))
    expect(t1Red?.prompt).toContain('/scratch/wt/T1')
  })

  it('warns when same-wave tasks declare overlapping files', async () => {
    const overlapping = {
      ...WT_ARTIFACT,
      tasks: WT_ARTIFACT.tasks.map((t) =>
        t.id === 'T2' ? { ...t, files: [{ path: 'src/validate.ts', status: 'existing', role: 'also' }] } : t
      ),
    }
    const rt = makeWtRuntime()
    const result = await wf.run(rt, JSON.stringify({ artifact: overlapping, mutation: 'worktree' }))
    expect(result.warnings.some((w: string) => w.includes('src/validate.ts') && w.includes('T1') && w.includes('T2'))).toBe(true)
  })
})

describe('dev-implement worktree failure policies', () => {
  it('merge conflict → merge-failed, worktree KEPT (path+branch in report), dependents skip, not cleaned', async () => {
    const rt = makeWtRuntime({
      merge: (prompt, i) =>
        prompt.includes('wt-task/T1')
          ? { merged: false, conflict: true, preMergeSha: `pre${i}`, mergeSha: '', note: 'CONFLICT in src/validate.ts' }
          : { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged' },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))

    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    expect(t1.status).toBe('merge-failed')
    expect(t1.worktreePath).toBe('/repo-worktrees/T1')
    expect(t1.branch).toBe('wt-task/T1')
    expect(result.mergeFailed).toBe(1)
    expect(result.tasks.find((t: { id: string }) => t.id === 'T3')!.status).toBe('skipped')
    // The kept worktree is NOT in the cleanup batch.
    const cleanup = rt.calls.find((c) => c.prompt.includes('remove the merged worktrees'))
    expect(cleanup?.prompt).not.toContain('/repo-worktrees/T1')
    expect(cleanup?.prompt).toContain('/repo-worktrees/T2')
  })

  it('integration red → revert with the pre-merge sha, integration-failed, worktree kept', async () => {
    const rt = makeWtRuntime({
      integration: (_prompt, i) =>
        i === 0
          ? { green: false, evidence: '2 tests failed on main', failureSummary: 'cross-task breakage' }
          : { green: true, evidence: 'suite green', failureSummary: '' },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))

    const revert = rt.calls.find((c) => c.prompt.includes('revert the failed merge'))
    expect(revert?.prompt).toContain('pre0')
    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    expect(t1.status).toBe('integration-failed')
    expect(t1.worktreePath).toBe('/repo-worktrees/T1')
    expect(result.integrationFailed).toBe(1)
    expect(result.tasks.find((t: { id: string }) => t.id === 'T3')!.status).toBe('skipped')
  })

  it('integration checker died → conservative revert + warning', async () => {
    const rt = makeWtRuntime({
      integration: (_prompt, i) => (i === 0 ? null : { green: true, evidence: 'ok', failureSummary: '' }),
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.tasks.find((t: { id: string }) => t.id === 'T1')!.status).toBe('integration-failed')
    expect(result.warnings.some((w: string) => /integration checker died/i.test(w))).toBe(true)
    expect(rt.calls.some((c) => c.prompt.includes('revert the failed merge'))).toBe(true)
  })

  it('not a git repository → honest degraded report, every task skipped, no further agents', async () => {
    const rt = makeWtRuntime({
      setup: () => ({ isGitRepo: false, headSha: '', note: 'not a repo' }),
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.skipped).toBe(3)
    expect(result.succeeded + result.failed + result.mergeFailed + result.integrationFailed).toBe(0)
    expect(result.warnings.some((w: string) => /git repository/i.test(w))).toBe(true)
    expect(rt.calls.some((c) => c.prompt.includes('create the isolated git worktrees'))).toBe(false)
  })

  it('worktree-create failure for one task → that task failed without TDD spend, siblings proceed', async () => {
    const rt = makeWtRuntime({
      create: (prompt) => {
        const ids = [...prompt.matchAll(/wt-task\/(T\d+)/g)].map((m) => m[1])
        const unique = [...new Set(ids)]
        return {
          created: unique.filter((id) => id !== 'T2'),
          failures: unique.includes('T2') ? [{ id: 'T2', note: 'path already exists — stale worktree from a previous run?' }] : [],
          note: 'partial',
        }
      },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    const t2 = result.tasks.find((t: { id: string }) => t.id === 'T2')!
    expect(t2.status).toBe('failed')
    expect(t2.note).toMatch(/already exists|worktree/i)
    expect(result.tasks.find((t: { id: string }) => t.id === 'T1')!.status).toBe('succeeded')
    expect(result.tasks.find((t: { id: string }) => t.id === 'T3')!.status).toBe('skipped')
  })

  it('failed TDD task in worktree mode keeps its worktree and never touches main', async () => {
    const rt = makeWtRuntime({
      check: () => ({ green: false, evidence: 'still red', failureSummary: 'assertion fails' }),
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    expect(t1.status).toBe('failed')
    expect(t1.worktreePath).toBe('/repo-worktrees/T1')
    // Nothing green → no merges at all, main untouched.
    expect(rt.calls.some((c) => c.prompt.includes('merge the task branch'))).toBe(false)
  })

  it('reports a thrown task chain as failed with the worktree kept, and warns', async () => {
    const rt = makeWtRuntime({
      red: (prompt) => {
        if (prompt.includes('/repo-worktrees/T2')) throw new Error('agent runner exploded')
        return { written: true, testFiles: ['test/x.test.ts'], note: 'ok' }
      },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    const t2 = result.tasks.find((t: { id: string }) => t.id === 'T2')!
    expect(t2.status).toBe('failed')
    expect(t2.note).toMatch(/chain crashed/i)
    expect(t2.worktreePath).toBe('/repo-worktrees/T2')
    expect(result.warnings.some((w: string) => /chain crashed/i.test(w))).toBe(true)
    // The sibling task is unaffected.
    expect(result.tasks.find((t: { id: string }) => t.id === 'T1')!.status).toBe('succeeded')
  })

  it('warns when the cleanup agent reports failures (worktrees left on disk)', async () => {
    const rt = makeWtRuntime({
      cleanup: () => ({ removed: ['T1'], failures: [{ id: 'T2', note: 'worktree busy' }], note: 'partial cleanup' }),
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.succeeded).toBe(3)
    expect(result.warnings.some((w: string) => w.includes('T2') && /cleanup/i.test(w))).toBe(true)
  })

  it('keeps the five tallies summing to the task count on a mixed run', async () => {
    const rt = makeWtRuntime({
      merge: (prompt, i) =>
        prompt.includes('wt-task/T1')
          ? { merged: false, conflict: true, preMergeSha: `pre${i}`, mergeSha: '', note: 'CONFLICT' }
          : { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged' },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    const sum = result.succeeded + result.failed + result.skipped + result.mergeFailed + result.integrationFailed
    expect(sum).toBe(WT_ARTIFACT.tasks.length)
  })

  it('sequential mode never emits worktree machinery and reports zeroed new tallies', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result.mergeFailed).toBe(0)
    expect(result.integrationFailed).toBe(0)
    for (const phrase of ['create the isolated git worktrees', 'merge the task branch', 'remove the merged worktrees', 'verify this is a git repository']) {
      expect(rt.calls.some((c) => c.prompt.includes(phrase))).toBe(false)
    }
  })
})
