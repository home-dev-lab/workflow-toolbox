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

import { defineWorkflow } from '@dwt/build/define'
import type { WorkflowRuntime, JsonSchema } from '@dwt/runtime'
import {
  classifyAndAct,
  adversarialVerification,
} from '@dwt/patterns'
import type { VerifiedClaim } from '@dwt/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface PrReviewInput {
  target: string
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Schema for the routed change summary (classifyAndAct act stage output)
const CHANGE_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    riskAreas: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'riskAreas'],
  additionalProperties: false,
} as const satisfies JsonSchema

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
// Reviewer lenses per category
// Each category gets 3 specialized lenses: different failure modes, not
// redundant coverage. Distinct lenses catch failures plain redundancy misses.
// ---------------------------------------------------------------------------

const REVIEWER_LENSES: Readonly<Record<string, readonly string[]>> = {
  bugfix: ['root-cause', 'regression-risk', 'test-coverage'],
  feature: ['correctness', 'security', 'api-design'],
  refactor: ['behavioral-equivalence', 'test-coverage', 'readability'],
  config: ['correctness', 'security', 'blast-radius'],
  docs: ['accuracy', 'completeness', 'clarity'],
}

// Fallback lenses when the category is not in the map
const DEFAULT_LENSES: readonly string[] = ['correctness', 'security', 'test-coverage']

// ---------------------------------------------------------------------------
// A finding enriched with its adversarial verdict (for the final output)
// ---------------------------------------------------------------------------

interface VerifiedFinding {
  title: string
  file: string
  severity: 'high' | 'medium' | 'low'
  detail: string
  verdict: 'confirmed' | 'partially-confirmed' | 'refuted' | 'unverifiable'
}

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

interface PrReviewOutput {
  category: string
  verdict: 'approve' | 'request-changes'
  summary: string
  findings: readonly VerifiedFinding[]
  stats: {
    reviewersSpawned: number
    findingsRaw: number
    findingsVerified: number
    findingsRefuted: number
    dropped: number
  }
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
    return { target: raw }
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

  return { target: obj['target'] }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: PrReviewInput): Promise<PrReviewOutput> {
  const warnings: string[] = []
  let reviewersSpawned = 0
  let dropped = 0

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
      `Return { "category": "<one of the five categories>" }`,
    actions: {
      feature: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a FEATURE change. Inspect the actual change (${target}) and produce a focused summary.\n` +
          `Return { "summary": "<what the feature does>", "riskAreas": ["<risk1>", ...] }`,
      },
      bugfix: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a BUGFIX change. Inspect the actual change (${target}) — re-derive from first principles.\n` +
          `Return { "summary": "<what was broken and how it is fixed>", "riskAreas": ["<risk1>", ...] }`,
      },
      refactor: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a REFACTOR change. Inspect the actual change (${target}).\n` +
          `Return { "summary": "<what was refactored and why>", "riskAreas": ["<risk1>", ...] }`,
      },
      config: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a CONFIG change. Inspect the actual change (${target}).\n` +
          `Return { "summary": "<what config changed and its effect>", "riskAreas": ["<risk1>", ...] }`,
      },
      docs: {
        schema: CHANGE_SUMMARY_SCHEMA,
        prompt: (target) =>
          `You are reviewing a DOCS change. Inspect the actual change (${target}).\n` +
          `Return { "summary": "<what documentation was updated>", "riskAreas": ["<risk1>", ...] }`,
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
    const result = await rt.agent<FindingsOutput>(
      `You are a specialized code reviewer examining the "${lens}" aspect of this change.\n` +
      `Change target: ${input.target}\n` +
      `Change summary: ${changeSummary.summary}\n` +
      `Risk areas: ${changeSummary.riskAreas.join(', ')}\n` +
      `Read the ACTUAL change (you have repo access). Do NOT trust the summary above — re-derive findings from first principles.\n` +
      `Focus ONLY on the "${lens}" lens. Return your findings.\n` +
      `Each finding: { title, file, severity ('high'|'medium'|'low'), detail }`,
      {
        schema: FINDINGS_SCHEMA,
        label: `pr-review:reviewer:${lens}`,
        phase: 'Review',
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
      claims: findings,
      renderClaim: (finding) =>
        `Reviewer (lens: ${lens}) reported: "${finding.title}" in ${finding.file}\n` +
        `Detail: ${finding.detail}\n` +
        `Severity: ${finding.severity}\n\n` +
        `IMPORTANT: Do NOT trust the reviewer summary above. Open the actual diff at ${input.target} ` +
        `and re-derive whether this finding is genuine from first principles.`,
      lenses: ['correctness', 'security', 'does-it-reproduce'],
      votes: 3,
      maxVerifyClaims: 5,
      phase: 'Verify',
    })

    for (const w of verifyResult.warnings) warnings.push(w)

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
  // failed, NOT that the finding is wrong. Only 'refuted' is excluded.
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
    `You are synthesizing a code review for the change: ${input.target}\n` +
    `Category: ${category}\n` +
    `Change summary: ${changeSummary.summary}\n\n` +
    `Verified findings (non-refuted):\n${JSON.stringify(synthesisFindings, null, 2)}\n\n` +
    `Produce an overall verdict: "approve" if no high-severity confirmed findings remain, ` +
    `"request-changes" otherwise. Include a concise summary.\n` +
    `Return { "verdict": "approve"|"request-changes", "summary": "<concise summary>" }`

  const synthesisAgent = await rt.agent<SynthesisOutput>(synthesisPrompt, {
    schema: SYNTHESIS_SCHEMA,
    label: 'pr-review:synthesize',
    phase: 'Synthesize',
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
    stats: {
      reviewersSpawned,
      findingsRaw,
      findingsVerified,
      findingsRefuted,
      dropped,
    },
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
      { title: 'Route', detail: 'Classify the change and produce a targeted summary' },
      { title: 'Review', detail: 'Spawn specialized reviewer agents per lens' },
      { title: 'Verify', detail: 'Adversarially verify each finding (fresh-evidence check)' },
      { title: 'Synthesize', detail: 'Produce an overall verdict from verified findings' },
    ],
  },
  parseInput,
  run,
})
