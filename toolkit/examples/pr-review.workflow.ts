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
import { withAgentDefaults, MODEL_ALIASES } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias, AgentDefaults } from '@workflow-toolbox/runtime'
import { resolveEffort, resolveVerifierEffort } from '@workflow-toolbox/std'
import {
  autoSelectEffort,
  classifyAndAct,
  adversarialVerification,
  collectTrail,
  probeAgentType,
  withLeafFence,
  withLeanRouting,
} from '@workflow-toolbox/patterns'
import type {
  ClaimVerdict,
  VerifiedClaim,
  AgentTypeProbeReport,
  TrailRecord,
  LeafFenceReport,
  LeanRoutingReport,
} from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'
import { docsForChangedFiles } from './docs-provenance.js'
import type { ProvenanceEntry } from './docs-provenance.js'
import { isBridgeAgentType, parseRoleStringMap, resolveWrapperModel } from './opencode-routing.js'

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
  /** Proportionate-review ladder rung this run executes (card #1819690936574150367).
   *  'full' (default, and the result when the `mode` key is OMITTED entirely) is
   *  today's behavior, bit-compatible: the Review phase spawns one reviewer PER LENS
   *  (see REVIEWER_LENSES/DEFAULT_LENSES below, plus docs-alignment/docs-coverage when
   *  armed) — nothing in that code path changes when this field is 'full'.
   *  'single-verifier' is the quota-degraded rung (`~/.claude/rules/proportionate-
   *  verification.md`'s "single verifier" shape, made launchable in one call): the
   *  Review phase spawns EXACTLY ONE reviewer whose prompt is the UNION of every lens
   *  that would have been armed for this range (including docs-alignment/docs-coverage
   *  when the provenance manifest arms them) — same FINDINGS_SCHEMA. The `agentTypes.review`
   *  override still applies to that one reviewer (this is precisely the shape a
   *  cross-family/quota-degraded verifier like 'workflow-toolbox:opencode-verifier'
   *  wants). The Verify phase (adversarialVerification) is UNCHANGED and still runs on
   *  whatever that one reviewer found — the ladder degrades the FINDER count, never the
   *  verification of what was found. Synthesize is unchanged.
   *  NOTE — 'diff-read' (the ladder's bottom rung: the arbiter reads the diff directly
   *  instead of reviewing findings) is DELIBERATELY NOT a mode here: it means "do not
   *  invoke this workflow at all", so there is nothing for this workflow to execute for
   *  it. Requesting it (or any other unrecognized value) is a parse-time error.
   *  Parsed from the bespoke top-level `mode` key (like `provenance` — not part of the
   *  shared parseConfig envelope). */
  mode: 'full' | 'single-verifier'
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
  /** Optional per-ROLE Claude model for the WRAPPER agent itself (key
   *  'review'), validated against MODEL_ALIASES. A review lens routed to a
   *  NAME-RECOGNIZED external bridge agentType (isBridgeAgentType,
   *  opencode-routing.ts — e.g. 'workflow-toolbox:opencode-verifier') is a
   *  THIN RELAY, so the wrapper defaults to 'haiku' and the run-global
   *  `perAgent.model` deliberately does NOT reach it (residual leak fixed by
   *  card #1826112535493871358). A CLAUDE review lens — no agentType routed,
   *  OR a specialist agentType not on the bridge allowlist (e.g.
   *  'magic-claude:ts-reviewer') — KEEPS its normal tier, never forced to
   *  haiku (fail-safe: an unrecognized agentType is assumed Claude-family,
   *  never assumed a bridge). An explicit `models.review` always wins either
   *  direction. null = no override. Requested via the bespoke top-level
   *  `models` key (parseConfig ignores it, like `provenance`/`mode` above). */
  models: Readonly<{ review?: ModelAlias }> | null
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
   *  'route', 'review', 'verify', 'synthesize'. null = no overrides — every
   *  stage keeps its committed default. Resolved per-stage via resolveEffort
   *  (invalid/missing values degrade to the stage default, never throw); the
   *  'verify' role is additionally clamped to a 'high' floor via
   *  resolveVerifierEffort — an override may only raise it.
   *
   *  'auto' on the WORKER role 'review' (card #1809425610812949851) enables
   *  change-difficulty effort auto-selection for the reviewer agents:
   *  deterministic signals from the routed change summary (changed-file
   *  count, summary size) decide the clear extremes in code, else ONE
   *  best-model triage call scores the change ("when unsure, score UP").
   *  The 'verify' role NEVER auto-routes (quality floor); 'auto' on any
   *  other role keeps that role's committed default, as before. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
  /** Blanket opt-OUT of the default leaf-agent fence (withLeafFence): every agent
   *  this workflow spawns denies SendMessage by default. true = allow the standard
   *  (messaging-capable) subagent instead — set only when this run genuinely needs
   *  its agents to coordinate. null/false (default) = the fence applies. Parsed
   *  from `args.messaging` by the shared parseConfig helper. */
  messaging: boolean | null
  /** Optional REPLACEMENT docs-provenance manifest for the docs-alignment lens —
   *  the knob that arms the lens on an EXTERNAL repo (the bundled manifest maps
   *  dwt paths only, so a foreign repo's changedFiles never match it). Same
   *  shape and matching semantics as the committed manifest: each entry maps
   *  `sources` (a path ending in '/' covers its whole subtree, anything else is
   *  an EXACT file match) to the `docs` surfaces describing them. Provided → it
   *  REPLACES the bundled manifest for the whole cross-check (never merged —
   *  the bundled map is dwt-specific). Must be a NON-EMPTY array when present:
   *  to leave the lens on the bundled manifest, omit the knob entirely (an
   *  empty array is more likely an authoring mistake than an intent). null =
   *  the bundled manifest. The result reports which one was consulted via
   *  `provenanceSource`. */
  provenance: readonly ProvenanceEntry[] | null
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
    // Runaway bounds (card #1820561035728258107, lived: a long/dense target
    // starved the REQUIRED riskAreas out of the JSON entirely — the unbounded
    // long-array sibling is exactly what eats the budget first). Same posture
    // as addedPublicSurface below: schema-level runaway bound, not a
    // truncation license.
    riskAreas: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 40 },
    // Repo-relative changed paths (`git diff --name-only <range>`). The
    // DECISION on this data is mechanical (deterministic path matching against
    // the committed docs-provenance manifest → docs-alignment lens on/off),
    // but the DATA is agent-reported from the real diff, not independently
    // verified — the script has no fs/git access to cross-check it.
    // maxItems is a schema-level runaway bound, not a truncation license — an
    // agent that lists fewer files only under-triggers the lens (the Tier 1
    // docs-contract gate still guards the anchors mechanically), and an EMPTY
    // list on a range-shaped target trips the degenerate-output warning below.
    changedFiles: { type: 'array', items: { type: 'string' }, maxItems: 200 },
    // NEW public surface this change ADDS (exports, HTTP routes, env vars,
    // CLI verbs/flags, config knobs) — the docs-coverage lens's arming
    // signal. Same trust posture as changedFiles: the DECISION is mechanical
    // script code, the DATA is agent-reported from the real diff. An empty
    // array is schema-valid ("nothing new exposed"), so a capitulating agent
    // only UNDER-arms the lens — the repos' inverse docs-contract gates
    // still hold the enumerable classes mechanically.
    addedPublicSurface: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 40 },
  },
  required: ['summary', 'riskAreas', 'changedFiles', 'addedPublicSurface'],
  additionalProperties: false,
} as const satisfies JsonSchema

