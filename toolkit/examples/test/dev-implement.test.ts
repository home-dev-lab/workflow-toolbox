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
// Test: scoped iteration runs — implementer iterates on the task's own test
// files, full suite once before reporting; the checker stays on the FULL
// verbatim command (source of truth).
// ---------------------------------------------------------------------------

describe('dev-implement scoped iteration runs', () => {
  it('tells the test-writer and implementer to iterate on the task test files, full run once before reporting', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const red = rt.calls.find((c) => c.opts?.label?.startsWith('dev-implement:red:'))
    const green = rt.calls.find((c) => c.opts?.label?.startsWith('dev-implement:green:'))
    expect(red).toBeDefined()
    expect(green).toBeDefined()
    for (const call of [red, green]) {
      // Scoped ITERATION runs (generic phrasing — no runner syntax)…
      expect(call?.prompt).toContain('running a subset')
      // …but one FULL run self-screens before reporting.
      expect(call?.prompt).toContain('once before reporting')
    }
  })

  it('keeps the checker on the FULL verbatim test command with no scoping instruction', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const checkers = rt.calls.filter((c) => c.opts?.label?.startsWith('dev-implement:check:'))
    expect(checkers.length).toBeGreaterThan(0)
    for (const c of checkers) {
      expect(c.prompt).toContain('pnpm test')
      // The checker is the source of truth — it never gets the scoped-run hint.
      expect(c.prompt).not.toContain('running a subset')
      expect(c.prompt).not.toContain('once before reporting')
    }
  })

  it('keeps the worktree integration checker unscoped too (the other source-of-truth prompt)', async () => {
    // makeWtRuntime/WT_INPUT are defined later in the module — module consts
    // initialize at collection time, before any it() body runs.
    const rt = makeWtRuntime()
    await wf.run(rt, JSON.stringify(WT_INPUT))

    const integration = rt.calls.filter((c) =>
      c.opts?.label?.startsWith('dev-implement:integration:'),
    )
    expect(integration.length).toBeGreaterThan(0)
    for (const c of integration) {
      expect(c.prompt).not.toContain('running a subset')
      expect(c.prompt).not.toContain('once before reporting')
    }
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
 * stages on the call's LABEL (unique by construction: `dev-implement:setup`,
 * `dev-implement:worktrees:wave*`, `dev-implement:<stage>:<taskId>`, …) rather
 * than on prompt content — worker-produced text (titles, notes, checker
 * failure summaries) flows into later prompts, so substring routing could be
 * fooled by it. The wave-create default parses the task branches out of its
 * own prompt so any wave shape gets all its worktrees "created".
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
  let revertCalls = 0
  return new FakeRuntime({
    onAgent: ({ prompt, opts }: { prompt: string; opts?: { label?: string }; index: number }) => {
      const label = opts?.label ?? ''
      if (label.startsWith('dev-implement:worktrees:')) {
        const i = createCalls++
        if (overrides?.create) return overrides.create(prompt, i)
        const ids = [...prompt.matchAll(/wt-task\/(T\d+)/g)].map((m) => m[1])
        return { created: [...new Set(ids)], failures: [], note: 'worktrees added' }
      }
      if (label.startsWith('dev-implement:prepare:')) {
        if (overrides?.prepare) return overrides.prepare(prompt)
        return { ok: true, note: 'setup command ran' }
      }
      if (label === 'dev-implement:setup') {
        if (overrides?.setup) return overrides.setup(prompt)
        return { isGitRepo: true, headSha: 'base000', gitRoot: '/repo', note: 'git repo confirmed' }
      }
      if (label.startsWith('dev-implement:finalize:')) {
        if (overrides?.finalize) return overrides.finalize(prompt)
        return { committed: true, sha: 'c0ffee1', note: 'committed' }
      }
      if (label.startsWith('dev-implement:merge:')) {
        const i = mergeCalls++
        if (overrides?.merge) return overrides.merge(prompt, i)
        return { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged clean' }
      }
      if (label.startsWith('dev-implement:integration:')) {
        const i = integrationCalls++
        if (overrides?.integration) return overrides.integration(prompt, i)
        return { green: true, evidence: 'suite green on main', failureSummary: '' }
      }
      if (label.startsWith('dev-implement:revert:')) {
        revertCalls++
        if (overrides?.revert) return overrides.revert(prompt)
        // Default revert echoes the preMergeSha from its OWN prompt (the revert
        // command interpolates it), satisfying the headSha === preMergeSha check.
        const sha = /git reset --hard (\S+)/.exec(prompt)?.[1] ?? `pre${revertCalls - 1}`
        return { reverted: true, headSha: sha, note: 'reset done' }
      }
      if (label === 'dev-implement:cleanup') {
        if (overrides?.cleanup) return overrides.cleanup(prompt)
        return { removed: ['all'], failures: [], note: 'cleaned' }
      }
      if (label.startsWith('dev-implement:check:')) {
        if (overrides?.check) return overrides.check(prompt)
        return { green: true, evidence: 'Test suite passed: 12/12', failureSummary: '' }
      }
      if (label.startsWith('dev-implement:red:')) {
        if (overrides?.red) return overrides.red(prompt)
        return { written: true, testFiles: ['test/x.test.ts'], note: 'failing tests written' }
      }
      if (label.startsWith('dev-implement:green:')) {
        if (overrides?.green) return overrides.green(prompt)
        return { done: true, filesTouched: ['src/x.ts'], note: 'implemented' }
      }
      throw new Error(`makeWtRuntime: unrouted label "${label}" — prompt: ${prompt.slice(0, 100)}`)
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

  it('maps a sub-directory projectDir into the worktree (gitRoot-relative)', async () => {
    // projectDir is a SUBDIRECTORY of the git root (monorepo layout): the
    // worktree checks out the WHOLE repo, so the TDD workdir must be the
    // worktree path PLUS the projectDir-relative suffix — and the default
    // worktree root must be a sibling of the GIT ROOT (a <projectDir>-worktrees
    // sibling would land INSIDE the repo and pollute git status).
    const artifact = { ...WT_ARTIFACT, context: { ...WT_ARTIFACT.context, projectDir: '/repo/toolkit' } }
    const rt = makeWtRuntime()
    const result = await wf.run(rt, JSON.stringify({ artifact, mutation: 'worktree' }))
    expect(result.succeeded).toBe(3)
    // Worktrees still live as a sibling of the GIT ROOT...
    const create = rt.calls.find((c) => c.prompt.includes('create the isolated git worktrees'))
    expect(create?.prompt).toContain('git worktree add /repo-worktrees/T1')
    // ...but the TDD stages work from the mapped subdirectory inside it.
    const t1Red = rt.calls.find((c) => c.prompt.includes('Write the failing tests first') && c.prompt.includes('T1'))
    expect(t1Red?.prompt).toContain('Work from directory: /repo-worktrees/T1/toolkit')
    // Merge/integration still run from the MAIN projectDir.
    const integ = rt.calls.find((c) => c.prompt.includes('verify the integrated main tree'))
    expect(integ?.prompt).toContain('from /repo/toolkit')
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

  it('merge agent died → merge-failed (branch not merged), worktree kept, dependents skip', async () => {
    const rt = makeWtRuntime({
      merge: (prompt, i) =>
        prompt.includes('wt-task/T1')
          ? null
          : { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged' },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    expect(t1.status).toBe('merge-failed')
    expect(t1.note).toMatch(/merge agent died/i)
    expect(t1.worktreePath).toBe('/repo-worktrees/T1')
    expect(result.tasks.find((t: { id: string }) => t.id === 'T3')!.status).toBe('skipped')
    // A dead merge agent must never trigger an integration check or a revert.
    expect(rt.calls.some((c) => c.opts?.label === 'dev-implement:integration:T1')).toBe(false)
    expect(rt.calls.some((c) => c.opts?.label === 'dev-implement:revert:T1')).toBe(false)
  })

  it('merged: true with an EMPTY preMergeSha → merge-failed BEFORE integration, loud warning, no bare reset', async () => {
    // An empty revert target would render the revert as a bare `git reset
    // --hard` (= reset to HEAD, KEEPING the bad merge) — the guard refuses it
    // deterministically instead of trusting the self-report.
    const rt = makeWtRuntime({
      merge: (prompt, i) =>
        prompt.includes('wt-task/T1')
          ? { merged: true, conflict: false, preMergeSha: '', mergeSha: 'mrg0', note: 'merged (sha lost)' }
          : { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged' },
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    const t1 = result.tasks.find((t: { id: string }) => t.id === 'T1')!
    expect(t1.status).toBe('merge-failed')
    expect(t1.note).toMatch(/preMergeSha|revert target/i)
    expect(result.warnings.some((w: string) => /empty\s+preMergeSha/i.test(w))).toBe(true)
    // No integration spend and no revert prompt for the refused merge.
    const t1Integration = rt.calls.find((c) => c.opts?.label === 'dev-implement:integration:T1')
    expect(t1Integration).toBeUndefined()
    const t1Revert = rt.calls.find((c) => c.opts?.label === 'dev-implement:revert:T1')
    expect(t1Revert).toBeUndefined()
  })

  it('revert agent died → loudest warning with the manual-recovery command (main may hold the bad merge)', async () => {
    const rt = makeWtRuntime({
      integration: (_prompt, i) =>
        i === 0
          ? { green: false, evidence: 'red on main', failureSummary: 'cross-task breakage' }
          : { green: true, evidence: 'ok', failureSummary: '' },
      revert: () => null,
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.tasks.find((t: { id: string }) => t.id === 'T1')!.status).toBe('integration-failed')
    expect(result.warnings.some((w: string) =>
      /revert agent died/i.test(w) && w.includes('MAIN tree may') && w.includes('git reset --hard pre0'),
    )).toBe(true)
  })

  it('revert reported NOT reverted → same manual-recovery warning', async () => {
    const rt = makeWtRuntime({
      integration: (_prompt, i) =>
        i === 0
          ? { green: false, evidence: 'red on main', failureSummary: 'cross-task breakage' }
          : { green: true, evidence: 'ok', failureSummary: '' },
      revert: () => ({ reverted: false, headSha: 'mrg0', note: 'reset refused' }),
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.warnings.some((w: string) =>
      /revert failed/i.test(w) && w.includes('git reset --hard pre0'),
    )).toBe(true)
  })

  it('revert reported reverted: true with a MISMATCHING headSha → not trusted, manual-recovery warning', async () => {
    // The headSha the agent confirmed with `git rev-parse HEAD` is the one
    // deterministic check available — a mismatch means the self-report lies.
    const rt = makeWtRuntime({
      integration: (_prompt, i) =>
        i === 0
          ? { green: false, evidence: 'red on main', failureSummary: 'cross-task breakage' }
          : { green: true, evidence: 'ok', failureSummary: '' },
      revert: () => ({ reverted: true, headSha: 'mrg0', note: 'claims success' }),
    })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.warnings.some((w: string) =>
      w.includes('reported HEAD mrg0') && w.includes('git reset --hard pre0'),
    )).toBe(true)
  })

  it('cleanup agent died → merged worktrees left on disk warning', async () => {
    const rt = makeWtRuntime({ cleanup: () => null })
    const result = await wf.run(rt, JSON.stringify(WT_INPUT))
    expect(result.succeeded).toBe(3)
    expect(result.warnings.some((w: string) =>
      /cleanup agent died/i.test(w) && w.includes('/repo-worktrees'),
    )).toBe(true)
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

// ---------------------------------------------------------------------------
// Test: task file path normalization — defense against ABSOLUTE paths, the
// defect class the human gate caught live in the worktree dogfood (absolute
// paths pointing at the MAIN repo would make obedient agents mutate the main
// tree instead of their isolated worktrees). Contract:
//   - relative file paths always pass through untouched;
//   - an absolute path under an ABSOLUTE projectDir is relativized + warned;
//   - any absolute path that CANNOT be mapped (relative projectDir, projectDir
//     "/", or outside projectDir) is rejected in parseInput — BOTH modes.
// ---------------------------------------------------------------------------

type FileEntry = { path: string; status: string; role: string }

function seqArtifact(projectDir: string, files: FileEntry[]) {
  return {
    ...ARTIFACT,
    context: { ...ARTIFACT.context, projectDir },
    tasks: [{ ...ARTIFACT.tasks[1], files }], // tasks[1] is T1 (no dependsOn)
  }
}

describe('dev-implement task file path normalization', () => {
  it('relativizes an absolute path under an absolute projectDir (sequential) and warns', async () => {
    const rt = makeRuntime()
    const input = { artifact: seqArtifact('/repo', [{ path: '/repo/src/a.ts', status: 'new', role: 'impl' }]) }
    const result = await wf.run(rt, JSON.stringify(input))
    const red = rt.calls.find((c) => c.prompt.toLowerCase().includes('write the failing tests first'))
    expect(red).toBeDefined()
    expect(red!.prompt).toContain('"src/a.ts"')
    expect(red!.prompt).not.toContain('/repo/src/a.ts')
    expect(result.warnings.some((w: string) => w.includes('/repo/src/a.ts') && w.includes('src/a.ts') && /relativiz/i.test(w))).toBe(true)
  })

  it('relativizes in worktree mode — TDD prompts carry the relative path', async () => {
    const rt = makeWtRuntime()
    const artifact = {
      ...WT_ARTIFACT,
      tasks: WT_ARTIFACT.tasks.map((t) =>
        t.id === 'T1' ? { ...t, files: [{ path: '/repo/src/validate.ts', status: 'new', role: 'impl' }] } : t,
      ),
    }
    const result = await wf.run(rt, JSON.stringify({ artifact, mutation: 'worktree' }))
    const red = rt.calls.find((c) => c.prompt.toLowerCase().includes('write the failing tests first') && c.prompt.includes('Task T1'))
    expect(red).toBeDefined()
    expect(red!.prompt).toContain('"src/validate.ts"')
    expect(red!.prompt).not.toContain('/repo/src/validate.ts')
    expect(result.warnings.some((w: string) => /relativiz/i.test(w))).toBe(true)
  })

  it('rejects an absolute path OUTSIDE projectDir (both modes — mutation safety)', async () => {
    const rt = makeRuntime()
    const input = { artifact: seqArtifact('/repo', [{ path: '/elsewhere/b.ts', status: 'new', role: 'impl' }]) }
    await expect(wf.run(rt, JSON.stringify(input))).rejects.toThrow(/\/elsewhere\/b\.ts.*relative|relative.*\/elsewhere\/b\.ts/is)
  })

  it('does not false-match a projectDir prefix without a path boundary', async () => {
    const rt = makeRuntime()
    const input = { artifact: seqArtifact('/a/b', [{ path: '/a/bc/x.ts', status: 'new', role: 'impl' }]) }
    await expect(wf.run(rt, JSON.stringify(input))).rejects.toThrow(/\/a\/bc\/x\.ts/)
  })

  it('relativizes under a trailing-slash projectDir', async () => {
    const rt = makeRuntime()
    const input = { artifact: seqArtifact('/repo/', [{ path: '/repo/src/a.ts', status: 'new', role: 'impl' }]) }
    const result = await wf.run(rt, JSON.stringify(input))
    const red = rt.calls.find((c) => c.prompt.toLowerCase().includes('write the failing tests first'))
    expect(red!.prompt).toContain('"src/a.ts"')
    expect(result.warnings.some((w: string) => /relativiz/i.test(w))).toBe(true)
  })

  it('rejects an absolute path when projectDir is RELATIVE (cannot be mapped)', async () => {
    const rt = makeRuntime()
    const input = { artifact: seqArtifact('.', [{ path: '/repo/src/a.ts', status: 'new', role: 'impl' }]) }
    await expect(wf.run(rt, JSON.stringify(input))).rejects.toThrow(/absolute/i)
  })

  it('rejects absolute paths when projectDir is "/" (degenerate root)', async () => {
    const rt = makeRuntime()
    const input = { artifact: seqArtifact('/', [{ path: '/etc/passwd', status: 'existing', role: 'config' }]) }
    await expect(wf.run(rt, JSON.stringify(input))).rejects.toThrow(/absolute/i)
  })

  it('leaves relative paths untouched with zero path warnings (regression)', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result.warnings.some((w: string) => /relativiz/i.test(w))).toBe(false)
  })

  it('rewrites only the absolute entries of a mixed files array, with one warning', async () => {
    const rt = makeRuntime()
    const input = {
      artifact: seqArtifact('/repo', [
        { path: 'src/r.ts', status: 'existing', role: 'impl' },
        { path: '/repo/src/abs.ts', status: 'new', role: 'impl' },
      ]),
    }
    const result = await wf.run(rt, JSON.stringify(input))
    const red = rt.calls.find((c) => c.prompt.toLowerCase().includes('write the failing tests first'))
    expect(red!.prompt).toContain('"src/r.ts"')
    expect(red!.prompt).toContain('"src/abs.ts"')
    expect(red!.prompt).not.toContain('/repo/src/abs.ts')
    expect(result.warnings.filter((w: string) => /relativiz/i.test(w)).length).toBe(1)
  })

  it('unifies same-wave overlap detection across absolute and relative spellings (worktree)', async () => {
    const rt = makeWtRuntime()
    const artifact = {
      ...WT_ARTIFACT,
      tasks: [
        { ...WT_ARTIFACT.tasks[0], files: [{ path: '/repo/src/shared.ts', status: 'existing', role: 'impl' }] },
        { ...WT_ARTIFACT.tasks[1], files: [{ path: 'src/shared.ts', status: 'existing', role: 'impl' }] },
      ],
    }
    const result = await wf.run(rt, JSON.stringify({ artifact, mutation: 'worktree' }))
    expect(result.warnings.some((w: string) => w.includes('src/shared.ts') && w.includes('T1') && w.includes('T2'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: worktree geometry — the projectSub mapping must use a path-boundary
// check (same class as the file-path normalization above): gitRoot "/a/b"
// must NOT be treated as a prefix of projectDir "/a/bc".
// ---------------------------------------------------------------------------

describe('dev-implement worktree projectSub boundary', () => {
  it('does not slice a false gitRoot prefix into the task workdir', async () => {
    const rt = makeWtRuntime({
      setup: () => ({ isGitRepo: true, headSha: 'base000', gitRoot: '/a/b', note: 'git repo confirmed' }),
    })
    const artifact = {
      ...WT_ARTIFACT,
      context: { ...WT_ARTIFACT.context, projectDir: '/a/bc' },
      tasks: [WT_ARTIFACT.tasks[0]],
    }
    await wf.run(rt, JSON.stringify({ artifact, mutation: 'worktree' }))
    const red = rt.calls.find((c) => c.prompt.toLowerCase().includes('write the failing tests first'))
    expect(red).toBeDefined()
    // Buggy startsWith/slice would compute projectSub "c" -> ".../T1c".
    expect(red!.prompt).not.toContain('/a/b-worktrees/T1c')
    expect(red!.prompt).toContain('Work from directory: /a/b-worktrees/T1\n')
  })

  it('normalizes an agent-copied gitRoot with trailing newline/slash (free-form shell output)', async () => {
    // "/repo/\n" used verbatim would defeat the projectSub prefix match (TDD
    // agents from the worktree ROOT) and yield a "/repo/-worktrees" wtRoot
    // INSIDE the repository.
    const rt = makeWtRuntime({
      setup: () => ({ isGitRepo: true, headSha: 'base000', gitRoot: '/repo/\n', note: 'copied raw output' }),
    })
    const artifact = { ...WT_ARTIFACT, context: { ...WT_ARTIFACT.context, projectDir: '/repo/toolkit' } }
    const result = await wf.run(rt, JSON.stringify({ artifact, mutation: 'worktree' }))
    expect(result.succeeded).toBe(3)
    const create = rt.calls.find((c) => c.opts?.label === 'dev-implement:worktrees:wave0')
    expect(create?.prompt).toContain('git worktree add /repo-worktrees/T1')
    const t1Red = rt.calls.find((c) => c.opts?.label === 'dev-implement:red:T1')
    expect(t1Red?.prompt).toContain('Work from directory: /repo-worktrees/T1/toolkit')
  })

  it('warns (instead of silently degrading) when projectDir is not under the reported gitRoot', async () => {
    const rt = makeWtRuntime({
      setup: () => ({ isGitRepo: true, headSha: 'base000', gitRoot: '/somewhere/else', note: 'garbage self-report' }),
    })
    const artifact = {
      ...WT_ARTIFACT,
      context: { ...WT_ARTIFACT.context, projectDir: '/repo/toolkit' },
      tasks: [WT_ARTIFACT.tasks[0]],
    }
    const result = await wf.run(rt, JSON.stringify({ artifact, mutation: 'worktree' }))
    expect(result.warnings.some((w: string) =>
      w.includes('/repo/toolkit') && w.includes('/somewhere/else') && /not under/i.test(w),
    )).toBe(true)
  })
})
