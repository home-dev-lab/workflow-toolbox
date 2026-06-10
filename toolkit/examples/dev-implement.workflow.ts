// dev-implement.workflow.ts — Execution half of the dev-workflow family (L3 HITL).
//
// PEDAGOGY: the dev-workflow family (design: docs/internal/dev-workflow-design.md)
//
//   dev-plan → [human reviews/edits the PlanArtifact] → dev-implement → dev-review-fix
//
// This workflow receives the APPROVED PlanArtifact from dev-plan after human
// review. The L3 boundary RE-VALIDATES on entry — the human may have pruned,
// reordered, or edited tasks (that is the POINT of the checkpoint), so every
// graph property dev-plan guaranteed (unique ids, resolvable dependsOn, no
// cycles) is re-checked here before any mutating agent is spawned.
//
// Architecture notes:
//   MUTATION POLICY: v1 is SEQUENTIAL — tasks run one at a time in dependency
//   order, computed IN CODE (stable Kahn topological sort). Sequential mutation
//   requires NO git: feedback is the actual testCommand output and verification
//   re-derives from the working tree. The `mutation` input switch accepts
//   "sequential" today and reserves "worktree" (parallel worktree execution +
//   merge step) for v2 — passing it fails fast with a clear message rather than
//   silently running something else.
//
//   Per task: a TDD loop via loopUntilDone (maxIterations-bounded):
//     red   — a test-writer agent writes the FAILING tests from task.testPlan
//             (first iteration only; never implements).
//     green — an implementer agent makes the tests pass against task.contracts;
//             it sees the previous check's failureSummary VERBATIM.
//     check — a SEPARATE checker agent re-runs context.testCommand and reads
//             the ACTUAL output (fresh-evidence checker, defence layer 2).
//             The implementer's self-report (done: true) is NEVER trusted —
//             agents die mid-reasoning and misreport completion.
//
//   A task that exhausts its iterations is FAILED with its last failure kept in
//   the report (it is the input to the corrective re-run); tasks depending on a
//   non-succeeded task are SKIPPED — computed in code, not by a model.
//
//   Phase 'Report' — deterministic tallying IN CODE (no agent).
//
// RESUME HINT:
//   If tasks fail or skip, fix the root cause and relaunch with resumeFromRunId:
//   agents of fully completed tasks replay from cache. (Loop prompts embed the
//   evolving failureSummary, so mid-loop iterations of the FAILED task re-run —
//   that is exactly the work that must be redone.)

import { defineWorkflow } from '@workflow-toolbox/build/define'
import { loopUntilDone, warn } from '@workflow-toolbox/patterns'
import type { PatternStats } from '@workflow-toolbox/patterns'
import type { WorkflowRuntime, JsonSchema } from '@workflow-toolbox/runtime'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Input contract — the approved PlanArtifact from dev-plan
// ---------------------------------------------------------------------------

interface TaskFile {
  path: string
  status: 'existing' | 'new'
  role: string
}

interface PlanTask {
  id: string
  title: string
  intent: string
  files: TaskFile[]
  contracts: string
  testPlan: string
  doneCriteria: string[]
  dependsOn: string[]
}

interface PlanContext {
  projectDir: string
  testCommand: string
  buildCommand: string
  conventions: string
}

interface PlanArtifact {
  goal: string
  context: PlanContext
  tasks: PlanTask[]
  risks: string[]
  outOfScope: string[]
}

