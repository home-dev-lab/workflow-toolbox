// pr-review.workflow.ts — Code review of a change set.
//
// PEDAGOGY: This example teaches 4 defence layers against agents that die
// mid-reasoning or misreport:
//
//  (1) SCHEMA AT EVERY CONSUMED BOUNDARY — every rt.agent() call that returns
//      structured data carries a `schema:` option. The runtime enforces the
//      shape; the composition never blindly trusts a raw string.
//
//  (2) FRESH-EVIDENCE CHECKER STAGE — adversarialVerification is passed a
//      renderClaim that embeds an explicit instruction to re-derive from the
//      actual diff, never trust the reviewer's summary. The verifier's refute-
//      first framing (built into the pattern) eliminates confirmation bias.
//
//  (3) DECOMPOSED AGENT SCOPES — one reviewer per lens (small, focused
//      context). Each reviewer sees exactly one aspect of the change.
//      Broad context → model laziness → missed findings.
//
//  (4) ON LAUNCH: ALWAYS check WorkflowOutput.error. On partial failure,
//      relaunch with resumeFromRunId — completed agent() calls replay from
//      cache; only missing/failed work re-runs (no redoing finished analysis).
//
// Architecture notes:
//  - Review + Verify are in PIPELINE FORM (no barrier between them): each
//    reviewer's findings flow directly into its own verifier. §6.1 rule 2:
//    barriers are only inserted when a later stage genuinely needs the FULL
//    prior output. Verify only needs one reviewer's findings at a time.
//  - Synthesize IS a barrier: synthesis needs ALL verified findings from ALL
//    reviewers to produce a coherent overall verdict.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias, AgentDefaults } from '@workflow-toolbox/runtime'
import { resolveEffort, resolveVerifierEffort } from '@workflow-toolbox/std'
import {
  classifyAndAct,
  adversarialVerification,
  collectTrail,
  probeAgentType,
  withLeafFence,
} from '@workflow-toolbox/patterns'
import type {
  ClaimVerdict,
  VerifiedClaim,
  AgentTypeProbeReport,
  TrailRecord,
  LeafFenceReport,
} from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Per-stage effort defaults (Class B/C launch-time tuning — see parseConfig).
//
// Every stage below used to inherit the SESSION effort silently (no `effort`
// opt passed to rt.agent/pattern calls). These constants are the stage-class
// defaults; a launch-time `args.effort.<role>` override (parsed by parseConfig
// into `input.effort`) can retune any of them without a source edit, via
// resolveEffort. The Verify role is clamped to a 'high' FLOOR — an override
// may only RAISE it, mirroring adversarialVerification's own model-floor
// guardrail (weaker effort on a refute-first verifier is exactly as risky as
// a weaker model there).
// ---------------------------------------------------------------------------
const CLASSIFY_EFFORT: EffortAlias = 'low'       // Route: classify — routing/mechanical
const ROUTE_ACT_EFFORT: EffortAlias = 'medium'   // Route: per-category summary — consolidation
const REVIEW_EFFORT: EffortAlias = 'high'        // Review: per-lens reviewer agents
const VERIFY_EFFORT_DEFAULT: EffortAlias = 'high' // Verify: adversarialVerification (floor 'high')
const SYNTHESIZE_EFFORT: EffortAlias = 'medium'  // Synthesize: final verdict — consolidation

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface PrReviewInput {
  target: string
  /** Optional model for the VERIFY fan (adversarialVerification). null = the pattern default
   *  (BEST_MODEL = opus). Pass 'sonnet' at launch — `args: { target, verifierModel: 'sonnet' }` —
   *  for the cheaper, abundant-quota bucket: the verify is targeted + diff-grounded, so sonnet is
   *  good enough and the fan dominates the run's tokens. Launch-time config; no source edit. */
  verifierModel: ModelAlias | null
  /** Optional subagent type for the Verify fan (adversarialVerification's own
   *  `verifierType` option) — routes the ADVERSARIAL VERIFIER agents through a
   *  specialist or cross-family bridge (e.g. 'codex:codex-rescue' /
   *  'workflow-toolbox:opencode-verifier') for decorrelated verification. This is
   *  the pattern's PREMIER use case for that option (see adversarial-verification.ts):
   *  a same-model verifier shares the reviewer's priors, a genuinely different
   *  model does not. null = the standard subagent (the default). Requested via the
   *  SAME structured config envelope as reviewerType: `args.agentTypes.verify`
   *  (the SAME role key as a future `effort.verify` override — one role, one key),
   *  validated by the shared parseConfig. PROBED at run entry (probeAgentType),
   *  mirroring the reviewerType precedent exactly: when the type cannot answer,
   *  the run degrades to the standard subagent — reported in the result's
   *  `verifierProbe`, never silent. Routes the Verify fan ONLY: the lens reviewers
   *  and the synthesizer are never specialized by this knob. Never hard-code a
   *  private (e.g. magic-claude:*) type as a default. */
  verifierType: string | null
  /** Optional subagent type for the per-lens REVIEW agents — a specialist
   *  reviewer, or a cross-family bridge (e.g. 'workflow-toolbox:opencode-verifier')
   *  for decorrelated review. null = the standard subagent (the default).
   *  Requested via the STRUCTURED config envelope: `args.agentTypes.review`
   *  (the SAME role key as `effort.review` — one role, one key; no bespoke
   *  top-level arg), validated by the shared parseConfig. PROBED at run entry
   *  (probeAgentType): when the type cannot answer, the run degrades to the
   *  standard subagent — reported in the result's `probe`, never silent. Routes
   *  the lens reviewers ONLY: the verifiers and the synthesizer are never
   *  specialized. Never hard-code a private (e.g. magic-claude:*) type as a
   *  default. A specialist reviewer is more thorough but noisier; the
   *  refute-first Verify stage filters the extra false positives. */
  reviewerType: string | null
  /** Optional Class-A blanket per-agent defaults, applied to EVERY agent in EVERY
   *  stage via one withAgentDefaults wrap (model/effort/agentType/isolation/stallMs).
   *  null = no blanket default. Parsed from `args.perAgent` by the shared
   *  `parseConfig` helper — launch-time, no source edit, e.g.
   *  `args: { target, perAgent: { model: 'sonnet', effort: 'low' } }`. Per-stage
   *  knobs still WIN: the verify fan's `verifierModel` overrides perAgent.model,
   *  so the blanket default tunes only the agents that do NOT pin their own. */
  perAgent: AgentDefaults | null
  /** Optional per-ROLE reasoning-effort overrides (Class B/C, parsed by the
   *  shared `parseConfig` helper from `args.effort`), e.g.
   *  `args: { target, effort: { review: 'xhigh' } }`. Role keys: 'classify',
   *  'route', 'review', 'verify', 'synthesize'. A role's value may also be
   *  the literal 'auto', meaning "keep THIS role's own committed default"
   *  (useful for symmetry in an explicit map). null = no overrides — every
   *  stage keeps its committed default. Resolved per-stage via resolveEffort
   *  (invalid/missing values degrade to the stage default, never throw); the
   *  'verify' role is additionally clamped to a 'high' floor via
   *  resolveVerifierEffort — an override may only raise it. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
  /** Blanket opt-OUT of the default leaf-agent fence (withLeafFence): every agent
   *  this workflow spawns denies SendMessage by default. true = allow the standard
   *  (messaging-capable) subagent instead — set only when this run genuinely needs
   *  its agents to coordinate. null/false (default) = the fence applies. Parsed
   *  from `args.messaging` by the shared parseConfig helper. */
  messaging: boolean | null
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Schema for the routed change summary (classifyAndAct act stage output).
// Bounds are anti-capitulation defences (internal note, observed live
// 2026-07-08): an act agent wrote a LONG correct summary, closed the JSON before
// riskAreas, got two "missing property" rejections, then capitulated into
// {"summary":"test","riskAreas":["a","b"]} — which validated. maxLength turns the
// runaway-summary trigger into an actionable "too long" rejection; minLength makes
// single-word junk fail validation instead of silently seeding the reviewers.
const CHANGE_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 12, maxLength: 1200 },
    riskAreas: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'riskAreas'],
  additionalProperties: false,
} as const satisfies JsonSchema

