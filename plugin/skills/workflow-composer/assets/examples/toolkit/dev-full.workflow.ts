// dev-full.workflow.ts — Full mode of the dev-workflow family (v2).
//
// PEDAGOGY: the dev-workflow family, full mode
//
//   dev-full ──▶ dev-plan ──[code gate A]──▶ dev-implement ──[code gate B]──▶ dev-review-fix
//
// One orchestrator run chains the three split workflows via workflow()
// composition over their COMMITTED artifacts ({scriptPath} refs), converting
// the family's human gates into CODE gates. The children stay independently
// runnable; each re-validates its input in its own parseInput — that existing
// L3 boundary IS the gate, dev-full only adds the in-code transforms the
// human used to perform by hand.
//
// Architecture notes:
//   Phase 'Plan' — runs the dev-plan child. Gate A (code): abort when the
//     child rejects, when its return shape cannot be narrowed, when the
//     Discover phase degraded to an empty testCommand/conventions (dev-plan
//     only WARNS about that, but both downstream children would reject the
//     artifact on entry — failing here gives the operator the precise cause),
//     or when the refuted-task ratio exceeds maxRefutedRatio (the rejected
//     list carries the refuting REASONS — the operator arbitrates from them).
//   Phase 'Implement' — runs the dev-implement child on the artifact.
//     Gate B (code): abort when the child rejects or when ZERO tasks
//     succeeded; otherwise continue — dev-review-fix reviews what succeeded
//     and can even repair what a failed task left behind.
//   Phase 'Review & Fix' — derives the dev-review-fix input IN CODE:
//     commands VERBATIM from artifact.context; changedFiles from the PLANNED
//     files of succeeded AND failed tasks (failed tasks still mutated the
//     tree — excluding them would leave the riskiest mutations unreviewed);
//     skipped tasks never ran, their files are excluded. An operator-provided
//     diffCommand WINS over this derivation: the real diff also catches files
//     the implementer created beyond the plan, which the derivation cannot.
//   Phase 'Report' — deterministic assembly IN CODE (no agent): outcome,
//     per-child sections, prefixed child warnings, child stats passthrough.
//
// THE ABORT CONTRACT: dev-full NEVER throws after the first child call —
//   every gate failure RETURNS {outcome: 'aborted-at-*', reason, ...} with
//   every completed child's output preserved, so the operator can fall back
//   to the split workflows with real arbitration material. parseInput is the
//   only throwing surface (fail-fast, before any child).
//
// Do NOT (implementation bounds):
//   - re-validate the artifact graph here — dev-implement re-validates on
//     entry (its parseInput owns that contract);
//   - spawn agents or mutate the tree — dev-full orchestrates, children work;
//   - trust a child's return shape — workflow() returns unknown, narrow it;
//   - re-hardcode child defaults (dimensions, maxFixIterations, mutation,
//     maxIterationsPerTask) — unset passthroughs are OMITTED so the child's
//     own default stays canonical.
//
// TRUST BOUNDARY (accepted residual risk — extends dev-review-fix's):
//   Full mode has NO human gate anywhere between the goal and autonomous tree
//   mutations: the plan is machine-approved (Gate A), the change set is
//   machine-derived, and the fix phase mutates from agent-derived finding
//   text. Only point dev-full at goals and repositories the operator is
//   willing to let agents modify END-TO-END without review. For human-gated
//   steps, use the split workflows (dev-plan → human → dev-implement →
//   human → dev-review-fix) instead.
//
// RESUME HINT:
//   workflow() children share the parent run's journal and cache. After an
//   abort, fix the cause and either relaunch dev-full fresh (drift mitigation
//   = corrections appended to the goal) or fall back to the split workflow
//   for the failed step, feeding it the preserved section from this output.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { emitDigest, relativizeUnder, warn } from '@workflow-toolbox/patterns'
import type { WorkflowRuntime, EffortAlias } from '@workflow-toolbox/runtime'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

interface ScriptPaths {
  /** Absolute path to the committed dev-plan artifact (.js). */
  plan: string
  /** Absolute path to the committed dev-implement artifact (.js). */
  implement: string
  /** Absolute path to the committed dev-review-fix artifact (.js). */
  reviewFix: string
}

