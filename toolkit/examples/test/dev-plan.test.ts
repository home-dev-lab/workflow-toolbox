// dev-plan.test.ts — end-to-end composition test for the dev-plan workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../dev-plan.workflow.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HAPPY_ARTIFACT = {
  goal: 'Add input validation to the CLI',
  context: {
    projectDir: '.',
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
      doneCriteria: ['validate() unit tests pass', 'no any types introduced'],
      dependsOn: [],
    },
    {
      id: 'T2',
      title: 'Wire validate() into the CLI entry',
      intent: 'Call validate() before dispatch so bad input fails fast with an actionable message.',
      files: [{ path: 'src/cli.ts', status: 'existing', role: 'integration point' }],
      contracts: 'cli main() exits non-zero and prints the validation error on bad input',
      testPlan: 'Write a failing CLI test for the bad-input path first.',
      doneCriteria: ['CLI bad-input test passes'],
      dependsOn: ['T1'],
    },
  ],
  risks: ['CLI flag parsing may have undocumented callers'],
  outOfScope: ['Refactoring the existing dispatch logic'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing uses UNIQUE phrases from the actual workflow prompts — in priority order:
 *   1. Verifier:          "adversarially verify" (pattern-owned prompt, always first)
 *   2. Synthesize:        "final planartifact" (unique phrase in Phase 'Synthesize')
 *   3. Plan worker:       "detail the implementation task" (planAndExecute workers)
 *   4. Plan planner:      "decompose the development goal" (plan prompt)
 *   5. Discover synth:    "consolidate the per-area discoveries" (fanOut synthesis)
 *   6. Discover task:     "explore this repository area" (fanOut task)
 * Order matters: check most-specific first to avoid cross-matching.
 */
function makeRuntime(overrides?: {
  verifier?: (prompt: string) => unknown
  synthesize?: (prompt: string) => unknown
  worker?: (prompt: string) => unknown
}): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Adversarial verifier stage — pattern owns this prompt phrase
      if (p.includes('adversarially verify')) {
        if (overrides?.verifier) return overrides.verifier(prompt)
        return { verdict: 'confirmed', reason: 'Task claim verified against actual code' }
      }

      // (2) Phase 'Synthesize' — final PlanArtifact agent
      if (p.includes('final planartifact')) {
        if (overrides?.synthesize) return overrides.synthesize(prompt)
        return HAPPY_ARTIFACT
      }

      // (3) Phase 'Plan' — planAndExecute worker (detail one implementation task)
      if (p.includes('detail the implementation task')) {
        if (overrides?.worker) return overrides.worker(prompt)
        return {
          tasks: [
            {
              title: 'Add validate() helper',
              intent: 'Create a pure validation helper for CLI args.',
              files: [{ path: 'src/validate.ts', status: 'new', role: 'implementation' }],
              contracts: 'export function validate(raw: unknown): { ok: boolean; error?: string }',
              testPlan: 'Failing test for validate(null) first.',
              doneCriteria: ['validate() unit tests pass'],
              risk: 'medium',
            },
          ],
        }
      }

      // (4) Phase 'Plan' — planAndExecute planner (decompose the goal)
      if (p.includes('decompose the development goal')) {
        return {
          subtasks: [
            { description: 'Create the validation helper module' },
            { description: 'Wire validation into the CLI entry point' },
          ],
        }
      }

      // (5) Phase 'Discover' — fanOutAndSynthesize synthesis (consolidate context)
      if (p.includes('consolidate the per-area discoveries')) {
        return {
          testCommand: 'pnpm test',
          buildCommand: 'pnpm build',
          conventions: 'TypeScript strict; vitest; small pure modules',
          repoBrief: 'Small TypeScript CLI package with vitest tests.',
        }
      }

      // (6) Phase 'Discover' — fanOutAndSynthesize task (explore one area)
      if (p.includes('explore this repository area')) {
        return {
          observations: [{ file: 'src/cli.ts', detail: 'CLI entry parses args inline without validation' }],
          testCommand: 'pnpm test',
          buildCommand: 'pnpm build',
          conventions: 'TypeScript strict',
        }
      }

      // Fallback
      return { observations: [] }
    },
  })
}