// Shared contract line for every act prompt below. riskAreas is asked for FIRST:
// the observed failure was generation-order — a long summary emitted first starved
// the required sibling field. Short/required-first is the same convention the other
// compositions already follow ("score" then "reason", "verdict" then "summary").
const CHANGE_SUMMARY_RULES =
  'Both fields are REQUIRED. Emit "riskAreas" FIRST, then "summary" — at most 500 characters ' +
  '(the schema rejects longer). Never satisfy the schema with placeholder values ("test", "a"); ' +
  'if a field is hard to fill, shorten it — do not fake it.'

type ChangeSummary = FromSchema<typeof CHANGE_SUMMARY_SCHEMA>

// Schema for a single reviewer's findings (review stage output)
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: { type: 'string' },
        },
        required: ['title', 'file', 'severity', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const satisfies JsonSchema

type FindingsOutput = FromSchema<typeof FINDINGS_SCHEMA>

// Schema for the synthesis agent output
const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request-changes'] },
    summary: { type: 'string' },
  },
  required: ['verdict', 'summary'],
  additionalProperties: false,
} as const satisfies JsonSchema

type SynthesisOutput = FromSchema<typeof SYNTHESIS_SCHEMA>

// ---------------------------------------------------------------------------
// Read-only git constraint — interpolated into every prompt below that asks an
// agent to inspect a change. Prevents agents from reaching for destructive git
// (observed live: a verifier ran `git checkout <sha> -- .`), which mutates the
// shared working tree and is denied by auto-mode, silently degrading the run.
// ---------------------------------------------------------------------------

