// dev-plan.workflow.ts — Planning half of the dev-workflow family (L3 HITL).
//
// PEDAGOGY: the dev-workflow family (design: docs/internal/dev-workflow-design.md)
//
//   dev-plan → [human reviews/edits the PlanArtifact] → dev-implement → dev-review-fix
//
// This workflow is the PLANNING half. It runs fully autonomously and ends at an
// artifact boundary: the PlanArtifact — a fully self-sufficient, human-editable
// JSON contract. Fresh-context implementer agents know NOTHING beyond their
// prompt, so every task in the artifact must carry its own intent, target files,
// contracts, test plan, and done criteria. 80% of the downstream quality lives
// in this artifact's completeness.
//
// Architecture notes:
//   Phase 'Discover'  — fanOutAndSynthesize: parallel per-area exploration →
//                       consolidated project context (testCommand, conventions).
//   Phase 'Plan'      — planAndExecute: dynamic decomposition into candidate
//                       tasks. The number of tasks is NOT known up front — that
//                       is the planner's job (unknown subtasks → planAndExecute).
//   Phase 'Critique'  — adversarialVerification on each candidate task's CLAIMS:
//                       do the files it says exist actually exist? Are the
//                       contracts real? Are the done criteria checkable?
//                       Refuted tasks are excluded and reported in `rejected`.
//   Phase 'Synthesize'— final PlanArtifact agent from kept tasks, then
//                       DETERMINISTIC validation IN CODE (unique ids, dependsOn
//                       references, cycle rejection). Graph validation is a code
//                       responsibility, not a model responsibility.
//
// WHY ids/dependsOn ARE ASSIGNED AT SYNTHESIZE (not by Plan workers):
//   Plan workers run in parallel and cannot see each other's tasks — they can
//   neither pick unique ids nor reference each other. Only the Synthesize agent
//   sees ALL kept tasks at once, so id assignment and the dependency graph are
//   its job; code then validates the graph deterministically.
//
// CACHE CAVEAT on validation failure:
//   If the synthesized artifact fails validation (cycle, duplicate id…), DO NOT
//   resumeFromRunId — resume would replay the SAME invalid synthesis from cache.
//   Fix the goal/prompts if needed and re-run fresh.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import type { WorkflowRuntime, JsonSchema } from '@workflow-toolbox/runtime'
import {
  fanOutAndSynthesize,
  planAndExecute,
  adversarialVerification,
  warn,
} from '@workflow-toolbox/patterns'
import type { VerifiedClaim, PatternStats } from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface DevPlanInput {
  goal: string
  /** Repository areas to discover (directories). Defaults to ['.']. */
  areas: string[]
  /** Project root the downstream implementer will run commands from. Defaults to '.'. */
  projectDir: string
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Schema for one area's discovery output (fanOutAndSynthesize task)
const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['file', 'detail'],
        additionalProperties: false,
      },
    },
    testCommand: { type: 'string' },
    buildCommand: { type: 'string' },
    conventions: { type: 'string' },
  },
  required: ['observations', 'testCommand', 'buildCommand', 'conventions'],
  additionalProperties: false,
} as const satisfies JsonSchema

type DiscoveryOutput = FromSchema<typeof DISCOVERY_SCHEMA>

// Schema for the consolidated project context (fanOutAndSynthesize synthesis)
const CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    testCommand: { type: 'string' },
    buildCommand: { type: 'string' },
    conventions: { type: 'string' },
    repoBrief: { type: 'string' },
  },
  required: ['testCommand', 'buildCommand', 'conventions', 'repoBrief'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ContextOutput = FromSchema<typeof CONTEXT_SCHEMA>

// One task's file target — status is an enum so the Critique phase has a
// concrete, refutable claim ("new" but the file exists = refuted).
const TASK_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    status: { type: 'string', enum: ['existing', 'new'] },
    role: { type: 'string' },
  },
  required: ['path', 'status', 'role'],
  additionalProperties: false,
} as const

