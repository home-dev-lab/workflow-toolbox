// monorepo-refactor-plan.workflow.ts — Planning half of an L3 human-in-the-loop pair.
//
// PEDAGOGY: L3 Human-in-the-Loop split (arch §5 L3, P8).
//
// This workflow is the PLANNING half of a two-workflow HITL pair:
//
//   monorepo-refactor-plan  →  [human review]  →  monorepo-refactor-execute
//
// There is NO mid-run human input in this workflow. It runs fully autonomously
// and ends by returning a plan artifact. The human then reviews that artifact
// (approving, pruning, or editing the proposed steps) and passes the approved
// version as args to monorepo-refactor-execute.
//
// WHY SPLIT INTO TWO WORKFLOWS (not one with a human pause):
//   The planning run can be long and analysis-intensive. By ending at an
//   artifact boundary the human gets a clean checkpoint: a readable, editable
//   JSON object rather than an opaque in-progress state. The approved artifact
//   is the explicit contract between planning and execution.
//
// BUDGET EXHAUSTION = CHECKPOINT, NOT LOSS:
//   If this workflow is interrupted before completing, DO NOT restart from
//   scratch. Relaunch with resumeFromRunId pointing at the interrupted run.
//   Every agent() call that already completed replays from cache — only the
//   missing work re-runs. This eliminates re-doing expensive analysis agents
//   and saves latency.
//
// Architecture notes:
//   Phase 'Map'       — classifyAndAct: inspect areas, classify problems, gather observations.
//   Phase 'Analyze'   — fanOutAndSynthesize: deep per-area analysis → consolidated brief.
//   Phase 'Plan'      — planAndExecute: dynamic decomposition → change proposals → draft plan text.
//   Phase 'Verify'    — adversarialVerification: refute weak proposals; exclude refuted ones.
//   Phase 'Synthesize'— final plan artifact agent from kept (non-refuted) changes.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import type { WorkflowRuntime, JsonSchema } from '@workflow-toolbox/runtime'
import {
  classifyAndAct,
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

export interface MonorepoRefactorPlanInput {
  goal: string
  areas: string[]
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Schema for a classified area's observation output (classifyAndAct act stage)
const OBSERVATION_SCHEMA = {
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
  },
  required: ['observations'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ObservationOutput = FromSchema<typeof OBSERVATION_SCHEMA>

// Schema for deep analysis of an area (fanOutAndSynthesize task output)
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          problem: { type: 'string' },
          impact: { type: 'string' },
        },
        required: ['file', 'problem', 'impact'],
        additionalProperties: false,
      },
    },
  },
  required: ['problems'],
  additionalProperties: false,
} as const satisfies JsonSchema

type AnalysisOutput = FromSchema<typeof ANALYSIS_SCHEMA>

// Schema for the consolidated analysis brief (fanOutAndSynthesize synthesis)
const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string' },
    hotspots: { type: 'array', items: { type: 'string' } },
  },
  required: ['brief', 'hotspots'],
  additionalProperties: false,
} as const satisfies JsonSchema

type BriefOutput = FromSchema<typeof BRIEF_SCHEMA>