// Shared contract line for every act prompt below. The mechanical fields come
// FIRST — changedFiles, then addedPublicSurface, then riskAreas, then the
// free-text summary LAST: the observed failure was generation-order — a long
// summary emitted first starved the required sibling fields. Short/required-
// first is the same convention the other compositions already follow ("score"
// then "reason", "verdict" then "summary"). The literal JSON templates in the
// act prompts MUST show every required field (review finding, run
// wf_4115390a-8a0: a template still showing the old 3-field shape invites
// exactly the capitulation the schema bounds exist to catch).
const CHANGE_SUMMARY_RULES =
  'All four fields are REQUIRED. Emit "changedFiles" FIRST (the repo-relative paths from ' +
  '`git diff --name-only <range>`, up to 200), then "addedPublicSurface" — ONLY the NEW public ' +
  'surface this change ADDS (new exports, HTTP routes, env vars, CLI verbs/flags, config knobs), ' +
  'one short entry each, e.g. "export: parsePipelineSpec" or "env var: SERVER_TTL"; an EMPTY array ' +
  'when the change exposes nothing new — then "riskAreas" (up to 40 short entries), then ' +
  '"summary" — at most 500 characters (the schema rejects longer). Never satisfy the schema ' +
  'with placeholder values ("test", "a"); if a field is hard to fill, shorten it — do not fake it.'

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
// classifyAndAct's `act` goal template — shared markdown builder for the five
// per-category prompts below (feature/bugfix/refactor/config/docs). Markdown
// (## sections + bullets) instead of one flat paragraph so observe's
// markdown-rendering goal display (card #1820724046774404234, the UI side of
// this fix) has real structure to render — the run wf_d55a5b96 witness showed
// a flat `classifyAndAct:act:feature:0` goal with nothing for it to format.
// Rule of Three: the five categories share this exact shape (task, what to
// report, output contract) and differ only in the category label, the
// "summary" ask, and an optional extra task line (bugfix's "re-derive from
// first principles") — one builder, not five near-identical copies.
//
// ⚠ ANTI-CAPITULATION INVARIANT (do not reorder): the Output Contract section's
// literal `Return {...}` field order — changedFiles, addedPublicSurface,
// riskAreas, summary LAST — is load-bearing (see CHANGE_SUMMARY_RULES above,
// run wf_4115390a-8a0). Restructuring into markdown must NOT touch this order.
//
// ⚠ TEST-COUPLED LITERAL (do not reword): "You are reviewing a <CATEGORY>
// change." is matched case-insensitively by the test suite's prompt router
// (`p.includes('you are reviewing a')`, examples/test/pr-review.test.ts) —
// keep it as the opening line verbatim.
function actPrompt(category: string, summaryAsk: string, extraTaskLine?: string): (target: string) => string {
  return (target) =>
    `You are reviewing a ${category} change.\n\n` +
    `## Task\n` +
    `- Inspect the actual change: ${target}.${extraTaskLine !== undefined ? ` ${extraTaskLine}` : ''}\n` +
    `- ${READ_ONLY_GIT}\n\n` +
    `## What to report\n` +
    `- **Risk areas**: the change's real risk areas, short entries.\n` +
    `- **Summary**: ${summaryAsk}.\n\n` +
    `## Output contract\n` +
    `Return { "changedFiles": ["<path>", ...], "addedPublicSurface": ["<new export/route/env var/CLI flag>", ...], ` +
    `"riskAreas": ["<risk1>", ...], "summary": "<...>" }. ${CHANGE_SUMMARY_RULES}`
}