export interface DevFullInput {
  /** The feature/fix to develop, including corrections from prior runs. */
  goal: string
  /** Repository areas dev-plan discovers. Defaults to ['.']. */
  areas: string[]
  /** Project root every child command runs from. */
  projectDir: string
  /** The three child artifacts. The sandbox has no filesystem, so existence
   *  cannot be pre-checked — an unreadable path surfaces as a caught child
   *  rejection at that gate. */
  scriptPaths: ScriptPaths
  /** Gate A: abort when rejected/(rejected+kept) exceeds this. Default 0.5. */
  maxRefutedRatio: number
  /** Passthroughs — null means OMIT the key and let the child default rule. */
  maxIterationsPerTask: number | null
  maxFixIterations: number | null
  dimensions: string[] | null
  /** Implementer (green) model tier for the dev-implement child. null = OMIT,
   *  so the child's default ('sonnet') rules. */
  implementerModel: string | null
  /** Optional specialist subagent type for the dev-implement implementer. null =
   *  OMIT, so the child's default (standard subagent) rules. Must exist in the
   *  consumer's session registry (the child's runtime throws on an unknown
   *  type). */
  implementerType: string | null
  /** Fixer model tier for the dev-review-fix child. null = OMIT, so the child's
   *  default ('sonnet') rules. */
  fixerModel: string | null
  /** Optional specialist subagent type for the dev-review-fix fixer. null = OMIT,
   *  so the child's default (standard subagent) rules. Must exist in the
   *  consumer's session registry (the child's runtime throws on an unknown
   *  type). */
  fixerType: string | null
  /** Optional specialist subagent type for the dev-review-fix dimension
   *  REVIEWERS. null = OMIT, so the child's default (standard subagent) rules.
   *  Must exist in the consumer's session registry (the child's runtime throws
   *  on an unknown type). A specialist reviewer is more thorough but noisier;
   *  the child's refute-first Verify stage filters the extra false positives. */
  reviewerType: string | null
  /** Optional subagent type to route the refute-first verifiers of BOTH the
   *  dev-plan Critique stage AND the dev-review-fix Verify stage through — e.g.
   *  'codex:codex-rescue' for a cross-model (GPT) verifier across the whole dev
   *  chain. Only the skeptics cross models; planners/reviewers/fixers stay on the
   *  session model. null = OMIT, so each child's same-model default rules. Must
   *  exist in the consumer's session registry (the child's runtime throws on an
   *  unknown type). */
  verifierType: string | null
  /** Optional VERBATIM diff command (git projects). When set it WINS over the
   *  planned-files derivation — the real diff also catches unplanned files. */
  diffCommand: string | null
  /** Optional per-ROLE reasoning-effort overrides (Class B/C), forwarded VERBATIM
   *  to ALL THREE children's `args.effort` — each child looks up only the role
   *  keys it recognizes (dev-plan: 'discoverTask'/'plan'/'critique'/…; dev-implement:
   *  'red'/'green'/'check'/…; dev-review-fix: 'review'/'verify'/'fix'/…) and ignores
   *  the rest, so one map can retune the whole chain without a source edit. A
   *  role's value may also be the literal 'auto' (keep that role's own
   *  committed default in whichever child owns it) — forwarded verbatim like
   *  any other value, since dev-full has no stages of its own to resolve it
   *  against. null = OMIT, so each child's own committed stage-class defaults
   *  rule (mirrors implementerModel/fixerModel/verifierType passthrough). */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
}

// ---------------------------------------------------------------------------
// Narrowed child shapes — SHALLOW, only the fields the gates read. Narrowing
// returns the ORIGINAL reference (full fidelity for the next child), it only
// proves the fields exist.
// ---------------------------------------------------------------------------

interface TaskFileLike {
  path: string
}

interface PlanTaskLike {
  id: string
  title: string
  files: TaskFileLike[]
}

interface PlanContextLike {
  projectDir: string
  testCommand: string
  buildCommand: string
  conventions: string
}

interface PlanArtifactLike {
  goal: string
  context: PlanContextLike
  tasks: PlanTaskLike[]
}

interface PlanResultLike {
  artifact: PlanArtifactLike
  rejected: readonly unknown[]
  stats: unknown
  warnings: readonly string[]
}