const READ_ONLY_GIT =
  'Inspect via READ-ONLY git only — `git show <sha>:<path>`, `git diff <range>`, `git log` — ' +
  'NEVER `git checkout` / `git reset` / `git restore` / `git clean` (they mutate the shared working tree and will be denied).'

// ---------------------------------------------------------------------------
// Reviewer lenses per category
// Each category gets specialized lenses: different failure modes, not redundant
// coverage. Distinct lenses catch failures plain redundancy misses. Every CODE
// category also carries `maintainability` (duplication / missed abstraction / DRY
// / coupling / complexity) — a correctness/security review otherwise never reports
// that a change copy-pastes code or could be abstracted, since each reviewer is
// told to focus ONLY on its own lens. `docs` (prose) is the sole exception.
// ---------------------------------------------------------------------------

const REVIEWER_LENSES: Readonly<Record<string, readonly string[]>> = {
  bugfix: ['root-cause', 'regression-risk', 'test-coverage', 'maintainability'],
  feature: ['correctness', 'security', 'api-design', 'maintainability'],
  refactor: ['behavioral-equivalence', 'test-coverage', 'readability', 'maintainability'],
  config: ['correctness', 'security', 'blast-radius', 'maintainability'],
  docs: ['accuracy', 'completeness', 'clarity'],
}

// Fallback lenses when the category is not in the map (code-shaped → includes maintainability)
const DEFAULT_LENSES: readonly string[] = ['correctness', 'security', 'test-coverage', 'maintainability']

// ---------------------------------------------------------------------------
// A finding enriched with its adversarial verdict (for the final output)
// ---------------------------------------------------------------------------

interface VerifiedFinding {
  title: string
  file: string
  severity: 'high' | 'medium' | 'low'
  detail: string
  // ClaimVerdict = the four agent verdicts + 'unverified-by-cap' (the
  // maxVerifyClaims cap withheld verification — pattern-level, patterns 0.3.0)
  verdict: ClaimVerdict
}

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

