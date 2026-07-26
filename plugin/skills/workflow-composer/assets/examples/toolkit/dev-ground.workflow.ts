// dev-ground.workflow.ts — grounding-first stage 1 of the dev loop: check a
// card's enumerated premises against reality BEFORE any code is written, and
// recommend cancel / reframe / proceed.
//
// WHY THIS EXISTS: docs/internal/dev-loop-as-workflows-design-brief.md (carte
// #1818921945756861933) documents the "recette" the arbitre session already
// runs by hand — plan ↔ critic → TDD → gates ↔ review — and identifies that
// its FIRST rung, grounding, was never mechanized. The brief's own lived case
// (14/07, cards #1819053659325990500 / #1819020803027502679): the card claimed
// an HTTP 500 the real code no longer returned (it was 409) — grounding
// CORRECTED THE CARD, not the code. Three of three premises on another card
// were refuted with no alternative → the grounding killed an L-sized plan
// before the first line of code. That is this workflow's reason to exist:
// automation that checks premises BEFORE spending implementation budget.
//
// PEDAGOGY — four defence layers (same as pr-review / independent-analysis /
// cross-model-verify):
//  (1) SCHEMA at every consumed boundary — D3 below.
//  (2) REFUTE-FIRST verification — votes tallied in code (adversarialVerification).
//  (3) DECOMPOSED — two disjoint arms (external research / internal analysis)
//      + a PoC canary sub-stage, none of which sees the whole picture alone.
//  (4) UNTRUSTED EMBEDDING — caller text (premise statements, context,
//      arbiterHypotheses, prediction) is data, never instructions.
//
// MODEL NOTE: mechanical probe fan-outs (the arms' per-premise research, the
// PoC canary) pin a cheap model; verification pins BEST_MODEL (never inherit
// the session model silently — the repo-wide fan-out rule).
// CROSS-MODEL NOTE: `args.agentTypes.verify` / `args.agentTypes.ground` route
// through the same probe/graceful-fallback convention as every sibling
// workflow (independent-analysis, cross-model-verify, pr-review) — never a
// bespoke top-level arg.
//
// THREE FLAGGED DECISIONS (provenance, so the next reader does not re-litigate
// them):
//  (1) SEQUENCING KILL-REASON — docs/internal/dev-loop-phase-b-tri.md:112 puts
//      B1 (dev-ground) THIRD in the Phase-C order ("après que le pilote
//      existe, car c'est lui qui le route"). Building it first inverts that
//      order. Kill reason: that doc's own status line (dev-loop-phase-b-tri.md:7)
//      reads "Statut : proposition d'arbitre, À RATIFIER" — it is
//      UNRATIFIED — and the pilot only ROUTES dev-ground (a launch-time
//      decision, "SI on grounde"), it has no structural/compile dependency on
//      it. dev-ground is a pure tool; the ordering concern does not apply.
//  (2) UNGROUNDED PREMISE — an early draft of this brief cited web-tool
//      availability as "PROVEN … run wf_ffd2b109-4d5". Re-verified: that run
//      id has NO trace anywhere in this tree (rg -a over the whole repo), and
//      `AgentOptions` (packages/runtime/src/types.ts) carries NO `tools`
//      field — a workflow cannot REQUEST WebSearch/WebFetch/Bash for an
//      agent; tool availability is a property of the RESOLVED agentType, i.e.
//      an ENVIRONMENTAL premise — no trace in the SOURCE tree, not a code
//      guarantee. Never cited as proven below; the external arm degrades
//      through the named 'source-unreachable' PoC outcome when web tools are
//      absent, and reports it, never assumes.
//  (3) TOOLING TRAP, flagged NOT fixed — toolkit/examples/docs-audit.workflow.ts:226
//      carries a raw NUL byte (`file` reports `data; charset=binary`); plain
//      `grep`/`git grep -n` silently return nothing on it (indistinguishable
//      from "no match"). Any grounding/grep sweep over examples/ in this repo
//      must use `grep -a` / `rg --text`. NOT fixed here: outside this
//      workflow's stated scope, and fixing it would dirty an unrelated
//      artifact's byte-identity. Flagged to the pilot as a drive-by candidate.
//
// D3 KILL REASONS (the schemas below, and why they take this shape):
//  (a) ONE flat mega-schema per premise from a SINGLE agent — killed because
//      the external and internal arms are disjoint BY DESIGN (see the arms'
//      own comment below) and would collapse to a union schema; one long
//      shape is also exactly the pr-review starvation geometry (a long field
//      generated first starves required short siblings).
//  (b) Asking a synthesis/verify agent to STATE the final route — killed by
//      "tally in code, never trust a model to count", and by the requirement
//      that routing be unit-testable pure code. `deriveRecommendation` below
//      is the ONLY place a route is decided; no prompt in this file asks a
//      model for cancel/reframe/proceed.
// deriveRecommendation is homed HERE (not @workflow-toolbox/std/patterns):
//      it is purely dev-ground's own routing policy — homing it upstream would
//      add a public value export, a docs-contract entry, and a cross-package
//      dependency for logic with exactly one owner.
//
// BOUNDS-CENSUS HONESTY: every string below is minLength/maxLength-bounded and
// every array maxItems-capped — this is the audit/review-family precedent
// (coverage-audit, docs-audit, pr-review), a DELIBERATE RAISE for this
// high-stakes routing stage, NOT "the house convention" (most examples do not
// bound this densely).
//
// CLAIM IDENTITY (load-bearing, task-6-authoritative design): the claim fed
// to adversarialVerification is THE PREMISE ITSELF — never the arms' or the
// PoC's CONCLUSION about it. The arms' proposed verdict/evidence and the PoC
// canary's outcome are rendered INTO the claim as material offered for
// refutation (ingredient 5: arbiter hypotheses explicitly offered for
// refutation). Consequence: Verify's own refute-first tally is the premise's
// FINAL truth value — the arm/PoC proposals are inputs to that tally, never a
// second, competing verdict. `POC_VERDICT` below therefore stays an
// INFORMATIONAL/audit mapping (its remediation text is carried into the final
// per-premise record) rather than a verdict that bypasses Verify — a premise
// the PoC could not settle still gets the SAME refute-first scrutiny as every
// other premise, which is the more conservative, coherent reading of "tally
// in code, never trust a model to count" applied end-to-end.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import {
  withLeafFence,
  probeAgentType,
  fanOutAndSynthesize,
  adversarialVerification,
  untrusted,
  renderSourceRefs,
  collectTrail,
  emitDigest,
  makeRecord,
  warn,
} from '@workflow-toolbox/patterns'
import type {
  AgentTypeProbeReport,
  ClaimVerdict,
  PatternResult,
  PatternStats,
  TrailRecord,
  RenderSourceRefsOptions,
} from '@workflow-toolbox/patterns'
import { MODEL_ALIASES } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, ModelAlias, EffortAlias, JsonSchema } from '@workflow-toolbox/runtime'
import { resolveEffort, resolveVerifierEffort } from '@workflow-toolbox/std'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface Premise {
  id: string
  statement: string
  target: 'external' | 'internal'
}

export interface DevGroundInput {
  premises: Premise[]
  /** Absolute paths only — the orchestrator has no filesystem, so a relative
   *  ref cannot be resolved by IT and would silently make an agent read the
   *  wrong file or none. DELIBERATE RAISE beyond the sibling optStringArray
   *  precedent (independent-analysis does not check this). */
  sourceRefs: string[]
  context: string
  /** Hypotheses the arbiter offers EXPLICITLY for refutation (ingredient 5 of
   *  the six-ingredients contract) — never answers to confirm. */
  arbiterHypotheses: string[]
  /** The pre-committed prediction (ingredient 6), checked item-by-item at
   *  result time by the Predict stage. */
  prediction: string
  /** From `cfg.agentTypes['verify']` — routes the Verify stage's verifiers. */
  verifierType: string | undefined
  /** From `cfg.agentTypes['ground']` — routes BOTH arms' task+synthesis
   *  agents through the same resolved type (one probe, one routing decision;
   *  the two arms are not independently routable — they share one grounding
   *  posture). NOTE: the two literal `agentTypes` map fields sketched by an
   *  earlier draft of this workflow's spec (a raw passthrough `agentTypes`
   *  map AND a separate generic `models` role map) are DROPPED here in favor
   *  of the proven sibling precedent (independent-analysis / cross-model-verify):
   *  derive NAMED fields from `cfg.agentTypes`/`cfg.effort` at parseInput time,
   *  never carry a raw config map on the typed input. */
  groundingType: string | undefined
  /** Verifier model override; undefined → adversarialVerification's BEST_MODEL. */
  verifierModel: ModelAlias | undefined
  /** Optional reasoning-effort override per role (Class B/C, `parseConfig`
   *  from `args.effort`). 'auto' = keep the role's own committed default. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
  /** Blanket opt-out of the default leaf-agent fence (see withLeafFence). */
  messaging: boolean | null
}