interface ReportTaskLike {
  id: string
  title: string
  status: string
}

interface ImplementResultLike {
  tasks: ReportTaskLike[]
  succeeded: number
  failed: number
  skipped: number
  stats: unknown
  warnings: readonly string[]
}

interface ReviewResultLike {
  value: Record<string, unknown>
  stats: unknown
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

type DevFullOutcome = 'completed' | 'aborted-at-plan' | 'aborted-at-implement' | 'aborted-at-review'

interface PlanSection {
  taskCount: number
  /** dev-plan's rejected tasks, reasons included — operator arbitration material. */
  rejected: readonly unknown[]
  /** The full PlanArtifact — the split-mode fallback input after an abort. */
  artifact: PlanArtifactLike
}

interface DevFullOutput {
  outcome: DevFullOutcome
  /** Why the chain aborted (null when completed). */
  reason: string | null
  plan: PlanSection | null
  implement: ImplementResultLike | null
  review: Record<string, unknown> | null
  /** Child envelope stats passthrough, keyed by chain step (calibration parity). */
  stats: { plan: unknown; implement: unknown; review: unknown }
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Narrowing helpers (self-contained, sibling parseInput style)
// ---------------------------------------------------------------------------

type Narrowed<T> = { ok: true; value: T } | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function stringsOrEmpty(v: unknown): readonly string[] {
  return isStringArray(v) ? v : []
}

function narrowPlanResult(value: unknown): Narrowed<PlanResultLike> {
  if (!isRecord(value)) {
    return { ok: false, reason: 'plan child returned an unexpected shape (not an object) — cannot read "artifact"' }
  }
  const artifact = value['artifact']
  if (!isRecord(artifact)) {
    return { ok: false, reason: 'plan child returned no "artifact" object — cannot hand off to dev-implement' }
  }
  if (typeof artifact['goal'] !== 'string') {
    return { ok: false, reason: 'plan child artifact has no string "goal"' }
  }
  const context = artifact['context']
  if (!isRecord(context)) {
    return { ok: false, reason: 'plan child artifact has no "context" object' }
  }
  for (const key of ['projectDir', 'testCommand', 'buildCommand', 'conventions'] as const) {
    if (typeof context[key] !== 'string') {
      return { ok: false, reason: `plan child artifact context has no string "${key}"` }
    }
  }
  const tasks = artifact['tasks']
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, reason: 'plan child artifact has no non-empty "tasks" array' }
  }
  for (const task of tasks) {
    if (!isRecord(task) || typeof task['id'] !== 'string' || typeof task['title'] !== 'string') {
      return { ok: false, reason: 'plan child artifact has a task without string "id"/"title"' }
    }
    const files = task['files']
    if (!Array.isArray(files) || files.some((f) => !isRecord(f) || typeof f['path'] !== 'string')) {
      return { ok: false, reason: `plan child artifact task "${String(task['id'])}" has a malformed "files" list` }
    }
  }
  const rejected = Array.isArray(value['rejected']) ? (value['rejected'] as readonly unknown[]) : []
  return {
    ok: true,
    value: {
      artifact: artifact as unknown as PlanArtifactLike,
      rejected,
      stats: value['stats'] ?? null,
      warnings: stringsOrEmpty(value['warnings']),
    },
  }
}

function narrowImplementResult(value: unknown): Narrowed<ImplementResultLike> {
  if (!isRecord(value)) {
    return { ok: false, reason: 'implement child returned an unexpected shape (not an object) — cannot read "succeeded"' }
  }
  for (const key of ['succeeded', 'failed', 'skipped'] as const) {
    if (typeof value[key] !== 'number') {
      return { ok: false, reason: `implement child returned no numeric "${key}" tally` }
    }
  }
  const tasks = value['tasks']
  if (!Array.isArray(tasks)) {
    return { ok: false, reason: 'implement child returned no "tasks" array' }
  }
  for (const task of tasks) {
    if (
      !isRecord(task) ||
      typeof task['id'] !== 'string' ||
      typeof task['title'] !== 'string' ||
      typeof task['status'] !== 'string'
    ) {
      return { ok: false, reason: 'implement child report has a task without string "id"/"title"/"status"' }
    }
  }
  return {
    ok: true,
    value: {
      tasks: tasks as unknown as ReportTaskLike[],
      succeeded: value['succeeded'] as number,
      failed: value['failed'] as number,
      skipped: value['skipped'] as number,
      stats: value['stats'] ?? null,
      warnings: stringsOrEmpty(value['warnings']),
    },
  }
}