const VALID_INPUT = { goal: 'Add input validation to the CLI', areas: ['src', 'test'] }

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('dev-plan workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('dev-plan')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Discover', 'Plan', 'Critique', 'Synthesize'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('dev-plan parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/goal|input/i)
  })

  it('throws an actionable error for empty goal', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: '', areas: ['src'] }))
    ).rejects.toThrow(/goal/i)
  })

  it('throws for empty areas array (explicit empty is an error)', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: [] }))
    ).rejects.toThrow(/areas/i)
  })

  it('throws for non-array areas', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: 'src' }))
    ).rejects.toThrow(/areas/i)
  })

  it('throws for areas containing empty strings', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: ['src', ''] }))
    ).rejects.toThrow(/areas/i)
  })

  it('defaults areas to ["."] when omitted', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify({ goal: 'Add validation' }))
    expect(result).toHaveProperty('artifact')
  })

  it('throws for a non-string projectDir', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: ['src'], projectDir: 42 }))
    ).rejects.toThrow(/projectDir/i)
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — full composition through all 4 phases
// ---------------------------------------------------------------------------

describe('dev-plan happy path', () => {
  it('returns the correct final output shape', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result).toHaveProperty('artifact')
    expect(result).toHaveProperty('rejected')
    expect(result).toHaveProperty('stats')
    expect(result).toHaveProperty('warnings')

    expect(Array.isArray(result.rejected)).toBe(true)
    expect(typeof result.stats).toBe('object')
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('artifact is self-contained: goal, context, tasks, risks, outOfScope', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.artifact.goal).toBe(VALID_INPUT.goal)
    expect(result.artifact.context).toHaveProperty('projectDir')
    expect(result.artifact.context).toHaveProperty('testCommand')
    expect(result.artifact.context).toHaveProperty('buildCommand')
    expect(result.artifact.context).toHaveProperty('conventions')
    expect(Array.isArray(result.artifact.tasks)).toBe(true)
    expect(result.artifact.tasks.length).toBeGreaterThan(0)
    expect(Array.isArray(result.artifact.risks)).toBe(true)
    expect(Array.isArray(result.artifact.outOfScope)).toBe(true)
  })

  it('every task is implementer-self-sufficient (all handoff fields present)', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    for (const task of result.artifact.tasks) {
      expect(typeof task.id).toBe('string')
      expect(typeof task.title).toBe('string')
      expect(typeof task.intent).toBe('string')
      expect(Array.isArray(task.files)).toBe(true)
      for (const f of task.files) {
        expect(typeof f.path).toBe('string')
        expect(['existing', 'new']).toContain(f.status)
        expect(typeof f.role).toBe('string')
      }
      expect(typeof task.contracts).toBe('string')
      expect(typeof task.testPlan).toBe('string')
      expect(Array.isArray(task.doneCriteria)).toBe(true)
      expect(task.doneCriteria.length).toBeGreaterThan(0)
      expect(Array.isArray(task.dependsOn)).toBe(true)
    }
  })

  it('records all 4 phases (Discover, Plan, Critique, Synthesize)', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(rt.phases).toContain('Discover')
    expect(rt.phases).toContain('Plan')
    expect(rt.phases).toContain('Critique')
    expect(rt.phases).toContain('Synthesize')
  })

  it('accumulates per-phase pattern stats', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.stats).toHaveProperty('discover')
    expect(result.stats).toHaveProperty('plan')
    expect(result.stats).toHaveProperty('critique')
  })

  it('spawns agents across all phases', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))
    // discover tasks + synthesis + planner + workers + verifier votes + synthesize
    expect(rt.agentsSpawned).toBeGreaterThan(4)
  })
})

// ---------------------------------------------------------------------------
// Test: refuted task claims land in rejected
// ---------------------------------------------------------------------------

