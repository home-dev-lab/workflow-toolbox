// monorepo-refactor-execute.workflow.ts — Execution half of an L3 human-in-the-loop pair.
//
// PEDAGOGY: L3 Human-in-the-Loop split — the EXECUTION side.
//
// This workflow receives the APPROVED plan artifact from monorepo-refactor-plan
// after human review. The L3 boundary re-validates on entry — never trust
// hand-edited artifacts blindly. The human may have pruned or edited steps,
// which is the POINT of the checkpoint. Re-validation catches malformed edits
// before any mutating agents are spawned.
//
// Architecture notes:
//   Phases 'Execute'+'Check' — rt.pipeline(steps, executeStage, checkStage).
//
//   WHY rt.pipeline (not planAndExecute):
//     The steps are KNOWN up front (from the approved plan artifact).
//     planAndExecute performs DYNAMIC decomposition — it spawns a planner agent
//     to generate subtasks. When subtasks are already known, planAndExecute is
//     the WRONG tool: it adds a redundant agent call and non-determinism.
//     Arch L1 table: "Subtasks are known — use the cheaper, more predictable form."
//     rt.pipeline processes known items through staged transforms directly.
//
//   executeStage — isolation: 'worktree' per step.
//     WHY worktree isolation: these are PARALLEL MUTATING agents. Each executor
//     writes to the working tree; without isolation, concurrent mutations would
//     corrupt each other's changes. Worktree isolation spins up a separate
//     working tree per agent (~setup cost per agent) so each executor operates
//     safely in its own branch. This is expensive and is ONLY used for parallel
//     mutation (arch §8 Risk). Do not use worktree isolation for read-only agents.
//
//   checkStage — fresh-evidence checker per step (defence layer 2).
//     WHY a separate checker: agents die mid-reasoning and misreport completion.
//     The executor's self-report (done: true) cannot be trusted. The checker is
//     a SEPARATE agent that reads the actual diff and runs tests — it re-derives
//     from the working tree, not from the executor's word.
//     NEVER trust the executor's self-report (defence layer 2).
//
//   Phase 'Report' — deterministic tallying IN CODE (no agent).
//     Deterministic counting is a code responsibility, not a model responsibility.
//     Spawning an agent to count succeeded/failed/dropped would be: slower,
//     non-deterministic, and a waste of budget. Count in code.
//
// RESUME HINT:
//   If any steps fail or drop, the report includes a resume hint. Relaunch
//   with resumeFromRunId after fixing the root cause — completed steps replay
//   from cache and only failed/dropped steps re-run.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
// warn() is envelope infrastructure (record + live rt.log), not a pattern —
// using it does not change this example's deliberate L0-only composition.
import { warn } from '@workflow-toolbox/patterns'
import { BEST_MODEL } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { resolveEffort, resolveVerifierEffort } from '@workflow-toolbox/std'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Per-stage effort defaults (Class B/C launch-time tuning — see parseConfig).
// A launch-time `args.effort.<role>` override (parsed into `input.effort`) can
// retune any of these without a source edit, via resolveEffort. 'check' is
// clamped to a 'high' FLOOR (resolveVerifierEffort) — an override may only
// RAISE it, mirroring the BEST_MODEL model-floor guardrail already pinned at
// its call site.
// ---------------------------------------------------------------------------
const EXECUTE_EFFORT: EffortAlias = 'high'         // Execute: per-step mutating executor
const CHECK_EFFORT_DEFAULT: EffortAlias = 'high'   // Check: fresh-evidence checker (floor 'high')

// ---------------------------------------------------------------------------
// Input contract — the approved plan artifact from monorepo-refactor-plan
// ---------------------------------------------------------------------------

interface PlanStep {
  order: number
  file: string
  action: string
  rationale: string
}

interface ApprovedPlan {
  planTitle: string
  steps: PlanStep[]
}

