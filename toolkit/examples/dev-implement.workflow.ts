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
//   MUTATION POLICY — two modes behind the `mutation` input switch:
//   "sequential" (default): tasks run one at a time in dependency order,
//   computed IN CODE (stable Kahn topological sort). Requires NO git: feedback
//   is the actual testCommand output and verification re-derives from the
//   working tree. "worktree": independent tasks run their TDD loops in
//   parallel WAVES, each in an isolated git worktree on a wt-task/<id> branch,
//   then merge back sequentially with an integration check after EACH merge —
//   git repo REQUIRED (see the runWorktree section below for the policies:
//   conservative conflicts, revert-on-red, kept failure worktrees, unsigned
//   machine commits by default).
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
  /** "sequential" (default, no git required) or "worktree" (parallel waves of
   *  per-task git worktrees + a merge step; git repo REQUIRED). */
  mutation: 'sequential' | 'worktree'
  /** TDD loop bound per task. */
  maxIterationsPerTask: number
  /** Worktree mode only — VERBATIM command run inside each fresh worktree
   *  before its TDD loop (fresh worktrees lack installed dependencies for most
   *  ecosystems, e.g. "pnpm install"); null = none. */
  worktreeSetupCommand: string | null
  /** Worktree mode only — where worktrees live; null = the sibling default
   *  `<projectDir>-worktrees` (a sibling stays invisible to git status/diff,
   *  so it cannot pollute the change set dev-review-fix reads downstream). */
  worktreeRoot: string | null
  /** Worktree mode only — sign the MACHINE commits (task branches + merges).
   *  Default false: a locked signing agent mid-run would kill merges opaquely;
   *  the operator owns/squashes the final history. */
  signCommits: boolean
  /** Warnings produced by task-file path normalization in parseInput (which is
   *  pure and has no rt to log to) — surfaced via warn() at run start so they
   *  land in both rt.log and the report's warnings[]. */
  pathWarnings: string[]
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

// ---- Worktree-mode schemas (all evidence-bearing — never bare booleans) ----