describe('dev-plan refuted task claims', () => {
  it('reports refuted candidate tasks in rejected', async () => {
    const rt = makeRuntime({
      verifier: () => ({ verdict: 'refuted', reason: 'src/validate.ts already exists — status "new" is wrong' }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.rejected.length).toBeGreaterThan(0)
    for (const r of result.rejected) {
      expect(typeof r.title).toBe('string')
      expect(typeof r.verdict).toBe('string')
      // The human arbitrates rejections — the verifier's reason must survive.
      expect(r.reason).toMatch(/already exists/)
    }
  })
})

// ---------------------------------------------------------------------------
// Test: deterministic artifact validation (in code, not agent)
// ---------------------------------------------------------------------------

describe('dev-plan artifact validation', () => {
  it('rejects an artifact with duplicate task ids', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [HAPPY_ARTIFACT.tasks[0], { ...HAPPY_ARTIFACT.tasks[1], id: 'T1' }],
      }),
    })
    await expect(wf.run(rt, JSON.stringify(VALID_INPUT))).rejects.toThrow(/duplicate|unique/i)
  })

  it('rejects an artifact whose dependsOn references an unknown task id', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [{ ...HAPPY_ARTIFACT.tasks[0], dependsOn: ['T999'] }],
      }),
    })
    await expect(wf.run(rt, JSON.stringify(VALID_INPUT))).rejects.toThrow(/unknown|reference/i)
  })

  it('rejects an artifact with a dependency cycle', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [
          { ...HAPPY_ARTIFACT.tasks[0], id: 'T1', dependsOn: ['T2'] },
          { ...HAPPY_ARTIFACT.tasks[1], id: 'T2', dependsOn: ['T1'] },
        ],
      }),
    })
    await expect(wf.run(rt, JSON.stringify(VALID_INPUT))).rejects.toThrow(/cycle/i)
  })

  it('rejects an artifact with a self-dependency cycle (T1 -> T1)', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [{ ...HAPPY_ARTIFACT.tasks[0], id: 'T1', dependsOn: ['T1'] }],
      }),
    })
    await expect(wf.run(rt, JSON.stringify(VALID_INPUT))).rejects.toThrow(/cycle/i)
  })

  it('rejects an artifact with an empty tasks list', async () => {
    const rt = makeRuntime({
      synthesize: () => ({ ...HAPPY_ARTIFACT, tasks: [] }),
    })
    await expect(wf.run(rt, JSON.stringify(VALID_INPUT))).rejects.toThrow(/tasks/i)
  })

  it('throws with a fresh-run hint when synthesis agent dies (returns null)', async () => {
    const rt = makeRuntime({ synthesize: () => null })
    await expect(wf.run(rt, JSON.stringify(VALID_INPUT))).rejects.toThrow(/synthesis|resume/i)
  })
})

// ---------------------------------------------------------------------------
// Test: degraded Plan phase — no candidate tasks
// ---------------------------------------------------------------------------