// ---------------------------------------------------------------------------
// Local input parsing — L3 re-validation (never trust a hand-edited artifact).
// Throws SYNCHRONOUSLY at entry before any agent spawns.
// ---------------------------------------------------------------------------

function requireNonEmptyString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`dev-ground: "${key}" must be a non-empty string`)
  }
  return v
}

function optStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
    throw new Error(`dev-ground: "${key}" must be an array of non-empty strings`)
  }
  return v as string[]
}

function parsePremises(raw: unknown): Premise[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('dev-ground: "premises" must be a non-empty array')
  }
  const seen = new Set<string>()
  return raw.map((p, i) => {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error(`dev-ground: "premises[${i}]" must be an object`)
    }
    const obj = p as Record<string, unknown>
    const id = obj['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`dev-ground: "premises[${i}].id" must be a non-empty string`)
    }
    const statement = obj['statement']
    if (typeof statement !== 'string' || statement.trim().length === 0) {
      throw new Error(`dev-ground: "premises[${i}].statement" must be a non-empty string`)
    }
    const target = obj['target']
    if (target !== 'external' && target !== 'internal') {
      throw new Error(`dev-ground: "premises[${i}].target" must be "external" or "internal"`)
    }
    // Duplicate ids silently merge two premises into one verdict at the
    // deriveRecommendation/arm-merge boundary (both keyed on premise id) —
    // catch it here, loudly, at entry.
    if (seen.has(id)) {
      throw new Error(`dev-ground: "premises" must have unique ids (duplicate: "${id}")`)
    }
    seen.add(id)
    return { id, statement, target }
  })
}

function parseSourceRefs(obj: Record<string, unknown>): string[] {
  const v = obj['sourceRefs']
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
    throw new Error('dev-ground: "sourceRefs" must be an array of non-empty strings')
  }
  const refs = v as string[]
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]
    if (ref !== undefined && !ref.startsWith('/')) {
      throw new Error(`dev-ground: "sourceRefs[${i}]" must be an absolute path (got "${ref}")`)
    }
  }
  return refs
}

// ---------------------------------------------------------------------------
// D3 — artifact schemas. Per-arm NARROW schemas merged in code (kill reason
// (a) above); the final route is DERIVED in code (kill reason (b) above).
// Every schema: additionalProperties:false, `required` listing EVERY
// property, every string min/maxLength-bounded, every array maxItems-capped.
// Field order is LOAD-BEARING (enum/short/mechanical FIRST, free prose LAST —
// pr-review commit 11eb758 / run wf_bda8b4b9-e35 / card #1814943589197677963:
// a long prose field emitted first starved its required short siblings, drew
// 2 schema rejections, then capitulated into `{"summary":"test"}` which
// VALIDATED — schema validity alone proves nothing).
// ---------------------------------------------------------------------------

export const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    premiseId: { type: 'string', minLength: 1, maxLength: 40 },
    tier: { enum: ['primary-source', 'secondary-source', 'local-code', 'poc-observation', 'inference'] },
    locator: { type: 'string', minLength: 1, maxLength: 300 },
    quote: { type: 'string', minLength: 1, maxLength: 400 },
  },
  required: ['premiseId', 'tier', 'locator', 'quote'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type Evidence = FromSchema<typeof EVIDENCE_SCHEMA>

// A field an agent must ALWAYS fill (mandatory declare-the-unverified,
// ingredient 4) is satisfied with filler unless it can express "nothing was
// left unverified" as an ENUM value rather than free prose — this is what
// lets the degeneration guard below distinguish an honest 'none' from filler.
export const COULD_NOT_VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['nothing-unverified', 'partially-unverified', 'nothing-verified'] },
    detail: { type: 'string', minLength: 0, maxLength: 400 },
  },
  required: ['status', 'detail'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type CouldNotVerify = FromSchema<typeof COULD_NOT_VERIFY_SCHEMA>

// "la boucle corrige la carte" (design brief §1, the 500-vs-409 lived case):
// a per-premise proposal to correct the CARD, not the code. `present` is a
// boolean so "no correction" is expressible without an empty-object special
// case — every other field stays a bounded string (minLength 0) so the
// schema-bounds sweep holds uniformly whether or not a correction is proposed.
export const CARD_CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    present: { type: 'boolean' },
    field: { type: 'string', minLength: 0, maxLength: 60 },
    current: { type: 'string', minLength: 0, maxLength: 200 },
    corrected: { type: 'string', minLength: 0, maxLength: 200 },
  },
  required: ['present', 'field', 'current', 'corrected'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type CardCorrectionField = FromSchema<typeof CARD_CORRECTION_SCHEMA>

// Used by BOTH arms (each in its OWN call+phase — narrow per arm, never a
// union). Agents constrain `verdict` to the FOUR-value Verdict; they NEVER
// emit 'unverified-by-cap' (only adversarialVerification's cap-truncation
// append does — see ClaimVerdict below). `alternativeMechanisms` is what
// makes 'reframe' DERIVABLE in code (kill reason (b)) — without it the route
// has no way to distinguish "blocked, no alternative" from "blocked, but
// here's another way in".
export const PREMISE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    premiseId: { type: 'string', minLength: 1, maxLength: 40 },
    verdict: { enum: ['confirmed', 'partially-confirmed', 'refuted', 'unverifiable'] },
    evidence: { type: 'array', maxItems: 8, items: EVIDENCE_SCHEMA },
    alternativeMechanisms: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    cardCorrection: CARD_CORRECTION_SCHEMA,
    couldNotVerify: COULD_NOT_VERIFY_SCHEMA,
    reasoning: { type: 'string', minLength: 12, maxLength: 800 },
  },
  required: [
    'premiseId',
    'verdict',
    'evidence',
    'alternativeMechanisms',
    'cardCorrection',
    'couldNotVerify',
    'reasoning',
  ],
  additionalProperties: false,
} as const satisfies JsonSchema
export type PremiseResultReport = FromSchema<typeof PREMISE_RESULT_SCHEMA>