// Render a review target as its own fenced block, split from the surrounding
// instruction prose. A target is user-supplied and — since targets conventionally
// embed the repo path — is commonly a multi-line paragraph, not a short path or
// git range. Inline-backtick-wrapping such a value renders as a single giant
// inline-code span in transcript viewers; a fenced block renders cleanly at any
// length and reads more clearly for the reviewing models too.
function targetBlock(target: string): string {
  return '```\n' + target + '\n```'
}

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

// Sentinel pipeline item for `mode: 'single-verifier'` — the Review phase
// spawns EXACTLY ONE reviewer covering every armed lens' instructions
// combined, instead of the one-reviewer-per-lens fan below. Never collides
// with a real lens name (every real lens key comes from REVIEWER_LENSES,
// DEFAULT_LENSES, 'docs-alignment', or 'docs-coverage').
const CONSOLIDATED_LENS = 'consolidated'

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
  /** The resolved mode this run executed — 'full' (default/omitted) or
   *  'single-verifier'. See the `mode` field's doc comment on PrReviewInput. */
  mode: 'full' | 'single-verifier'
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
  /** Lean-routing outcome (withLeanRouting): whether the Synthesize stage —
   *  the run's one provably pure, tool-free stage — defaulted to the
   *  minimal-ambient-context agentType, or degraded/opted out. Classify,
   *  Review, and Verify are NOT routed here: each of those prompts explicitly
   *  instructs its agent to inspect the actual diff/repo (READ_ONLY_GIT), so
   *  they genuinely need tool access and would break if fenced to zero tools. */
  leanRouting: LeanRoutingReport
  /** Doc surfaces the docs-provenance manifest mapped to this change's files.
   *  Non-empty = the docs-alignment reviewer lens ran, scoped to exactly these
   *  surfaces; empty = no mapped module touched, lens skipped. */
  provenanceDocs: readonly string[]
  /** Which manifest the lens cross-check consulted: 'input' = the launch-time
   *  `provenance` knob (external-repo review), 'bundled' = the committed dwt
   *  manifest (default). Observability guard: without it, a mis-shaped launch
   *  manifest that matches nothing would be indistinguishable from "no mapped
   *  module touched" — the same silent-disarm class the empty-changedFiles
   *  warning covers. */
  provenanceSource: 'input' | 'bundled'
  /** The Route-reported NEW public surfaces that armed the docs-coverage
   *  lens. Empty = lens silent: the change adds no new surface, or a doc
   *  file was touched in the same diff (the author engaged the docs — the
   *  alignment lens and the mechanical gates cover that path). Observability
   *  guard against silent disarm, same class as provenanceSource. */
  coverageSurfaces: readonly string[]
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

