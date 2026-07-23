// independent-analysis.workflow.ts — bias-free, multi-lens adversarial analysis
// of an arbitrary complex subject (a design, plan, claim, decision, or code).
//
// WHY THIS EXISTS: the main model that drives a session has biases — it wants to
// go fast and it tends to confirm its own earlier assumptions. Fresh agents, each
// pinned to a distinct lens and blind to the conversation, do not share that
// investment. This workflow turns "stress-test my thinking" into a deterministic
// fan-out + refute-first verification, so the conclusion is earned, not asserted.
//
// PEDAGOGY — the same 4 defence layers as pr-review, generalized:
//  (1) SCHEMA AT EVERY CONSUMED BOUNDARY — lens proposal, per-lens findings, and
//      the deduped candidate list each carry a schema.
//  (2) REFUTE-FIRST VERIFICATION — adversarialVerification tallies votes IN CODE
//      (no manual claim/verdict join — the one-off this generalizes hit exactly
//      that title-matching bug), and verifiers are framed to REFUTE.
//  (3) DECOMPOSED SCOPES — one agent per lens; each sees one angle, not the whole.
//  (4) UNTRUSTED EMBEDDING — the subject/context/assumptions are caller text and
//      a prompt-injection surface; every embedding site delimits them as data and
//      mangles embedded copies of the delimiter.
//
// MODEL NOTE: adversarialVerification defaults its verifier model to the toolkit
// BEST_MODEL. Pass `verifierModel` to override (required while a stronger model is
// unavailable). The fan-out/synthesis agents inherit the session model.
//
// CROSS-MODEL NOTE: pass `args.agentTypes.verify = 'codex:codex-rescue'` (the
// structured config envelope; no bespoke top-level arg) to route every verifier
// through a non-Claude (GPT) model — genuine decorrelation, the one real lever
// against same-model correlated findings (the verifier no longer shares the
// session model's priors). The request is PROBED at entry with graceful fallback
// to the standard verifier. Local-machine-only (depends on a codex setup); for a
// portable cross-model verifier prefer an MCP→model endpoint. See cross-model-verify.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { MODEL_ALIASES } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { resolveEffort, resolveVerifierEffort } from '@workflow-toolbox/std'
// untrusted() / renderSourceRefs() (used below) are promoted from here +
// cross-model-verify.workflow.ts into @workflow-toolbox/patterns, Rule of
// Three — the two copies were byte-identical.
import {
  adversarialVerification,
  collectTrail,
  fanOutAndSynthesize,
  probeAgentType,
  renderSourceRefs,
  untrusted,
  withLeafFence,
} from '@workflow-toolbox/patterns'
import type { VerifiedClaim, AgentTypeProbeReport } from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Per-stage effort defaults (Class B/C launch-time tuning — see parseConfig).
// A launch-time `args.effort.<role>` override (parsed into `input.effort`) can
// retune any of these without a source edit, via resolveEffort. 'verify' is
// clamped to a 'high' FLOOR (resolveVerifierEffort) — an override may only
// RAISE it, mirroring adversarialVerification's own model-floor guardrail.
// ---------------------------------------------------------------------------
const LENSES_EFFORT: EffortAlias = 'medium'          // Lenses: auto-propose analysis angles
const ANALYZE_TASK_EFFORT: EffortAlias = 'high'      // Analyze: per-lens adversarial analysis
const ANALYZE_SYNTHESIS_EFFORT: EffortAlias = 'medium' // Analyze: dedup/consolidation
const VERIFY_EFFORT_DEFAULT: EffortAlias = 'high'    // Verify: adversarialVerification (floor 'high')

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface IndependentAnalysisInput {
  /** What to analyze — a design, plan, claim, decision, or code description. */
  subject: string
  /** Background/material grounding the analysis (may be empty). */
  context: string
  /** The claims/known points to stress-test AND dedup findings against. */
  assumptions: string[]
  /** Analysis angles; when empty, `lensCount` lenses are auto-proposed. */
  lenses: string[]
  /** Files agents should READ to ground claims in real source (may be empty). */
  sourceRefs: string[]
  /** How many lenses to auto-propose when `lenses` is empty. */
  lensCount: number
  /** Verifier votes per (non-low) candidate. */
  votes: number
  /** Verifier model override; undefined → adversarialVerification's BEST_MODEL. */
  verifierModel: ModelAlias | undefined
  /** Subagent type to route EVERY verifier through — e.g. 'codex:codex-rescue'
   *  for a GPT cross-model verifier (genuine decorrelation, the one real lever
   *  against same-model correlated findings). undefined → standard same-model
   *  verifier. Requested via the STRUCTURED config envelope:
   *  `args.agentTypes.verify` (role key mirrors `effort.verify`; no bespoke
   *  top-level arg). PROBED at entry (probeAgentType) with graceful fallback
   *  to the standard verifier, reported in the result's `probe` field.
   *  Cross-model wrappers are local-machine-only; not portable. */
  verifierType: string | undefined
  /** Optional per-ROLE reasoning-effort overrides (Class B/C, parsed by the
   *  shared `parseConfig` helper from `args.effort`), e.g.
   *  `args: { subject, effort: { analyzeTask: 'xhigh' } }`. Role keys: 'lenses',
   *  'analyzeTask', 'analyzeSynthesis', 'verify'. A role's value may also be
   *  the literal 'auto' (keep THIS role's own committed default). null = no
   *  overrides. Resolved per-stage via resolveEffort; 'verify' is additionally
   *  clamped to a 'high' floor via resolveVerifierEffort. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
  /** Blanket opt-OUT of the default leaf-agent fence (withLeafFence): every agent
   *  this workflow spawns denies SendMessage by default. true = allow the standard
   *  (messaging-capable) subagent instead. null/false (default) = the fence applies. */
  messaging: boolean | null
}


// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

const LENS_SCHEMA = {
  type: 'object',
  properties: {
    lenses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          focus: { type: 'string' },
        },
        required: ['key', 'focus'],
        additionalProperties: false,
      },
    },
  },
  required: ['lenses'],
  additionalProperties: false,
} as const satisfies JsonSchema

type LensList = FromSchema<typeof LENS_SCHEMA>
type Lens = LensList['lenses'][number]

const ANGLES_SCHEMA = {
  type: 'object',
  properties: {
    angles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          kind: {
            type: 'string',
            enum: ['risk', 'gap', 'wrong-assumption', 'edge-case', 'alternative'],
          },
          // Honest self-check: is this already covered by a stated assumption?
          alreadyKnown: { type: 'boolean' },
        },
        required: ['title', 'why', 'severity', 'kind', 'alreadyKnown'],
        additionalProperties: false,
      },
    },
  },
  required: ['angles'],
  additionalProperties: false,
} as const satisfies JsonSchema

type AnglesOutput = FromSchema<typeof ANGLES_SCHEMA>

const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          lens: { type: 'string' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          kind: {
            type: 'string',
            enum: ['risk', 'gap', 'wrong-assumption', 'edge-case', 'alternative'],
          },
        },
        required: ['title', 'lens', 'why', 'severity', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CandidatesOutput = FromSchema<typeof CANDIDATES_SCHEMA>
type Candidate = CandidatesOutput['candidates'][number]

// ---------------------------------------------------------------------------
// Untrusted-text embedding — caller text is data, never instructions.
// ---------------------------------------------------------------------------

const renderAssumptions = (assumptions: readonly string[]): string =>
  assumptions.length === 0
    ? '(none stated)'
    : assumptions.map((a, i) => `  K${i + 1}. ${a}`).join('\n')

// ---------------------------------------------------------------------------

function requireNonEmptyString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`independent-analysis: "${key}" must be a non-empty string`)
  }
  return v
}

function optStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
    throw new Error(`independent-analysis: "${key}" must be an array of non-empty strings`)
  }
  return v as string[]
}