// Schema for a Plan worker's candidate tasks — NO id/dependsOn here: parallel
// workers cannot coordinate ids or reference each other's tasks (see header).
const CANDIDATE_TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          intent: { type: 'string' },
          files: { type: 'array', items: TASK_FILE_SCHEMA },
          contracts: { type: 'string' },
          testPlan: { type: 'string' },
          doneCriteria: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'intent', 'files', 'contracts', 'testPlan', 'doneCriteria'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CandidateTasksOutput = FromSchema<typeof CANDIDATE_TASKS_SCHEMA>
type CandidateTask = CandidateTasksOutput['tasks'][number]

// Schema for the final PlanArtifact (Synthesize phase) — the L3 handoff contract
const PLAN_ARTIFACT_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    context: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        testCommand: { type: 'string' },
        buildCommand: { type: 'string' },
        conventions: { type: 'string' },
      },
      required: ['projectDir', 'testCommand', 'buildCommand', 'conventions'],
      additionalProperties: false,
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          intent: { type: 'string' },
          files: { type: 'array', items: TASK_FILE_SCHEMA },
          contracts: { type: 'string' },
          testPlan: { type: 'string' },
          doneCriteria: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'intent', 'files', 'contracts', 'testPlan', 'doneCriteria', 'dependsOn'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'context', 'tasks', 'risks', 'outOfScope'],
  additionalProperties: false,
} as const satisfies JsonSchema

type PlanArtifact = FromSchema<typeof PLAN_ARTIFACT_SCHEMA>

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

interface RejectedTask {
  title: string
  files: string[]
  verdict: string
  /** The refuting verifiers' reasons — the human arbitrates rejections, so the
   *  WHY must survive into the output (live-run lesson: title alone is not
   *  enough to decide whether a rejection was right). */
  reason: string
}

interface DevPlanOutput {
  artifact: PlanArtifact
  rejected: readonly RejectedTask[]
  /** Per-phase pattern envelope stats — kept typed so callers can calibrate
   *  budgets from real runs (arch §8: budgetFloor calibration). */
  stats: Record<string, PatternStats>
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable error messages
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): DevPlanInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'dev-plan: input must be an object with "goal" (string), optional "areas" (string[]) ' +
      'and optional "projectDir" (string) — received: ' +
      (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw),
    )
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj['goal'] !== 'string' || obj['goal'].trim().length === 0) {
    throw new Error(
      'dev-plan: "goal" must be a non-empty string — describe the feature or fix to plan ' +
      '(e.g. "Add input validation to the CLI"). Include corrections from prior runs here.',
    )
  }

  let areas: string[]
  if (obj['areas'] === undefined) {
    // Omitted areas = discover from the project root.
    areas = ['.']
  } else {
    if (!Array.isArray(obj['areas']) || obj['areas'].length === 0) {
      throw new Error(
        'dev-plan: "areas" must be a non-empty array of strings (or omitted to default to ["."]) — ' +
        'each element is a directory to discover (e.g. ["src", "test"])',
      )
    }
    for (let i = 0; i < obj['areas'].length; i++) {
      const area = obj['areas'][i]
      if (typeof area !== 'string' || area.trim().length === 0) {
        throw new Error(
          `dev-plan: "areas[${i}]" must be a non-empty string — each element must be a directory path`,
        )
      }
    }
    areas = obj['areas'] as string[]
  }

  let projectDir = '.'
  if (obj['projectDir'] !== undefined) {
    if (typeof obj['projectDir'] !== 'string' || obj['projectDir'].trim().length === 0) {
      throw new Error(
        'dev-plan: "projectDir" must be a non-empty string (or omitted to default to ".") — ' +
        'the directory the implementer will run commands from',
      )
    }
    projectDir = obj['projectDir']
  }

  return { goal: obj['goal'], areas, projectDir }
}

// ---------------------------------------------------------------------------
// validateArtifact — deterministic graph validation IN CODE (no agent).
//
// Unique ids, resolvable dependsOn references, and cycle rejection are exact,
// decidable checks — running them in code is faster, deterministic, and removes
// a failure point. The Synthesize agent proposes the graph; code validates it.
//
// On failure the error says to RE-RUN FRESH: resumeFromRunId would replay the
// same invalid synthesis from cache (same prompt → cached result → same error).
// ---------------------------------------------------------------------------

const RERUN_HINT =
  'Do NOT resumeFromRunId — resume replays the same invalid synthesis from cache. ' +
  'Re-run fresh (adjust the goal if the planner keeps producing this shape).'