export interface DevImplementInput {
  artifact: PlanArtifact
  /** v1 supports "sequential" only; "worktree" is reserved for v2. */
  mutation: 'sequential'
  /** TDD loop bound per task. */
  maxIterationsPerTask: number
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Red stage output — the test-writer's report
const RED_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean' },
    testFiles: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['written', 'testFiles', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type RedResult = FromSchema<typeof RED_RESULT_SCHEMA>

// Green stage output — the implementer's self-report (NEVER trusted for green)
const GREEN_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['done', 'filesTouched', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type GreenResult = FromSchema<typeof GREEN_RESULT_SCHEMA>

// Check stage output — the only source of truth for green
const CHECK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    evidence: { type: 'string' },
    failureSummary: { type: 'string' },
  },
  required: ['green', 'evidence', 'failureSummary'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CheckResult = FromSchema<typeof CHECK_RESULT_SCHEMA>

// ---------------------------------------------------------------------------
// Final workflow output — deterministic report
// ---------------------------------------------------------------------------

type TaskStatus = 'succeeded' | 'failed' | 'skipped'

interface ReportTask {
  id: string
  title: string
  status: TaskStatus
  /** TDD loop iterations consumed (0 for skipped tasks). */
  iterations: number
  /** The checker's actual-output evidence ('' when no check ran). */
  evidence: string
  /** Failure/skip explanation — the input to the corrective re-run. */
  note?: string
}

interface DevImplementOutput {
  goal: string
  tasks: ReportTask[]
  succeeded: number
  failed: number
  skipped: number
  /** Per-task loop envelope stats, keyed by task id. */
  stats: Record<string, PatternStats>
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// parseInput — L3 re-validation. NEVER trust a hand-edited artifact blindly:
// the human may have pruned a task another still dependsOn, duplicated an id,
// or introduced a cycle. Catch malformed edits BEFORE any mutating agent runs.
// ---------------------------------------------------------------------------

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`dev-implement: ${where}.${key} must be a non-empty string`)
  }
  return v
}

function requireStringArray(obj: Record<string, unknown>, key: string, where: string): string[] {
  const v = obj[key]
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new Error(`dev-implement: ${where}.${key} must be an array of strings`)
  }
  return v as string[]
}

function parseTask(raw: unknown, index: number): PlanTask {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`dev-implement: artifact.tasks[${index}] must be an object`)
  }
  const t = raw as Record<string, unknown>
  const where = `artifact.tasks[${index}]`

  const id = requireString(t, 'id', where)
  const title = requireString(t, 'title', where)
  const intent = requireString(t, 'intent', where)
  const contracts = requireString(t, 'contracts', where)
  const testPlan = requireString(t, 'testPlan', where)
  const doneCriteria = requireStringArray(t, 'doneCriteria', where)
  const dependsOn = requireStringArray(t, 'dependsOn', where)

  if (!Array.isArray(t['files'])) {
    throw new Error(`dev-implement: ${where}.files must be an array`)
  }
  const files: TaskFile[] = (t['files'] as unknown[]).map((f, j) => {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error(`dev-implement: ${where}.files[${j}] must be an object`)
    }
    const file = f as Record<string, unknown>
    const path = requireString(file, 'path', `${where}.files[${j}]`)
    const role = requireString(file, 'role', `${where}.files[${j}]`)
    const status = file['status']
    if (status !== 'existing' && status !== 'new') {
      throw new Error(`dev-implement: ${where}.files[${j}].status must be "existing" or "new"`)
    }
    return { path, status, role }
  })

  return { id, title, intent, files, contracts, testPlan, doneCriteria, dependsOn }
}

// Same graph rules dev-plan validated at Synthesize — re-checked because the
// artifact crossed a human-edit boundary since.
function validateGraph(tasks: PlanTask[]): void {
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(
        `dev-implement: duplicate task id "${task.id}" in artifact — ids must be unique ` +
        '(a hand-edit may have copied a task without renaming it)',
      )
    }
    ids.add(task.id)
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(
          `dev-implement: task "${task.id}" dependsOn references unknown task id "${dep}" — ` +
          'if you pruned that task, also remove it from dependsOn lists',
        )
      }
    }
  }

  // Cycle detection: iterative DFS with visiting/done marking.
  const deps = new Map<string, readonly string[]>()
  for (const task of tasks) deps.set(task.id, task.dependsOn)

  const state = new Map<string, 'visiting' | 'done'>()
  for (const task of tasks) {
    if (state.has(task.id)) continue
    const stack: Array<{ id: string; nextDep: number }> = [{ id: task.id, nextDep: 0 }]
    state.set(task.id, 'visiting')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) break
      const frameDeps = deps.get(frame.id) ?? []
      if (frame.nextDep >= frameDeps.length) {
        state.set(frame.id, 'done')
        stack.pop()
        continue
      }
      const dep = frameDeps[frame.nextDep] as string
      frame.nextDep++
      const depState = state.get(dep)
      if (depState === 'visiting') {
        const path = stack.map((f) => f.id).concat(dep).join(' -> ')
        throw new Error(`dev-implement: dependency cycle in artifact: ${path} — break the cycle and re-run`)
      }
      if (depState === undefined) {
        state.set(dep, 'visiting')
        stack.push({ id: dep, nextDep: 0 })
      }
    }
  }
}