// Setup agent: git availability, the base sha (display/forensics only; the
// revert target is each merge's OWN preMergeSha, never this base sha) and the
// git ROOT — projectDir may be a subdirectory of the repository (monorepo),
// and both the default worktree location and the in-worktree workdir mapping
// derive from the root, not from projectDir.
const SETUP_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    isGitRepo: { type: 'boolean' },
    headSha: { type: 'string' },
    gitRoot: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['isGitRepo', 'headSha', 'gitRoot', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type SetupResult = FromSchema<typeof SETUP_RESULT_SCHEMA>

// Per-wave worktree provisioning: which tasks got a worktree, which failed.
const WT_CREATE_SCHEMA = {
  type: 'object',
  properties: {
    created: { type: 'array', items: { type: 'string' } },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id', 'note'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['created', 'failures', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type WtCreateResult = FromSchema<typeof WT_CREATE_SCHEMA>

// Per-task worktree preparation (the verbatim worktreeSetupCommand).
const PREPARE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['ok', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type PrepareResult = FromSchema<typeof PREPARE_RESULT_SCHEMA>

// Task-branch commit (finalize) — the sha is the merge step's input evidence.
const FINALIZE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },
    sha: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['committed', 'sha', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type FinalizeResult = FromSchema<typeof FINALIZE_RESULT_SCHEMA>

// Merge result — preMergeSha is the revert target if integration goes red.
const MERGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    conflict: { type: 'boolean' },
    preMergeSha: { type: 'string' },
    mergeSha: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['merged', 'conflict', 'preMergeSha', 'mergeSha', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type MergeResult = FromSchema<typeof MERGE_RESULT_SCHEMA>

// Revert confirmation — the resulting HEAD must equal the preMergeSha.
const REVERT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    reverted: { type: 'boolean' },
    headSha: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['reverted', 'headSha', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type RevertResult = FromSchema<typeof REVERT_RESULT_SCHEMA>

// Batched end-of-run cleanup of MERGED worktrees only.
const CLEANUP_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    removed: { type: 'array', items: { type: 'string' } },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id', 'note'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['removed', 'failures', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CleanupResult = FromSchema<typeof CLEANUP_RESULT_SCHEMA>

// ---------------------------------------------------------------------------
// Final workflow output — deterministic report
// ---------------------------------------------------------------------------

// Worktree-mode statuses: 'merge-failed' (conflict — merge aborted) and
// 'integration-failed' (suite red on main after the merge — merge reverted).
// In BOTH cases the MAIN tree was left unmutated by the task, which is why
// downstream consumers deriving a change set from 'succeeded'|'failed' tasks
// (dev-full) correctly exclude them. Plain worktree 'failed' tasks never
// merged either — main stays clean, unlike sequential mode's partial mutations.
type TaskStatus = 'succeeded' | 'failed' | 'skipped' | 'merge-failed' | 'integration-failed'

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
  /** Worktree mode, KEPT worktrees only (failed/merge-failed/integration-failed):
   *  where the task's tree lives on disk for forensics/manual resume. */
  worktreePath?: string
  /** Worktree mode, kept worktrees only: the task branch (wt-task/<id>). */
  branch?: string
}

interface DevImplementOutput {
  goal: string
  tasks: ReportTask[]
  succeeded: number
  failed: number
  skipped: number
  /** Worktree mode tallies (always present; 0 in sequential mode). The five
   *  counters sum to tasks.length. */
  mergeFailed: number
  integrationFailed: number
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
  // Task ids flow into shell commands (worktree paths, wt-task/<id> branch
  // names) — restrict to a shell- and git-safe charset instead of trusting
  // quoting downstream. Enforced in BOTH modes on purpose: the same approved
  // artifact must stay valid if the operator re-runs it in worktree mode.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `dev-implement: ${where}.id "${id}" must match [A-Za-z0-9._-]+ — ids become worktree ` +
      `paths and branch names`,
    )
  }
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

// ---------------------------------------------------------------------------
// Task-file path normalization (POSIX). Defense against the defect class a
// live worktree dogfood exposed: ABSOLUTE task.files paths pointing at the
// main repo make obedient agents mutate the MAIN tree instead of their
// isolated worktrees. Rules:
//   - a relative path always passes through untouched;
//   - an absolute path under an ABSOLUTE projectDir is relativized (+ warning)
//     using a boundary-safe prefix match ("/a/b" never matches "/a/bc/...");
//   - any other absolute path (relative projectDir, projectDir "/", or a path
//     outside projectDir) cannot be mapped and is REJECTED here in parseInput.
// Rejection applies in BOTH mutation modes because mutation safety is the
// point: a sequential agent told to edit an absolute path mutates that
// location verbatim too, outOfScope fence or not.
// ---------------------------------------------------------------------------
function normalizeTaskFiles(
  tasks: PlanTask[],
  projectDir: string,
): { tasks: PlanTask[]; warnings: string[] } {
  const root = projectDir.replace(/\/+$/, '') // '' when projectDir is '/'
  const mappable = root.startsWith('/')
  const warnings: string[] = []

  const normalized = tasks.map((task) => {
    let changed = false
    const files = task.files.map((file) => {
      if (!file.path.startsWith('/')) return file
      const rel = mappable && file.path.startsWith(root + '/') ? file.path.slice(root.length + 1) : ''
      if (rel === '') {
        throw new Error(
          `dev-implement: task ${task.id} file path "${file.path}" is absolute and cannot be made ` +
          `relative to projectDir "${projectDir}" — task files must be relative to projectDir ` +
          `(worktree mode maps them into per-task worktrees; an absolute path would mutate that ` +
          `location verbatim). Edit the artifact.`,
        )
      }
      changed = true
      warnings.push(
        `dev-implement: task ${task.id} file path relativized: ${file.path} -> ${rel} — ` +
        `absolute paths are unsafe (worktree mode would mutate the main tree); ` +
        `prefer paths relative to projectDir in the artifact`,
      )
      return { ...file, path: rel }
    })
    return changed ? { ...task, files } : task
  })

  return { tasks: normalized, warnings }
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
  const parsedTasks = (a['tasks'] as unknown[]).map(parseTask)
  validateGraph(parsedTasks)
  const { tasks, warnings: pathWarnings } = normalizeTaskFiles(parsedTasks, context.projectDir)

  const risks = Array.isArray(a['risks']) ? (a['risks'] as unknown[]).filter((r): r is string => typeof r === 'string') : []
  const outOfScope = Array.isArray(a['outOfScope'])
    ? (a['outOfScope'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : []

  if (obj['mutation'] !== undefined && obj['mutation'] !== 'sequential' && obj['mutation'] !== 'worktree') {
    throw new Error(
      'dev-implement: "mutation" must be "sequential" (default, no git required) or "worktree" ' +
      '(parallel per-task worktrees + a merge step — git repo required)',
    )
  }
  const mutation: 'sequential' | 'worktree' = obj['mutation'] === 'worktree' ? 'worktree' : 'sequential'

  // Worktree-only knobs are rejected in sequential mode: silently ignoring
  // them would hide a typo'd mutation value from the operator.
  for (const key of ['worktreeSetupCommand', 'worktreeRoot', 'signCommits'] as const) {
    if (mutation !== 'worktree' && obj[key] !== undefined) {
      throw new Error(`dev-implement: "${key}" is only valid with mutation "worktree"`)
    }
  }

  let worktreeSetupCommand: string | null = null
  if (obj['worktreeSetupCommand'] !== undefined && obj['worktreeSetupCommand'] !== null) {
    if (typeof obj['worktreeSetupCommand'] !== 'string' || obj['worktreeSetupCommand'].trim().length === 0) {
      throw new Error(
        'dev-implement: "worktreeSetupCommand" must be a non-empty VERBATIM shell command — it runs ' +
        'inside each fresh worktree before its TDD loop (fresh worktrees lack installed dependencies ' +
        'for most ecosystems, e.g. "pnpm install")',
      )
    }
    worktreeSetupCommand = obj['worktreeSetupCommand']
  }

  let worktreeRoot: string | null = null
  if (obj['worktreeRoot'] !== undefined && obj['worktreeRoot'] !== null) {
    if (typeof obj['worktreeRoot'] !== 'string' || obj['worktreeRoot'].trim().length === 0) {
      throw new Error(
        'dev-implement: "worktreeRoot" must be a non-empty directory path (omit for the sibling ' +
        'default <projectDir>-worktrees)',
      )
    }
    worktreeRoot = obj['worktreeRoot']
  }

  let signCommits = false
  if (obj['signCommits'] !== undefined) {
    if (typeof obj['signCommits'] !== 'boolean') {
      throw new Error('dev-implement: "signCommits" must be a boolean (default false — machine commits unsigned)')
    }
    signCommits = obj['signCommits']
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
    mutation,
    maxIterationsPerTask,
    worktreeSetupCommand,
    worktreeRoot,
    signCommits,
    pathWarnings,
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
// Wave grouping (worktree mode) — Kahn LEVELS on top of the stable order.
// Tasks in the same wave are mutually independent; a wave's worktrees are
// created only AFTER the previous wave's merges, so dependents branch from a
// HEAD that already contains their dependencies (this also makes cross-wave
// file overlap a normal fast-forward edit instead of a guaranteed conflict).
// ---------------------------------------------------------------------------

function waveLevels(tasks: PlanTask[]): PlanTask[][] {
  const level = new Map<string, number>()
  const waves: PlanTask[][] = []
  for (const task of topologicalOrder(tasks)) {
    const l =
      task.dependsOn.length === 0
        ? 0
        : Math.max(...task.dependsOn.map((d) => level.get(d) ?? 0)) + 1
    level.set(task.id, l)
    ;(waves[l] ??= []).push(task)
  }
  return waves
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

/** What a finished TDD loop means for the report — mode-agnostic. */
interface TddOutcome {
  green: boolean
  iterations: number
  evidence: string
  lastFailure: string
  stoppedBy: string
}

// Shared per-task prompt context: the task record is the implementer's WHOLE
// knowledge of the plan (fresh-context handoff), so every stage prompt
// restates it in full. `workdir` is ctx.projectDir in sequential mode and the
// task's worktree path in worktree mode — the ONLY difference between modes
// at the TDD level.
function buildTaskBlock(artifact: PlanArtifact, task: PlanTask, workdir: string): string {
  return (
    `Goal: ${artifact.goal}\n` +
    `Work from directory: ${workdir}\n` +
    `Conventions: ${artifact.context.conventions}\n` +
    `Out of scope (do NOT touch): ${JSON.stringify(artifact.outOfScope)}\n` +
    `Task ${task.id}: ${task.title}\n` +
    `Intent: ${task.intent}\n` +
    `Files: ${JSON.stringify(task.files)}\n` +
    `Contracts: ${task.contracts}\n` +
    `Test plan: ${task.testPlan}\n` +
    `Done criteria: ${JSON.stringify(task.doneCriteria)}\n`
  )
}

// The bounded red/green/check TDD loop for ONE task, parameterized by working
// directory. Sequential mode passes ctx.projectDir (prompts byte-identical to
// the pre-worktree implementation); worktree mode passes the task's worktree.
async function runTaskTddLoop(
  rt: WorkflowRuntime,
  artifact: PlanArtifact,
  task: PlanTask,
  workdir: string,
  maxIterationsPerTask: number,
  warnings: string[],
  stats: Record<string, PatternStats>,
): Promise<TddOutcome> {
  const ctx = artifact.context
  const taskBlock = buildTaskBlock(artifact, task, workdir)

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
        `Run ${ctx.testCommand} from ${workdir} and read the ACTUAL output. Then check ` +
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
  return {
    green: outcome.state.green,
    iterations: outcome.iterations,
    evidence: outcome.state.evidence,
    lastFailure: outcome.state.lastFailure,
    stoppedBy: outcome.stoppedBy,
  }
}

function failureNote(outcome: TddOutcome): string {
  return outcome.lastFailure === ''
    ? `failed — loop stopped by ${outcome.stoppedBy} before any check ran`
    : `failed — last check: ${outcome.lastFailure}`
}

function tally(reportTasks: ReportTask[]): {
  succeeded: number
  failed: number
  skipped: number
  mergeFailed: number
  integrationFailed: number
} {
  const t = { succeeded: 0, failed: 0, skipped: 0, mergeFailed: 0, integrationFailed: 0 }
  for (const task of reportTasks) {
    if (task.status === 'succeeded') t.succeeded++
    else if (task.status === 'failed') t.failed++
    else if (task.status === 'merge-failed') t.mergeFailed++
    else if (task.status === 'integration-failed') t.integrationFailed++
    else t.skipped++
  }
  return t
}

function skippedRecord(task: PlanTask, blockedBy: string[]): ReportTask {
  return {
    id: task.id,
    title: task.title,
    status: 'skipped',
    iterations: 0,
    evidence: '',
    note: `skipped — depends on non-succeeded task(s): ${blockedBy.join(', ')}`,
  }
}

async function run(rt: WorkflowRuntime, input: DevImplementInput): Promise<DevImplementOutput> {
  if (input.mutation === 'worktree') return runWorktree(rt, input)

  const warnings: string[] = []
  for (const w of input.pathWarnings) warn(rt, warnings, w)
  const stats: Record<string, PatternStats> = {}
  const { artifact, maxIterationsPerTask } = input

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
      reportTasks.push(skippedRecord(task, blockedBy))
      continue
    }

    const outcome = await runTaskTddLoop(
      rt, artifact, task, artifact.context.projectDir, maxIterationsPerTask, warnings, stats,
    )
    if (outcome.green) {
      statusById.set(task.id, 'succeeded')
      reportTasks.push({
        id: task.id,
        title: task.title,
        status: 'succeeded',
        iterations: outcome.iterations,
        evidence: outcome.evidence,
      })
    } else {
      statusById.set(task.id, 'failed')
      reportTasks.push({
        id: task.id,
        title: task.title,
        status: 'failed',
        iterations: outcome.iterations,
        evidence: outcome.evidence,
        note: failureNote(outcome),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic tallying IN CODE (no agent).
  // -------------------------------------------------------------------------

  rt.phase('Report')

  const tallies = tally(reportTasks)
  if (tallies.failed > 0 || tallies.skipped > 0) {
    warn(
      rt,
      warnings,
      `dev-implement: ${tallies.failed} task(s) failed, ${tallies.skipped} skipped — fix the root cause and ` +
      `relaunch with resumeFromRunId (agents of completed tasks replay from cache), or feed ` +
      `the failure notes back into a corrective dev-plan run`,
    )
  }

  return {
    goal: artifact.goal,
    tasks: reportTasks,
    ...tallies,
    stats,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Worktree mode — parallel waves of per-task worktrees + a merge step.
//
// Why not the runtime's agent({isolation: 'worktree'})? That worktree is
// per-AGENT and auto-cleaned, with no controllable branch or path — a task's
// TDD loop spans 3+ agents (red/green/check × iterations) that must share one
// tree, and the merge step needs a known branch name. So worktrees are managed
// BY AGENTS via shell, per task, with deterministic paths/branches.
//
// Do NOT (implementation bounds):
//   - resolve merge conflicts (conservative policy — conflict = merge-failed);
//   - push/fetch or touch the operator's stash;
//   - delete KEPT worktrees (failure forensics) or force worktree creation
//     over an existing path (stale-run leftovers are the operator's call);
//   - sign machine commits unless signCommits is true.
// ---------------------------------------------------------------------------

async function runWorktree(rt: WorkflowRuntime, input: DevImplementInput): Promise<DevImplementOutput> {
  const warnings: string[] = []
  for (const w of input.pathWarnings) warn(rt, warnings, w)
  const stats: Record<string, PatternStats> = {}
  const { artifact, maxIterationsPerTask, worktreeSetupCommand, worktreeRoot, signCommits } = input
  const ctx = artifact.context

  const wtBranch = (id: string): string => `wt-task/${id}`
  // Machine commits are unsigned by default: a locked signing agent mid-run
  // would kill merges opaquely; the operator owns/squashes the final history.
  const signFlag = signCommits ? '' : '-c commit.gpgsign=false '

  // -------------------------------------------------------------------------
  // Phase 'Setup' — git availability (parseInput is pure and cannot check it).
  // -------------------------------------------------------------------------
  rt.phase('Setup')

  const setup = await rt.agent<SetupResult>(
    `You are the environment setup agent for a worktree-mode dev-implement run. ` +
    `First verify this is a git repository: from ${ctx.projectDir} run ` +
    `\`git rev-parse --is-inside-work-tree\`, then capture the current HEAD with ` +
    `\`git rev-parse HEAD\` and the repository root with \`git rev-parse --show-toplevel\`.\n` +
    `Return { "isGitRepo": true|false, "headSha": "<sha or empty>", "gitRoot": "<absolute path or empty>", "note": "<what you saw>" }`,
    { schema: SETUP_RESULT_SCHEMA, label: 'dev-implement:setup', phase: 'Setup' },
  )
  if (setup === null || !setup.isGitRepo) {
    warn(
      rt,
      warnings,
      `dev-implement: worktree mode requires a git repository at ${ctx.projectDir}` +
      (setup === null ? ' (setup agent died)' : ` — ${setup.note}`) +
      `; every task skipped. Use mutation "sequential" for non-git projects.`,
    )
    rt.phase('Report')
    const reportTasks: ReportTask[] = artifact.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: 'skipped' as const,
      iterations: 0,
      evidence: '',
      note: 'skipped — worktree mode requires a git repository',
    }))
    return { goal: artifact.goal, tasks: reportTasks, ...tally(reportTasks), stats, warnings }
  }

  // Worktree geometry — derived from the GIT ROOT, not projectDir: a worktree
  // checks out the WHOLE repository, so when projectDir is a subdirectory
  // (monorepo layout) the TDD workdir is the worktree path PLUS the
  // projectDir-relative suffix, and the default worktree root must be a
  // sibling of the git root (a <projectDir>-worktrees sibling would land
  // INSIDE the repository and pollute git status).
  const gitRoot = setup.gitRoot.trim() === '' ? ctx.projectDir : setup.gitRoot
  // Boundary-safe mapping (same class as normalizeTaskFiles): gitRoot "/a/b"
  // must not be sliced out of an adjacent-prefix projectDir like "/a/bc".
  const projectSub =
    ctx.projectDir === gitRoot
      ? ''
      : ctx.projectDir.startsWith(gitRoot + '/')
        ? ctx.projectDir.slice(gitRoot.length)
        : ''
  const wtRoot = worktreeRoot ?? `${gitRoot}-worktrees`
  const wtPath = (id: string): string => `${wtRoot}/${id}`
  const taskWorkdir = (id: string): string => `${wtPath(id)}${projectSub}`

  const statusById = new Map<string, TaskStatus>()
  const reportTasks: ReportTask[] = []
  const merged: Array<{ id: string; path: string; branch: string }> = []

  const waves = waveLevels(artifact.tasks)
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w] as PlanTask[]

    // Dependents of non-succeeded tasks skip (same mechanics as sequential).
    const eligible: PlanTask[] = []
    for (const task of wave) {
      const blockedBy = task.dependsOn.filter((d) => statusById.get(d) !== 'succeeded')
      if (blockedBy.length > 0) {
        statusById.set(task.id, 'skipped')
        reportTasks.push(skippedRecord(task, blockedBy))
      } else {
        eligible.push(task)
      }
    }
    if (eligible.length === 0) continue

    // ---- Provision the wave's worktrees: ONE agent, SEQUENTIAL commands ----
    // (concurrent `git worktree add` from the same repo race on .git locks).
    // Created HERE, after the previous wave's merges, so dependents branch
    // from a HEAD that already contains their dependencies.
    const create = await rt.agent<WtCreateResult>(
      `You are the worktree provisioning agent — create the isolated git worktrees for this wave, ` +
      `running the commands ONE AT A TIME from ${ctx.projectDir} (concurrent worktree adds race on git locks):\n` +
      eligible.map((t) => `git worktree add ${wtPath(t.id)} -b ${wtBranch(t.id)}`).join('\n') +
      `\nIf a path already exists, do NOT force or remove it — report that task in "failures" ` +
      `(a stale worktree from a previous run is the operator's call to delete).\n` +
      `Return { "created": ["<taskId>"], "failures": [{"id": "<taskId>", "note": "<why>"}], "note": "<summary>" }`,
      { schema: WT_CREATE_SCHEMA, label: `dev-implement:worktrees:wave${w}`, phase: 'Setup' },
    )
    if (create === null) {
      warn(rt, warnings, `dev-implement: worktree provisioning agent died for wave ${w} — the whole wave fails`)
    }
    const createdSet = new Set(create?.created ?? [])
    const createFailures = new Map((create?.failures ?? []).map((f) => [f.id, f.note]))

    const ready: PlanTask[] = []
    for (const task of eligible) {
      if (createdSet.has(task.id)) {
        ready.push(task)
      } else {
        statusById.set(task.id, 'failed')
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: 'failed',
          iterations: 0,
          evidence: '',
          note: `failed — worktree creation: ${createFailures.get(task.id) ?? (create === null ? 'provisioning agent died' : 'not reported as created')}`,
        })
      }
    }

    // Same-wave file overlap = no runtime hazard (worktrees isolate) but a
    // likely merge conflict — warn, never auto-serialize (least surprise).
    // Computed on READY tasks only (a task that never got a worktree does not
    // run, so warning about it would be a false positive). Advisory only,
    // pairs against the FIRST declaring task: with 3+ tasks on one file,
    // later tasks each warn vs the first owner, not vs each other.
    const fileOwner = new Map<string, string>()
    for (const task of ready) {
      for (const file of task.files) {
        const owner = fileOwner.get(file.path)
        if (owner !== undefined && owner !== task.id) {
          warn(
            rt,
            warnings,
            `dev-implement: tasks ${owner} and ${task.id} in the same wave both declare ${file.path} — ` +
            `worktrees isolate the edits but a merge conflict is likely; consider a dependsOn edge`,
          )
        } else {
          fileOwner.set(file.path, task.id)
        }
      }
    }

    // ---- Parallel per-task chains: [prepare] → TDD loop → finalize commit ----
    type ChainResult =
      | { kind: 'prepare-failed'; note: string }
      | { kind: 'tdd-failed'; outcome: TddOutcome }
      | { kind: 'finalize-failed'; outcome: TddOutcome; note: string }
      | { kind: 'green'; outcome: TddOutcome; sha: string }

    const chainResults = await rt.parallel<ChainResult>(
      ready.map((task) => async (): Promise<ChainResult> => {
        if (worktreeSetupCommand !== null) {
          const prep = await rt.agent<PrepareResult>(
            `You are the worktree preparation agent — prepare the task worktree for ${task.id}: run this ` +
            `VERBATIM setup command with ${taskWorkdir(task.id)} as the working directory (fresh worktrees ` +
            `lack installed dependencies; this makes the test command runnable):\n${worktreeSetupCommand}\n` +
            `Return { "ok": true|false, "note": "<what happened>" }`,
            { schema: PREPARE_RESULT_SCHEMA, label: `dev-implement:prepare:${task.id}`, phase: 'Setup' },
          )
          if (prep === null || !prep.ok) {
            return { kind: 'prepare-failed', note: prep === null ? 'preparation agent died' : prep.note }
          }
        }

        const outcome = await runTaskTddLoop(
          rt, artifact, task, taskWorkdir(task.id), maxIterationsPerTask, warnings, stats,
        )
        if (!outcome.green) return { kind: 'tdd-failed', outcome }

        const fin = await rt.agent<FinalizeResult>(
          `You are the task-branch committer — commit the task changes on its task branch: with ` +
          `${wtPath(task.id)} as the working directory run \`git add -A\`, then commit with ` +
          `\`git ${signFlag}commit\` and capture the sha (\`git rev-parse HEAD\`).\n` +
          `The commit message is the LITERAL line between the markers below — quote/escape it ` +
          `yourself when invoking git (titles may contain quotes or backticks; never let them ` +
          `reach the shell unquoted):\n` +
          `<<<MESSAGE\n${wtBranch(task.id)}: ${task.title}\nMESSAGE>>>\n` +
          `Return { "committed": true|false, "sha": "<sha or empty>", "note": "<what happened>" }`,
          { schema: FINALIZE_RESULT_SCHEMA, label: `dev-implement:finalize:${task.id}`, phase: 'Implement' },
        )
        if (fin === null || !fin.committed) {
          return { kind: 'finalize-failed', outcome, note: fin === null ? 'finalize agent died' : fin.note }
        }
        return { kind: 'green', outcome, sha: fin.sha }
      }),
    )

    // ---- Classify chain results (wave order); queue the green ones to merge ----
    const toMerge: Array<{ task: PlanTask; outcome: TddOutcome }> = []
    ready.forEach((task, i) => {
      const result = chainResults[i] ?? null
      const kept = { worktreePath: wtPath(task.id), branch: wtBranch(task.id) }
      if (result === null) {
        statusById.set(task.id, 'failed')
        reportTasks.push({
          id: task.id, title: task.title, status: 'failed', iterations: 0, evidence: '',
          note: 'failed — task chain crashed (an agent threw)', ...kept,
        })
        warn(rt, warnings, `dev-implement: task chain crashed for ${task.id} — worktree kept at ${wtPath(task.id)}`)
      } else if (result.kind === 'prepare-failed') {
        statusById.set(task.id, 'failed')
        reportTasks.push({
          id: task.id, title: task.title, status: 'failed', iterations: 0, evidence: '',
          note: `failed — worktree setup command: ${result.note}`, ...kept,
        })
      } else if (result.kind === 'tdd-failed') {
        statusById.set(task.id, 'failed')
        reportTasks.push({
          id: task.id, title: task.title, status: 'failed',
          iterations: result.outcome.iterations, evidence: result.outcome.evidence,
          note: failureNote(result.outcome), ...kept,
        })
      } else if (result.kind === 'finalize-failed') {
        statusById.set(task.id, 'failed')
        reportTasks.push({
          id: task.id, title: task.title, status: 'failed',
          iterations: result.outcome.iterations, evidence: result.outcome.evidence,
          note: `failed — task-branch commit: ${result.note}`, ...kept,
        })
      } else {
        toMerge.push({ task, outcome: result.outcome })
      }
    })

    // ---- Sequential merges, integration-checked after EACH merge ----
    // Per-merge (not per-wave) verification gives exact failure attribution.
    rt.phase('Merge')
    for (const { task, outcome } of toMerge) {
      const kept = { worktreePath: wtPath(task.id), branch: wtBranch(task.id) }

      const merge = await rt.agent<MergeResult>(
        `You are the merge agent — from ${ctx.projectDir} (the MAIN tree), merge the task branch ` +
        `${wtBranch(task.id)} into the current branch: FIRST capture the pre-merge HEAD ` +
        `(\`git rev-parse HEAD\`), then run \`git ${signFlag}merge --no-ff ${wtBranch(task.id)}\`.\n` +
        `On CONFLICT: run \`git merge --abort\` and report conflict: true — NEVER resolve conflicts ` +
        `yourself. Evidence required: the pre-merge sha and the resulting sha (or '' if aborted).\n` +
        `Return { "merged": true|false, "conflict": true|false, "preMergeSha": "<sha>", ` +
        `"mergeSha": "<sha or empty>", "note": "<what git actually said>" }`,
        { schema: MERGE_RESULT_SCHEMA, label: `dev-implement:merge:${task.id}`, phase: 'Merge' },
      )
      if (merge === null || merge.conflict || !merge.merged) {
        statusById.set(task.id, 'merge-failed')
        reportTasks.push({
          id: task.id, title: task.title, status: 'merge-failed',
          iterations: outcome.iterations, evidence: outcome.evidence,
          note: `merge-failed — ${merge === null ? 'merge agent died (branch not merged)' : merge.note}`, ...kept,
        })
        continue
      }

      const integ = await rt.agent<CheckResult>(
        `You are the independent integration checker — verify the integrated main tree: run ` +
        `${ctx.testCommand} from ${ctx.projectDir} and read the ACTUAL output (the per-task checker ` +
        `saw an isolated worktree; you are checking that the MERGED whole still passes).\n` +
        `Return { "green": true|false, "evidence": "<what the run actually showed>", ` +
        `"failureSummary": "<empty string if green, else the failures>" }`,
        { schema: CHECK_RESULT_SCHEMA, label: `dev-implement:integration:${task.id}`, phase: 'Merge' },
      )
      if (integ === null || !integ.green) {
        if (integ === null) {
          warn(rt, warnings, `dev-implement: integration checker died for ${task.id} — reverting conservatively without evidence`)
        }
        const revert = await rt.agent<RevertResult>(
          `You are the merge revert agent — revert the failed merge: from ${ctx.projectDir} run ` +
          `\`git reset --hard ${merge.preMergeSha}\` and confirm with \`git rev-parse HEAD\`.\n` +
          `Return { "reverted": true|false, "headSha": "<sha>", "note": "<what happened>" }`,
          { schema: REVERT_RESULT_SCHEMA, label: `dev-implement:revert:${task.id}`, phase: 'Merge' },
        )
        if (revert === null || !revert.reverted) {
          warn(
            rt,
            warnings,
            `dev-implement: revert ${revert === null ? 'agent died' : 'failed'} for ${task.id} — the MAIN tree may ` +
            `still hold the bad merge; manual recovery: git reset --hard ${merge.preMergeSha}`,
          )
        }
        statusById.set(task.id, 'integration-failed')
        reportTasks.push({
          id: task.id, title: task.title, status: 'integration-failed',
          iterations: outcome.iterations, evidence: integ === null ? '' : integ.evidence,
          note: `integration-failed — ${integ === null ? 'integration checker died (conservative revert)' : integ.failureSummary}`,
          ...kept,
        })
        continue
      }

      statusById.set(task.id, 'succeeded')
      reportTasks.push({
        id: task.id, title: task.title, status: 'succeeded',
        iterations: outcome.iterations, evidence: integ.evidence,
      })
      merged.push({ id: task.id, path: wtPath(task.id), branch: wtBranch(task.id) })
    }
  }

  // ---- Batched cleanup of MERGED worktrees only (kept ones stay for forensics) ----
  if (merged.length > 0) {
    const cleanup = await rt.agent<CleanupResult>(
      `You are the cleanup agent — remove the merged worktrees and their task branches. From ` +
      `${ctx.projectDir}, for EACH entry run \`git worktree remove <path>\` FIRST and ` +
      `\`git branch -d <branch>\` SECOND (a branch checked out in a live worktree cannot be deleted):\n` +
      merged.map((m) => `${m.id}: ${m.path} (${m.branch})`).join('\n') +
      `\nDo NOT touch any other worktree or branch.\n` +
      `Return { "removed": ["<taskId>"], "failures": [{"id": "<taskId>", "note": "<why>"}], "note": "<summary>" }`,
      { schema: CLEANUP_RESULT_SCHEMA, label: 'dev-implement:cleanup', phase: 'Merge' },
    )
    if (cleanup === null) {
      warn(rt, warnings, `dev-implement: cleanup agent died — merged worktrees left on disk under ${wtRoot} (manual: git worktree remove)`)
    } else if (cleanup.failures.length > 0) {
      warn(rt, warnings, `dev-implement: cleanup incomplete for ${cleanup.failures.map((f) => f.id).join(', ')} — ${cleanup.note}`)
    }
  }

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic tallying IN CODE (no agent).
  // -------------------------------------------------------------------------

  rt.phase('Report')

  const tallies = tally(reportTasks)
  const keptWorktrees = reportTasks.filter((t) => t.worktreePath !== undefined)
  if (tallies.failed + tallies.mergeFailed + tallies.integrationFailed + tallies.skipped > 0) {
    warn(
      rt,
      warnings,
      `dev-implement: ${tallies.failed} task(s) failed, ${tallies.mergeFailed} merge-failed, ` +
      `${tallies.integrationFailed} integration-failed, ${tallies.skipped} skipped — the MAIN tree only ` +
      `contains the ${tallies.succeeded} merged task(s)` +
      (keptWorktrees.length > 0
        ? `; kept worktree(s) for forensics: ${keptWorktrees.map((t) => `${t.id} at ${t.worktreePath ?? ''}`).join(', ')}`
        : '') +
      `. Fix the root cause and re-run (worktree creation refuses stale paths — remove kept worktrees first), ` +
      `or feed the failure notes back into a corrective dev-plan run.`,
    )
  }

  return {
    goal: artifact.goal,
    tasks: reportTasks,
    ...tallies,
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
      'dev-plan (the human may have edited it), runs each task through a bounded TDD loop ' +
      '(failing tests first, implement against the contracts, then an independent checker reads ' +
      'the real test output), and reports a deterministic per-task tally with evidence. Two ' +
      'mutation modes: "sequential" (default — one task at a time in dependency order, no git ' +
      'required) and "worktree" (git required — independent tasks run in parallel waves, each in ' +
      'an isolated git worktree, then merge sequentially with an integration check after every ' +
      'merge; conflicts abort conservatively and failure worktrees are kept for forensics).',
    whenToUse:
      'Use after a human has reviewed and approved the PlanArtifact from dev-plan. Pass ' +
      '{ artifact } (plus optional mutation/maxIterationsPerTask, and for worktree mode optional ' +
      'worktreeSetupCommand/worktreeRoot/signCommits) as the workflow args. Sequential mode works ' +
      'without git; worktree mode requires a git repository and machine commits are unsigned ' +
      'unless signCommits is true. Task file paths must be RELATIVE to projectDir: absolute ' +
      'paths under an absolute projectDir are auto-relativized (with a warning); any other ' +
      'absolute path is rejected at parse time in both modes.',
    phases: [
      { title: 'Setup', detail: 'Worktree mode: git check, per-wave worktree provisioning, setup command' },
      { title: 'Implement', detail: 'Per task: write failing tests, implement (TDD loop) — parallel within a wave in worktree mode' },
      { title: 'Check', detail: 'Independent fresh-evidence checker runs the real test command per iteration' },
      { title: 'Merge', detail: 'Worktree mode: sequential merges, integration check after EACH merge, revert on red' },
      { title: 'Report', detail: 'Deterministic tally incl. merge-failed/integration-failed (in code, no agent)' },
    ],
  },
  parseInput,
  run,
})