function validateArtifact(artifact: PlanArtifact): void {
  const tasks = artifact.tasks
  if (tasks.length === 0) {
    throw new Error(`dev-plan: synthesized artifact has an empty "tasks" list. ${RERUN_HINT}`)
  }

  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(
        `dev-plan: duplicate task id "${task.id}" in synthesized artifact — ids must be unique. ${RERUN_HINT}`,
      )
    }
    ids.add(task.id)
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(
          `dev-plan: task "${task.id}" dependsOn references unknown task id "${dep}". ${RERUN_HINT}`,
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
        throw new Error(`dev-plan: dependency cycle detected in synthesized artifact: ${path}. ${RERUN_HINT}`)
      }
      if (depState === undefined) {
        state.set(dep, 'visiting')
        stack.push({ id: dep, nextDep: 0 })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: DevPlanInput): Promise<DevPlanOutput> {
  const warnings: string[] = []
  const stats: Record<string, PatternStats> = {}

  // -------------------------------------------------------------------------
  // Phase 'Discover' — fanOutAndSynthesize
  //
  // Why: areas are independent read-only explorations; the synthesis barrier is
  // justified because the consolidated context (ONE testCommand, ONE conventions
  // digest) genuinely needs all per-area discoveries. This context block is
  // distilled ONCE here and injected into every downstream prompt — and into the
  // artifact itself, where it becomes the implementer's whole world-knowledge.
  // -------------------------------------------------------------------------

  rt.phase('Discover')

  const discoverResult = await fanOutAndSynthesize<string, DiscoveryOutput, ContextOutput>(rt, {
    tasks: input.areas,
    taskPrompt: (area) =>
      `Explore this repository area to ground a development plan.\n` +
      `Goal: ${input.goal}\n` +
      `Project root: ${input.projectDir}\n` +
      `Area: ${area}\n` +
      `Read the actual files. Report: observations relevant to the goal (entry points, ` +
      `existing helpers, test layout), the test command, the build command (empty string ` +
      `if none), and the coding conventions you can verify (style, test framework, idioms).\n` +
      `testCommand and buildCommand MUST be a single shell command executable VERBATIM from ` +
      `the project root — no prose, no parenthetical commentary, no alternatives. Anything ` +
      `that is advice (gates, caveats, related commands) belongs in conventions instead.\n` +
      `Return { "observations": [{ "file": "<path>", "detail": "<relevant fact>" }], ` +
      `"testCommand": "<cmd or empty>", "buildCommand": "<cmd or empty>", "conventions": "<digest>" }`,
    taskSchema: DISCOVERY_SCHEMA,
    synthesisPrompt: (parts) =>
      `Consolidate the per-area discoveries into one project context for a development plan.\n` +
      `Goal: ${input.goal}\n` +
      `Discoveries: ${JSON.stringify(parts)}\n` +
      `Resolve disagreements conservatively (prefer the command actually present in the area ` +
      `closest to the project root). testCommand and buildCommand MUST each be a single shell ` +
      `command executable VERBATIM from the project root — no prose, no parenthetical ` +
      `commentary; move any advice into conventions. The conventions digest must be ` +
      `self-sufficient: a reader with NO other context must be able to write idiomatic code ` +
      `from it.\n` +
      `Return { "testCommand": "<cmd or empty>", "buildCommand": "<cmd or empty>", ` +
      `"conventions": "<digest>", "repoBrief": "<one-paragraph project summary>" }`,
    synthesisSchema: CONTEXT_SCHEMA,
    phase: 'Discover',
  })

  for (const w of discoverResult.warnings) warnings.push(w)
  stats['discover'] = discoverResult.stats

  // Total Discover failure must never be silently masked — degrade loudly.
  if (discoverResult.value === null) {
    warn(
      rt,
      warnings,
      'Discover phase produced no consolidated context (synthesis dropped) — ' +
        'planning continues with an EMPTY context; expect a weaker artifact',
    )
  }
  const context: ContextOutput = discoverResult.value ?? {
    testCommand: '',
    buildCommand: '',
    conventions: '',
    repoBrief: '',
  }

  // -------------------------------------------------------------------------
  // Phase 'Plan' — planAndExecute
  //
  // Why planAndExecute (not fanOutAndSynthesize): the planner dynamically
  // decomposes the goal — the number of tasks is NOT known up front. Workers
  // then detail each subtask into candidate tasks carrying every handoff field
  // EXCEPT id/dependsOn (parallel workers cannot coordinate those — see header).
  // The pattern synthesis emits a draft narrative; the real artifact is produced
  // in Phase 'Synthesize' from the ADVERSARIALLY FILTERED tasks, not from this
  // draft. workerResults are captured for the Critique phase.
  // -------------------------------------------------------------------------

  rt.phase('Plan')

  const planResult = await planAndExecute<CandidateTasksOutput, string>(rt, {
    planPrompt:
      `Decompose the development goal into independent implementation subtasks.\n` +
      `Goal: ${input.goal}\n` +
      `Project brief: ${context.repoBrief}\n` +
      `Conventions: ${context.conventions}\n` +
      `Each subtask must be one coherent unit of work a single developer could TDD in ` +
      `isolation. Prefer fewer, well-scoped subtasks over many fragments.\n` +
      `Return { "subtasks": [{ "description": "<subtask description>" }] }`,
    workerPrompt: (subtask) =>
      `Detail the implementation task: ${subtask.description}\n` +
      `Goal: ${input.goal}\n` +
      `Project brief: ${context.repoBrief}\n` +
      `Conventions: ${context.conventions}\n` +
      `Open the actual files to verify your claims. Produce SELF-SUFFICIENT task records: ` +
      `a fresh-context implementer will see ONLY this record plus the project context.\n` +
      `- intent: WHAT + WHY, readable with zero other context\n` +
      `- files: every file touched, status "existing" (verify it exists!) or "new"\n` +
      `- contracts: signatures/shapes/invariants the implementation must honor\n` +
      `- testPlan: which failing test(s) to write FIRST\n` +
      `- doneCriteria: each independently checkable\n` +
      `Return { "tasks": [{ "title", "intent", "files": [{ "path", "status", "role" }], ` +
      `"contracts", "testPlan", "doneCriteria": ["<criterion>"] }] }`,
    workerSchema: CANDIDATE_TASKS_SCHEMA,
    synthesisPrompt: (results) =>
      `Compose a short draft plan narrative from these candidate implementation tasks.\n` +
      `Goal: ${input.goal}\n` +
      `Candidate tasks: ${JSON.stringify(results)}\n` +
      `Plain text. This is a working note for the final synthesis, not the artifact.`,
    maxSubtasks: 8,
    phase: 'Plan',
  })

  for (const w of planResult.warnings) warnings.push(w)
  stats['plan'] = planResult.stats

  const candidateTasks: CandidateTask[] = planResult.workerResults.flatMap((r) => r.tasks)

  // -------------------------------------------------------------------------
  // Phase 'Critique' — adversarialVerification
  //
  // Why: candidate tasks are agent-generated and their claims may be hallucinated
  // (files marked "new" that exist, contracts naming APIs that don't, vague done
  // criteria). renderClaim instructs the verifier to RE-DERIVE from the actual
  // code — never trust the task record (fresh-evidence checker). Refuted tasks
  // are EXCLUDED from the artifact but REPORTED in rejected.
  // -------------------------------------------------------------------------

  rt.phase('Critique')

  let verifiedTasks: Array<VerifiedClaim<CandidateTask>> = []
  const rejected: RejectedTask[] = []

  if (candidateTasks.length > 0) {
    const critiqueResult = await adversarialVerification<CandidateTask>(rt, {
      claims: candidateTasks,
      renderClaim: (task) =>
        `Plan task claim: "${task.title}"\n` +
        `Intent: ${task.intent}\n` +
        `Files: ${JSON.stringify(task.files)}\n` +
        `Contracts: ${task.contracts}\n` +
        `Done criteria: ${JSON.stringify(task.doneCriteria)}\n\n` +
        `IMPORTANT: Do NOT trust this task record. Open the actual files and re-derive:\n` +
        `(1) every file with status "existing" exists, every "new" does NOT already exist;\n` +
        `(2) the contracts match the real code (signatures, types, exports);\n` +
        `(3) each done criterion is concretely checkable (a test or an inspectable fact).\n` +
        `Refute the task if any claim is wrong.`,
      maxVerifyClaims: 12,
      phase: 'Critique',
    })

    for (const w of critiqueResult.warnings) warnings.push(w)
    stats['critique'] = critiqueResult.stats
    verifiedTasks = critiqueResult.value
  } else {
    warn(rt, warnings, 'Plan phase produced no candidate tasks — Critique phase skipped')
  }

  const keptTasks: CandidateTask[] = []
  for (const vt of verifiedTasks) {
    if (vt.verdict === 'refuted') {
      rejected.push({
        title: vt.claim.title,
        files: vt.claim.files.map((f) => f.path),
        verdict: vt.verdict,
        reason: vt.votes
          .flatMap((v) => (v !== null && v.verdict === 'refuted' ? [v.reason] : []))
          .join('; '),
      })
    } else {
      keptTasks.push(vt.claim)
    }
  }

  // -------------------------------------------------------------------------
  // Phase 'Synthesize' — final PlanArtifact agent + deterministic validation.
  //
  // Barrier: id assignment and the dependency graph need ALL kept tasks at once
  // (see header). The agent proposes the graph; validateArtifact() checks it in
  // code. goal and context.projectDir are then OVERRIDDEN deterministically from
  // the input — echoing exact values is a code responsibility, not a model one.
  // -------------------------------------------------------------------------

  rt.phase('Synthesize')

  const synthesizePrompt =
    `Produce the final PlanArtifact from these verified implementation tasks.\n` +
    `Goal: ${input.goal}\n` +
    `Project context: ${JSON.stringify({ projectDir: input.projectDir, ...context })}\n` +
    `Kept tasks (critique survivors): ${JSON.stringify(keptTasks)}\n` +
    `Draft narrative: ${planResult.value ?? '(none)'}\n` +
    `Assign sequential ids ("T1", "T2", …) and a dependsOn graph (ids only, no cycles — ` +
    `a task lists ONLY tasks whose output it genuinely needs). Order tasks so dependencies ` +
    `come first. Derive risks and outOfScope (explicit NON-goals — the anti-drift fence).\n` +
    `Return { "goal", "context": { "projectDir", "testCommand", "buildCommand", "conventions" }, ` +
    `"tasks": [{ "id", "title", "intent", "files": [{ "path", "status", "role" }], "contracts", ` +
    `"testPlan", "doneCriteria": [], "dependsOn": [] }], "risks": [], "outOfScope": [] }`

  const synthesized = await rt.agent<PlanArtifact>(synthesizePrompt, {
    schema: PLAN_ARTIFACT_SCHEMA,
    label: 'dev-plan:synthesize',
    phase: 'Synthesize',
  })

  if (synthesized === null) {
    throw new Error(
      'dev-plan: final PlanArtifact synthesis failed — the synthesis agent died. ' +
      'Use resumeFromRunId to retry from the Synthesize phase (all prior work is cached).',
    )
  }

  validateArtifact(synthesized)

  // Deterministic override: exact echo of goal/projectDir is code's job.
  const artifact: PlanArtifact = {
    ...synthesized,
    goal: input.goal,
    context: { ...synthesized.context, projectDir: input.projectDir },
  }

  return { artifact, rejected, stats, warnings }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'dev-plan',
    description:
      'Planning half of the dev-workflow family: discovers the repository context, dynamically ' +
      'decomposes the goal into self-sufficient implementation tasks, adversarially critiques each ' +
      'task claim against the actual code, and synthesizes a validated PlanArtifact (tasks with ' +
      'ids, contracts, test plans, done criteria, and a cycle-checked dependency graph) for human review.',
    whenToUse:
      'Use to plan a feature or fix before implementation. The human reviews/edits the PlanArtifact, ' +
      'then passes the approved artifact to dev-implement.',
    phases: [
      { title: 'Discover', detail: 'Parallel per-area exploration, consolidated project context' },
      { title: 'Plan', detail: 'Dynamic decomposition into self-sufficient candidate tasks' },
      { title: 'Critique', detail: 'Adversarially verify task claims against the actual code' },
      { title: 'Synthesize', detail: 'Final PlanArtifact + deterministic graph validation in code' },
    ],
  },
  parseInput,
  run,
})