// Schema for a worker's change proposals (planAndExecute worker output)
const CHANGES_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          action: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['file', 'action', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ChangesOutput = FromSchema<typeof CHANGES_SCHEMA>

// Type alias for a single change proposal
type ChangeProposal = ChangesOutput['changes'][number]

// Schema for the final plan artifact (Synthesize phase)
const PLAN_ARTIFACT_SCHEMA = {
  type: 'object',
  properties: {
    planTitle: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          order: { type: 'number' },
          file: { type: 'string' },
          action: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['order', 'file', 'action', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['planTitle', 'steps'],
  additionalProperties: false,
} as const satisfies JsonSchema

type PlanArtifact = FromSchema<typeof PLAN_ARTIFACT_SCHEMA>

// ---------------------------------------------------------------------------
// Final workflow output (the L3 artifact passed to monorepo-refactor-execute)
// ---------------------------------------------------------------------------

interface RejectedChange {
  file: string
  action: string
  rationale: string
  verdict: string
}

interface MonorepoRefactorPlanOutput {
  goal: string
  plan: PlanArtifact
  rejected: readonly RejectedChange[]
  /** Per-phase pattern envelope stats — kept typed so callers can calibrate
   *  budgets from real runs (arch §8: budgetFloor calibration). */
  stats: Record<string, PatternStats>
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable error messages
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): MonorepoRefactorPlanInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'monorepo-refactor-plan: input must be an object with "goal" (string) and "areas" (string[]) — ' +
      'received: ' + (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw),
    )
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj['goal'] !== 'string' || obj['goal'].trim().length === 0) {
    throw new Error(
      'monorepo-refactor-plan: "goal" must be a non-empty string — ' +
      'describe the refactoring objective (e.g. "Reduce duplication across packages")',
    )
  }

  if (!Array.isArray(obj['areas']) || obj['areas'].length === 0) {
    throw new Error(
      'monorepo-refactor-plan: "areas" must be a non-empty array of strings — ' +
      'provide at least one monorepo package or directory to inspect (e.g. ["packages/core", "packages/ui"])',
    )
  }

  for (let i = 0; i < obj['areas'].length; i++) {
    const area = obj['areas'][i]
    if (typeof area !== 'string' || area.trim().length === 0) {
      throw new Error(
        `monorepo-refactor-plan: "areas[${i}]" must be a non-empty string — ` +
        `each element must be a monorepo package or directory path`,
      )
    }
  }

  return {
    goal: obj['goal'],
    areas: obj['areas'] as string[],
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: MonorepoRefactorPlanInput): Promise<MonorepoRefactorPlanOutput> {
  const warnings: string[] = []
  const stats: Record<string, PatternStats> = {}

  // -------------------------------------------------------------------------
  // Phase 'Map' — classifyAndAct
  //
  // Pattern: classifyAndAct (routing pattern).
  // Why: areas can have different problem profiles. The classifier inspects
  // each area against the goal and routes it to a focused observation agent
  // per problem category. Decomposed scopes keep each agent's context small —
  // broad context causes model laziness and missed findings.
  //
  // 'healthy' action returns empty observations cheaply (model 'haiku') —
  // mechanical leaf work needs no expensive model.
  //
  // Schema enforced: { observations: [{file, detail}] }
  // -------------------------------------------------------------------------

  rt.phase('Map')

  const mapResult = await classifyAndAct<string, ObservationOutput>(rt, {
    items: input.areas,
    categories: ['dead-code', 'duplication', 'api-drift', 'structure', 'healthy'],
    classifyPrompt: (area) =>
      `Inspect this monorepo area against the refactoring goal and classify it into exactly one category: ` +
      `dead-code, duplication, api-drift, structure, or healthy.\n` +
      `Goal: ${input.goal}\n` +
      `Area: ${area}\n` +
      `Return { "category": "<one of the five categories>" }`,
    actions: {
      'dead-code': {
        schema: OBSERVATION_SCHEMA,
        prompt: (area) =>
          `You are making a focused observation on DEAD-CODE in this monorepo area.\n` +
          `Goal: ${input.goal}\n` +
          `Area: ${area}\n` +
          `Inspect the area and report files containing dead or unreachable code.\n` +
          `Return { "observations": [{ "file": "<path>", "detail": "<what makes it dead code>" }] }`,
      },
      'duplication': {
        schema: OBSERVATION_SCHEMA,
        prompt: (area) =>
          `You are making a focused observation on DUPLICATION in this monorepo area.\n` +
          `Goal: ${input.goal}\n` +
          `Area: ${area}\n` +
          `Inspect the area and report files with duplicated logic or copy-paste code.\n` +
          `Return { "observations": [{ "file": "<path>", "detail": "<what is duplicated and where>" }] }`,
      },
      'api-drift': {
        schema: OBSERVATION_SCHEMA,
        prompt: (area) =>
          `You are making a focused observation on API-DRIFT in this monorepo area.\n` +
          `Goal: ${input.goal}\n` +
          `Area: ${area}\n` +
          `Inspect the area and report files where API contracts have diverged across packages.\n` +
          `Return { "observations": [{ "file": "<path>", "detail": "<the drift and its effect>" }] }`,
      },
      'structure': {
        schema: OBSERVATION_SCHEMA,
        prompt: (area) =>
          `You are making a focused observation on STRUCTURE problems in this monorepo area.\n` +
          `Goal: ${input.goal}\n` +
          `Area: ${area}\n` +
          `Inspect the area and report files with structural issues (wrong location, bad boundaries, etc.).\n` +
          `Return { "observations": [{ "file": "<path>", "detail": "<the structural problem>" }] }`,
      },
      'healthy': {
        schema: OBSERVATION_SCHEMA,
        // 'haiku' for mechanical healthy-area check — no deep analysis needed
        model: 'haiku',
        prompt: (area) =>
          `This monorepo area appears healthy relative to the goal.\n` +
          `Goal: ${input.goal}\n` +
          `Area: ${area}\n` +
          `Confirm it is healthy and return an empty observations list.\n` +
          `Return { "observations": [] }`,
      },
    },
    phase: 'Map',
  })

  for (const w of mapResult.warnings) warnings.push(w)
  stats['map'] = mapResult.stats

  // Build classified areas with their observations for Phase 'Analyze'
  type ClassifiedArea = {
    area: string
    category: string
    observations: ObservationOutput['observations']
  }

  const classifiedAreas: ClassifiedArea[] = mapResult.value.map(item => ({
    area: item.item,
    category: item.category,
    observations: item.result.observations,
  }))

  // -------------------------------------------------------------------------
  // Phase 'Analyze' — fanOutAndSynthesize
  //
  // Pattern: fanOutAndSynthesize (parallelization + synthesis barrier).
  // Why: each classified area with its observations feeds a deep analysis agent.
  // The synthesis barrier is justified: the brief genuinely needs ALL per-area
  // analyses before it can consolidate hotspots and write a coherent summary.
  // Data crosses agent boundaries as JSON.stringify (prompt text — the only
  // safe transport between agent invocations).
  //
  // Schema enforced: task → { problems: [{file, problem, impact}] }
  //                  synthesis → { brief: string, hotspots: string[] }
  // -------------------------------------------------------------------------

  rt.phase('Analyze')

  // If Map produced nothing (every classify/act agent dropped), fall back to
  // analyzing the RAW input areas without observations — and SAY SO. A total
  // Map failure must never be silently masked by a fabricated task.
  let analysisTasks: readonly ClassifiedArea[] = classifiedAreas
  if (classifiedAreas.length === 0) {
    // warn() (envelope helper) both records AND rt.log()s — composition-level
    // degradation stays visible live in /workflows, not just in the result.
    warn(
      rt,
      warnings,
      'Map phase produced no classified areas (all classification agents dropped) — ' +
        'analyzing raw input areas without observations',
    )
    analysisTasks = input.areas.map((area) => ({ area, category: 'unmapped', observations: [] }))
  }

  const analyzeResult = await fanOutAndSynthesize<ClassifiedArea, AnalysisOutput, BriefOutput>(rt, {
    tasks: analysisTasks,
    taskPrompt: (task) =>
      `Perform a deep analysis of this monorepo area.\n` +
      `Goal: ${input.goal}\n` +
      `Area: ${task.area}\n` +
      `Category: ${task.category}\n` +
      `Observations: ${JSON.stringify(task.observations)}\n` +
      `Re-derive from the actual code — do NOT trust the observations above blindly.\n` +
      `Return { "problems": [{ "file": "<path>", "problem": "<what is wrong>", "impact": "<high|medium|low>" }] }`,
    taskSchema: ANALYSIS_SCHEMA,
    synthesisPrompt: (parts) =>
      `Consolidate into a single analysis brief from these per-area deep analyses.\n` +
      `Goal: ${input.goal}\n` +
      `Analyses: ${JSON.stringify(parts)}\n` +
      `Return { "brief": "<consolidated summary of key problems>", "hotspots": ["<file1>", ...] }`,
    synthesisSchema: BRIEF_SCHEMA,
    phase: 'Analyze',
  })

  for (const w of analyzeResult.warnings) warnings.push(w)
  stats['analyze'] = analyzeResult.stats

  const brief: BriefOutput = analyzeResult.value ?? { brief: 'No analysis available', hotspots: [] }

  // -------------------------------------------------------------------------
  // Phase 'Plan' — planAndExecute
  //
  // Pattern: planAndExecute (orchestrator-workers with dynamic decomposition).
  // Why planAndExecute (not fanOutAndSynthesize): the planner dynamically
  // decomposes the refactoring goal into independent change proposals. The
  // number of proposals is NOT known up front — that is the planner's job.
  // CONTRAST with monorepo-refactor-execute, which uses plain rt.pipeline:
  // there the steps are already known (the approved plan), so dynamic
  // decomposition would be the wrong tool. Unknown subtasks → planAndExecute;
  // known subtasks → pipeline over the list.
  // Workers detail each proposal; synthesis produces draft plan text (free
  // text, no schema — it will be passed whole into the Synthesize prompt).
  //
  // Worker results are captured via the synthesisPrompt closure so they are
  // available for adversarial verification in Phase 'Verify'.
  //
  // Cap maxSubtasks: 8 to prevent runaway decompositions.
  // -------------------------------------------------------------------------

  rt.phase('Plan')

  const planResult = await planAndExecute<ChangesOutput, string>(rt, {
    planPrompt:
      `Decompose into independent change proposals for this monorepo refactoring.\n` +
      `Goal: ${input.goal}\n` +
      `Analysis brief: ${brief.brief}\n` +
      `Hotspots: ${brief.hotspots.join(', ')}\n` +
      `Produce a list of independent, parallel-safe change proposals.\n` +
      `Each subtask description should identify ONE file and ONE concrete action.\n` +
      `Return { "subtasks": [{ "description": "<proposal description>" }] }`,
    workerPrompt: (subtask) =>
      `Detail the change proposal: ${subtask.description}\n` +
      `Goal: ${input.goal}\n` +
      `Expand this into concrete file changes with rationale.\n` +
      `Return { "changes": [{ "file": "<path>", "action": "<what to do>", "rationale": "<why>" }] }`,
    workerSchema: CHANGES_SCHEMA,
    synthesisPrompt: (results) =>
      `Compose a draft refactoring plan from these detailed change proposals.\n` +
      `Goal: ${input.goal}\n` +
      `Change proposals: ${JSON.stringify(results)}\n` +
      `Produce a coherent draft plan narrative (plain text) that will feed the final plan synthesis.`,
    maxSubtasks: 8,
    phase: 'Plan',
  })

  for (const w of planResult.warnings) warnings.push(w)
  stats['plan'] = planResult.stats

  // -------------------------------------------------------------------------
  // Phase 'Verify' — adversarialVerification
  //
  // Why: proposals are agent-generated and may be hallucinated or impractical.
  // renderClaim embeds an explicit instruction to RE-DERIVE from the actual
  // code — never trust the proposal's rationale (fresh-evidence checker).
  // Refuted changes are EXCLUDED from the final plan but REPORTED in rejected.
  // Cap maxVerifyClaims: 10 to bound verification work for large plans.
  // -------------------------------------------------------------------------

  rt.phase('Verify')

  let verifiedChanges: Array<VerifiedClaim<ChangeProposal>> = []
  const rejectedChanges: RejectedChange[] = []

  const workerChanges: ChangeProposal[] = planResult.workerResults.flatMap((r) => r.changes)

  if (workerChanges.length > 0) {
    const verifyResult = await adversarialVerification<ChangeProposal>(rt, {
      claims: workerChanges,
      renderClaim: (change) =>
        `Change proposal: "${change.action}" in ${change.file}\n` +
        `Rationale: ${change.rationale}\n\n` +
        `IMPORTANT: Do NOT trust the rationale above. Open the actual file at ${change.file} ` +
        `and re-derive from the code whether this change is necessary and correct.`,
      maxVerifyClaims: 10,
      phase: 'Verify',
    })

    for (const w of verifyResult.warnings) warnings.push(w)
    stats['verify'] = verifyResult.stats
    verifiedChanges = verifyResult.value
  } else {
    warn(rt, warnings, 'Plan phase produced no change proposals — Verify phase skipped')
  }

  // Separate kept (non-refuted) from rejected (refuted)
  const keptChanges: ChangeProposal[] = []
  for (const vc of verifiedChanges) {
    if (vc.verdict === 'refuted') {
      rejectedChanges.push({
        file: vc.claim.file,
        action: vc.claim.action,
        rationale: vc.claim.rationale,
        verdict: vc.verdict,
      })
    } else {
      keptChanges.push(vc.claim)
    }
  }

  // -------------------------------------------------------------------------
  // Phase 'Synthesize' — final plan artifact
  //
  // Barrier: synthesis needs ALL kept changes to produce the ordered plan.
  // rt.phase() records the barrier explicitly.
  //
  // Schema enforced: { planTitle: string, steps: [{order, file, action, rationale}] }
  // Data crosses agent boundary as JSON.stringify of keptChanges (prompt text).
  // -------------------------------------------------------------------------

  rt.phase('Synthesize')

  const synthesizePrompt =
    `Produce the final plan artifact from these verified change proposals.\n` +
    `Goal: ${input.goal}\n` +
    `Kept changes (non-refuted): ${JSON.stringify(keptChanges)}\n` +
    `Produce a structured plan with a title and ordered steps.\n` +
    `Return { "planTitle": "<descriptive title>", "steps": [{ "order": <n>, "file": "<path>", "action": "<what>", "rationale": "<why>" }] }`

  const planArtifactAgent = await rt.agent<PlanArtifact>(synthesizePrompt, {
    schema: PLAN_ARTIFACT_SCHEMA,
    label: 'monorepo-refactor-plan:synthesize',
    phase: 'Synthesize',
  })

  if (planArtifactAgent === null) {
    throw new Error(
      'monorepo-refactor-plan: final plan synthesis failed — unable to produce a plan artifact. ' +
      'Use resumeFromRunId to retry from the Synthesize phase (all prior work is cached).',
    )
  }

  return {
    goal: input.goal,
    plan: planArtifactAgent,
    rejected: rejectedChanges,
    stats,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'monorepo-refactor-plan',
    description:
      'Planning half of an L3 HITL pair: inspects monorepo areas, classifies problems, ' +
      'produces a deep analysis brief, decomposes into change proposals, adversarially verifies them, ' +
      'and synthesizes a structured plan artifact for human review.',
    whenToUse:
      'Use when you need a structured, adversarially-verified refactoring plan for a monorepo. ' +
      'The human reviews the output artifact and passes the approved plan to monorepo-refactor-execute.',
    phases: [
      { title: 'Map', detail: 'Classify and observe problem areas in the monorepo' },
      { title: 'Analyze', detail: 'Deep per-area analysis and consolidated brief' },
      { title: 'Plan', detail: 'Dynamic decomposition into independent change proposals' },
      { title: 'Verify', detail: 'Adversarially verify change proposals (fresh-evidence check)' },
      { title: 'Synthesize', detail: 'Produce the final structured plan artifact' },
    ],
  },
  parseInput,
  run,
})