function parseInput(raw: unknown): DevImplementInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'dev-implement: input must be an object with "artifact" (the approved PlanArtifact from ' +
      'dev-plan), optional "mutation" ("sequential") and optional "maxIterationsPerTask" (number) — ' +
      'received: ' + (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw),
    )
  }
  const obj = raw as Record<string, unknown>

  if (obj['artifact'] === null || typeof obj['artifact'] !== 'object' || Array.isArray(obj['artifact']) || obj['artifact'] === undefined) {
    throw new Error(
      'dev-implement: "artifact" must be an object — pass the approved PlanArtifact produced by dev-plan',
    )
  }
  const a = obj['artifact'] as Record<string, unknown>

  const goal = requireString(a, 'goal', 'artifact')

  if (a['context'] === null || typeof a['context'] !== 'object' || Array.isArray(a['context'])) {
    throw new Error('dev-implement: artifact.context must be an object')
  }
  const c = a['context'] as Record<string, unknown>
  const context: PlanContext = {
    projectDir: requireString(c, 'projectDir', 'artifact.context'),
    testCommand: requireString(c, 'testCommand', 'artifact.context'),
    // buildCommand may legitimately be '' (no build step) — type-check only.
    buildCommand: typeof c['buildCommand'] === 'string' ? c['buildCommand'] : '',
    conventions: requireString(c, 'conventions', 'artifact.context'),
  }

  if (!Array.isArray(a['tasks']) || a['tasks'].length === 0) {
    throw new Error(
      'dev-implement: artifact.tasks must be a non-empty array — if every task was pruned ' +
      'during review, there is nothing to implement',
    )
  }
  const tasks = (a['tasks'] as unknown[]).map(parseTask)
  validateGraph(tasks)

  const risks = Array.isArray(a['risks']) ? (a['risks'] as unknown[]).filter((r): r is string => typeof r === 'string') : []
  const outOfScope = Array.isArray(a['outOfScope'])
    ? (a['outOfScope'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : []

  if (obj['mutation'] === 'worktree') {
    throw new Error(
      'dev-implement: mutation "worktree" is not yet implemented — it is reserved for v2 ' +
      '(parallel per-task worktrees + a merge step, git repo required). Use "sequential".',
    )
  }
  if (obj['mutation'] !== undefined && obj['mutation'] !== 'sequential') {
    throw new Error(
      'dev-implement: "mutation" must be "sequential" (default) or "worktree" (reserved for v2)',
    )
  }

  let maxIterationsPerTask = 4
  if (obj['maxIterationsPerTask'] !== undefined) {
    if (typeof obj['maxIterationsPerTask'] !== 'number' || obj['maxIterationsPerTask'] < 1) {
      throw new Error('dev-implement: "maxIterationsPerTask" must be a number >= 1')
    }
    maxIterationsPerTask = Math.floor(obj['maxIterationsPerTask'])
  }

  return {
    artifact: { goal, context, tasks, risks, outOfScope },
    mutation: 'sequential',
    maxIterationsPerTask,
  }
}

// ---------------------------------------------------------------------------
// Stable topological sort (Kahn) — IN CODE, deterministic.
//
// Dependency order is an exact, decidable computation; delegating it to a model
// would be slower and non-deterministic. Stability: among ready tasks, artifact
// list order is preserved, so a human reordering the artifact still influences
// scheduling within dependency constraints. parseInput already rejected cycles,
// so this always consumes every task.
// ---------------------------------------------------------------------------

function topologicalOrder(tasks: PlanTask[]): PlanTask[] {
  const done = new Set<string>()
  const ordered: PlanTask[] = []
  const remaining = [...tasks]
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((t) => t.dependsOn.every((d) => done.has(d)))
    if (readyIndex === -1) break // unreachable: cycles were rejected in parseInput
    const task = remaining.splice(readyIndex, 1)[0] as PlanTask
    done.add(task.id)
    ordered.push(task)
  }
  return ordered
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

interface TaskLoopState {
  testsWritten: boolean
  green: boolean
  lastFailure: string
  evidence: string
}

async function run(rt: WorkflowRuntime, input: DevImplementInput): Promise<DevImplementOutput> {
  const warnings: string[] = []
  const stats: Record<string, PatternStats> = {}
  const { artifact, maxIterationsPerTask } = input
  const ctx = artifact.context

  rt.phase('Implement')
  rt.phase('Check')

  const ordered = topologicalOrder(artifact.tasks)
  const statusById = new Map<string, TaskStatus>()
  const reportTasks: ReportTask[] = []

  // SEQUENTIAL mutation: one task at a time, in dependency order. No git
  // required — the working tree plus the real testCommand output are the only
  // shared state, and nothing else writes concurrently.
  for (const task of ordered) {
    // Dependents of a non-succeeded task are skipped IN CODE — running an
    // implementer on top of a missing dependency would burn agents on a known
    // failure and could half-mutate the tree.
    const blockedBy = task.dependsOn.filter((d) => statusById.get(d) !== 'succeeded')
    if (blockedBy.length > 0) {
      statusById.set(task.id, 'skipped')
      reportTasks.push({
        id: task.id,
        title: task.title,
        status: 'skipped',
        iterations: 0,
        evidence: '',
        note: `skipped — depends on non-succeeded task(s): ${blockedBy.join(', ')}`,
      })
      continue
    }

    // Shared per-task prompt context: the task record is the implementer's
    // WHOLE knowledge of the plan (fresh-context handoff), so every stage
    // prompt restates it in full.
    const taskBlock =
      `Goal: ${artifact.goal}\n` +
      `Work from directory: ${ctx.projectDir}\n` +
      `Conventions: ${ctx.conventions}\n` +
      `Out of scope (do NOT touch): ${JSON.stringify(artifact.outOfScope)}\n` +
      `Task ${task.id}: ${task.title}\n` +
      `Intent: ${task.intent}\n` +
      `Files: ${JSON.stringify(task.files)}\n` +
      `Contracts: ${task.contracts}\n` +
      `Test plan: ${task.testPlan}\n` +
      `Done criteria: ${JSON.stringify(task.doneCriteria)}\n`

    const loopResult = await loopUntilDone<TaskLoopState>(rt, {
      initial: { testsWritten: false, green: false, lastFailure: '', evidence: '' },
      maxIterations: maxIterationsPerTask,
      body: async (rtBody, state, iteration) => {
        const next: TaskLoopState = { ...state }

        // ---- red: write the failing tests FIRST (once) ----
        if (!next.testsWritten) {
          const red = await rtBody.agent<RedResult>(
            `You are the TDD test-writer for one task. Write the failing tests first — ` +
            `do NOT implement any production code.\n` +
            taskBlock +
            `Create/extend the test files per the test plan, run ${ctx.testCommand} to confirm ` +
            `the new tests FAIL for the right reason, and report.\n` +
            `If the test plan says there is nothing to write (a docs-only or no-test task), that ` +
            `is a SUCCESS, not a failure: return written: true with an empty testFiles list and ` +
            `say so in the note — the done criteria will still be verified by the checker.\n` +
            `Return { "written": true|false, "testFiles": ["<path>"], "note": "<what was written>" }`,
            {
              schema: RED_RESULT_SCHEMA,
              label: `dev-implement:red:${task.id}`,
              phase: 'Implement',
            },
          )
          if (red === null) {
            warn(rtBody, warnings, `dev-implement: red (test-writer) agent died for task ${task.id} — retrying next iteration`)
            return { state: next, done: false }
          }
          if (!red.written) {
            warn(rtBody, warnings, `dev-implement: test-writer could not write tests for task ${task.id}: ${red.note}`)
            return { state: next, done: false }
          }
          next.testsWritten = true
        }

        // ---- green: implement against the contracts ----
        const green = await rtBody.agent<GreenResult>(
          `You are the TDD implementer for one task. Make the failing tests pass.\n` +
          taskBlock +
          `Previous check failure (fix THIS first): ${next.lastFailure === '' ? '(first attempt)' : next.lastFailure}\n` +
          `Implement per the contracts. Do NOT weaken, skip, or delete tests to get green. ` +
          `Run ${ctx.testCommand} yourself and iterate locally before reporting.\n` +
          `Return { "done": true|false, "filesTouched": ["<path>"], "note": "<what changed>" }`,
          {
            schema: GREEN_RESULT_SCHEMA,
            label: `dev-implement:green:${task.id}:${iteration}`,
            phase: 'Implement',
          },
        )
        if (green === null) {
          warn(rtBody, warnings, `dev-implement: green (implementer) agent died for task ${task.id} (iteration ${iteration})`)
        }

        // ---- check: fresh evidence, defence layer 2 ----
        // The implementer's self-report is NEVER the source of truth: agents
        // die mid-reasoning and misreport completion. Only the checker's read
        // of the ACTUAL test output flips a task to green.
        const check = await rtBody.agent<CheckResult>(
          `You are the independent checker for one task. Independently verify by running the ` +
          `test command yourself — do NOT trust the implementer's self-report below.\n` +
          taskBlock +
          `Implementer self-report (untrusted): ${green === null ? '(implementer died — check the tree anyway: a prior iteration may already pass)' : JSON.stringify(green)}\n` +
          `Run ${ctx.testCommand} from ${ctx.projectDir} and read the ACTUAL output. Then check ` +
          `each done criterion against the working tree.\n` +
          `Return { "green": true|false, "evidence": "<what the run actually showed>", ` +
          `"failureSummary": "<empty string if green, else the failures to fix>" }`,
          {
            schema: CHECK_RESULT_SCHEMA,
            label: `dev-implement:check:${task.id}:${iteration}`,
            phase: 'Check',
          },
        )
        if (check === null) {
          warn(rtBody, warnings, `dev-implement: checker agent died for task ${task.id} (iteration ${iteration}) — treating as not green`)
          next.green = false
          next.lastFailure = 'checker agent died — no fresh evidence for this iteration'
          return { state: next, done: false }
        }

        next.green = check.green
        next.evidence = check.evidence
        next.lastFailure = check.failureSummary
        return { state: next, done: check.green }
      },
    })

    for (const w of loopResult.warnings) warnings.push(w)
    stats[task.id] = loopResult.stats

    const outcome = loopResult.value
    if (outcome.state.green) {
      statusById.set(task.id, 'succeeded')
      reportTasks.push({
        id: task.id,
        title: task.title,
        status: 'succeeded',
        iterations: outcome.iterations,
        evidence: outcome.state.evidence,
      })
    } else {
      statusById.set(task.id, 'failed')
      reportTasks.push({
        id: task.id,
        title: task.title,
        status: 'failed',
        iterations: outcome.iterations,
        evidence: outcome.state.evidence,
        note:
          outcome.state.lastFailure === ''
            ? `failed — loop stopped by ${outcome.stoppedBy} before any check ran`
            : `failed — last check: ${outcome.state.lastFailure}`,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic tallying IN CODE (no agent).
  // -------------------------------------------------------------------------

  rt.phase('Report')

  let succeeded = 0
  let failed = 0
  let skipped = 0
  for (const t of reportTasks) {
    if (t.status === 'succeeded') succeeded++
    else if (t.status === 'failed') failed++
    else skipped++
  }

  if (failed > 0 || skipped > 0) {
    warn(
      rt,
      warnings,
      `dev-implement: ${failed} task(s) failed, ${skipped} skipped — fix the root cause and ` +
      `relaunch with resumeFromRunId (agents of completed tasks replay from cache), or feed ` +
      `the failure notes back into a corrective dev-plan run`,
    )
  }

  return {
    goal: artifact.goal,
    tasks: reportTasks,
    succeeded,
    failed,
    skipped,
    stats,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'dev-implement',
    description:
      'Execution half of the dev-workflow family: re-validates the approved PlanArtifact from ' +
      'dev-plan (the human may have edited it), runs each task sequentially in dependency order ' +
      'through a bounded TDD loop (failing tests first, implement against the contracts, then an ' +
      'independent checker reads the real test output), and reports a deterministic ' +
      'succeeded/failed/skipped tally with per-task evidence.',
    whenToUse:
      'Use after a human has reviewed and approved the PlanArtifact from dev-plan. Pass ' +
      '{ artifact } (plus optional mutation/maxIterationsPerTask) as the workflow args. ' +
      'Sequential mode works without git.',
    phases: [
      { title: 'Implement', detail: 'Per task in dependency order: write failing tests, implement (TDD loop)' },
      { title: 'Check', detail: 'Independent fresh-evidence checker runs the real test command per iteration' },
      { title: 'Report', detail: 'Deterministic succeeded/failed/skipped tally (in code, no agent)' },
    ],
  },
  parseInput,
  run,
})