export interface MonorepoRefactorExecuteInput {
  goal: string
  plan: ApprovedPlan
  /** Model for the per-step EXECUTOR (mutating) agent. Default 'sonnet' — the
   *  executor is the high-volume execution stage (one per plan step, run in
   *  parallel); the fresh-evidence checker (defence layer 2) is pinned to
   *  BEST_MODEL regardless. Mirrors dev-implement's implementerModel and
   *  dev-review-fix's fixerModel. NOTE: this executor MUTATES the tree under
   *  worktree isolation, and the default extrapolates the dev-implement A/B
   *  (measured on a non-worktree implementer) — for a complex refactor, prefer
   *  overriding to 'opus'/BEST_MODEL, or 'inherit' to track the session model.
   *  The single-pass execute→check (no retry loop) plus the human checkpoint
   *  before these mutations land bound the downside. */
  executeModel: ModelAlias
  /** Optional per-ROLE reasoning-effort overrides (Class B/C, parsed by the
   *  shared `parseConfig` helper from `args.effort`), e.g.
   *  `args: { goal, plan, effort: { execute: 'xhigh' } }`. Role keys: 'execute',
   *  'check'. A role's value may also be the literal 'auto' (keep THIS role's
   *  own committed default). null = no overrides. Resolved per-stage via
   *  resolveEffort; 'check' is additionally clamped to a 'high' floor via
   *  resolveVerifierEffort. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Schema for executor output (executeStage)
const EXECUTE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['done', 'filesTouched', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ExecuteResult = FromSchema<typeof EXECUTE_RESULT_SCHEMA>

// Schema for checker output (checkStage)
const CHECK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verified: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['verified', 'evidence'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CheckResult = FromSchema<typeof CHECK_RESULT_SCHEMA>

// ---------------------------------------------------------------------------
// Per-step result tracked through the pipeline
// ---------------------------------------------------------------------------

interface StepPipelineData {
  step: PlanStep
  executeResult: ExecuteResult | null
  checkResult: CheckResult | null
}

// ---------------------------------------------------------------------------
// Final report step entry
// ---------------------------------------------------------------------------

interface ReportStep {
  order: number
  file: string
  action: string
  executed: boolean
  verified: boolean
  note?: string
  evidence?: string
}

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

interface MonorepoRefactorExecuteOutput {
  goal: string
  planTitle: string
  steps: ReportStep[]
  succeeded: number
  failed: number
  dropped: number
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable error messages.
//
// PEDAGOGY: The L3 boundary ALWAYS re-validates. The human may have pruned,
// reordered, or edited steps — that is the point of the checkpoint. Re-validation
// catches malformed edits before any mutating agents are spawned, not after.
// Never trust hand-edited artifacts blindly.
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): MonorepoRefactorExecuteInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'monorepo-refactor-execute: input must be an object — ' +
      'received: ' + (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw),
    )
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj['goal'] !== 'string' || obj['goal'].trim().length === 0) {
    throw new Error(
      'monorepo-refactor-execute: "goal" must be a non-empty string — ' +
      'provide the refactoring goal from the approved plan artifact',
    )
  }

  if (obj['plan'] === null || typeof obj['plan'] !== 'object' || Array.isArray(obj['plan'])) {
    throw new Error(
      'monorepo-refactor-execute: "plan" must be an object — ' +
      'provide the approved plan artifact from monorepo-refactor-plan',
    )
  }

  const plan = obj['plan'] as Record<string, unknown>

  if (typeof plan['planTitle'] !== 'string' || plan['planTitle'].trim().length === 0) {
    throw new Error(
      'monorepo-refactor-execute: "plan.planTitle" must be a non-empty string — ' +
      'the approved plan artifact must include a planTitle',
    )
  }

  if (!Array.isArray(plan['steps']) || plan['steps'].length === 0) {
    throw new Error(
      'monorepo-refactor-execute: "plan.steps" must be a non-empty array — ' +
      'provide at least one step in the approved plan (if all steps were pruned, ' +
      'there is nothing to execute)',
    )
  }

  const steps = plan['steps'] as unknown[]
  const parsedSteps: PlanStep[] = []

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(
        `monorepo-refactor-execute: "plan.steps[${i}]" must be an object — ` +
        `each step must have order, file, action, and rationale`,
      )
    }
    const step = s as Record<string, unknown>

    if (typeof step['order'] !== 'number') {
      throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].order" must be a number`)
    }
    if (typeof step['file'] !== 'string' || step['file'].trim().length === 0) {
      throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].file" must be a non-empty string`)
    }
    if (typeof step['action'] !== 'string' || step['action'].trim().length === 0) {
      throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].action" must be a non-empty string`)
    }
    if (typeof step['rationale'] !== 'string') {
      throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].rationale" must be a string`)
    }

    parsedSteps.push({
      order: step['order'],
      file: step['file'],
      action: step['action'],
      rationale: step['rationale'],
    })
  }

  // The executor (mutating) model tier. Default 'sonnet'; the checker stays
  // BEST_MODEL (set at the call site). ModelAlias is an open string union, so
  // any non-empty string is a valid alias; only empty/non-string is rejected.
  let executeModel: ModelAlias = 'sonnet'
  if (obj['executeModel'] !== undefined) {
    if (typeof obj['executeModel'] !== 'string' || obj['executeModel'].trim().length === 0) {
      throw new Error(
        'monorepo-refactor-execute: "executeModel" must be a non-empty model alias ' +
        '(e.g. "sonnet", "opus", "haiku", "inherit") — omit for the default "sonnet"',
      )
    }
    executeModel = obj['executeModel']
  }

  // Optional Class B/C per-role effort overrides, validated by the shared
  // parseConfig helper. It reads only the recognized `effort` slice and
  // IGNORES this workflow's bespoke goal/plan/executeModel keys.
  const effort = parseConfig(obj).effort ?? null

  return {
    goal: obj['goal'],
    plan: {
      planTitle: plan['planTitle'],
      steps: parsedSteps,
    },
    executeModel,
    effort,
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: MonorepoRefactorExecuteInput): Promise<MonorepoRefactorExecuteOutput> {
  const warnings: string[] = []

  // Resolve each stage's effort ONCE: a launch-time `args.effort.<role>`
  // override wins when valid, else the stage-class default declared above.
  // 'check' is additionally floored at 'high' — see resolveVerifierEffort.
  const executeEffort = resolveEffort(input.effort?.['execute'], EXECUTE_EFFORT)
  const checkEffort = resolveVerifierEffort(input.effort?.['check'], CHECK_EFFORT_DEFAULT)

  // -------------------------------------------------------------------------
  // Phases 'Execute' + 'Check' — rt.pipeline(steps, executeStage, checkStage)
  //
  // WHY rt.pipeline (not planAndExecute): steps are KNOWN up front from the
  // approved plan. planAndExecute is for DYNAMIC decomposition (the planner
  // generates subtasks). When subtasks are known, use rt.pipeline directly —
  // it is cheaper and deterministic (no planner agent spawned).
  //
  // executeStage — MUTATING agent, isolation: 'worktree'.
  //   Parallel MUTATING agents require worktree isolation: each executor writes
  //   to the working tree and must not corrupt another's concurrent changes.
  //   Worktree isolation is expensive (~setup per agent); use ONLY for parallel
  //   mutation (arch §8 Risk). Read-only agents do not need it.
  //
  // checkStage — fresh-evidence checker (defence layer 2).
  //   The checker re-derives from the actual working tree: reads the diff,
  //   runs the relevant tests. It does NOT trust the executor's self-report.
  //   Why: agents die mid-reasoning and misreport completion (done: true but
  //   no actual change made). The checker is the independent safety net.
  // -------------------------------------------------------------------------

  rt.phase('Execute')
  rt.phase('Check')

  const executeStage = async (
    _prev: unknown,
    originalItem: unknown,
  ): Promise<StepPipelineData> => {
    const step = originalItem as PlanStep

    // Mutating agent: applies the change in an isolated worktree.
    // isolation: 'worktree' — parallel mutation requires isolated working trees.
    const execResult = await rt.agent<ExecuteResult>(
      `Apply the change described below to the monorepo.\n` +
      `Goal: ${input.goal}\n` +
      `Step ${step.order}: ${step.action} in ${step.file}\n` +
      `Rationale: ${step.rationale}\n` +
      `Make the change. Report what you did.\n` +
      `Return { "done": true|false, "filesTouched": ["<path>", ...], "note": "<what was done or why it failed>" }`,
      {
        schema: EXECUTE_RESULT_SCHEMA,
        label: `monorepo-refactor-execute:execute:${step.order}`,
        phase: 'Execute',
        // High-volume mutating execution stage — tiered by the executeModel
        // knob (default 'sonnet'). The checker below is pinned to BEST_MODEL.
        model: input.executeModel,
        effort: executeEffort,
        // Required for parallel mutating agents (arch §8 Risk): each executor
        // gets its own isolated working tree, so concurrent mutations cannot
        // corrupt each other. Worktrees are expensive (per-agent setup) — use
        // ONLY for parallel mutation, never for read-only analysis.
        isolation: 'worktree',
      },
    )

    return { step, executeResult: execResult, checkResult: null }
  }

  const checkStage = async (prev: unknown): Promise<StepPipelineData> => {
    const data = prev as StepPipelineData

    // If the executor returned null (agent died), skip the checker.
    // The step will be counted as dropped in the Report phase.
    if (data.executeResult === null) {
      return data
    }

    // Fresh-evidence checker: reads the actual diff and runs tests.
    // NEVER trust the executor's self-report — agents misreport completion.
    // The checker re-derives from the working tree (defence layer 2).
    const checkResult = await rt.agent<CheckResult>(
      `Verify the change exists in the working tree for this step.\n` +
      `Goal: ${input.goal}\n` +
      `Step ${data.step.order}: ${data.step.action} in ${data.step.file}\n` +
      `Executor self-report: ${JSON.stringify(data.executeResult)}\n\n` +
      `IMPORTANT: Do NOT trust the executor self-report above. Read the actual diff ` +
      `for ${data.step.file} and run the relevant tests. Re-derive from first principles ` +
      `whether the change was actually applied correctly.\n` +
      `Inspect the diff via READ-ONLY git only — \`git show <sha>:<path>\`, \`git diff <range>\`, \`git log\` — ` +
      `NEVER \`git checkout\` / \`git reset\` / \`git restore\` / \`git clean\` (they mutate the shared working tree and will be denied).\n` +
      `Return { "verified": true|false, "evidence": "<what you found in the diff/tests>" }`,
      {
        schema: CHECK_RESULT_SCHEMA,
        label: `monorepo-refactor-execute:check:${data.step.order}`,
        phase: 'Check',
        // The fresh-evidence checker is the independent safety net — pinned to
        // the strongest tier explicitly (NOT merely inherit), so the verifier
        // stays strong independent of the session model precisely because the
        // executor above may be tiered down.
        model: BEST_MODEL,
        effort: checkEffort,
      },
    )

    return { ...data, checkResult }
  }

  const pipelineResults = await rt.pipeline(
    input.plan.steps as readonly unknown[],
    executeStage,
    checkStage,
  )

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic tallying IN CODE (no agent).
  //
  // Deterministic counting is a code responsibility, not a model responsibility.
  // Spawning an agent to tally results would be: non-deterministic, slower,
  // and adds an unnecessary failure point. Count in code.
  //
  // Terminology:
  //   succeeded = executed (done: true) AND verified (verified: true)
  //   failed    = executed (done: true) BUT checker refuted (verified: false)
  //              OR executor self-reported done: false
  //   dropped   = executor returned null (agent died mid-reasoning)
  // -------------------------------------------------------------------------

  rt.phase('Report')

  const reportSteps: ReportStep[] = []
  let succeeded = 0
  let failed = 0
  let dropped = 0

  for (const raw of pipelineResults) {
    if (raw === null) {
      // The pipeline dropped this item entirely (both stages failed/threw).
      // We cannot recover the step data, so we count it as dropped with a warning.
      dropped++
      warn(
        rt,
        warnings,
        'monorepo-refactor-execute: a pipeline item was dropped entirely — ' +
        'use resumeFromRunId to retry after fixing the root cause',
      )
      continue
    }

    const data = raw as StepPipelineData

    if (data.executeResult === null) {
      // Executor returned null — agent died before producing output.
      dropped++
      reportSteps.push({
        order: data.step.order,
        file: data.step.file,
        action: data.step.action,
        executed: false,
        verified: false,
        note: 'Executor agent returned null — relaunch with resumeFromRunId after fixing root cause',
      })
      continue
    }

    const executed = data.executeResult.done
    const verified = data.checkResult?.verified ?? false
    const note = data.executeResult.note
    const evidence = data.checkResult?.evidence

    const reportStep: ReportStep = {
      order: data.step.order,
      file: data.step.file,
      action: data.step.action,
      executed,
      verified,
      ...(note !== undefined ? { note } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    }

    reportSteps.push(reportStep)

    if (executed && verified) {
      succeeded++
    } else {
      failed++
    }
  }

  if (failed > 0 || dropped > 0) {
    warn(
      rt,
      warnings,
      `monorepo-refactor-execute: ${failed} step(s) failed, ${dropped} step(s) dropped — ` +
      `fix the root cause and relaunch with resumeFromRunId; completed steps replay from cache`,
    )
  }

  return {
    goal: input.goal,
    planTitle: input.plan.planTitle,
    steps: reportSteps,
    succeeded,
    failed,
    dropped,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'monorepo-refactor-execute',
    description:
      'Execution half of an L3 HITL pair: takes the human-approved plan artifact from ' +
      'monorepo-refactor-plan, executes each step in an isolated worktree, independently ' +
      'verifies each change with a fresh-evidence checker, and produces a deterministic report.',
    whenToUse:
      'Use after a human has reviewed and approved the plan artifact from monorepo-refactor-plan. ' +
      'Pass the approved artifact (goal + plan with steps) as the workflow args.',
    phases: [
      { title: 'Execute', detail: 'Apply each plan step in an isolated worktree (parallel mutation)' },
      { title: 'Check', detail: 'Independently verify each change with a fresh-evidence checker' },
      { title: 'Report', detail: 'Deterministic tally of succeeded/failed/dropped steps (in code, no agent)' },
    ],
  },
  parseInput,
  run,
})