describe('dev-plan with no candidate tasks', () => {
  it('warns, skips Critique stats, and still synthesizes from an empty kept list', async () => {
    // All Plan workers die → zero candidate tasks → Critique is skipped.
    const rt = makeRuntime({ worker: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.warnings.some((w: string) => /no candidate tasks/i.test(w))).toBe(true)
    expect(result.stats).not.toHaveProperty('critique')
    expect(result.rejected).toEqual([])
    // The synthesize agent still ran (fake returns a valid artifact).
    expect(result.artifact.tasks.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Test: task file path hygiene — artifacts must be born with RELATIVE paths
// (the worktree dogfood's human gate caught absolute paths pointing at the
// main repo). dev-plan instructs planners, then normalizes the synthesized
// artifact in code: under an absolute projectDir, absolute paths are
// relativized + warned; unmappable absolutes are KEPT but warned (the output
// goes to a human gate — dev-implement will reject them if not fixed).
// ---------------------------------------------------------------------------

describe('dev-plan task file path hygiene', () => {
  it('instructs the plan workers and the synthesizer to use relative paths', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: ['src'] }))
    const worker = rt.calls.find((c) => c.prompt.toLowerCase().includes('detail the implementation task'))
    const synth = rt.calls.find((c) => c.prompt.toLowerCase().includes('final planartifact'))
    expect(worker).toBeDefined()
    expect(synth).toBeDefined()
    expect(worker!.prompt.toLowerCase()).toContain('relative')
    expect(synth!.prompt.toLowerCase()).toContain('relative')
  })

  it('relativizes under-root absolute paths in the synthesized artifact and warns', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [
          {
            ...HAPPY_ARTIFACT.tasks[0],
            files: [{ path: '/repo/src/validate.ts', status: 'new', role: 'implementation' }],
          },
          HAPPY_ARTIFACT.tasks[1],
        ],
      }),
    })
    const result = await wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: ['src'], projectDir: '/repo' }))
    const t1 = result.artifact.tasks.find((t: { id: string }) => t.id === 'T1')
    expect(t1!.files[0]!.path).toBe('src/validate.ts')
    expect(result.warnings.some((w: string) => /relativiz/i.test(w) && w.includes('/repo/src/validate.ts'))).toBe(true)
  })

  it('keeps an unmappable absolute path but warns (the human gate must fix it)', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [
          {
            ...HAPPY_ARTIFACT.tasks[0],
            files: [{ path: '/elsewhere/x.ts', status: 'existing', role: 'integration' }],
          },
          HAPPY_ARTIFACT.tasks[1],
        ],
      }),
    })
    const result = await wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: ['src'], projectDir: '/repo' }))
    const t1 = result.artifact.tasks.find((t: { id: string }) => t.id === 'T1')
    expect(t1!.files[0]!.path).toBe('/elsewhere/x.ts')
    expect(result.warnings.some((w: string) => /absolute/i.test(w) && w.includes('/elsewhere/x.ts'))).toBe(true)
  })

  it('warns without rewriting when projectDir is relative', async () => {
    const rt = makeRuntime({
      synthesize: () => ({
        ...HAPPY_ARTIFACT,
        tasks: [
          {
            ...HAPPY_ARTIFACT.tasks[0],
            files: [{ path: '/abs/x.ts', status: 'new', role: 'implementation' }],
          },
          HAPPY_ARTIFACT.tasks[1],
        ],
      }),
    })
    const result = await wf.run(rt, JSON.stringify({ goal: 'Add validation', areas: ['src'] }))
    const t1 = result.artifact.tasks.find((t: { id: string }) => t.id === 'T1')
    expect(t1!.files[0]!.path).toBe('/abs/x.ts')
    expect(result.warnings.some((w: string) => /absolute/i.test(w) && w.includes('/abs/x.ts'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: risk-aware verification votes — low:1, medium/high:3
// ---------------------------------------------------------------------------

describe('dev-plan risk-aware votes', () => {
  const helperTask = {
    title: 'Add validate() helper',
    intent: 'Create a pure validation helper for CLI args.',
    files: [{ path: 'src/validate.ts', status: 'new', role: 'implementation' }],
    contracts: 'export function validate(raw: unknown): { ok: boolean; error?: string }',
    testPlan: 'Failing test for validate(null) first.',
    doneCriteria: ['validate() unit tests pass'],
  }
  const wireTask = {
    title: 'Wire validate() into the CLI entry',
    intent: 'Call validate() before dispatch so bad input fails fast.',
    files: [{ path: 'src/cli.ts', status: 'existing', role: 'integration point' }],
    contracts: 'cli main() exits non-zero and prints the validation error on bad input',
    testPlan: 'Failing CLI bad-input test first.',
    doneCriteria: ['CLI bad-input test passes'],
  }

  it('spends 1 verifier vote on a low-risk task and 3 on a high-risk task', async () => {
    const rt = makeRuntime({
      worker: (prompt) =>
        prompt.includes('Create the validation helper module')
          ? { tasks: [{ ...helperTask, risk: 'low' }] }
          : { tasks: [{ ...wireTask, risk: 'high' }] },
    })
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const verifyLabels = rt.calls
      .map((c) => c.opts?.label ?? '')
      .filter((l) => l.startsWith('adversarialVerification:verify:'))

    // claim 0 = the low-risk helper task → 1 vote; claim 1 = the high-risk wiring task → 3
    expect(verifyLabels.filter((l) => l.startsWith('adversarialVerification:verify:0:'))).toHaveLength(1)
    expect(verifyLabels.filter((l) => l.startsWith('adversarialVerification:verify:1:'))).toHaveLength(3)
    expect(verifyLabels).toHaveLength(4)

    // The single-vote claim really is the low-risk task (renderClaim prints its title).
    const soloPrompt = rt.calls.find(
      (c) => c.opts?.label === 'adversarialVerification:verify:0:0',
    )?.prompt
    expect(soloPrompt).toContain('Add validate() helper')
  })

  it('a medium-risk task keeps 3 votes and a 2-of-3 refutation still rejects (regression)', async () => {
    let wireVotes = 0
    const rt = makeRuntime({
      worker: (prompt) =>
        prompt.includes('Create the validation helper module')
          ? { tasks: [{ ...helperTask, risk: 'medium' }] }
          : { tasks: [{ ...wireTask, risk: 'medium' }] },
      verifier: (prompt) => {
        if (prompt.includes('Wire validate() into the CLI entry')) {
          wireVotes += 1
          return wireVotes <= 2
            ? { verdict: 'refuted', reason: 'the CLI entry already validates its input' }
            : { verdict: 'confirmed', reason: 'wiring is genuinely missing' }
        }
        return { verdict: 'confirmed', reason: 'Task claim verified against actual code' }
      },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const verifyLabels = rt.calls
      .map((c) => c.opts?.label ?? '')
      .filter((l) => l.startsWith('adversarialVerification:verify:'))
    expect(verifyLabels).toHaveLength(6)

    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatchObject({ title: 'Wire validate() into the CLI entry' })
  })

  it('floors a multi-file task off the single-vote path even when self-rated "low", and warns', async () => {
    // risk is SELF-assessed by the worker whose task it gates — a structural
    // floor (multi-file ≠ isolated) must keep the full quorum regardless of
    // the label.
    const rt = makeRuntime({
      worker: (prompt) =>
        prompt.includes('Create the validation helper module')
          ? {
              tasks: [{
                ...helperTask,
                files: [
                  { path: 'src/validate.ts', status: 'new', role: 'implementation' },
                  { path: 'src/cli.ts', status: 'existing', role: 'integration point' },
                ],
                risk: 'low',
              }],
            }
          : { tasks: [{ ...wireTask, risk: 'high' }] },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const verifyLabels = rt.calls
      .map((c) => c.opts?.label ?? '')
      .filter((l) => l.startsWith('adversarialVerification:verify:'))
    // The self-rated "low" multi-file task keeps the full 3-vote quorum.
    expect(verifyLabels.filter((l) => l.startsWith('adversarialVerification:verify:0:'))).toHaveLength(3)
    expect(verifyLabels).toHaveLength(6)
    expect(result.warnings.some((w: string) => /not an isolated change/i.test(w))).toBe(true)
  })

  it('warns when an implausibly high fraction of tasks self-rate risk "low"', async () => {
    // 2 subtasks × 2 tasks = 4 candidate tasks, all "low" → >80% on 4+ tasks.
    const rt = makeRuntime({
      worker: () => ({
        tasks: [
          { ...helperTask, risk: 'low' },
          { ...helperTask, title: 'Add parse() helper', risk: 'low' },
        ],
      }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result.warnings.some((w: string) => /implausibly high/i.test(w))).toBe(true)
  })

  it('does NOT warn about the low-risk fraction on a small or mixed-risk plan', async () => {
    // The default happy path produces 2 medium-risk tasks — neither guard fires.
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result.warnings.some((w: string) => /implausibly high|not an isolated change/i.test(w))).toBe(false)
  })

  it('does NOT warn when ALL tasks self-rate "low" but the plan is under the 4-task floor', async () => {
    // 3/3 = 100% low, yet 3 < 4 tasks: the count floor (toy plans legitimately
    // skew low) must hold even at a maximal fraction.
    const rt = makeRuntime({
      worker: (prompt) =>
        prompt.includes('Create the validation helper module')
          ? {
              tasks: [
                { ...helperTask, risk: 'low' },
                { ...helperTask, title: 'Add parse() helper', risk: 'low' },
              ],
            }
          : { tasks: [{ ...wireTask, risk: 'low' }] },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result.warnings.some((w: string) => /implausibly high/i.test(w))).toBe(false)
  })

  it('does NOT warn at EXACTLY the 0.8 low fraction (4 of 5) — the threshold is strict', async () => {
    // Pins the strict `> 0.8` comparison: flipping it to `>= 0.8` would make
    // this legitimate 4-of-5 plan warn.
    const rt = makeRuntime({
      worker: (prompt) =>
        prompt.includes('Create the validation helper module')
          ? {
              tasks: [
                { ...helperTask, risk: 'low' },
                { ...helperTask, title: 'Add parse() helper', risk: 'low' },
                { ...helperTask, title: 'Add format() helper', risk: 'low' },
              ],
            }
          : {
              tasks: [
                { ...wireTask, risk: 'low' },
                { ...wireTask, title: 'Wire parse() into the CLI entry', risk: 'medium' },
              ],
            },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(result.warnings.some((w: string) => /implausibly high/i.test(w))).toBe(false)
  })
})