export const ARM_SCHEMA = {
  type: 'object',
  properties: {
    results: { type: 'array', maxItems: 20, items: PREMISE_RESULT_SCHEMA },
  },
  required: ['results'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type ArmReport = FromSchema<typeof ARM_SCHEMA>

// PoC canary report — field order enum FIRST, rationale (prose) LAST. Copied
// shape (task 5, authoritative — supersedes an earlier draft's narrower
// POC_OUTCOME_SCHEMA sketch that this file never shipped).
export const POC_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { enum: ['ran-confirmed', 'ran-refuted', 'ran-inconclusive', 'refused-by-classifier', 'source-unreachable'] },
    premiseId: { type: 'string', minLength: 1, maxLength: 80 },
    probe: { type: 'string', minLength: 3, maxLength: 300 },
    observation: { type: 'string', minLength: 3, maxLength: 400 },
    denialQuote: { type: 'string', minLength: 0, maxLength: 200 },
    rationale: { type: 'string', minLength: 12, maxLength: 600 },
  },
  required: ['outcome', 'premiseId', 'probe', 'observation', 'denialQuote', 'rationale'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type PocReport = FromSchema<typeof POC_SCHEMA>

// The Reframe agent supplies only `text` — `status: 'sketch-unavailable'` is
// never something the agent itself would self-report; it is what a NULL
// agent response degrades to (see run() below). Keeping status OUT of the
// agent-facing schema makes that degradation a code-level guarantee, not a
// prompt request the agent could get wrong.
export const REFRAME_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 12, maxLength: 600 },
  },
  required: ['text'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type ReframeAgentReport = FromSchema<typeof REFRAME_SCHEMA>

export interface ReframeSketch {
  status: 'sketched' | 'sketch-unavailable'
  text: string
}

export const PREDICT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', minLength: 1, maxLength: 200 },
          outcome: { enum: ['held', 'broke', 'not-tested'] },
        },
        required: ['item', 'outcome'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const satisfies JsonSchema
export type PredictReport = FromSchema<typeof PREDICT_SCHEMA>
export type PredictionCheckItem = PredictReport['items'][number]

// ---------------------------------------------------------------------------
// Local stage vocabulary — do NOT invent a parallel truth taxonomy.
// `ClaimVerdict` (@workflow-toolbox/patterns) owns claim TRUTH and is REUSED
// verbatim throughout this file (never re-declared). `GroundingRoute` names
// STAGE outcomes for ROUTING, not claim truth values — same justification as
// dev-implement.workflow.ts:417-423's `TddBlockingVerdict`: "these name STAGE
// outcomes for routing, not claim truth values, and the patterns type is
// consumed exhaustively (Record<ClaimVerdict, …>) by other workflows —
// polluting it would force meaningless handling on every claim consumer."
// ---------------------------------------------------------------------------

export type GroundingRoute = 'cancel' | 'reframe' | 'proceed'

// Typed Record<GroundingRoute, string> so a future route is a COMPILE error.
// `cancel`'s sentence teaches BOTH of its causes (refuted-with-no-alternative
// AND unsettled-with-no-alternative) — naming an exit without its corrective
// path is the anti-pattern (dev-implement.workflow.ts:425-427 precedent).
//
// Arbiter review finding (fix round, card #1819690698539009755): the reframe
// sentence previously claimed "an alternative … for EVERY blocking premise",
// but `deriveRecommendation` routes to 'reframe' on `blockers.some(hasAlternative)`
// — ANY blocking premise with an alternative, not all of them (KEPT semantics,
// arbiter call — a genuinely mixed card, part fixable/part not, still deserves
// the reframe path rather than a blanket cancel). The wording now matches the
// code: it names the weaker, TRUE guarantee, and points the reader at `reasons`
// (surfaced verbatim in `recommendationNote`/`summaryMarkdown`) for which
// specific blockers still lack one.
export const VERDICT_ROUTING: Record<GroundingRoute, string> = {
  cancel:
    'do not spend implementation budget — kill or park the card; if the block is an ' +
    'UNSETTLED premise rather than a refuted one, re-file it as an investigation with a ' +
    'raised grounding budget rather than re-running the same plan',
  reframe:
    'at least one blocking premise surfaced a real alternative mechanism — replan against ' +
    'it; any OTHER blocking premise without an alternative (named in the per-premise reasons ' +
    'above) still blocks its own part of the plan and needs its own resolution before that ' +
    'part proceeds; a reframeSketch is required',
  proceed:
    'every premise held (or was non-blocking) — implementation may start against the ' +
    'grounded premises',
}

export interface GroundingRecommendation {
  route: GroundingRoute
  reasons: string[]
}

/** Renders `blocked (${route}) — …. Routing: ….` for cancel/reframe, and
 *  `proceed — …. Routing: ….` for proceed (dev-implement.workflow.ts
 *  precedent). Naming an exit without teaching its corrective path is the
 *  anti-pattern this exists to avoid. */
export function formatRecommendation(rec: GroundingRecommendation): string {
  if (rec.route === 'proceed') {
    return `proceed — ${rec.reasons.join('; ')}. Routing: ${VERDICT_ROUTING.proceed}.`
  }
  return `blocked (${rec.route}) — ${rec.reasons.join('; ')}. Routing: ${VERDICT_ROUTING[rec.route]}.`
}

// ---------------------------------------------------------------------------
// Deterministic derivation — PURE, exported, unit-testable. Every premise is
// load-bearing BY CONSTRUCTION: the input contract has no loadBearing flag
// because a card only enumerates premises it depends on.
// ---------------------------------------------------------------------------

export interface PremiseOutcome {
  premiseId: string
  verdict: ClaimVerdict
  alternativeMechanisms: readonly string[]
}

function hasAlternative(r: PremiseOutcome): boolean {
  return r.alternativeMechanisms.some((a) => a.trim().length > 0)
}

/** BLOCKING = 'refuted' | 'unverifiable' | 'unverified-by-cap'; NON-BLOCKING =
 *  'confirmed' | 'partially-confirmed'. blockers.length === 0 → 'proceed';
 *  else alternatives (from BLOCKING premises ONLY) present → 'reframe'; else
 *  → 'cancel'.
 *
 *  GAP CLOSED (doctrine risk n°1 — "an unverifiable premise must NEVER
 *  silently route to proceed"): the briefed cancel/reframe rules both require
 *  refuted>=1, so refuted===0 && unverifiable>=1 (no alternatives) matched
 *  NEITHER rule and would otherwise fall through toward 'proceed'. DECIDED:
 *  that case routes to 'reframe' when an alternative was surfaced, else
 *  'cancel' — never 'proceed' on ignorance. 14/07 anchor: 3 of 3 premises
 *  refuted, no alternatives → cancel, killing an L-sized plan before the
 *  first line of code. REFRAME has >=5 precedents (branch-map sweep) — a
 *  first-class outcome, not a curiosity; its reframeSketch requirement is
 *  enforced at the synthesis stage (deriveRecommendation cannot itself check
 *  that a sketch was produced). */
export function deriveRecommendation(
  premiseResults: readonly PremiseOutcome[],
): GroundingRecommendation {
  if (premiseResults.length === 0) {
    throw new Error('dev-ground: deriveRecommendation requires at least one premise result')
  }

  const reasons: string[] = []
  const blockers: PremiseOutcome[] = []

  for (const r of premiseResults) {
    switch (r.verdict) {
      case 'confirmed':
        reasons.push(`${r.premiseId}: confirmed`)
        break
      case 'partially-confirmed':
        reasons.push(`${r.premiseId}: partially-confirmed`)
        break
      case 'refuted':
      case 'unverifiable':
      case 'unverified-by-cap':
        blockers.push(r)
        reasons.push(
          `${r.premiseId}: ${r.verdict}` +
            (hasAlternative(r) ? ' — alternative mechanism surfaced' : ' — no alternative mechanism surfaced'),
        )
        break
      default: {
        const _never: never = r.verdict
        throw new Error(`dev-ground: deriveRecommendation — unhandled ClaimVerdict "${String(_never)}"`)
      }
    }
  }

  if (blockers.length === 0) {
    return { route: 'proceed', reasons }
  }

  // Alternatives counted from BLOCKING premises ONLY (sharp case): an
  // alternative noted on a CONFIRMED premise is not an alternative to a
  // blocked mechanism and must NOT trigger reframe.
  const hasAnyAlternative = blockers.some(hasAlternative)
  return { route: hasAnyAlternative ? 'reframe' : 'cancel', reasons }
}

// ---------------------------------------------------------------------------
// In-code degeneration guard (defence layer 3) — PURE, unit-testable here;
// wired to `warn(rt, warnings, …)` by the agent stages below. Heuristic
// + LOUD, NEVER fatal (pr-review commit 11eb758 / run wf_bda8b4b9-e35 anchor:
// schema validity alone proves nothing).
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /^(n\/a|none|nothing|test|a|-|tbd|todo|null|\.)$/i

export function isDegenerateText(text: string, minMeaningful: number): boolean {
  const t = text.trim()
  if (t.length === 0) return true
  if (t.length < minMeaningful) return true
  if (PLACEHOLDER_RE.test(t)) return true
  // A single token repeated (e.g. "test test test") is placeholder-ish too.
  const words = t.split(/\s+/)
  if (words.length > 1 && new Set(words.map((w) => w.toLowerCase())).size === 1) return true
  return false
}

// ---------------------------------------------------------------------------
// PoC canary sub-stage vocabulary. Only an EXTERNAL premise the sources did
// NOT settle earns a canary (design brief:94 — the split is by premise
// TARGET, not by tool); internal premises are the internal-analysis arm's
// business. Deliberately a LOCAL vocabulary, not an extension of
// @workflow-toolbox/patterns' claim-verification `Verdict` — same why-local
// reasoning as `GroundingRoute` above (dev-implement.workflow.ts:417-423).
// ---------------------------------------------------------------------------

export type PocOutcome =
  | 'ran-confirmed'
  | 'ran-refuted'
  | 'ran-inconclusive'
  | 'refused-by-classifier'
  | 'source-unreachable'

// The last two are FIRST-CLASS: schema-valid, named, routable — NEVER an
// error, NEVER a throw, NEVER counted in a failure tally (design brief
// contrainte 3: "un canary peut être refusé par le classificateur de
// sécurité — le refus est une issue normale à router, pas une erreur").
export const POC_ROUTING: Record<PocOutcome, string> = {
  'ran-confirmed':
    'the canary held the premise against the real system — carry the evidence into the plan; ' +
    'no further probe',
  'ran-refuted':
    'the real system contradicts the premise — route the CARD back for cancel/reframe, do not ' +
    'plan against a falsified premise',
  'ran-inconclusive':
    'the canary ran but decided nothing — the probe design is the problem, not the premise; ' +
    'sharpen the canary or escalate the premise to a human, never upgrade it to confirmed',
  'refused-by-classifier':
    'a policy boundary blocked the probe, not the premise — re-run under an operator who can ' +
    'grant the tool, or reframe the premise so it is checkable without the denied call; ' +
    'relaunching identically will be denied identically',
  'source-unreachable':
    'the environment could not reach the source — retry once the network/credential/host is ' +
    'available, or record the premise as an environmental dependency of the card; this is not ' +
    'evidence about the premise',
}

// Informational mapping (see the file-header CLAIM IDENTITY note): a PoC
// outcome is material offered to Verify for refutation, never a verdict that
// bypasses it. Kept exhaustive + typed so a sixth PocOutcome is a COMPILE
// error here (mirrors the design's own "tally in code" discipline even for
// an audit-only mapping). GENUINELY CONSULTED (fix round, card
// #1819690698539009755): the Verify renderClaim below reads this mapping and
// renders its output as one more offered-for-refutation hypothesis line — an
// earlier revision exported this const but never actually referenced it,
// which was dead code from run()'s own control-flow perspective.
export const POC_VERDICT: Record<PocOutcome, ClaimVerdict> = {
  'ran-confirmed': 'confirmed',
  'ran-refuted': 'refuted',
  'ran-inconclusive': 'unverifiable',
  'refused-by-classifier': 'unverifiable',
  'source-unreachable': 'unverifiable',
}

// Recognition grammar copied from packages/debugger/src/tool-denial.ts
// (DenialKind, classifyDenial) — that module is PRIVATE, absent from the
// examples deps and root build:dist list, and is a POST-HOC transcript
// scanner: the orchestrator never sees the agent's raw tool_result, only its
// StructuredOutput. So this is a PROMPT precedent, not an import. The three
// wordings are a CLOSED allow-list: precision over recall. A missed novel
// wording is a quiet gap; a false 'denied' on a clean run erodes the whole
// signal.
const DENIAL_GRAMMAR =
  'Report "refused-by-classifier" ONLY when a tool result contains one of these three:\n' +
  '  1. "denied by the Claude Code auto mode classifier" (often with a "[Category]" reason tag — quote it);\n' +
  '  2. "Hook <Name> denied this tool";\n' +
  '  3. "the tool use was rejected" OR "want to proceed with this tool use".\n' +
  'PRECISION OVER RECALL. Ordinary tool errors are NOT denials: non-zero exit codes, MCP ' +
  '-32602 arg-validation, HTTP 404s, EISDIR, ERR_MODULE_NOT_FOUND. "No such tool available" ' +
  'is DELIBERATELY EXCLUDED — that is tool-not-found (usually a wrong tool name), a different ' +
  'class from a permission denial of a tool you were entitled to. When a command simply fails, ' +
  'that is "ran-inconclusive" or real evidence — never "refused-by-classifier".'

const POC_RULES =
  'Field order: outcome, premiseId, probe, observation, denialQuote, rationale. Example (adapt ' +
  'the content, keep the shape):\n' +
  '{"outcome":"source-unreachable","premiseId":"P1","probe":"curl https://example.invalid/api",' +
  '"observation":"connection timed out after 30s, host unresolvable",' +
  '"denialQuote":"","rationale":"the host does not resolve from this sandbox; this says nothing ' +
  'about whether the API itself supports the premise"}\n' +
  'Never satisfy the schema with placeholder values ("test", "a"); if a field is hard to fill, ' +
  'shorten it — do not fake it. A refusal or an unreachable source is a CORRECT, EXPECTED ' +
  'answer — do not invent a result to look productive.'

// ---------------------------------------------------------------------------
// Merged premise table — the code-owned join of {input premise} × {arm
// finding} × {PoC outcome}, keyed by premise id, built deterministically in
// input order (never Map insertion order derived from agent replies).
// ---------------------------------------------------------------------------

export interface MergedPremise {
  id: string
  target: 'external' | 'internal'
  statement: string
  finding: { arm: 'external' | 'internal'; report: PremiseResultReport } | null
  pocOutcome: PocReport | null
}

/** A premise is SETTLED when an arm proposed anything OTHER than
 *  'unverifiable' for it. This is the ONE named place `settled` is derived —
 *  do not add a second parallel notion of it (task-5 spec instruction). */
function isSettled(m: MergedPremise): boolean {
  return m.finding !== null && m.finding.report.verdict !== 'unverifiable'
}

/** Only an EXTERNAL premise the sources did NOT settle earns a canary.
 *  Internal premises are the internal-analysis arm's business (the split is
 *  by premise TARGET, not by tool); a settled external premise already has
 *  its evidence. Order-preserving; returns `[]` on empty input; never
 *  throws. */
export function selectPocPremises(premises: readonly MergedPremise[]): readonly MergedPremise[] {
  return premises.filter((p) => p.target === 'external' && !isSettled(p))
}

export interface FinalPremiseResult {
  id: string
  target: 'external' | 'internal'
  verdict: ClaimVerdict
  statement: string
  evidence: Evidence[]
  alternativeMechanisms: string[]
  couldNotVerify: CouldNotVerify
  pocOutcome: PocOutcome | null
  /** The PoC routing sentence, when a canary ran for this premise — informational,
   *  audit-only (see the file-header CLAIM IDENTITY note). */
  pocRouting: string | null
  /** UNVERIFIED PROPOSAL — arm-authored (the research/analysis agent's own
   *  suggestion), and does NOT pass refute-first verification the way the
   *  premise `verdict` above does. A correction can cite REAL evidence and
   *  still overreach its scope (true-evidence/false-reach: e.g. a real line
   *  proves ONE code path lacks validation, but the correction generalizes
   *  that to "the CLI accepts any path" — a claim about a surface the cited
   *  line does not cover). Treat as pilot input to weigh, never auto-apply;
   *  cross-check against `verdict` before acting on it. */
  cardCorrection: CardCorrectionField | null
}

/** Structured, unverified card-correction proposal — see
 *  FinalPremiseResult.cardCorrection for the "unverified, arm-authored"
 *  caveat. `hypothesis` is what the card currently claims (bounded by the
 *  source CardCorrectionField.field/current, ≤60+~205 chars); `correction`
 *  is what it should say instead (bounded by CardCorrectionField.corrected,
 *  ≤200 chars). Arbiter review finding (fix round, card
 *  #1819690698539009755): STRUCTURED, not a pre-rendered prose string — so
 *  renderSummaryMarkdown looks up the owning premise's verdict by
 *  `premiseId` directly (no regex re-parse, no separator fragility — a
 *  premiseId containing a space or dash no longer risks a mis-split). */
export interface CardCorrectionEntry {
  premiseId: string
  hypothesis: string
  correction: string
}

const NO_MATERIAL_COULD_NOT_VERIFY: CouldNotVerify = {
  status: 'nothing-verified',
  detail: 'no grounding arm or PoC canary produced any material for this premise',
}

// ---------------------------------------------------------------------------
// HUMAN-FIRST artifact (brief amendment, hard product requirement): the final
// artifact must be readable by a human BEFORE it is parseable by a machine.
// `renderSummaryMarkdown` is PURE and rendered IN CODE from the already-
// validated final fields — never a second model call (that would just be
// another agent summarizing an agent, with nothing to refute it). Voluminous
// detail (full evidence texts) stays in the machine fields' bounded quotes +
// the run journal — never inlined as a wall of text here; this is a table +
// one paragraph + two short lists, capped and snapped to a line boundary.
// ---------------------------------------------------------------------------

const SUMMARY_MARKDOWN_MAX_CHARS = 6000
const SUMMARY_TRUNCATION_MARKER = '\n\n*(summary truncated at the character cap — see premiseResults for the full table)*'

/** Neutralizes markdown table-breaking characters in a cell's rendered text —
 *  a literal `|` would split the row, an embedded newline would break out of
 *  it entirely. Arbiter review finding (fix round, card
 *  #1819690698539009755): premise ids and evidence locators are caller- or
 *  agent-supplied text, not guaranteed pipe/newline-free. `target`/`verdict`
 *  are closed schema enums and never need this — only the free-text cells do. */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Renders the human-first summary: a premise-by-premise verdict table, the
 *  route + why in one paragraph, the card-correction list, and the
 *  prediction-check line. Capped at ~6000 chars, snapped to a line boundary
 *  (never mid-line) with an explicit truncation marker. */
export function renderSummaryMarkdown(
  finalResults: readonly FinalPremiseResult[],
  recommendation: GroundingRecommendation,
  recommendationNote: string,
  cardCorrections: readonly CardCorrectionEntry[],
  predictionCheck: readonly PredictionCheckItem[],
): string {
  const lines: string[] = []
  lines.push(`# Grounding result: ${recommendation.route.toUpperCase()}`)
  lines.push('')
  lines.push(recommendationNote)
  lines.push('')
  lines.push('## Premises')
  lines.push('')
  lines.push('| id | target | verdict | evidence |')
  lines.push('|---|---|---|---|')
  for (const p of finalResults) {
    const ev = p.evidence[0]
    const evidenceCell = ev !== undefined ? `${ev.tier} @ ${ev.locator}` : p.pocRouting !== null ? `PoC: ${p.pocOutcome ?? '?'}` : '(none)'
    lines.push(`| ${escapeTableCell(p.id)} | ${p.target} | ${p.verdict} | ${escapeTableCell(evidenceCell)} |`)
  }

  if (cardCorrections.length > 0) {
    lines.push('')
    lines.push('## Card corrections (unverified proposals — arm-authored, not refute-first checked)')
    lines.push('')
    // Structured entries (see CardCorrectionEntry) — direct premiseId lookup
    // against the VERIFIED table above so a contradiction between an
    // unverified proposal and its own premise's verdict is visible at a
    // glance, with no re-parsing of a pre-rendered string.
    const verdictById = new Map(finalResults.map((p): [string, ClaimVerdict] => [p.id, p.verdict]))
    for (const c of cardCorrections) {
      const verdict = verdictById.get(c.premiseId)
      const annotation = verdict !== undefined ? ` [verdict for this premise: ${verdict}]` : ''
      lines.push(`- ${c.premiseId} — ${c.hypothesis} → "${c.correction}"${annotation}`)
    }
  }

  if (predictionCheck.length > 0) {
    lines.push('')
    lines.push('## Prediction check')
    lines.push('')
    for (const item of predictionCheck) lines.push(`- ${item.item}: **${item.outcome}**`)
  }

  const full = lines.join('\n').trimEnd()
  if (full.length + SUMMARY_TRUNCATION_MARKER.length <= SUMMARY_MARKDOWN_MAX_CHARS) return full

  // Snap to a line boundary — never cut mid-line — leaving room for the marker.
  const budget = SUMMARY_MARKDOWN_MAX_CHARS - SUMMARY_TRUNCATION_MARKER.length
  const truncated = full.slice(0, budget)
  const lastNewline = truncated.lastIndexOf('\n')
  const snapped = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated
  return `${snapped}${SUMMARY_TRUNCATION_MARKER}`
}

// ---------------------------------------------------------------------------
// The 6-INGREDIENTS PROMPT CONTRACT — an explicit, auditable RULES block
// rendered into BOTH arms' task prompts (design brief contrainte 4: "les six
// ingrédients qui ont fait payer le grounding — sans eux, il est coûteux ET
// du théâtre"). Ingredient 1 (real sourceRefs) is rendered separately via the
// extracted renderSourceRefs (this workflow's own policy strings below);
// ingredients 2-6 are this RULES block.
// ---------------------------------------------------------------------------

const SIX_INGREDIENTS_RULES =
  'Ground every premise on REAL evidence, per these rules (a grounding pass without them is ' +
  'expensive theatre):\n' +
  '  2. OPEN ENUMERATION — the premise list is a STARTING POINT, not a closed menu; surface ' +
  'mechanisms/evidence outside it when you find them.\n' +
  '  3. REFUTE-FIRST — actively try to DISPROVE the premise before confirming it; default to ' +
  '"unverifiable" under genuine uncertainty, never to a comfortable "confirmed".\n' +
  '  4. DECLARE THE UNVERIFIED — couldNotVerify is REQUIRED; it must be an honest report, ' +
  'never filler ("n/a"/"none" typed without checking).\n' +
  '  5. ARBITER HYPOTHESES — offered below explicitly FOR REFUTATION, not as answers to confirm.\n' +
  '  6. THE PRE-COMMITTED PREDICTION — read it; your evidence will be checked against it later.'

const SOURCE_REFS_POLICY: RenderSourceRefsOptions = {
  emptyNote: 'No source files were provided — reason from the premise statements + context as given.',
  leadIn: 'READ these files to GROUND every premise in real content (cite specifics):',
}

// ---------------------------------------------------------------------------
// Model/effort pinning — module consts, each with a role-naming comment,
// resolved ONCE at the top of run(). Never inherit the session model
// silently (repo-wide fan-out rule).
// ---------------------------------------------------------------------------

/** Mechanical per-premise research probes (both arms) — cheap, high volume. */
const GROUND_TASK_MODEL: ModelAlias = 'haiku'
const GROUND_TASK_EFFORT: EffortAlias = 'medium'
/** Per-arm synthesis (reconciling the arm's own per-premise findings) — one
 *  call per arm, needs more judgment than a single-premise probe. */
const GROUND_SYNTHESIS_MODEL: ModelAlias = 'sonnet'
const GROUND_SYNTHESIS_EFFORT: EffortAlias = 'high'
/** PoC canary — a mechanical probe, not a judgment call. */
const POC_MODEL: ModelAlias = 'haiku'
const POC_EFFORT: EffortAlias = 'low'
/** Refute-first verification — the workflow's quality-critical stage; floored
 *  at 'high' via resolveVerifierEffort (an override may only RAISE it). */
const VERIFY_EFFORT_DEFAULT: EffortAlias = 'high'
/** Reframe sketch — a design proposal, needs real judgment. */
const REFRAME_MODEL: ModelAlias = 'sonnet'
const REFRAME_EFFORT: EffortAlias = 'high'
/** Prediction check — reads the verified table and decides held/broke/not-tested. */
const PREDICT_MODEL: ModelAlias = 'sonnet'
const PREDICT_EFFORT: EffortAlias = 'high'

// Refute-first verification lenses: a grounding premise fails in at least
// THREE separable ways (the cited source doesn't actually say it; the
// locator/quote is fabricated; a PoC/source outcome was misread as
// settling) — identical verifiers are correlated on exactly those.
// adversarialVerification throws synchronously when lenses.length !== votes,
// so votes is PINNED to this array's length, never caller-tunable.
const GROUNDING_LENSES: readonly string[] = [
  'does-the-cited-source-actually-say-this',
  'is-the-locator-and-quote-real-and-checkable',
  'was-the-poc-or-source-outcome-misread-as-settling',
]

// ---------------------------------------------------------------------------
export default defineWorkflow({
  meta: {
    name: 'dev-ground',
    description:
      "Grounding-first stage 1 of the dev loop: checks a card's premises against reality " +
      '(external research ∥ internal code analysis → PoC canary for what sources cannot ' +
      'settle → refute-first verification) before any code is written, and recommends ' +
      'cancel / reframe / proceed with a corrective path.',
    // Eight DISTINCT titles are LOAD-BEARING: emitDigest attribution DROPS
    // BOTH digests when one pattern is invoked twice under one phase title
    // (envelope.ts ATTRIBUTION note) — every stage below gets its own title.
    phases: [
      { title: 'Fence' },
      { title: 'Probe' },
      { title: 'Ground External' },
      { title: 'Ground Internal' },
      { title: 'PoC' },
      { title: 'Verify' },
      { title: 'Reframe' },
      { title: 'Predict' },
    ],
  },

  parseInput: (raw): DevGroundInput => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        'dev-ground: input must be an object with at least "premises" (non-empty array) and "prediction" (non-empty string)',
      )
    }
    const obj = raw as Record<string, unknown>

    const premises = parsePremises(obj['premises'])
    const sourceRefs = parseSourceRefs(obj)
    const context = typeof obj['context'] === 'string' ? obj['context'] : ''
    const arbiterHypotheses = optStringArray(obj, 'arbiterHypotheses')
    const prediction = requireNonEmptyString(obj, 'prediction')

    let verifierModel: ModelAlias | undefined
    if (obj['verifierModel'] !== undefined) {
      if (
        typeof obj['verifierModel'] !== 'string' ||
        !(MODEL_ALIASES as readonly string[]).includes(obj['verifierModel'])
      ) {
        throw new Error(`dev-ground: "verifierModel" must be one of ${MODEL_ALIASES.join(', ')}`)
      }
      verifierModel = obj['verifierModel'] as ModelAlias
    }

    // Class B/C launch-time config via the shared parseConfig helper:
    // per-role effort overrides (`effort.<role>`) and the per-role agentType
    // routing map (`agentTypes.verify` / `agentTypes.ground` — the structured
    // channel; no bespoke top-level arg).
    const cfg = parseConfig(obj)
    const effort = cfg.effort ?? null
    const verifierType = cfg.agentTypes?.['verify']
    const groundingType = cfg.agentTypes?.['ground']
    const messaging = cfg.messaging ?? null

    return {
      premises,
      sourceRefs,
      context,
      arbiterHypotheses,
      prediction,
      verifierType,
      groundingType,
      verifierModel,
      effort,
      messaging,
    }
  },

  run: async (rt0: WorkflowRuntime, input: DevGroundInput) => {
    // ---- Fence — LOWEST-priority default, applied first ----
    // plugin/agents/leaf.md's `disallowedTools: SendMessage` is a DENYLIST,
    // so WebSearch/WebFetch/Bash survive the fence — this is why the
    // external arm (below) is viable at all under it.
    rt0.phase('Fence')
    const { rt, report: leafFence } = await withLeafFence(rt0, {
      phase: 'Fence',
      disabled: input.messaging === true,
    })

    // ---- Resolve every role ONCE — proves the pinning rather than merely
    // asserting it ("never inherit the session model silently"). ----
    const resolved = {
      groundExternalTask: { model: GROUND_TASK_MODEL, effort: resolveEffort(input.effort?.['groundExternalTask'], GROUND_TASK_EFFORT) },
      groundExternalSynthesis: { model: GROUND_SYNTHESIS_MODEL, effort: resolveEffort(input.effort?.['groundExternalSynthesis'], GROUND_SYNTHESIS_EFFORT) },
      groundInternalTask: { model: GROUND_TASK_MODEL, effort: resolveEffort(input.effort?.['groundInternalTask'], GROUND_TASK_EFFORT) },
      groundInternalSynthesis: { model: GROUND_SYNTHESIS_MODEL, effort: resolveEffort(input.effort?.['groundInternalSynthesis'], GROUND_SYNTHESIS_EFFORT) },
      poc: { model: POC_MODEL, effort: resolveEffort(input.effort?.['poc'], POC_EFFORT) },
      verify: { model: (input.verifierModel ?? 'opus') as ModelAlias, effort: resolveVerifierEffort(input.effort?.['verify'], VERIFY_EFFORT_DEFAULT) },
      reframe: { model: REFRAME_MODEL, effort: resolveEffort(input.effort?.['reframe'], REFRAME_EFFORT) },
      predict: { model: PREDICT_MODEL, effort: resolveEffort(input.effort?.['predict'], PREDICT_EFFORT) },
    }

    const warnings: string[] = []

    // ---- Probes (conditional, EARLY — mirrors independent-analysis) ----
    // Two INDEPENDENTLY conditional probes, never silent, each reported in
    // its own output field (`groundProbe` / `probe`) — never sharing one
    // field, since they route two different roles.
    let resolvedGroundingType: string | undefined
    let groundProbe: AgentTypeProbeReport | null = null
    if (input.groundingType !== undefined) {
      rt.phase('Probe')
      const probe = await probeAgentType(rt, input.groundingType, { phase: 'Probe', required: true })
      resolvedGroundingType = probe.agentType
      groundProbe = { requested: input.groundingType, available: probe.available, reason: probe.reason }
    }

    let resolvedVerifierType: string | undefined
    let verifyProbe: AgentTypeProbeReport | null = null
    if (input.verifierType !== undefined) {
      rt.phase('Probe')
      const probe = await probeAgentType(rt, input.verifierType, { phase: 'Probe', required: true })
      resolvedVerifierType = probe.agentType
      verifyProbe = { requested: input.verifierType, available: probe.available, reason: probe.reason }
    }

    // ---- Partition — pure, in code. Disjointness is a PARTITION INVARIANT
    // established HERE, not a hope about model behaviour. ----
    const externalPremises = input.premises.filter((p) => p.target === 'external')
    const internalPremises = input.premises.filter((p) => p.target === 'internal')

    // ---- Untrusted blocks (defence layer 4 — caller text is data) ----
    const contextBlock = input.context.trim().length > 0 ? untrusted('CONTEXT', input.context) : '(no extra context)'
    const arbiterHypothesesBlock =
      input.arbiterHypotheses.length === 0
        ? '(none offered)'
        : untrusted('ARBITER-HYPOTHESES', input.arbiterHypotheses.map((h, i) => `H${i + 1}. ${h}`).join('\n'))
    const predictionBlock = untrusted('PREDICTION', input.prediction)
    const sourceBlock = renderSourceRefs(input.sourceRefs, SOURCE_REFS_POLICY)

    const armPromptBody = (roleLabel: string, premise: Premise): string =>
      `${SIX_INGREDIENTS_RULES}\n\n` +
      `${sourceBlock}\n\n` +
      `PREMISE:\n${untrusted('PREMISE', `${premise.id}: ${premise.statement}`)}\n\n` +
      `CONTEXT:\n${contextBlock}\n\n` +
      `ARBITER HYPOTHESES:\n${arbiterHypothesesBlock}\n\n` +
      `PRE-COMMITTED PREDICTION:\n${predictionBlock}\n\n` +
      `CARD-CORRECTION SCOPE DISCIPLINE: cardCorrection is an UNVERIFIED PROPOSAL — it does ` +
      `NOT get refute-first checked the way your verdict does. If you propose one, state ` +
      `EXACTLY where the evidence reaches (which surface/layer/call site) and do NOT ` +
      `generalize beyond the cited line — "this one call site skips validation" is checkable; ` +
      `"the CLI accepts any path" is a different, broader claim the same evidence does not prove.\n\n` +
      `Return the premise-result shape: { premiseId: "${premise.id}", verdict, evidence, ` +
      `alternativeMechanisms, cardCorrection, couldNotVerify, reasoning }. (${roleLabel})`

    // ---- The two arms — rt.parallel over CONDITIONAL thunks (EMPTY-ARM
    // GUARD: fanOutAndSynthesize throws synchronously on empty tasks). ----
    type ArmResult =
      | { arm: 'external'; result: PatternResult<ArmReport | null> }
      | { arm: 'internal'; result: PatternResult<ArmReport | null> }

    const armThunks: Array<() => Promise<ArmResult>> = []

    if (externalPremises.length > 0) {
      armThunks.push(async () => ({
        arm: 'external',
        result: await fanOutAndSynthesize<Premise, PremiseResultReport, ArmReport>(rt, {
          tasks: externalPremises,
          taskPrompt: (p) =>
            `You are an external research prober. Investigate ONE premise against every source ` +
            `you can reach: official docs, memory fiches, Confluence/Jira/Bitbucket, external ` +
            `MCPs, the web (GitHub issues, Context7…) — whatever fits. If you have NO web tool ` +
            `available, report couldNotVerify honestly rather than guessing — that is a ` +
            `first-class, expected outcome, not a failure.\n\n` +
            armPromptBody('external', p),
          taskSchema: PREMISE_RESULT_SCHEMA,
          taskModel: resolved.groundExternalTask.model,
          taskEffort: resolved.groundExternalTask.effort,
          ...(resolvedGroundingType !== undefined
            ? { taskType: resolvedGroundingType, synthesisType: resolvedGroundingType }
            : {}),
          synthesisPrompt: (parts) =>
            `You are the external grounding synthesis agent. Below are per-premise research ` +
            `reports from ${parts.length} independent external probers (JSON). Reconcile them ` +
            `into ONE results array, one entry per premise you were given — do not drop or ` +
            `merge distinct premise ids.\n\n` +
            `RAW REPORTS (JSON):\n${untrusted('EXTERNAL-REPORTS', JSON.stringify(parts))}\n\n` +
            `Return { results: [...] }.`,
          synthesisSchema: ARM_SCHEMA,
          synthesisModel: resolved.groundExternalSynthesis.model,
          synthesisEffort: resolved.groundExternalSynthesis.effort,
          phase: 'Ground External',
        }),
      }))
    } else {
      warn(rt, warnings, 'dev-ground: no external premises — Ground External arm skipped')
    }

    if (internalPremises.length > 0) {
      armThunks.push(async () => ({
        arm: 'internal',
        result: await fanOutAndSynthesize<Premise, PremiseResultReport, ArmReport>(rt, {
          tasks: internalPremises,
          taskPrompt: (p) =>
            `You are an internal code analyst. Investigate ONE premise against OUR OWN source ` +
            `code — not external docs, not memory. Read the actual files.\n\n` +
            armPromptBody('internal', p),
          taskSchema: PREMISE_RESULT_SCHEMA,
          taskModel: resolved.groundInternalTask.model,
          taskEffort: resolved.groundInternalTask.effort,
          ...(resolvedGroundingType !== undefined
            ? { taskType: resolvedGroundingType, synthesisType: resolvedGroundingType }
            : {}),
          synthesisPrompt: (parts) =>
            `You are the internal grounding synthesis agent. Below are per-premise code-analysis ` +
            `reports from ${parts.length} independent internal analysts (JSON). Reconcile them ` +
            `into ONE results array, one entry per premise you were given — do not drop or ` +
            `merge distinct premise ids.\n\n` +
            `RAW REPORTS (JSON):\n${untrusted('INTERNAL-REPORTS', JSON.stringify(parts))}\n\n` +
            `Return { results: [...] }.`,
          synthesisSchema: ARM_SCHEMA,
          synthesisModel: resolved.groundInternalSynthesis.model,
          synthesisEffort: resolved.groundInternalSynthesis.effort,
          phase: 'Ground Internal',
        }),
      }))
    } else {
      warn(rt, warnings, 'dev-ground: no internal premises — Ground Internal arm skipped')
    }

    // NOTE ON loopUntilDone: multi-hop research is INTRA-agent (one external
    // prober chains WebSearch→WebFetch→Read within its own turn) — there is
    // no ROUND-LEVEL decision for a loop to make here, so loopUntilDone would
    // only buy a JSON-serializable accumulator obligation and a resume-replay
    // surface for zero routing benefit. Multi-hop is a PROMPT requirement,
    // not an orchestration one.
    const armResults = await rt.parallel<ArmResult>(armThunks)

    let externalArmResult: PatternResult<ArmReport | null> | null = null
    let internalArmResult: PatternResult<ArmReport | null> | null = null
    for (const ar of armResults) {
      if (ar === null) continue
      if (ar.arm === 'external') externalArmResult = ar.result
      else internalArmResult = ar.result
    }

    // ---- Merge — deterministic, in CODE, by premise id (NEVER
    // model-tallied). Iterates input.premises in INPUT order. ----
    const findings = new Map<string, { arm: 'external' | 'internal'; report: PremiseResultReport }>()

    function foldArm(arm: 'external' | 'internal', result: PatternResult<ArmReport | null> | null, ownPremises: readonly Premise[]): void {
      if (result === null) return
      if (result.value === null) {
        warn(rt, warnings, `dev-ground: ${arm} arm produced no synthesis — its premises remain unsettled`)
        return
      }
      const ownIds = new Set(ownPremises.map((p) => p.id))
      for (const item of result.value.results) {
        if (!ownIds.has(item.premiseId)) {
          warn(
            rt,
            warnings,
            `dev-ground: ${arm} arm returned a finding for premise "${item.premiseId}", outside its own partition — dropped`,
          )
          continue
        }
        findings.set(item.premiseId, { arm, report: item as PremiseResultReport })
      }
    }
    foldArm('external', externalArmResult, externalPremises)
    foldArm('internal', internalArmResult, internalPremises)

    const mergedPremises: MergedPremise[] = input.premises.map((p) => ({
      id: p.id,
      target: p.target,
      statement: p.statement,
      finding: findings.get(p.id) ?? null,
      pocOutcome: null,
    }))
    const mergedById = new Map(mergedPremises.map((m) => [m.id, m]))

    // ---- PoC canary sub-stage ----
    rt.phase('PoC')
    const pocEligible = selectPocPremises(mergedPremises)
    const pocTrail: TrailRecord[] = []
    let pocStats: PatternStats | null = null

    if (pocEligible.length === 0) {
      // EMPTY-SET NO-OP: report what actually happened (nothing qualified),
      // never a generic "skipped" — an empty phase must not imply probes ran.
      warn(rt, warnings, 'dev-ground: no external premise was left unsettled — PoC stage did not run (nothing qualified)')
      // Tier-2 skip-digest: PoC is entered (rt.phase('PoC')) but zero canaries
      // spawn here — without this, observe's phase box would guess a generic
      // emptyReason instead of showing the real "nothing qualified" why.
      // Custom-stage naming convention: '<workflow-name>:<phase-lowercase>',
      // matching this file's kebab-case agent-label prefix (e.g.
      // 'dev-ground:poc:<premiseId>' below). `phase` MUST equal the
      // rt.phase() title exactly — the sole resolution hint for a zero-agent
      // phase; each of this workflow's eight phase titles is distinct so no
      // digest ever collides with another under the same title (see the
      // meta.phases comment above).
      emitDigest(rt, {
        stage: 'dev-ground:poc',
        phase: 'PoC',
        output: 'no external premise was left unsettled — PoC stage did not run (nothing qualified)',
        counts: { eligible: 0 },
      })
    } else {
      let pocAgentsSpawned = 0
      let pocDropped = 0
      const pocResults = await rt.parallel(
        pocEligible.map((p) => async () => {
          pocAgentsSpawned++
          const report = await rt.agent<PocReport>(
            `You are the canary — a SMALL, EXECUTABLE probe of ONE premise the sources could not ` +
            `settle. Actually RUN something (a command, a check) against the real system; do not ` +
            `reason from memory.\n\n${DENIAL_GRAMMAR}\n\n${POC_RULES}\n\n` +
            `PREMISE:\n${untrusted('PREMISE', `${p.id}: ${p.statement}`)}\n\n` +
            `Return { outcome, premiseId: "${p.id}", probe, observation, denialQuote, rationale }.`,
            {
              schema: POC_SCHEMA,
              label: `dev-ground:poc:${p.id}`,
              phase: 'PoC',
              model: resolved.poc.model,
              effort: resolved.poc.effort,
            },
          )
          return { premiseId: p.id, report }
        }),
      )

      for (const r of pocResults) {
        if (r === null) continue
        pocTrail.push(makeRecord(`dev-ground:poc:${r.premiseId}`, r.report !== null, { model: resolved.poc.model, effort: resolved.poc.effort }))
        const merged = mergedById.get(r.premiseId)
        if (merged === undefined) continue

        if (r.report === null) {
          // AGENT DEATH ≠ 'source-unreachable': the agent DYING is infra
          // failure, not "the agent ran and the source was unreachable".
          pocDropped++
          warn(
            rt,
            warnings,
            `dev-ground: PoC canary for "${r.premiseId}" died (agent returned null) — treated as ` +
              `unverifiable, NOT reported as source-unreachable`,
          )
          continue
        }

        merged.pocOutcome = r.report

        // In-code degeneration guards — heuristic, LOUD, never fatal.
        if (r.report.outcome === 'refused-by-classifier' && r.report.denialQuote.trim().length === 0) {
          warn(
            rt,
            warnings,
            `dev-ground: PoC canary for "${r.premiseId}" reported refused-by-classifier with an empty denialQuote — cannot verify the claimed denial`,
          )
        }
        if (isDegenerateText(r.report.probe, 10) || isDegenerateText(r.report.observation, 10)) {
          warn(rt, warnings, `dev-ground: PoC canary for "${r.premiseId}" returned a placeholder-looking probe/observation`)
        }
        if (
          (r.report.outcome === 'ran-confirmed' || r.report.outcome === 'ran-refuted') &&
          r.report.observation.trim().length < 20
        ) {
          warn(
            rt,
            warnings,
            `dev-ground: PoC canary for "${r.premiseId}" gave a decisive verdict "${r.report.outcome}" with a very short observation`,
          )
        }
      }
      pocStats = {
        itemsIn: pocEligible.length,
        itemsOut: pocEligible.length - pocDropped,
        agentsSpawned: pocAgentsSpawned,
        dropped: pocDropped,
        truncated: 0,
      }
    }

    // ---- Verify — refute-first, THE PREMISE ITSELF is the claim ----
    rt.phase('Verify')
    const verifyClaims = mergedPremises.filter((m) => m.finding !== null || m.pocOutcome !== null)
    const verification =
      verifyClaims.length === 0
        ? (() => {
            warn(rt, warnings, 'dev-ground: no premise records survived the grounding arms — nothing to verify')
            // Tier-2 skip-digest: Verify is entered but adversarialVerification
            // never runs here (it emits its OWN digest on the normal path) —
            // zero agents spawn in this branch. Same naming/attribution
            // contract as the PoC digest above.
            emitDigest(rt, {
              stage: 'dev-ground:verify',
              phase: 'Verify',
              output: 'no premise records survived the grounding arms — nothing to verify',
              counts: { claims: 0 },
            })
            return null
          })()
        : await adversarialVerification<MergedPremise>(rt, {
            claims: verifyClaims,
            renderClaim: (m) => {
              const findingBlock =
                m.finding !== null
                  ? untrusted('ARM-PROPOSAL', JSON.stringify(m.finding.report))
                  : '(no arm proposal — grounding produced nothing for this premise)'
              // Arbiter review finding (fix round): POC_VERDICT was exported
              // but never actually CONSULTED by run() — genuinely dead from
              // the control-flow's perspective, contradicting its own doc
              // comment ("informational, audit-only"). Now wired in as ONE
              // more offered-for-refutation hypothesis line, consistent with
              // CLAIM IDENTITY (still never binding — the verifier's own
              // tally, not this mapping, produces the final verdict).
              const pocBlock =
                m.pocOutcome !== null
                  ? untrusted('POC-OUTCOME', JSON.stringify(m.pocOutcome)) +
                    `\nPoC-derived hypothesis verdict (offered for refutation, NOT binding): ${POC_VERDICT[m.pocOutcome.outcome]}`
                  : '(no PoC canary ran for this premise)'
              return (
                `This premise was grounded by two independent arms (external research ∥ internal ` +
                `code analysis) plus an optional PoC canary. Actively try to REFUTE the premise; ` +
                `default to "unverifiable" under genuine uncertainty.\n\n` +
                `PREMISE:\n${untrusted('PREMISE', m.statement)}\n\n` +
                `ARM PROPOSAL (arbiter hypothesis — offered for refutation, NOT an answer to confirm):\n${findingBlock}\n\n` +
                `POC OUTCOME (arbiter hypothesis — offered for refutation):\n${pocBlock}`
              )
            },
            votes: GROUNDING_LENSES.length,
            lenses: GROUNDING_LENSES,
            effort: resolved.verify.effort,
            ...(input.verifierModel !== undefined ? { model: input.verifierModel } : {}),
            ...(resolvedVerifierType !== undefined ? { verifierType: resolvedVerifierType } : {}),
            phase: 'Verify',
          })

    const verifiedById = new Map<string, ClaimVerdict>(
      (verification?.value ?? []).map((v) => [v.claim.id, v.verdict]),
    )

    // ---- Assemble the final per-premise artifact ----
    const finalResults: FinalPremiseResult[] = mergedPremises.map((m) => {
      const hasMaterial = m.finding !== null || m.pocOutcome !== null
      const verdict: ClaimVerdict = hasMaterial ? (verifiedById.get(m.id) ?? 'unverifiable') : 'unverifiable'
      return {
        id: m.id,
        target: m.target,
        verdict,
        statement: m.statement,
        evidence: m.finding?.report.evidence ?? [],
        alternativeMechanisms: m.finding?.report.alternativeMechanisms ?? [],
        couldNotVerify: m.finding?.report.couldNotVerify ?? NO_MATERIAL_COULD_NOT_VERIFY,
        pocOutcome: m.pocOutcome?.outcome ?? null,
        pocRouting: m.pocOutcome !== null ? POC_ROUTING[m.pocOutcome.outcome] : null,
        cardCorrection:
          m.finding?.report.cardCorrection !== undefined && m.finding.report.cardCorrection.present
            ? m.finding.report.cardCorrection
            : null,
      }
    })

    // ---- Recommendation — deriveRecommendation IN CODE, never asked of a model ----
    const premiseOutcomes: PremiseOutcome[] = finalResults.map((p) => ({
      premiseId: p.id,
      verdict: p.verdict,
      alternativeMechanisms: p.alternativeMechanisms,
    }))
    const recommendation = deriveRecommendation(premiseOutcomes)
    const recommendationNote = formatRecommendation(recommendation)

    // "la boucle corrige la carte" (design brief §1, the 500-vs-409 lived
    // case, cards #1819053659325990500 / #1819020803027502679): a correction
    // anchored to a CONFIRMED premise is noise, so only refuted/
    // partially-confirmed premises' corrections survive to the top level.
    //
    // UNVERIFIED PROPOSALS, BY DESIGN: unlike the premise `verdict` (which IS
    // refute-first checked by adversarialVerification above), cardCorrections
    // are the arm's own unrefuted suggestions — pilot input, never auto-
    // applied. Fix-round finding (real e2e run wf_ca96af60-02d): an arm cited
    // a genuine source line but overgeneralized its reach (a true-evidence/
    // false-reach claim) — the correction survived because this channel is
    // deliberately not verified. Kept that way (verifying every proposed
    // correction would double the Verify fan for a channel whose whole point
    // is fast, cheap arm-authored suggestions) — but `renderSummaryMarkdown`
    // below labels the section honestly and annotates each line with the
    // premise's own verified verdict so a contradiction is visible at a glance.
    //
    // STRUCTURED, not pre-rendered prose (fix round, card
    // #1819690698539009755): `hypothesis` = what the card currently claims,
    // `correction` = what it should say instead — both derived from the
    // arm's own schema-bounded CardCorrectionField, so the artifact carries
    // machine-readable fields instead of a string a consumer would have to
    // re-parse.
    const cardCorrections: CardCorrectionEntry[] = finalResults
      .filter((p) => (p.verdict === 'refuted' || p.verdict === 'partially-confirmed') && p.cardCorrection !== null)
      .map((p) => ({
        premiseId: p.id,
        hypothesis: `${p.cardCorrection!.field}: "${p.cardCorrection!.current}"`,
        correction: p.cardCorrection!.corrected,
      }))

    // ---- Reframe (conditional agent, REQUIRED iff route === 'reframe') ----
    let reframeSketch: ReframeSketch | null = null
    if (recommendation.route === 'reframe') {
      rt.phase('Reframe')
      const blocked = finalResults.filter(
        (p) => p.verdict === 'refuted' || p.verdict === 'unverifiable' || p.verdict === 'unverified-by-cap',
      )
      const sketch = await rt.agent<ReframeAgentReport>(
        `Sketch a narrower reframing of this card: the premises below were blocked, but at ` +
          `least one real alternative mechanism was surfaced. A reframing is a design PROPOSAL — ` +
          `do not restate the blocked plan, propose the narrower path the alternative opens.\n\n` +
          `BLOCKED PREMISES + ALTERNATIVES:\n${untrusted(
            'BLOCKED',
            JSON.stringify(blocked.map((p) => ({ id: p.id, statement: p.statement, verdict: p.verdict, alternativeMechanisms: p.alternativeMechanisms }))),
          )}\n\n` +
          `Return { text }.`,
        { schema: REFRAME_SCHEMA, label: 'dev-ground:reframe', phase: 'Reframe', model: resolved.reframe.model, effort: resolved.reframe.effort },
      )
      if (sketch === null) {
        warn(rt, warnings, 'dev-ground: reframe sketch agent returned null — degrading to sketch-unavailable')
        reframeSketch = { status: 'sketch-unavailable', text: '' }
      } else {
        reframeSketch = { status: 'sketched', text: sketch.text }
      }
    }

    // ---- Predict (unconditional — input.prediction is always non-empty) ----
    rt.phase('Predict')
    const predictReport = await rt.agent<PredictReport>(
      `Check the pre-committed prediction item by item against the verified premise table below. ` +
        `Decompose the prediction into checkable items and, for EACH, decide held | broke | ` +
        `not-tested.\n\n` +
        `PREDICTION:\n${predictionBlock}\n\n` +
        `VERIFIED PREMISES:\n${untrusted(
          'VERIFIED',
          JSON.stringify(finalResults.map((p) => ({ id: p.id, verdict: p.verdict }))),
        )}\n\n` +
        `Return { items: [{ item, outcome }] }.`,
      { schema: PREDICT_SCHEMA, label: 'dev-ground:predict', phase: 'Predict', model: resolved.predict.model, effort: resolved.predict.effort },
    )
    let predictionCheck: PredictionCheckItem[]
    if (predictReport === null || predictReport.items.length === 0) {
      warn(rt, warnings, 'dev-ground: prediction-check agent returned nothing — degrading to a single not-tested record')
      predictionCheck = [{ item: input.prediction.slice(0, 200), outcome: 'not-tested' }]
    } else {
      predictionCheck = predictReport.items
    }

    // Brief's measure of a real grounding is the REFUTATION rate (14 of 36
    // killed on 14/07), NEVER production counters — surfaced explicitly.
    const refutation = { refuted: finalResults.filter((p) => p.verdict === 'refuted').length, total: finalResults.length }

    // HUMAN-FIRST artifact: the JSON blob above is the machine core;
    // summaryMarkdown is what a human reads first. Rendered IN CODE from the
    // fields already assembled above — never a second model call.
    const summaryMarkdown = renderSummaryMarkdown(finalResults, recommendation, recommendationNote, cardCorrections, predictionCheck)

    return {
      premises: input.premises,
      sourceRefs: input.sourceRefs,
      prediction: input.prediction,
      resolved,
      premiseResults: finalResults,
      recommendation,
      recommendationNote,
      summaryMarkdown,
      cardCorrections,
      reframeSketch,
      predictionCheck,
      refutation,
      groundProbe,
      probe: verifyProbe,
      leafFence,
      stats: {
        external: externalArmResult?.stats ?? null,
        internal: internalArmResult?.stats ?? null,
        poc: pocStats,
        verify: verification?.stats ?? null,
      },
      envelope: {
        trail: collectTrail(externalArmResult, internalArmResult, { trail: pocTrail }, verification),
      },
      warnings: [
        ...(externalArmResult?.warnings ?? []),
        ...(internalArmResult?.warnings ?? []),
        ...(verification?.warnings ?? []),
        ...warnings,
      ],
    }
  },
})