// Bounds on the launch-time provenance manifest — anti-inflation caps (an
// operator mistake, e.g. passing a whole file tree, would otherwise balloon
// the lens prompt) sized well above any real manifest (the largest committed
// one has 12 entries).
const MAX_PROVENANCE_ENTRIES = 64
const MAX_PROVENANCE_PATHS_PER_FIELD = 32
const MAX_PROVENANCE_PATH_LENGTH = 300
// A provenance "path" must look like one: no control characters (newlines
// would break the prompt's line-per-surface layout) and no backticks (the
// docs paths are interpolated inside backtick-quoted markdown in the
// docs-alignment reviewer prompt — a backtick there is an injection vector,
// never a legitimate repo-relative path).
const PROVENANCE_PATH_RE = /^[^`\u0000-\u001f\u007f]+$/

/** Validate the optional launch-time `provenance` manifest: a NON-EMPTY array
 *  of { sources, docs } entries, each a non-empty array of path-shaped
 *  strings (repo-relative), within the size bounds above. Fail-fast +
 *  actionable: a malformed manifest silently matching nothing would disarm
 *  the docs-alignment lens — exactly the degradation this knob's
 *  `provenanceSource` output field exists to make visible. */
function parseProvenance(raw: unknown): readonly ProvenanceEntry[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      'pr-review: "provenance" must be a NON-EMPTY array of { sources, docs } entries — ' +
      'omit it entirely to use the bundled dwt manifest',
    )
  }
  if (raw.length > MAX_PROVENANCE_ENTRIES) {
    throw new Error(
      `pr-review: "provenance" has ${raw.length} entries — the cap is ${MAX_PROVENANCE_ENTRIES}`,
    )
  }
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `pr-review: provenance[${i}] must be an object with "sources" and "docs" string arrays`,
      )
    }
    const e = entry as Record<string, unknown>
    for (const field of ['sources', 'docs'] as const) {
      const v = e[field]
      if (
        !Array.isArray(v) ||
        v.length === 0 ||
        v.some((s) => typeof s !== 'string' || s.trim().length === 0)
      ) {
        throw new Error(
          `pr-review: provenance[${i}].${field} must be a non-empty array of non-empty strings ` +
          '(repo-relative paths; a path ending in "/" covers its subtree, otherwise exact file match)',
        )
      }
      if (v.length > MAX_PROVENANCE_PATHS_PER_FIELD) {
        throw new Error(
          `pr-review: provenance[${i}].${field} has ${v.length} paths — the cap is ${MAX_PROVENANCE_PATHS_PER_FIELD}`,
        )
      }
      for (const s of v as string[]) {
        if (s.length > MAX_PROVENANCE_PATH_LENGTH || !PROVENANCE_PATH_RE.test(s)) {
          throw new Error(
            `pr-review: provenance[${i}].${field} contains "${s.slice(0, 60)}…" — ` +
            `each path must be ≤ ${MAX_PROVENANCE_PATH_LENGTH} chars with no backticks or control characters`,
          )
        }
      }
    }
    return { sources: e['sources'] as string[], docs: e['docs'] as string[] }
  })
}

// pr-review routes only ONE role (`review`) through the shared bridge-routing
// doctrine — unlike coverage-audit/docs-audit's 3-role map (inventory/
// extract/verify). Same convention (parseRoleStringMap from opencode-
// routing.ts, see its header comment for the Rule-of-Three rationale), scoped
// to pr-review's own role set.
const MODELS_ROLE_KEYS = ['review'] as const

function parseModels(raw: unknown): Readonly<{ review?: ModelAlias }> | null {
  return parseRoleStringMap(raw, 'models', MODEL_ALIASES, MODELS_ROLE_KEYS, 'pr-review') as
    Readonly<{ review?: ModelAlias }> | null
}

// Proportionate-review ladder rungs this workflow accepts as `mode`.
// 'diff-read' — the ladder's bottom rung — is DELIBERATELY EXCLUDED: it means
// "do not invoke this workflow at all" (the arbiter reads the diff directly),
// so there is no run-time behavior for it to select. See the `mode` field's
// doc comment on PrReviewInput for the full rationale.
const ALLOWED_MODES = ['full', 'single-verifier'] as const
type PrReviewMode = typeof ALLOWED_MODES[number]

/** Validate the optional launch-time `mode` key. undefined/null → 'full' (the
 *  default rung, bit-compatible with pre-ladder behavior). Any other value
 *  must be one of ALLOWED_MODES — fail-fast + actionable, same discipline as
 *  parseProvenance, and the one place that spells out why 'diff-read' throws
 *  instead of silently degrading. */
function parseMode(raw: unknown): PrReviewMode {
  if (raw === undefined || raw === null) return 'full'
  if (typeof raw !== 'string' || !(ALLOWED_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `pr-review: "mode" must be one of ${ALLOWED_MODES.join(', ')} — got ${JSON.stringify(raw)}. ` +
      `("diff-read" is deliberately NOT a mode: the proportionate-review ladder's bottom rung ` +
      `means "do not invoke this workflow at all" — read the diff directly instead.)`,
    )
  }
  return raw as PrReviewMode
}

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
      mode: 'full',
      reviewerType: null,
      models: null,
      verifierModel: null,
      verifierType: null,
      perAgent: null,
      effort: null,
      messaging: null,
      provenance: null,
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
  // Bespoke pr-review key (parseConfig ignores it): the external-repo
  // docs-provenance manifest for the docs-alignment lens.
  const provenance = parseProvenance(obj['provenance'])

  // Bespoke pr-review key (parseConfig ignores it, like provenance above):
  // the proportionate-review ladder rung. undefined → 'full'.
  const mode = parseMode(obj['mode'])

  // Bespoke pr-review key (parseConfig ignores it, like provenance/mode
  // above): the wrapper-model gate for the review lens (card #1826112535493871358).
  const models = parseModels(obj['models'])

  return { target: obj['target'], mode, reviewerType, models, verifierModel, verifierType, perAgent, effort, messaging, provenance }
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

  // Lean routing — a SEPARATE, SELECTIVE default (unlike the blanket leaf
  // fence above): resolved once here on the fenced `rt0`, but only actually
  // applied to the one stage below that is provably pure (Synthesize — its
  // entire prompt is inline summary + JSON, no "inspect the diff" instruction
  // anywhere in it). Classify/Review/Verify all explicitly instruct their
  // agents to read the actual change via READ_ONLY_GIT, so they keep the
  // normal (tool-capable) runtime — routing them here would strip the very
  // tool access their fresh-evidence defence depends on. See lean-routing.ts.
  // `messaging: true` disables this too: `lean.md` also denies SendMessage
  // (empty tools allowlist), so honoring a run's explicit request for
  // messaging-capable agents means standing BOTH capability fences down, not
  // just the leaf one — a silent SendMessage denial on the one call this knob
  // was meant to exempt would be exactly the regression withLeafFence guards
  // against elsewhere.
  const { rt: leanBase, report: leanRouting } = await withLeanRouting(rt0, {
    phase: 'Fence',
    disabled: input.messaging === true,
    ...(input.perAgent !== null ? { perAgent: input.perAgent } : {}),
  })

  // Class-A one-wiring-point: wrap the runtime ONCE so the blanket per-agent
  // defaults reach every agent in every pattern below (per-call/pattern opts
  // still win). When no perAgent was supplied this is a no-op passthrough.
  // Applied identically to BOTH the fenced runtime (rt, used by every
  // tool-needing stage) and the lean-defaulting runtime (leanRt, used ONLY by
  // Synthesize below) so a workflow author's blanket override wins on either.
  const rt = input.perAgent !== null ? withAgentDefaults(rt0, input.perAgent) : rt0
  const leanRt = input.perAgent !== null ? withAgentDefaults(leanBase, input.perAgent) : leanBase
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
  // `let`: with effort.review === 'auto' this is re-resolved from the routed
  // change summary once it exists (post-Route) — see the auto-effort block.
  let reviewEffort = resolveEffort(input.effort?.['review'], REVIEW_EFFORT)
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
    const probe = await probeAgentType(rt, input.reviewerType, { phase: 'Probe', required: true })
    resolvedReviewerType = probe.agentType ?? null
    probeReport = { requested: input.reviewerType, available: probe.available, reason: probe.reason }
  }

  // Wrapper-role Claude model for the review lens (card #1826112535493871358,
  // GATED doctrine adapted from coverage-audit/docs-audit's `models`, commit
  // 340437f). UNLIKE those two workflows, `agentTypes.review` here is
  // documented DUAL-PURPOSE (a same-family Claude specialist OR a
  // cross-family bridge) — so "agentType resolved" is NOT a valid bridge
  // proxy: a name-based discriminator decides instead (isBridgeAgentType,
  // arbiter ruling "Option B"). A bridge-routed review lens (e.g.
  // workflow-toolbox:opencode-verifier) defaults to 'haiku' (perAgent.model
  // does NOT reach it); a CLAUDE review lens — no agentType routed, OR a
  // specialist agentType not on the bridge allowlist (e.g.
  // magic-claude:ts-reviewer) — KEEPS its normal tier, fail-safe toward
  // quality. `models.review` always wins when supplied, either direction.
  const reviewModel = resolveWrapperModel(isBridgeAgentType(resolvedReviewerType), input.models?.review)

  // Same probe-then-resolve treatment for the Verify fan's routing request
  // (agentTypes.verify) — mirrors the reviewerType block above exactly, so an
  // unavailable cross-family verifier degrades to the standard subagent
  // instead of silently starving every verify call.
  let resolvedVerifierType: string | null = null
  let verifierProbeReport: AgentTypeProbeReport | null = null
  if (input.verifierType !== null) {
    rt.phase('Probe')
    const probe = await probeAgentType(rt, input.verifierType, { phase: 'Probe', required: true })
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
        prompt: actPrompt('FEATURE', 'what the feature does'),
        effort: routeActEffort,
      },
      bugfix: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: actPrompt('BUGFIX', 'what was broken and how it is fixed', 're-derive from first principles.'),
        effort: routeActEffort,
      },
      refactor: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: actPrompt('REFACTOR', 'what was refactored and why'),
        effort: routeActEffort,
      },
      config: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: actPrompt('CONFIG', 'what config changed and its effect'),
        effort: routeActEffort,
      },
      docs: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: actPrompt('DOCS', 'what documentation was updated'),
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

  // Auto-effort for the reviewer WORKERS (card #1809425610812949851, opt-in
  // via effort.review === 'auto'): now that the routed change summary exists,
  // deterministic signals (changed-file count, summary size) decide the clear
  // extremes in code; otherwise ONE best-model triage call scores the change
  // ("when unsure, score UP"). Fallback = the committed 'review' default.
  // The verify fan's 'high' floor is untouched (resolveVerifierEffort).
  if (input.effort?.['review'] === 'auto') {
    const selection = await autoSelectEffort(rt, [{
      id: 'change',
      brief: `${category} change: ${changeSummary.summary.slice(0, 400)}`,
      signals: {
        filesTouched: changeSummary.changedFiles.length,
        specChars: changeSummary.summary.length,
      },
    }], { fallback: REVIEW_EFFORT, phase: 'Route', label: 'pr-review:auto-effort' })
    for (const w of selection.warnings) {
      warnings.push(w)
      rt.log(`⚠ ${w}`)
    }
    reviewEffort = selection.efforts['change'] ?? REVIEW_EFFORT
    rt.log(`pr-review: auto-effort selected '${reviewEffort}' for the review stage (${selection.decidedBy['change'] ?? 'fallback'})`)
  }

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

  // Same guard class for changedFiles (review finding, run wf_0decbfe8-7e4):
  // an act agent that capitulates to `"changedFiles": []` is schema-valid and
  // otherwise indistinguishable from "no mapped module touched" — it silently
  // disarms the docs-alignment lens. A git-range-shaped target ALWAYS changes
  // at least one file, so an empty list there is capitulation, not signal.
  // Heuristic + loud, never fatal: a free-text change DESCRIPTION (no range
  // syntax) can legitimately have no file list.
  const looksLikeGitRange = /[0-9a-f]{6,40}|\bHEAD\b|\.\./.test(input.target)
  if (changeSummary.changedFiles.length === 0 && looksLikeGitRange) {
    const w =
      `route: empty changedFiles from the ${category} act stage on a range-shaped target — ` +
      'likely schema capitulation; the docs-alignment lens is DISARMED for this run ' +
      '(docs-coverage arms off addedPublicSurface, a separate field — though a capitulating ' +
      'agent has likely emptied both; stale prose anchors remain covered by the mechanical ' +
      'docs-contract gate)'
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

  // Provenance-triggered docs-alignment lens (Tier 2 of the doc-alignment
  // defence). MECHANICAL trigger, zero extra agents when nothing mapped is
  // touched: the Route stage's changedFiles are prefix-matched against the
  // docs-provenance manifest — the launch-time `provenance` input when
  // provided (external-repo review), else the committed dwt manifest
  // (bundled at build time — the sandbox has no fs). A hit appends ONE extra
  // reviewer scoped to the mapped surfaces. The judgment (is the prose still
  // true?) stays with the LLM reviewer; the decision to spawn it is
  // deterministic script code.
  const provenanceSource: 'input' | 'bundled' = input.provenance !== null ? 'input' : 'bundled'
  const provenanceDocs = docsForChangedFiles(
    changeSummary.changedFiles,
    input.provenance ?? undefined,
  )
  if (provenanceDocs.length > 0) {
    rt.log(
      `docs-alignment lens armed: ${provenanceDocs.length} mapped doc surface(s) for this change (${provenanceSource} manifest)`,
    )
  }

  // docs-coverage lens (Tier 2 INVERSE of the doc-alignment defence): the
  // change ADDS public surface (Route-reported) while touching NO doc file —
  // one extra reviewer judges "user-facing or internal?" per added surface.
  // A diff that touches any .md (or a mapped doc surface) is treated as the
  // author engaging the docs: the alignment lens and the mechanical gates
  // cover the QUALITY of that engagement, so coverage stays silent there.
  const docsTouchedInDiff = changeSummary.changedFiles.some(
    (f) => f.endsWith('.md') || provenanceDocs.includes(f),
  )
  const coverageSurfaces: readonly string[] =
    !docsTouchedInDiff && changeSummary.addedPublicSurface.length > 0
      ? changeSummary.addedPublicSurface
      : []
  if (coverageSurfaces.length > 0) {
    rt.log(
      `docs-coverage lens armed: ${coverageSurfaces.length} added public surface(s), no doc file touched`,
    )
  } else if (changeSummary.addedPublicSurface.length > 0) {
    // Loud suppression (review finding, run wf_4115390a-8a0): without this
    // line, "surface added but the author touched docs" is indistinguishable
    // in the logs from "nothing new was exposed".
    rt.log(
      `docs-coverage lens silent: ${changeSummary.addedPublicSurface.length} added public surface(s) ` +
      `but doc files are part of this change — the docs-alignment lens and the mechanical gates cover that path`,
    )
  }

  const baseLenses = REVIEWER_LENSES[category] ?? DEFAULT_LENSES
  const lenses = [
    ...baseLenses,
    ...(provenanceDocs.length > 0 ? ['docs-alignment'] : []),
    ...(coverageSurfaces.length > 0 ? ['docs-coverage'] : []),
  ]

  // Proportionate-review ladder (card #1819690936574150367): 'full' (default)
  // runs the pipeline over EVERY lens below — one reviewer each, exactly the
  // pre-ladder code path (reviewItems === lenses, byte-identical prompts).
  // 'single-verifier' collapses the fan to ONE sentinel item; reviewStage
  // below special-cases CONSOLIDATED_LENS to build a single prompt covering
  // every lens' instructions combined instead of iterating them.
  const isConsolidated = input.mode === 'single-verifier'
  const reviewItems: readonly string[] = isConsolidated ? [CONSOLIDATED_LENS] : lenses

  // Per-lens reviewer instructions (review finding, run wf_4115390a-8a0: the
  // former three-way nested ternary duplicated structure per branch — extracted
  // to one early-return builder per lens family).
  // - docs-alignment reviews the mapped DOC SURFACES against the change (its
  //   findings are stale claims in prose);
  // - docs-coverage is its INVERSE: it judges the NEW surface the change adds
  //   without touching any doc;
  // - every other lens reviews the code itself.
  const lensInstructionsFor = (lens: string): string => {
    if (lens === 'docs-coverage') {
      // Added-surface strings are agent-derived from the UNTRUSTED diff and
      // get interpolated into the prompt list — strip backticks and control
      // characters so a hostile diff cannot escape the list formatting (same
      // injection class as the launch-time provenance paths). Semantic
      // injection (a misleading surface DESCRIPTION) is out of scope here by
      // design: the data is agent-reported like every other Route field, and
      // the refute-first Verify fan re-derives findings from the real diff.
      const sanitizedSurface = (s: string): string =>
        s.replace(/[`\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, 200)
      return (
        `The routing stage reports this change ADDS the following public surface, while touching ` +
        `NO documentation file:\n` +
        coverageSurfaces.map((s) => `- ${sanitizedSurface(s)}`).join('\n') +
        `\n\nMapped doc homes for the changed modules (docs-provenance manifest):\n` +
        (provenanceDocs.length > 0
          ? provenanceDocs.map((d) => `- \`${d}\``).join('\n')
          : `- (none mapped — name the natural home)`) +
        `\n\nRead the ACTUAL change first (${READ_ONLY_GIT}). For EACH added surface, judge: is it ` +
        `USER-FACING (an author, operator, or consumer must know it to use the product) or internal ` +
        `plumbing?\n` +
        `- User-facing and undocumented = one finding: set \`file\` to the SOURCE path that grew the ` +
        `surface, and in \`detail\` name the doc surface where it should be described (a mapped home ` +
        `above when the module is mapped; otherwise the natural home, plus suggest adding the ` +
        `docs-provenance pair). Severity by consumer impact: a surface a consumer cannot discover ` +
        `without reading source = high; a niche or advanced knob = medium; marginal = low.\n` +
        `- Internal-only additions are NOT findings — at most note them as candidates for the repo's ` +
        `reasoned exemption allowlists.\n` +
        `Do NOT re-review the code quality itself (other lenses do), and do NOT report surfaces this ` +
        `change does not add.`
      )
    }
    if (lens === 'docs-alignment') {
      return (
        `These committed doc surfaces (repo-relative) document the modules this change touches:\n` +
        provenanceDocs.map((d) => `- \`${d}\``).join('\n') +
        `\n\nRead the ACTUAL change first (${READ_ONLY_GIT}), then read EACH mapped surface and check ` +
        `every claim it makes about the changed behavior is still true after this change — names, ` +
        `defaults, option lists, counts, quoted values, described semantics, worked examples.\n` +
        `A finding = one claim that is now false or misleading; set \`file\` to the DOC path and quote ` +
        `the stale sentence in \`detail\` with what it should say instead. Severity by consumer impact: ` +
        `an author following the doc builds the wrong thing = high; imprecise but harmless = low.\n` +
        `Do NOT review the code itself (other lenses do), and do NOT report doc prose the change does not affect.`
      )
    }
    return (
      `Read the ACTUAL change (you have repo access). Do NOT trust the summary above — re-derive findings from first principles.\n` +
      `${READ_ONLY_GIT}\n` +
      `Focus ONLY on the "${lens}" lens.`
    )
  }

  // reviewStage: for a given lens, spawn one reviewer agent with focused scope.
  // The stage receives the lens as originalItem (items = reviewItems: `lenses`
  // in 'full' mode, or the single CONSOLIDATED_LENS sentinel in
  // 'single-verifier' mode).
  const reviewStage = async (
    _prev: unknown,
    originalItem: unknown,
  ): Promise<FindingsOutput | null> => {
    const lens = originalItem as string

    reviewersSpawned++

    // mode: 'single-verifier' — ONE consolidated reviewer whose prompt is the
    // UNION of every armed lens' own instructions (built from the SAME
    // lensInstructionsFor used by the per-lens path below), instead of
    // spawning one reviewer per lens. Same FINDINGS_SCHEMA, same
    // agentTypes.review routing, same effort — only the FAN collapses.
    if (lens === CONSOLIDATED_LENS) {
      const consolidatedInstructions = lenses
        .map((l) => `### Lens: ${l}\n${lensInstructionsFor(l)}`)
        .join('\n\n')

      const result = await rt.agent<FindingsOutput>(
        `## Role\n` +
        `You are reviewing this change in single-verifier mode: ONE consolidated pass ` +
        `covering every lens that would normally get its own reviewer (${lenses.join(', ')}).\n\n` +
        `## Change\n` +
        `**Target:**\n${targetBlock(input.target)}\n\n` +
        `### Summary (from the routing stage)\n${changeSummary.summary}\n\n` +
        `### Risk areas\n${changeSummary.riskAreas.map((r) => `- ${r}`).join('\n')}\n\n` +
        `## Instructions — cover EVERY lens below, in full\n${consolidatedInstructions}\n\n` +
        `## Output\n` +
        `Return your findings across ALL lenses combined. Each finding: \`{ title, file, severity ('high'|'medium'|'low'), detail }\``,
        {
          schema: FINDINGS_SCHEMA,
          label: 'pr-review:reviewer:consolidated',
          phase: 'Review',
          effort: reviewEffort,
          // Same agentTypes.review routing as the per-lens path — this is
          // precisely the shape a cross-family/quota-degraded verifier wants.
          ...(resolvedReviewerType !== null ? { agentType: resolvedReviewerType } : {}),
          // Wrapper-model gate (card #1826112535493871358): haiku by default
          // when bridge-routed, models.review override, or the Claude tier
          // unchanged when not bridge-routed (undefined → omitted).
          ...(reviewModel !== undefined ? { model: reviewModel } : {}),
        },
      )

      return result
    }

    const lensInstructions = lensInstructionsFor(lens)

    // Defence (1): schema enforces the findings shape at this consumed boundary.
    // Prompt is STRUCTURED MARKDOWN (## sections, bullets), not one \n-joined wall:
    // transcript viewers render markdown, where a single \n does NOT break a paragraph —
    // the old shape read as one giant unscannable blob (user finding, 2026-07-08).
    const result = await rt.agent<FindingsOutput>(
      `## Role\n` +
      `You are a specialized code reviewer examining the **${lens}** aspect of this change.\n\n` +
      `## Change\n` +
      `**Target:**\n${targetBlock(input.target)}\n\n` +
      `### Summary (from the routing stage)\n${changeSummary.summary}\n\n` +
      `### Risk areas\n${changeSummary.riskAreas.map((r) => `- ${r}`).join('\n')}\n\n` +
      `## Instructions\n` +
      `${lensInstructions}\n\n` +
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
        // Wrapper-model gate (card #1826112535493871358): haiku by default
        // when bridge-routed, models.review override, or the Claude tier
        // unchanged when not bridge-routed (undefined → omitted).
        ...(reviewModel !== undefined ? { model: reviewModel } : {}),
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
      // Per-lens stage/label discriminator (card #1816036725248493168,
      // amendment A2 — the flagship remediation of the original finding, run
      // wf_7b5bb844-368): this verifyStage runs once per lens via
      // rt.pipeline's no-barrier per-item stages, all on the SAME `rt` — the
      // auto salt counter would assign completion-order numbers (concurrent
      // invocations), non-deterministic across resumeFromRunId replays. The
      // lens name is a stable, author-meaningful key instead: every real lens
      // (base categories, 'docs-alignment', 'docs-coverage', 'consolidated')
      // matches the stageKey charset/shape rule claimStageInstance canonically
      // enforces (letters, digits, underscore, dot, hyphen, 1-32 chars, not
      // purely numeric — see stage-instance.ts's STAGE_KEY_PATTERN, the ONE
      // source of truth for this rule) — none of these lens names is purely
      // numeric, so none collides with the auto counter's own ' #<n>' format.
      stageKey: lens,
      claims: findings,
      renderClaim: (finding) =>
        `## Claim to verify (lens: ${lens})\n` +
        `**${finding.title}** — \`${finding.file}\` · severity: ${finding.severity}\n\n` +
        `${finding.detail}\n\n` +
        `## Instructions\n` +
        `IMPORTANT: Do NOT trust the reviewer summary above. Open the actual diff at the target below ` +
        `and re-derive whether this finding is genuine from first principles.\n\n` +
        `**Target:**\n${targetBlock(input.target)}\n\n` +
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

  // Run review + verify pipeline concurrently across reviewItems (no barrier).
  // 'full' mode: one pipeline slot per lens (byte-identical to pre-ladder).
  // 'single-verifier' mode: one pipeline slot — the consolidated sentinel.
  const pipelineResults = await rt.pipeline(
    reviewItems as readonly unknown[],
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
    `You are synthesizing a code review for the change below (category: ${category}).\n\n` +
    `**Target:**\n${targetBlock(input.target)}\n\n` +
    `### Change summary\n${changeSummary.summary}\n\n` +
    `## Verified findings (non-refuted)\n` +
    '```json\n' + JSON.stringify(synthesisFindings, null, 2) + '\n```\n\n' +
    `## Output\n` +
    `Produce an overall verdict: "approve" if no high-severity confirmed findings remain, ` +
    `"request-changes" otherwise. Include a concise summary.\n` +
    `Return { "verdict": "approve"|"request-changes", "summary": "<concise summary>" }`

  // Routed through leanRt: this prompt's entire content (change summary +
  // JSON-stringified verified findings) is already inline above — the agent
  // never needs to inspect the repo, so it is the run's one lean-eligible call.
  const synthesisAgent = await leanRt.agent<SynthesisOutput>(synthesisPrompt, {
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
    mode: input.mode,
    findings: outputFindings,
    // Reviewer routing outcome: the pure identifier actually used (null =
    // standard subagent) + the structured probe story when routing was requested.
    reviewerType: resolvedReviewerType,
    probe: probeReport,
    verifierType: resolvedVerifierType,
    verifierProbe: verifierProbeReport,
    leafFence,
    leanRouting,
    provenanceDocs,
    provenanceSource,
    coverageSurfaces,
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
    whenToUse: 'Use when you need a structured, adversarially-verified code review of a git ref range or change description. ' +
      'Pass mode: "single-verifier" for the quota-degraded proportionate-review rung (one consolidated reviewer instead ' +
      'of one per lens); the ladder\'s bottom rung ("diff-read": read the diff yourself, no findings to verify) is not a ' +
      'mode this workflow accepts — don\'t launch it for that case.',
    phases: [
      { title: 'Fence', detail: 'Resolve the default leaf-agent fence (SendMessage denied by default) and the lean-routing default for the pure Synthesize stage' },
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