interface PrReviewOutput {
  category: string
  verdict: 'approve' | 'request-changes'
  summary: string
  findings: readonly VerifiedFinding[]
  /** The subagent type the lens reviewers actually ran through (probe-resolved);
   *  null = the standard subagent (default, or graceful fallback). */
  reviewerType: string | null
  /** Probe story when `agentTypes.review` was requested; null otherwise. */
  probe: AgentTypeProbeReport | null
  /** The subagent type the Verify fan actually ran through (probe-resolved);
   *  null = the standard subagent (default, or graceful fallback). */
  verifierType: string | null
  /** Probe story when `agentTypes.verify` was requested; null otherwise. */
  verifierProbe: AgentTypeProbeReport | null
  /** Leaf-agent fence outcome (withLeafFence): whether every spawned agent
   *  defaulted to the SendMessage-denying agentType, or degraded/opted out. */
  leafFence: LeafFenceReport
  stats: {
    reviewersSpawned: number
    findingsRaw: number
    findingsVerified: number
    findingsRefuted: number
    dropped: number
  }
  /** Combined Route + per-lens Verify trail (collectTrail, in pipeline order). */
  envelope: { trail: TrailRecord[] }
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable error
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): PrReviewInput {
  // Bare string shorthand: accept a plain string as { target: string }
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      throw new Error(
        'pr-review: target must be a non-empty string — provide a git ref range or change description (e.g. "HEAD~3..HEAD")',
      )
    }
    return {
      target: raw,
      reviewerType: null,
      verifierModel: null,
      verifierType: null,
      perAgent: null,
      effort: null,
      messaging: null,
    }
  }

  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      'pr-review: input must be an object with a "target" field, or a bare non-empty string — ' +
      'received: ' + typeof raw,
    )
  }

  const obj = raw as Record<string, unknown>

  if (!('target' in obj) || obj['target'] === undefined) {
    throw new Error(
      'pr-review: missing required field "target" — provide a git ref range or change description',
    )
  }

  if (typeof obj['target'] !== 'string' || obj['target'].trim().length === 0) {
    throw new Error(
      'pr-review: "target" must be a non-empty string — provide a git ref range or change description (e.g. "HEAD~3..HEAD")',
    )
  }

  // Optional verify-fan model override. Shape-only (a non-empty string); ModelAlias is an open
  // union so an unknown alias is the runtime's problem, not parse-time. Omit → pattern default.
  let verifierModel: ModelAlias | null = null
  if (obj['verifierModel'] !== undefined && obj['verifierModel'] !== null) {
    if (typeof obj['verifierModel'] !== 'string' || obj['verifierModel'].trim().length === 0) {
      throw new Error(
        'pr-review: "verifierModel" must be a non-empty model alias string (e.g. "sonnet") — omit it for the default (opus)',
      )
    }
    verifierModel = obj['verifierModel'] as ModelAlias
  }

  // Class-A blanket per-agent defaults + Class B per-role effort overrides +
  // the per-role agentType routing map, all validated by the shared parseConfig
  // helper. It reads only the recognized `perAgent`/`effort`/`agentTypes`
  // slices and IGNORES pr-review's bespoke target/verifierModel keys, so the
  // conventions compose cleanly. The lens reviewers' routing request lives at
  // `agentTypes.review` — the SAME role key as `effort.review` (one role, one
  // key: parseConfig never validates key sets, so a near-miss key would be a
  // SILENT no-op — mirroring the effort key is the guard). The Verify fan's
  // routing request follows the SAME convention at `agentTypes.verify`.
  const cfg = parseConfig(obj)
  const perAgent = cfg.perAgent ?? null
  const effort = cfg.effort ?? null
  const reviewerType = cfg.agentTypes?.['review'] ?? null
  const verifierType = cfg.agentTypes?.['verify'] ?? null
  const messaging = cfg.messaging ?? null

  return { target: obj['target'], reviewerType, verifierModel, verifierType, perAgent, effort, messaging }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt00: WorkflowRuntime, input: PrReviewInput): Promise<PrReviewOutput> {
  // Leaf-agent fence — the LOWEST-priority default, applied first/innermost so
  // it never clobbers a workflow-level perAgent blanket (below) or a per-role
  // agentType (each call site's own opts). Every agent this workflow spawns
  // defaults to the SendMessage-denying agentType unless `messaging: true` was
  // requested — see @workflow-toolbox/patterns' withLeafFence.
  rt00.phase('Fence')
  const { rt: rt0, report: leafFence } = await withLeafFence(rt00, {
    phase: 'Fence',
    disabled: input.messaging === true,
    // The probe call itself must inherit the SAME blanket default the rest of the
    // run gets below — otherwise it silently runs on the raw session model/effort,
    // contradicting perAgent's own "every agent inherits" contract.
    ...(input.perAgent !== null ? { perAgent: input.perAgent } : {}),
  })

  // Class-A one-wiring-point: wrap the runtime ONCE so the blanket per-agent
  // defaults reach every agent in every pattern below (per-call/pattern opts
  // still win). When no perAgent was supplied this is a no-op passthrough.
  const rt = input.perAgent !== null ? withAgentDefaults(rt0, input.perAgent) : rt0
  const warnings: string[] = []
  let reviewersSpawned = 0
  let dropped = 0
  // One entry per lens whose verifyStage actually ran adversarialVerification
  // (a dropped reviewer or an empty findings list contributes nothing) —
  // folded into envelope.trail via collectTrail at Synthesize time.
  const lensTrails: Array<{ trail: TrailRecord[] }> = []

  // Resolve each stage's effort ONCE: a launch-time `args.effort.<role>`
  // override wins when valid, else the stage-class default declared above.
  // 'verify' is additionally floored at 'high' — see resolveVerifierEffort.
  const classifyEffort = resolveEffort(input.effort?.['classify'], CLASSIFY_EFFORT)
  const routeActEffort = resolveEffort(input.effort?.['route'], ROUTE_ACT_EFFORT)
  const reviewEffort = resolveEffort(input.effort?.['review'], REVIEW_EFFORT)
  const verifyEffort = resolveVerifierEffort(input.effort?.['verify'], VERIFY_EFFORT_DEFAULT)
  const synthesizeEffort = resolveEffort(input.effort?.['synthesize'], SYNTHESIZE_EFFORT)

  // -------------------------------------------------------------------------
  // Phase 'Probe' (conditional) — resolve the reviewer routing BEFORE any
  // reviewer spawns. One schema-less probe through the requested type; any
  // non-affirmative outcome (UNAVAILABLE marker, null, error text, throw on an
  // unregistered type) degrades to the standard subagent. Never silent: the
  // probe logs + emits its own digest, and the result carries `probe`.
  // -------------------------------------------------------------------------

  let resolvedReviewerType: string | null = null
  let probeReport: AgentTypeProbeReport | null = null
  if (input.reviewerType !== null) {
    rt.phase('Probe')
    const probe = await probeAgentType(rt, input.reviewerType, { phase: 'Probe' })
    resolvedReviewerType = probe.agentType ?? null
    probeReport = { requested: input.reviewerType, available: probe.available, reason: probe.reason }
  }

  // Same probe-then-resolve treatment for the Verify fan's routing request
  // (agentTypes.verify) — mirrors the reviewerType block above exactly, so an
  // unavailable cross-family verifier degrades to the standard subagent
  // instead of silently starving every verify call.
  let resolvedVerifierType: string | null = null
  let verifierProbeReport: AgentTypeProbeReport | null = null
  if (input.verifierType !== null) {
    rt.phase('Probe')
    const probe = await probeAgentType(rt, input.verifierType, { phase: 'Probe' })
    resolvedVerifierType = probe.agentType ?? null
    verifierProbeReport = { requested: input.verifierType, available: probe.available, reason: probe.reason }
  }

  // -------------------------------------------------------------------------
  // Phase 'Route' — classifyAndAct
  //
  // Pattern: classifyAndAct (routing pattern).
  // Why: A change can be a bugfix, feature, refactor, config or docs update.
  // Each category has different review priorities. The classifier inspects the
  // change target; the action produces a focused summary with risk areas.
  // Defence (1): schema enforces { summary, riskAreas } shape at this boundary.
  // -------------------------------------------------------------------------

  rt.phase('Route')

  const routeResult = await classifyAndAct<string, ChangeSummary>(rt, {
    items: [input.target],
    categories: ['feature', 'bugfix', 'refactor', 'config', 'docs'],
    classifyPrompt: (target) =>
      `Inspect this change and classify it into exactly one category: feature, bugfix, refactor, config, or docs.\n` +
      `Change target: ${target}\n` +
      `${READ_ONLY_GIT}\n` +
      `Return { "category": "<one of the five categories>" }`,
    classifyEffort,
    actions: {
      feature: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a FEATURE change. Inspect the actual change (${target}) and produce a focused summary.\n` +
          `${READ_ONLY_GIT}\n` +
          `Return { "riskAreas": ["<risk1>", ...], "summary": "<what the feature does>" }. ${CHANGE_SUMMARY_RULES}`,
        effort: routeActEffort,
      },
      bugfix: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a BUGFIX change. Inspect the actual change (${target}) — re-derive from first principles.\n` +
          `${READ_ONLY_GIT}\n` +
          `Return { "riskAreas": ["<risk1>", ...], "summary": "<what was broken and how it is fixed>" }. ${CHANGE_SUMMARY_RULES}`,
        effort: routeActEffort,
      },
      refactor: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a REFACTOR change. Inspect the actual change (${target}).\n` +
          `${READ_ONLY_GIT}\n` +
          `Return { "riskAreas": ["<risk1>", ...], "summary": "<what was refactored and why>" }. ${CHANGE_SUMMARY_RULES}`,
        effort: routeActEffort,
      },
      config: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a CONFIG change. Inspect the actual change (${target}).\n` +
          `${READ_ONLY_GIT}\n` +
          `Return { "riskAreas": ["<risk1>", ...], "summary": "<what config changed and its effect>" }. ${CHANGE_SUMMARY_RULES}`,
        effort: routeActEffort,
      },
      docs: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a DOCS change. Inspect the actual change (${target}).\n` +
          `${READ_ONLY_GIT}\n` +
          `Return { "riskAreas": ["<risk1>", ...], "summary": "<what documentation was updated>" }. ${CHANGE_SUMMARY_RULES}`,
        effort: routeActEffort,
      },
    },
    phase: 'Route',
  })

  for (const w of routeResult.warnings) warnings.push(w)

  // Route must succeed — no routed result means classification failed entirely
  const routedItem = routeResult.value[0]
  if (routedItem === undefined) {
    throw new Error(
      'pr-review: classification failed — no category could be assigned to the change. ' +
      'Warnings: ' + warnings.join('; '),
    )
  }

  const category = routedItem.category
  const changeSummary = routedItem.result

  // Degenerate-output guard (internal note): a schema-rejected agent can
  // capitulate into minimal junk that VALIDATES — the journal's `attempt` stays 1
  // (StructuredOutput retries are intra-conversation), so nothing else surfaces it.
  // Heuristic + loud, never fatal: the reviewers re-derive findings from the diff, so
  // a lost seeding degrades orientation, it does not invalidate the review.
  const junkAreas =
    changeSummary.riskAreas.length > 0 && changeSummary.riskAreas.every((r) => r.trim().length <= 2)
  if (junkAreas || changeSummary.summary.trim().length < 12) {
    const w =
      `route: degenerate change summary from the ${category} act stage ` +
      `(summary="${changeSummary.summary.slice(0, 40)}", riskAreas=${JSON.stringify(changeSummary.riskAreas.slice(0, 4))}) — ` +
      'reviewer seeding lost; findings still re-derive from the actual diff'
    warnings.push(w)
    rt.log(`⚠ ${w}`)
  }

  // -------------------------------------------------------------------------
  // Phase 'Review' + 'Verify' — pipeline form, NO barrier between them.
  //
  // Pattern: rt.pipeline with reviewStage then verifyStage per lens.
  // Why pipeline (not barrier): each reviewer's findings flow into its own
  // verifier independently. §6.1 rule 2 — a barrier is only correct when the
  // NEXT stage genuinely needs the FULL prior output. Verify needs only one
  // reviewer's findings at a time, so no barrier is inserted here.
  //
  // Defence (3): one reviewer per lens (decomposed scopes — small focused
  //   context). Each agent sees exactly one aspect of the change.
  // Defence (2): verifier renderClaim embeds instruction to re-derive from
  //   the actual diff (fresh-evidence checker), not trust the reviewer summary.
  // Defence (1): schema enforced on reviewer output (FINDINGS_SCHEMA).
  // -------------------------------------------------------------------------

  const lenses = REVIEWER_LENSES[category] ?? DEFAULT_LENSES

  // reviewStage: for a given lens, spawn one reviewer agent with focused scope.
  // The stage receives the lens as originalItem (items = lenses).
  const reviewStage = async (
    _prev: unknown,
    originalItem: unknown,
  ): Promise<FindingsOutput | null> => {
    const lens = originalItem as string

    reviewersSpawned++

    // Defence (1): schema enforces the findings shape at this consumed boundary.
    // Prompt is STRUCTURED MARKDOWN (## sections, bullets), not one \n-joined wall:
    // transcript viewers render markdown, where a single \n does NOT break a paragraph —
    // the old shape read as one giant unscannable blob (user finding, 2026-07-08).
    const result = await rt.agent<FindingsOutput>(
      `## Role\n` +
      `You are a specialized code reviewer examining the **${lens}** aspect of this change.\n\n` +
      `## Change\n` +
      `- **Target:** \`${input.target}\`\n\n` +
      `### Summary (from the routing stage)\n${changeSummary.summary}\n\n` +
      `### Risk areas\n${changeSummary.riskAreas.map((r) => `- ${r}`).join('\n')}\n\n` +
      `## Instructions\n` +
      `Read the ACTUAL change (you have repo access). Do NOT trust the summary above — re-derive findings from first principles.\n` +
      `${READ_ONLY_GIT}\n` +
      `Focus ONLY on the "${lens}" lens.\n\n` +
      `## Output\n` +
      `Return your findings. Each finding: \`{ title, file, severity ('high'|'medium'|'low'), detail }\``,
      {
        schema: FINDINGS_SCHEMA,
        label: `pr-review:reviewer:${lens}`,
        phase: 'Review',
        effort: reviewEffort,
        // Optional subagent type (agentTypes.review knob), PROBE-RESOLVED at
        // run entry. Omitted when null → standard subagent (default; also the
        // graceful-fallback path when the requested type could not answer).
        // Routes the lens reviewers ONLY; verifiers and synthesizer stay generic.
        ...(resolvedReviewerType !== null ? { agentType: resolvedReviewerType } : {}),
      },
    )

    return result
  }

  // verifyStage: adversarialVerification on THAT reviewer's findings.
  // Why: a reviewer may hallucinate or misread the diff. The verifier is
  // instructed to re-derive from the actual diff, eliminating confirmation bias.
  const verifyStage = async (
    prev: unknown,
    originalItem: unknown,
  ): Promise<Array<VerifiedClaim<FindingsOutput['findings'][number]>> | null> => {
    const lens = originalItem as string
    const reviewOutput = prev as FindingsOutput | null

    // Defence: null reviewer (died mid-reasoning) → skip lens, count as dropped
    if (reviewOutput === null) {
      dropped++
      return null
    }

    const findings = reviewOutput.findings
    if (findings.length === 0) {
      // No findings from this reviewer — nothing to verify
      return []
    }

    // Defence (2): renderClaim embeds the instruction to RE-DERIVE from the
    // actual diff, never trust the reviewer's summary (fresh-evidence checker).
    const verifyResult = await adversarialVerification(rt, {
      // Verify-fan model: launch-time override via `args.verifierModel`, default opus (BEST_MODEL).
      // This verification is TARGETED + diff-grounded, so passing 'sonnet' at launch is a sound,
      // cheaper choice — but the committed DEFAULT stays opus (no implicit downgrade).
      ...(input.verifierModel !== null ? { model: input.verifierModel } : {}),
      // Verify-fan agentType: launch-time override via `args.agentTypes.verify`,
      // probe-resolved above. Omitted when null → the standard subagent (default,
      // also the graceful-fallback path when the requested type could not answer).
      ...(resolvedVerifierType !== null ? { verifierType: resolvedVerifierType } : {}),
      claims: findings,
      renderClaim: (finding) =>
        `## Claim to verify (lens: ${lens})\n` +
        `**${finding.title}** — \`${finding.file}\` · severity: ${finding.severity}\n\n` +
        `${finding.detail}\n\n` +
        `## Instructions\n` +
        `IMPORTANT: Do NOT trust the reviewer summary above. Open the actual diff at \`${input.target}\` ` +
        `and re-derive whether this finding is genuine from first principles.\n` +
        `${READ_ONLY_GIT}`,
      lenses: ['correctness', 'security', 'does-it-reproduce'],
      votes: 3,
      maxVerifyClaims: 5,
      effort: verifyEffort,
      phase: 'Verify',
    })

    for (const w of verifyResult.warnings) warnings.push(w)
    lensTrails.push(verifyResult)

    return verifyResult.value
  }

  // Run review + verify pipeline concurrently across lenses (no barrier).
  const pipelineResults = await rt.pipeline(
    lenses as readonly unknown[],
    reviewStage,
    verifyStage,
  )

  // Collect verified findings across all lenses
  const allVerifiedFindings: Array<VerifiedClaim<FindingsOutput['findings'][number]>> = []
  for (const item of pipelineResults) {
    if (item === null) {
      // Entire lens pipeline dropped (reviewer died and verifyStage returned null)
      // dropped already incremented in verifyStage above for null reviewers;
      // a null at this level means the pipeline itself dropped the item
      continue
    }
    const verifiedArray = item as Array<VerifiedClaim<FindingsOutput['findings'][number]>>
    for (const vc of verifiedArray) {
      allVerifiedFindings.push(vc)
    }
  }

  // Build stats before synthesis
  const findingsRaw = allVerifiedFindings.length
  const findingsRefuted = allVerifiedFindings.filter(vc => vc.verdict === 'refuted').length
  const findingsVerified = findingsRaw - findingsRefuted

  // Findings to present in the final output (all — including refuted, for transparency)
  const outputFindings: VerifiedFinding[] = allVerifiedFindings.map(vc => ({
    title: vc.claim.title,
    file: vc.claim.file,
    severity: vc.claim.severity,
    detail: vc.claim.detail,
    verdict: vc.verdict,
  }))

  // Findings to pass to synthesis: keep all non-refuted findings.
  // Defence: keep-unverified-rather-than-drop — 'unverifiable' means a verifier
  // failed and 'unverified-by-cap' means the maxVerifyClaims cap withheld
  // verification; neither means the finding is wrong, so both stay included
  // in synthesis. Only 'refuted' is excluded.
  const synthesisFindings = allVerifiedFindings
    .filter(vc => vc.verdict !== 'refuted')
    .map(vc => ({
      title: vc.claim.title,
      file: vc.claim.file,
      severity: vc.claim.severity,
      detail: vc.claim.detail,
      verdict: vc.verdict,
    }))

  // -------------------------------------------------------------------------
  // Phase 'Synthesize' — genuine barrier.
  //
  // Why barrier here: synthesis needs ALL verified findings from ALL reviewers.
  // Only once the full pipeline (Review → Verify) has completed can we produce
  // a coherent overall verdict. rt.phase() records the phase transition.
  //
  // Defence (1): schema enforces { verdict, summary } shape.
  // Data crosses agent boundary as JSON.stringify of verified findings
  // (prompt text — the only safe transport between agent invocations).
  // -------------------------------------------------------------------------

  rt.phase('Synthesize')

  const synthesisPrompt =
    `## Task\n` +
    `You are synthesizing a code review for the change \`${input.target}\` (category: ${category}).\n\n` +
    `### Change summary\n${changeSummary.summary}\n\n` +
    `## Verified findings (non-refuted)\n` +
    '```json\n' + JSON.stringify(synthesisFindings, null, 2) + '\n```\n\n' +
    `## Output\n` +
    `Produce an overall verdict: "approve" if no high-severity confirmed findings remain, ` +
    `"request-changes" otherwise. Include a concise summary.\n` +
    `Return { "verdict": "approve"|"request-changes", "summary": "<concise summary>" }`

  const synthesisAgent = await rt.agent<SynthesisOutput>(synthesisPrompt, {
    schema: SYNTHESIS_SCHEMA,
    label: 'pr-review:synthesize',
    phase: 'Synthesize',
    effort: synthesizeEffort,
  })

  // Synthesis is the final gate — if it fails, surface a meaningful error
  if (synthesisAgent === null) {
    throw new Error(
      'pr-review: synthesis agent failed — unable to produce a verdict. ' +
      'Use resumeFromRunId to retry from the Synthesize phase (reviewed findings are cached).',
    )
  }

  return {
    category,
    verdict: synthesisAgent.verdict,
    summary: synthesisAgent.summary,
    findings: outputFindings,
    // Reviewer routing outcome: the pure identifier actually used (null =
    // standard subagent) + the structured probe story when routing was requested.
    reviewerType: resolvedReviewerType,
    probe: probeReport,
    verifierType: resolvedVerifierType,
    verifierProbe: verifierProbeReport,
    leafFence,
    stats: {
      reviewersSpawned,
      findingsRaw,
      findingsVerified,
      findingsRefuted,
      dropped,
    },
    envelope: { trail: collectTrail(routeResult, ...lensTrails) },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'pr-review',
    description: 'Multi-lens code review of a change set: classifies the change, spawns specialized reviewers, adversarially verifies findings, and synthesizes a verdict.',
    whenToUse: 'Use when you need a structured, adversarially-verified code review of a git ref range or change description.',
    phases: [
      { title: 'Fence', detail: 'Resolve the default leaf-agent fence (SendMessage denied by default)' },
      { title: 'Probe', detail: 'Resolve the requested reviewer agentType (graceful Claude fallback)' },
      { title: 'Route', detail: 'Classify the change and produce a targeted summary' },
      { title: 'Review', detail: 'Spawn specialized reviewer agents per lens' },
      { title: 'Verify', detail: 'Adversarially verify each finding (fresh-evidence check)' },
      { title: 'Synthesize', detail: 'Produce an overall verdict from verified findings' },
    ],
  },
  parseInput,
  run,
})