function narrowReviewResult(value: unknown): Narrowed<ReviewResultLike> {
  if (!isRecord(value)) {
    return { ok: false, reason: 'review child returned an unexpected shape (not an object)' }
  }
  return {
    ok: true,
    value: { value, stats: value['stats'] ?? null, warnings: stringsOrEmpty(value['warnings']) },
  }
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable error messages (the ONLY throwing
// surface; every later failure RETURNS an abort outcome instead)
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): DevFullInput {
  if (!isRecord(raw)) {
    throw new Error(
      'dev-full: input must be an object with "goal" (string), "projectDir" (string) and ' +
      '"scriptPaths" ({plan, implement, reviewFix} absolute artifact paths) — received: ' +
      (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw),
    )
  }

  if (typeof raw['goal'] !== 'string' || raw['goal'].trim().length === 0) {
    throw new Error(
      'dev-full: "goal" must be a non-empty string — the feature or fix to develop end-to-end. ' +
      'Include corrections from prior runs here (drift mitigation = re-run with an amended goal).',
    )
  }
  const goal = raw['goal']

  if (typeof raw['projectDir'] !== 'string' || raw['projectDir'].trim().length === 0) {
    throw new Error('dev-full: "projectDir" must be a non-empty string — the root every child command runs from')
  }
  const projectDir = raw['projectDir']

  let areas: string[]
  if (raw['areas'] === undefined) {
    areas = ['.']
  } else {
    if (!isStringArray(raw['areas']) || raw['areas'].length === 0 || raw['areas'].some((a) => a.trim() === '')) {
      throw new Error(
        'dev-full: "areas" must be a non-empty array of non-empty strings (or omitted to default to ["."])',
      )
    }
    areas = raw['areas']
  }

  const sp = raw['scriptPaths']
  if (!isRecord(sp)) {
    throw new Error(
      'dev-full: "scriptPaths" must be an object {plan, implement, reviewFix} — absolute paths to the ' +
      'three committed child artifacts (e.g. "<repo>/toolkit/workflows/dev-plan.js")',
    )
  }
  for (const key of ['plan', 'implement', 'reviewFix'] as const) {
    if (typeof sp[key] !== 'string' || sp[key].trim().length === 0) {
      throw new Error(`dev-full: "scriptPaths.${key}" must be a non-empty string — absolute path to the committed artifact`)
    }
  }
  const scriptPaths: ScriptPaths = {
    plan: sp['plan'] as string,
    implement: sp['implement'] as string,
    reviewFix: sp['reviewFix'] as string,
  }

  let maxRefutedRatio = 0.5
  if (raw['maxRefutedRatio'] !== undefined) {
    if (typeof raw['maxRefutedRatio'] !== 'number' || raw['maxRefutedRatio'] < 0 || raw['maxRefutedRatio'] > 1) {
      throw new Error('dev-full: "maxRefutedRatio" must be a number in [0, 1] (default 0.5)')
    }
    maxRefutedRatio = raw['maxRefutedRatio']
  }

  let maxIterationsPerTask: number | null = null
  if (raw['maxIterationsPerTask'] !== undefined) {
    if (typeof raw['maxIterationsPerTask'] !== 'number' || raw['maxIterationsPerTask'] < 1) {
      throw new Error('dev-full: "maxIterationsPerTask" must be a number >= 1 (omit to use the dev-implement default)')
    }
    maxIterationsPerTask = Math.floor(raw['maxIterationsPerTask'])
  }

  let maxFixIterations: number | null = null
  if (raw['maxFixIterations'] !== undefined) {
    if (typeof raw['maxFixIterations'] !== 'number' || raw['maxFixIterations'] < 1) {
      throw new Error('dev-full: "maxFixIterations" must be a number >= 1 (omit to use the dev-review-fix default)')
    }
    maxFixIterations = Math.floor(raw['maxFixIterations'])
  }

  let dimensions: string[] | null = null
  if (raw['dimensions'] !== undefined) {
    if (!isStringArray(raw['dimensions']) || raw['dimensions'].length === 0 || raw['dimensions'].some((d) => d.trim() === '')) {
      throw new Error(
        'dev-full: "dimensions" must be a non-empty array of non-empty strings (omit to use the dev-review-fix default)',
      )
    }
    dimensions = raw['dimensions']
  }

  let diffCommand: string | null = null
  if (raw['diffCommand'] !== undefined && raw['diffCommand'] !== null) {
    if (typeof raw['diffCommand'] !== 'string' || raw['diffCommand'].trim().length === 0) {
      throw new Error(
        'dev-full: "diffCommand" must be a non-empty VERBATIM shell command (or omitted — no-git projects ' +
        'fall back to the planned-files derivation)',
      )
    }
    diffCommand = raw['diffCommand']
  }

  let implementerModel: string | null = null
  if (raw['implementerModel'] !== undefined && raw['implementerModel'] !== null) {
    if (typeof raw['implementerModel'] !== 'string' || raw['implementerModel'].trim().length === 0) {
      throw new Error(
        'dev-full: "implementerModel" must be a non-empty model alias (e.g. "sonnet", "opus", "haiku", ' +
        '"inherit") — omit to use the dev-implement default ("sonnet")',
      )
    }
    implementerModel = raw['implementerModel']
  }

  let implementerType: string | null = null
  if (raw['implementerType'] !== undefined && raw['implementerType'] !== null) {
    if (typeof raw['implementerType'] !== 'string' || raw['implementerType'].trim().length === 0) {
      throw new Error(
        'dev-full: "implementerType" must be a non-empty subagent-type string ' +
        '(e.g. "magic-claude:ts-tdd-guide") — omit to use the dev-implement default (standard subagent)',
      )
    }
    implementerType = raw['implementerType']
  }

  let fixerModel: string | null = null
  if (raw['fixerModel'] !== undefined && raw['fixerModel'] !== null) {
    if (typeof raw['fixerModel'] !== 'string' || raw['fixerModel'].trim().length === 0) {
      throw new Error(
        'dev-full: "fixerModel" must be a non-empty model alias (e.g. "sonnet", "opus", "haiku", ' +
        '"inherit") — omit to use the dev-review-fix default ("sonnet")',
      )
    }
    fixerModel = raw['fixerModel']
  }

  let fixerType: string | null = null
  if (raw['fixerType'] !== undefined && raw['fixerType'] !== null) {
    if (typeof raw['fixerType'] !== 'string' || raw['fixerType'].trim().length === 0) {
      throw new Error(
        'dev-full: "fixerType" must be a non-empty subagent-type string ' +
        '(e.g. "magic-claude:ts-build-resolver") — omit to use the dev-review-fix default (standard subagent)',
      )
    }
    fixerType = raw['fixerType']
  }

  let reviewerType: string | null = null
  if (raw['reviewerType'] !== undefined && raw['reviewerType'] !== null) {
    if (typeof raw['reviewerType'] !== 'string' || raw['reviewerType'].trim().length === 0) {
      throw new Error(
        'dev-full: "reviewerType" must be a non-empty subagent-type string ' +
        '(e.g. "magic-claude:ts-reviewer") — omit to use the dev-review-fix default (standard subagent)',
      )
    }
    reviewerType = raw['reviewerType']
  }

  let verifierType: string | null = null
  if (raw['verifierType'] !== undefined && raw['verifierType'] !== null) {
    if (typeof raw['verifierType'] !== 'string' || raw['verifierType'].trim().length === 0) {
      throw new Error(
        'dev-full: "verifierType" must be a non-empty subagent-type string ' +
        '(e.g. "codex:codex-rescue") — omit to use the dev-plan default (standard same-model Critique verifier)',
      )
    }
    verifierType = raw['verifierType']
  }

  // Optional Class B/C per-role effort overrides, validated by the shared
  // parseConfig helper (reads only the recognized `effort` slice). Forwarded
  // VERBATIM to all three children — see the field doc on DevFullInput.
  const effort = parseConfig(raw).effort ?? null

  return {
    goal,
    areas,
    projectDir,
    scriptPaths,
    maxRefutedRatio,
    maxIterationsPerTask,
    maxFixIterations,
    dimensions,
    diffCommand,
    implementerModel,
    implementerType,
    fixerModel,
    fixerType,
    reviewerType,
    verifierType,
    effort,
  }
}

// ---------------------------------------------------------------------------
// Child invocation — budget-checked, never throws
// ---------------------------------------------------------------------------

type ChildCall = { ok: true; value: unknown } | { ok: false; reason: string }

async function callChild(rt: WorkflowRuntime, scriptPath: string, args: unknown): Promise<ChildCall> {
  // Honest pre-check: the turn's token pool is shared across the whole chain;
  // once it is exhausted the child's first agent() would throw mid-run with an
  // opaque error — abort BEFORE launching it instead.
  if (rt.budget.total !== null && rt.budget.remaining() === 0) {
    return { ok: false, reason: `budget exhausted before the child at ${scriptPath} could start` }
  }
  try {
    return { ok: true, value: await rt.workflow({ scriptPath }, args) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// run — the orchestration
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: DevFullInput): Promise<DevFullOutput> {
  const warnings: string[] = []

  let planSection: PlanSection | null = null
  let implementResult: ImplementResultLike | null = null
  let reviewValue: Record<string, unknown> | null = null
  const stats: { plan: unknown; implement: unknown; review: unknown } = {
    plan: null,
    implement: null,
    review: null,
  }

  function finish(outcome: DevFullOutcome, reason: string | null): DevFullOutput {
    if (reason !== null) rt.log(`dev-full: ${outcome} — ${reason}`)
    return { outcome, reason, plan: planSection, implement: implementResult, review: reviewValue, stats, warnings }
  }

  // -------------------------------------------------------------------------
  // Phase 'Plan' — dev-plan child + Gate A in code.
  // -------------------------------------------------------------------------
  rt.phase('Plan')
  rt.log(`dev-full: planning "${input.goal}"`)

  const planCall = await callChild(rt, input.scriptPaths.plan, {
    goal: input.goal,
    areas: input.areas,
    projectDir: input.projectDir,
    ...(input.verifierType !== null ? { verifierType: input.verifierType } : {}),
    ...(input.effort !== null ? { effort: input.effort } : {}),
  })
  if (!planCall.ok) return finish('aborted-at-plan', planCall.reason)

  const planNarrow = narrowPlanResult(planCall.value)
  if (!planNarrow.ok) return finish('aborted-at-plan', planNarrow.reason)
  const plan = planNarrow.value

  planSection = { taskCount: plan.artifact.tasks.length, rejected: plan.rejected, artifact: plan.artifact }
  stats.plan = plan.stats
  for (const w of plan.warnings) warnings.push(`plan: ${w}`)

  // Gate A.1 — degraded Discover context. dev-plan only WARNS when Discover
  // failed and emitted empty commands, but BOTH downstream children reject an
  // empty testCommand/conventions on entry — abort here with the real cause.
  for (const key of ['testCommand', 'conventions'] as const) {
    if (plan.artifact.context[key].trim() === '') {
      return finish(
        'aborted-at-plan',
        `artifact.context.${key} is empty — the dev-plan Discover phase degraded (see its warnings); ` +
        `dev-implement and dev-review-fix would reject this artifact on entry. ` +
        `Fix discovery (or edit the artifact and fall back to the split workflows).`,
      )
    }
  }

  // Gate A.2 — refuted-task ratio (the machine version of the human plan review).
  const rejectedCount = plan.rejected.length
  const ratio = rejectedCount / (rejectedCount + plan.artifact.tasks.length)
  const roundedRatio = Math.round(ratio * 100) / 100
  if (ratio > input.maxRefutedRatio) {
    return finish(
      'aborted-at-plan',
      `refuted-task ratio ${roundedRatio} exceeds maxRefutedRatio ${input.maxRefutedRatio} ` +
      `(${rejectedCount} rejected vs ${plan.artifact.tasks.length} kept) — the critique distrusts this plan. ` +
      `Arbitrate from plan.rejected (each entry carries the refuting reason), then re-run with an amended goal.`,
    )
  }
  rt.log(
    `dev-full: gate A passed — ${plan.artifact.tasks.length} tasks kept, ${rejectedCount} rejected ` +
    `(ratio ${roundedRatio} <= ${input.maxRefutedRatio})`,
  )

  // -------------------------------------------------------------------------
  // Phase 'Implement' — dev-implement child + Gate B in code.
  // -------------------------------------------------------------------------
  rt.phase('Implement')

  const implementArgs: Record<string, unknown> = { artifact: plan.artifact }
  if (input.maxIterationsPerTask !== null) implementArgs['maxIterationsPerTask'] = input.maxIterationsPerTask
  if (input.implementerModel !== null) implementArgs['implementerModel'] = input.implementerModel
  if (input.implementerType !== null) implementArgs['implementerType'] = input.implementerType
  if (input.effort !== null) implementArgs['effort'] = input.effort

  const implementCall = await callChild(rt, input.scriptPaths.implement, implementArgs)
  if (!implementCall.ok) return finish('aborted-at-implement', implementCall.reason)

  const implementNarrow = narrowImplementResult(implementCall.value)
  if (!implementNarrow.ok) return finish('aborted-at-implement', implementNarrow.reason)
  const implement = implementNarrow.value

  implementResult = implement
  stats.implement = implement.stats
  for (const w of implement.warnings) warnings.push(`implement: ${w}`)

  // Gate B — continue iff at least one task succeeded (ratified policy).
  if (implement.succeeded === 0) {
    return finish(
      'aborted-at-implement',
      `no task succeeded (0 of ${implement.tasks.length}) — nothing to review. ` +
      `Feed the per-task failure notes back into a corrective dev-plan run.`,
    )
  }
  rt.log(
    `dev-full: gate B passed — ${implement.succeeded} succeeded, ${implement.failed} failed, ` +
    `${implement.skipped} skipped`,
  )

  // -------------------------------------------------------------------------
  // Derive the dev-review-fix input IN CODE (the former human handoff).
  // -------------------------------------------------------------------------
  const ranIds = new Set(
    implement.tasks.filter((t) => t.status === 'succeeded' || t.status === 'failed').map((t) => t.id),
  )
  // Same path normalization as dev-implement's parse boundary: an
  // operator-supplied scriptPath may point at an older dev-plan whose artifact
  // still carries under-root ABSOLUTE paths; relativizing keeps changedFiles
  // consistent with relative diff-style paths and dedupes across both
  // spellings. Idempotent on relative paths (null → keep); unmappable
  // absolutes never reach this point (the implement child rejects them at its
  // parse boundary → gate B aborts).
  const relativize = (p: string): string => relativizeUnder(input.projectDir, p) ?? p
  const seenPaths = new Set<string>()
  const derivedFiles: string[] = []
  for (const task of plan.artifact.tasks) {
    if (!ranIds.has(task.id)) continue
    for (const file of task.files) {
      const path = relativize(file.path)
      if (!seenPaths.has(path)) {
        seenPaths.add(path)
        derivedFiles.push(path)
      }
    }
  }

  let changedFiles: string[] | null = null
  if (input.diffCommand === null) {
    if (derivedFiles.length === 0) {
      return finish(
        'aborted-at-review',
        'no changed files could be derived from the plan artifact (the tasks that ran declare no files) — ' +
        'pass "diffCommand" (git projects) so dev-review-fix can read the real change set.',
      )
    }
    changedFiles = derivedFiles
    warn(
      rt,
      warnings,
      'changedFiles derived from planned task files — files created beyond the plan are not reviewed; ' +
      'pass "diffCommand" on git projects for the real diff.',
    )
  }

  const statusLines = implement.tasks.map((t) => `${t.id} (${t.title}): ${t.status}`)
  const changeSummary =
    `Implemented by dev-implement (per-task outcomes):\n${statusLines.join('\n')}` +
    (changedFiles !== null
      ? '\n\nNote: the changed-files list approximates the change set from the PLANNED files of ' +
        'succeeded and failed tasks; files created beyond the plan are not covered.'
      : '')

  const reviewArgs: Record<string, unknown> = {
    projectDir: plan.artifact.context.projectDir,
    testCommand: plan.artifact.context.testCommand,
    buildCommand: plan.artifact.context.buildCommand,
    conventions: plan.artifact.context.conventions,
    goal: input.goal,
    changeSummary,
    diffCommand: input.diffCommand,
    changedFiles,
  }
  if (input.dimensions !== null) reviewArgs['dimensions'] = input.dimensions
  if (input.maxFixIterations !== null) reviewArgs['maxFixIterations'] = input.maxFixIterations
  if (input.fixerModel !== null) reviewArgs['fixerModel'] = input.fixerModel
  if (input.fixerType !== null) reviewArgs['fixerType'] = input.fixerType
  if (input.reviewerType !== null) reviewArgs['reviewerType'] = input.reviewerType
  if (input.verifierType !== null) reviewArgs['verifierType'] = input.verifierType
  if (input.effort !== null) reviewArgs['effort'] = input.effort

  // -------------------------------------------------------------------------
  // Phase 'Review & Fix' — dev-review-fix child (narrow-only: the review
  // VERDICT is surfaced in the output, deliberately NOT gated — a red suite
  // or unfixed findings still complete the chain with honest reporting).
  // -------------------------------------------------------------------------
  rt.phase('Review & Fix')

  const reviewCall = await callChild(rt, input.scriptPaths.reviewFix, reviewArgs)
  if (!reviewCall.ok) return finish('aborted-at-review', reviewCall.reason)

  const reviewNarrow = narrowReviewResult(reviewCall.value)
  if (!reviewNarrow.ok) return finish('aborted-at-review', reviewNarrow.reason)
  const review = reviewNarrow.value

  reviewValue = review.value
  stats.review = review.stats
  for (const w of review.warnings) warnings.push(`review: ${w}`)

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic assembly IN CODE (no agent).
  // -------------------------------------------------------------------------
  rt.phase('Report')
  const reportSummary =
    `dev-full: completed — plan ${plan.artifact.tasks.length} tasks, ` +
    `implement ${implement.succeeded}/${implement.tasks.length} succeeded, ` +
    `review suiteGreen=${String(review.value['suiteGreen'] ?? 'unknown')}`
  rt.log(reportSummary)
  // Tier-2 skip-digest: Report is entered only on the happy-path completion
  // (every abort returns earlier from within Plan/Implement/Review & Fix) and
  // never spawns an agent — deterministic assembly IN CODE. Custom-stage
  // naming convention: '<workflow-name>:<phase-lowercase>', matching this
  // family's kebab-case agent-label prefix elsewhere. `phase` MUST equal the
  // rt.phase() title exactly — the sole resolution hint for a zero-agent phase.
  emitDigest(rt, {
    stage: 'dev-full:report',
    phase: 'Report',
    output: reportSummary,
    counts: { planTasks: plan.artifact.tasks.length, implementSucceeded: implement.succeeded, implementTotal: implement.tasks.length },
  })
  return finish('completed', null)
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'dev-full',
    description:
      'Full mode of the dev-workflow family: chains dev-plan, dev-implement and dev-review-fix in ONE ' +
      'run via workflow() composition over their committed artifacts, converting the human gates into ' +
      'code gates (refuted-ratio abort, degraded-context abort, continue iff at least one task ' +
      'succeeded, in-code change-set handoff). Every abort RETURNS a structured report preserving the ' +
      'completed children\'s output.',
    whenToUse:
      'Use for end-to-end autonomous development ONLY when the operator accepts the whole-chain trust ' +
      'boundary (no human gate from goal to tree mutations). For human-gated steps, run the split ' +
      'workflows instead. Args: {goal, projectDir, scriptPaths: {plan, implement, reviewFix}} plus ' +
      'optional areas/maxRefutedRatio/maxIterationsPerTask/maxFixIterations/dimensions/diffCommand.',
    phases: [
      { title: 'Plan', detail: 'dev-plan child; gate A: shape, degraded context, refuted-task ratio' },
      { title: 'Implement', detail: 'dev-implement child; gate B: continue iff >= 1 task succeeded' },
      { title: 'Review & Fix', detail: 'dev-review-fix child on the derived change set (diffCommand wins)' },
      { title: 'Report', detail: 'Deterministic outcome + per-child sections + prefixed warnings (in code)' },
    ],
  },
  parseInput,
  run,
})