// No explicit type args: passing only <TInput> would pin TOut to its `unknown`
// default (TS skips inference for the rest once any arg is given). Letting both
// infer — TInput from parseInput's annotated return, TOut from run's body —
// gives consumers a typed result. (pr-review follows the same no-generics form.)
export default defineWorkflow({
  meta: {
    name: 'independent-analysis',
    description:
      'Bias-free multi-lens adversarial analysis of a subject: fan out one agent per lens to surface forgotten angles/risks, dedup vs stated assumptions, then refute-first verify the survivors.',
    phases: [{ title: 'Fence' }, { title: 'Probe' }, { title: 'Lenses' }, { title: 'Analyze' }, { title: 'Verify' }],
  },

  parseInput: (raw): IndependentAnalysisInput => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        'independent-analysis: input must be an object with at least "subject" (a non-empty string)',
      )
    }
    const obj = raw as Record<string, unknown>

    const subject = requireNonEmptyString(obj, 'subject')
    const context = typeof obj['context'] === 'string' ? obj['context'] : ''
    const assumptions = optStringArray(obj, 'assumptions')
    const lenses = optStringArray(obj, 'lenses')
    const sourceRefs = optStringArray(obj, 'sourceRefs')

    let lensCount = 5
    if (obj['lensCount'] !== undefined) {
      if (typeof obj['lensCount'] !== 'number' || obj['lensCount'] < 1) {
        throw new Error('independent-analysis: "lensCount" must be a number >= 1')
      }
      lensCount = Math.floor(obj['lensCount'])
    }

    let votes = 3
    if (obj['votes'] !== undefined) {
      if (typeof obj['votes'] !== 'number' || obj['votes'] < 1) {
        throw new Error('independent-analysis: "votes" must be a number >= 1')
      }
      votes = Math.floor(obj['votes'])
    }

    let verifierModel: ModelAlias | undefined
    if (obj['verifierModel'] !== undefined) {
      if (
        typeof obj['verifierModel'] !== 'string' ||
        !(MODEL_ALIASES as readonly string[]).includes(obj['verifierModel'])
      ) {
        throw new Error(
          `independent-analysis: "verifierModel" must be one of ${MODEL_ALIASES.join(', ')}`,
        )
      }
      verifierModel = obj['verifierModel'] as ModelAlias
    }


    // Class B/C launch-time config, validated by the shared parseConfig helper:
    // per-role effort overrides (`effort.verify`) and the per-role agentType
    // routing map (`agentTypes.verify` — the structured channel for cross-model
    // routing; no bespoke top-level arg). Bespoke subject/lenses/votes/
    // verifierModel keys are IGNORED by parseConfig, so the conventions compose.
    const cfg = parseConfig(obj)
    const effort = cfg.effort ?? null
    const verifierType = cfg.agentTypes?.['verify']
    const messaging = cfg.messaging ?? null

    return { subject, context, assumptions, lenses, sourceRefs, lensCount, votes, verifierModel, verifierType, effort, messaging }
  },

  run: async (rt0: WorkflowRuntime, input: IndependentAnalysisInput) => {
    // Leaf-agent fence — the LOWEST-priority default, applied first so it never
    // clobbers a per-role agentType (each call site's own opts, e.g. verifierType
    // below). Every agent this workflow spawns defaults to the SendMessage-denying
    // agentType unless `messaging: true` was requested — see
    // @workflow-toolbox/patterns' withLeafFence.
    rt0.phase('Fence')
    const { rt, report: leafFence } = await withLeafFence(rt0, {
      phase: 'Fence',
      disabled: input.messaging === true,
    })
    const subjectBlock = untrusted('SUBJECT', input.subject)
    const contextBlock = input.context.trim().length > 0 ? untrusted('CONTEXT', input.context) : '(no extra context)'
    const assumptionsBlock = renderAssumptions(input.assumptions)
    const sourceBlock = renderSourceRefs(input.sourceRefs, {
      emptyNote: 'No source files were provided — reason from the subject + context as given.',
      leadIn: 'READ these files to GROUND every claim in real content (cite specifics):',
    })

    // Resolve each stage's effort ONCE: a launch-time `args.effort.<role>`
    // override wins when valid, else the stage-class default declared above.
    // 'verify' is additionally floored at 'high' — see resolveVerifierEffort.
    const lensesEffort = resolveEffort(input.effort?.['lenses'], LENSES_EFFORT)
    const analyzeTaskEffort = resolveEffort(input.effort?.['analyzeTask'], ANALYZE_TASK_EFFORT)
    const analyzeSynthesisEffort = resolveEffort(input.effort?.['analyzeSynthesis'], ANALYZE_SYNTHESIS_EFFORT)
    const verifyEffort = resolveVerifierEffort(input.effort?.['verify'], VERIFY_EFFORT_DEFAULT)

    // ---- Phase 0 (conditional): probe the requested verifier agentType ----
    // One schema-less probe; any non-affirmative outcome (UNAVAILABLE marker,
    // null, error text, throw on an unregistered type) degrades to the standard
    // same-model verifier. Never silent: logged + digested + result `probe`.
    let resolvedVerifierType: string | undefined
    let probeInfo: AgentTypeProbeReport | null = null
    if (input.verifierType !== undefined) {
      rt.phase('Probe')
      const probe = await probeAgentType(rt, input.verifierType, { phase: 'Probe', required: true })
      resolvedVerifierType = probe.agentType
      probeInfo = { requested: input.verifierType, available: probe.available, reason: probe.reason }
    }

    // ---- Phase 1: lenses (caller-supplied, else auto-proposed) ----
    rt.phase('Lenses')
    let lensList: Lens[]
    if (input.lenses.length > 0) {
      lensList = input.lenses.map((l, i) => ({ key: l.slice(0, 48) || `lens-${i + 1}`, focus: l }))
    } else {
      const proposed = await rt.agent<LensList>(
        `Propose exactly ${input.lensCount} DIVERSE, non-overlapping analysis lenses to adversarially ` +
          `stress-test the subject below. Each lens is a distinct angle a forgotten risk could hide in ` +
          `(e.g. correctness, edge cases, failure modes, security, performance, operability, ` +
          `assumptions, alternatives, scope/altitude — pick what FITS this subject). Return { "lenses": ` +
          `[{ "key": "<short-slug>", "focus": "<one sentence: what this lens hunts for>" }] }.\n\n` +
          `SUBJECT:\n${subjectBlock}\n\nCONTEXT:\n${contextBlock}`,
        { schema: LENS_SCHEMA, label: 'independent-analysis:propose-lenses', phase: 'Lenses', effort: lensesEffort },
      )
      if (proposed === null || proposed.lenses.length === 0) {
        throw new Error(
          'independent-analysis: lens proposal failed (agent died or returned no lenses) — ' +
            'resume from the Lenses phase or pass explicit "lenses".',
        )
      }
      lensList = proposed.lenses
    }
    rt.log(`independent-analysis: ${lensList.length} lenses (${lensList.map((l) => l.key).join(', ')})`)

    // Preventive nudge: a lens implying EXTERNAL verification (docs / web /
    // "verify against" / official) can only be grounded by a network tool, which
    // is silently deniable per environment. With no sourceRefs, the analyst
    // reasons from priors and its external claims are unverifiable — warn (never
    // fail) so the author attaches the source via sourceRefs (Read is never
    // network-gated) or grounds it out-of-band and passes the conclusion as context.
    if (input.sourceRefs.length === 0) {
      const externalLens = lensList.find((l) =>
        /\bdocs?\b|\bweb\b|verify against|official/i.test(`${l.key} ${l.focus}`),
      )
      if (externalLens !== undefined) {
        rt.log(
          `independent-analysis: lens "${externalLens.key}" implies external verification ` +
            `but no sourceRefs were provided — agents will reason from priors and external ` +
            `claims will be unverifiable. Attach the source via sourceRefs (Read is never ` +
            `network-gated), or ground it out-of-band and pass the conclusion as context.`,
        )
      }
    }

    // ---- Phases 2: fan out per lens, then synthesize a deduped candidate list ----
    const analysis = await fanOutAndSynthesize<Lens, AnglesOutput, CandidatesOutput>(rt, {
      tasks: lensList,
      taskPrompt: (lens) =>
        `You are an independent analyst. Examine the subject ADVERSARIALLY through ONE lens only.\n` +
        `LENS "${lens.key}": ${lens.focus}\n\n` +
        `Your job is to surface FORGOTTEN angles — risks, gaps, wrong assumptions, edge cases, or ` +
        `better alternatives — that the stated assumptions below do NOT already cover. Be concrete and ` +
        `specific; prefer a few high-signal findings over a long shallow list. For EACH finding, honestly ` +
        `set alreadyKnown=true if it merely restates a stated assumption.\n\n` +
        `${sourceBlock}\n\n` +
        `SUBJECT:\n${subjectBlock}\n\nCONTEXT:\n${contextBlock}\n\n` +
        `ALREADY-STATED ASSUMPTIONS (do NOT restate these as new):\n${assumptionsBlock}\n\n` +
        `Return { "angles": [{ "title", "why", "severity": high|medium|low, ` +
        `"kind": risk|gap|wrong-assumption|edge-case|alternative, "alreadyKnown": bool }] }. ` +
        `If this lens genuinely surfaces nothing new, return an empty angles array.`,
      taskSchema: ANGLES_SCHEMA,
      taskEffort: analyzeTaskEffort,
      synthesisPrompt: (parts) =>
        `You are the synthesis agent. Below are findings from ${parts.length} independent lens analysts ` +
        `of the SAME subject (JSON). Produce a DEDUPED candidate list: (1) merge findings that are the ` +
        `same angle in different words into one; (2) DROP any finding with alreadyKnown=true or that ` +
        `merely restates one of the stated assumptions; (3) keep only genuinely-new angles. Carry the ` +
        `most representative lens for each. Order by severity (high first).\n\n` +
        `STATED ASSUMPTIONS (already covered — drop matches):\n${assumptionsBlock}\n\n` +
        `RAW LENS FINDINGS (JSON):\n${untrusted('LENS-FINDINGS', JSON.stringify(parts))}\n\n` +
        `Return { "candidates": [{ "title", "lens", "why", "severity": high|medium|low, ` +
        `"kind": risk|gap|wrong-assumption|edge-case|alternative }] }.`,
      synthesisSchema: CANDIDATES_SCHEMA,
      synthesisEffort: analyzeSynthesisEffort,
      phase: 'Analyze',
    })

    const candidates: Candidate[] = analysis.value?.candidates ?? []
    rt.log(`independent-analysis: ${candidates.length} candidate findings after synthesis/dedup`)

    if (candidates.length === 0) {
      return {
        subject: input.subject,
        lensesUsed: lensList.map((l) => l.key),
        confirmed: [],
        refuted: [],
        allVerified: [],
        candidateCount: 0,
        stats: { analyze: analysis.stats, verify: null },
        envelope: { trail: collectTrail(analysis) },
        warnings: [...analysis.warnings, 'no candidate findings survived synthesis'],
      }
    }

    // ---- Phase 3: refute-first verification of each candidate ----
    const verification = await adversarialVerification<Candidate>(rt, {
      claims: candidates,
      renderClaim: (c) =>
        `An independent multi-lens sweep proposes the finding below as a GENUINELY NEW and REAL issue ` +
        `with the subject — one NOT already covered by the stated assumptions. Decide whether it is BOTH ` +
        `real AND new. REFUTE it if: it merely restates a stated assumption, it is a non-issue given the ` +
        `subject as described, it is unfounded/speculative, or it duplicates another known point. ` +
        (input.sourceRefs.length > 0
          ? `Re-derive from the ACTUAL source files (${input.sourceRefs.join(', ')}) — do NOT trust the ` +
            `finding's own description.\n\n`
          : `\n`) +
        `FINDING:\n${untrusted('FINDING', `${c.title}\n[${c.severity}/${c.kind}, lens=${c.lens}]\n${c.why}`)}\n\n` +
        `STATED ASSUMPTIONS:\n${assumptionsBlock}\n\n` +
        `SUBJECT (for grounding):\n${subjectBlock}`,
      votes: input.votes,
      // Low-severity findings get a single vote; the rest get the full panel.
      votesPerClaim: (c) => (c.severity === 'low' ? 1 : input.votes),
      effort: verifyEffort,
      ...(input.verifierModel !== undefined ? { model: input.verifierModel } : {}),
      ...(resolvedVerifierType !== undefined ? { verifierType: resolvedVerifierType } : {}),
      phase: 'Verify',
    })

    const verified = (verification.value ?? []) as ReadonlyArray<VerifiedClaim<Candidate>>
    const isReal = (v: VerifiedClaim<Candidate>): boolean =>
      v.verdict === 'confirmed' || v.verdict === 'partially-confirmed'

    const confirmed = verified
      .filter(isReal)
      .map((v) => ({ ...v.claim, verdict: v.verdict }))
    const refuted = verified
      .filter((v) => v.verdict === 'refuted')
      .map((v) => ({ title: v.claim.title, severity: v.claim.severity, lens: v.claim.lens }))

    return {
      subject: input.subject,
      lensesUsed: lensList.map((l) => l.key),
      // Verifier routing outcome: the type actually used (undefined → standard
      // same-model verifier) + the structured probe story when routing was requested.
      verifierType: resolvedVerifierType ?? null,
      probe: probeInfo,
      // Leaf-agent fence outcome (withLeafFence): whether every spawned agent
      // defaulted to the SendMessage-denying agentType, or degraded/opted out.
      leafFence,
      confirmed,
      refuted,
      allVerified: verified.map((v) => ({
        title: v.claim.title,
        severity: v.claim.severity,
        kind: v.claim.kind,
        verdict: v.verdict,
      })),
      candidateCount: candidates.length,
      stats: { analyze: analysis.stats, verify: verification.stats },
      envelope: { trail: collectTrail(analysis, verification) },
      warnings: [...analysis.warnings, ...verification.warnings],
    }
  },
})
