// dev-review-fix.workflow.ts — Review-and-fix third of the dev-workflow family (L3 HITL).
//
// PEDAGOGY: the dev-workflow family
//
//   dev-plan → [human reviews/edits the PlanArtifact] → dev-implement → dev-review-fix
//
// This workflow reviews the WHOLE change set a dev-implement run (or any other
// change) produced — re-reading the diff catches cross-task drift no per-task
// checker could see — then adversarially verifies each finding against the
// actual code, fixes the confirmed ones, and reports deterministically.
//
// Architecture notes:
//   Phase 'Review' — a HAND-ROLLED fan-out (rt.parallel reviewers, one per
//     review dimension) followed by a consolidation agent with an IN-CODE
//     fallback. Deliberately NOT fanOutAndSynthesize: that pattern does not
//     expose per-task results, so a dead synthesis agent would silently lose
//     EVERY reviewer's findings — for a review, a silent total miss is the
//     worst failure mode. Here a dead consolidator degrades to an in-code
//     concat (duplicates possible, loudly warned) instead of to nothing.
//   Phase 'Verify' — adversarialVerification on each finding: the verifier
//     re-derives the issue from the CURRENT tree; plausible-but-wrong findings
//     are refuted. Findings are sorted by severity IN CODE before ids are
//     assigned, because the verify cap is POSITIONAL (slice) — sorting first
//     guarantees the cap can only truncate the lowest-severity tail.
//     Partition: confirmed/partially-confirmed → fix queue; refuted → rejected
//     (with the refuting reasons — the human arbitrates rejections);
//     unverifiable/unverified-by-cap → unverified, NEVER fixed (mutating the
//     tree on unverified evidence is the risk this phase exists to avoid).
//   Phase 'Fix' — ONE batched loopUntilDone over the whole fix queue, not one
//     loop per finding: findings often touch the same files, and a later fix
//     can re-break an earlier one WHILE the suite stays green (review findings
//     are precisely the issues tests do not cover). The checker therefore
//     re-validates EVERY queue finding each iteration, and its verdict REPLACES
//     the fixed-set (a finding can go fixed → re-broken → fixed again). The
//     fixer's self-report is NEVER trusted — only the checker's fresh read of
//     the real testCommand output and the current tree flips findings to fixed.
//   Phase 'Report' — deterministic tallying IN CODE (no agent).
//
// DIFF ACQUISITION (the family's no-git rule):
//   Git projects pass `diffCommand` (a VERBATIM shell command printing the
//   change set, e.g. "git diff main...HEAD"). No-git projects pass
//   `changedFiles` (an explicit file list — e.g. carried over from a
//   dev-implement report's filesTouched). The modes are asymmetric and the
//   reviewer prompt says so: without a diff, "new vs pre-existing" cannot be
//   derived from the tree alone — `changeSummary` anchors what changed.
//
// RESUME HINT:
//   If findings end unfixed, fix the root cause and relaunch with
//   resumeFromRunId: review/verify agents replay from cache; the fix loop
//   re-runs from the first changed prompt — exactly the work to redo.
//
// TRUST BOUNDARY (accepted residual risk — there is NO human gate between
// Review and Fix):
//   Unlike dev-implement, whose tree mutations are bounded by a human-approved
//   PlanArtifact, the Fix phase mutates the tree from agent-derived finding
//   text — reviewers quote the reviewed code, so a hostile change set carries
//   a prompt-injection path into the fixer. Adversarial verification, the
//   fixer's instruction bounds and the checker's id filter mitigate but do
//   not remove this. Only point dev-review-fix at change sets you are willing
//   to let agents modify autonomously — NOT at an untrusted third-party PR
//   checked out locally.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import { adversarialVerification, loopUntilDone, warn } from '@workflow-toolbox/patterns'
import type { PatternStats, VerifiedClaim } from '@workflow-toolbox/patterns'
import type { WorkflowRuntime, JsonSchema } from '@workflow-toolbox/runtime'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface DevReviewFixInput {
  /** Directory every command runs from. */
  projectDir: string
  /** VERBATIM shell command that runs the test suite. */
  testCommand: string
  /** VERBATIM build command ('' = no build step). */
  buildCommand: string
  /** Coding-conventions digest injected into reviewer/fixer prompts. */
  conventions: string
  /** What the change set was SUPPOSED to achieve (cross-task drift check). */
  goal: string
  /** What the change set actually did — anchors no-git reviews ('' = none). */
  changeSummary: string
  /** Exactly ONE of diffCommand/changedFiles is set (the other is null). */
  diffCommand: string | null
  changedFiles: string[] | null
  /** Review dimensions, one reviewer each. */
  dimensions: string[]
  /** Fix loop bound. */
  maxFixIterations: number
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

const SEVERITIES = ['low', 'medium', 'high'] as const

// One reviewer's findings (per dimension)
const DIMENSION_FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          location: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: SEVERITIES },
        },
        required: ['file', 'location', 'summary', 'detail', 'severity'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const satisfies JsonSchema

type DimensionFindings = FromSchema<typeof DIMENSION_FINDINGS_SCHEMA>

// The consolidation agent's output — deduplicated, with dimension provenance
const CONSOLIDATED_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          location: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: SEVERITIES },
          dimensions: { type: 'array', items: { type: 'string' } },
        },
        required: ['file', 'location', 'summary', 'detail', 'severity', 'dimensions'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ConsolidatedOutput = FromSchema<typeof CONSOLIDATED_SCHEMA>
type ConsolidatedFinding = ConsolidatedOutput['findings'][number]

/** A finding with its in-code-assigned id — the unit Verify and Fix work on. */
type IdFinding = ConsolidatedFinding & { id: string }

// Fixer self-report (NEVER trusted for fixed-status)
const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['fixed', 'filesTouched', 'note'],
  additionalProperties: false,
} as const satisfies JsonSchema

type FixResult = FromSchema<typeof FIX_RESULT_SCHEMA>

// Checker output — the only source of truth for fixed-status
const CHECK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          fixed: { type: 'boolean' },
        },
        required: ['id', 'fixed'],
        additionalProperties: false,
      },
    },
    evidence: { type: 'string' },
    failureSummary: { type: 'string' },
  },
  required: ['green', 'findings', 'evidence', 'failureSummary'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CheckResult = FromSchema<typeof CHECK_RESULT_SCHEMA>

// ---------------------------------------------------------------------------
// Final workflow output — deterministic report
// ---------------------------------------------------------------------------

type FindingStatus = 'fixed' | 'unfixed' | 'rejected' | 'unverified'

interface ReportFinding {
  id: string
  dimensions: string[]
  file: string
  location: string
  summary: string
  severity: string
  /** The verify verdict ('partially-confirmed' stays visible — a fix resting
   *  on weaker evidence is the human's business to know). */
  verdict: string
  status: FindingStatus
  /** The checker's actual-output evidence ('' when no check ran for it). */
  evidence: string
  /** Rejection reasons / unverified explanation / last failure. */
  note?: string
}

interface DevReviewFixOutput {
  goal: string
  /** The FINAL check's suite verdict: false = the last completed checker read
   *  saw a red suite/build EVEN IF every finding is individually fixed; null =
   *  no checker read completed (clean review, empty fix queue, or every
   *  checker died). Read this BEFORE trusting tallies.fixed. */
  suiteGreen: boolean | null
  findings: ReportFinding[]
  tallies: {
    findings: number
    /** Findings that entered the fix queue (confirmed + partially-confirmed). */
    confirmed: number
    rejected: number
    unverified: number
    fixed: number
    unfixed: number
  }
  /** Pattern/phase envelope stats: review (hand-built), verify, fix. */
  stats: Record<string, PatternStats>
  warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable error messages
// ---------------------------------------------------------------------------

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`dev-review-fix: "${key}" must be a non-empty string`)
  }
  return v
}

function optionalString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (v === undefined) return ''
  if (typeof v !== 'string') {
    throw new Error(`dev-review-fix: "${key}" must be a string when provided`)
  }
  return v
}

function parseInput(raw: unknown): DevReviewFixInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'dev-review-fix: input must be an object with "projectDir" (string), "testCommand" ' +
      '(string, executable verbatim) and EXACTLY ONE of "diffCommand" (string — git projects) ' +
      'or "changedFiles" (string[] — no-git projects) — received: ' +
      (raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw),
    )
  }
  const obj = raw as Record<string, unknown>

  const projectDir = requireString(obj, 'projectDir')
  const testCommand = requireString(obj, 'testCommand')
  const buildCommand = optionalString(obj, 'buildCommand')
  const conventions = optionalString(obj, 'conventions')
  const goal = optionalString(obj, 'goal')
  const changeSummary = optionalString(obj, 'changeSummary')

  // Diff source: exactly one of diffCommand / changedFiles. An explicit null
  // counts as ABSENT: the parsed shape itself carries null for the unused
  // source (JSON has no undefined), so parseInput must accept its own
  // documented output shape — { diffCommand: null, changedFiles: [...] } is
  // ONE source, not two.
  const hasDiffCommand = obj['diffCommand'] !== undefined && obj['diffCommand'] !== null
  const hasChangedFiles = obj['changedFiles'] !== undefined && obj['changedFiles'] !== null
  if (hasDiffCommand && hasChangedFiles) {
    throw new Error(
      'dev-review-fix: pass exactly one of "diffCommand" or "changedFiles", not both — ' +
      'diffCommand for git projects (a verbatim command printing the diff), changedFiles ' +
      'for no-git projects (an explicit changed-file list)',
    )
  }
  if (!hasDiffCommand && !hasChangedFiles) {
    throw new Error(
      'dev-review-fix: a diff source is required — pass "diffCommand" (git projects, e.g. ' +
      '"git diff main...HEAD") or "changedFiles" (no-git projects, e.g. the filesTouched ' +
      'from a dev-implement report)',
    )
  }

  let diffCommand: string | null = null
  let changedFiles: string[] | null = null
  if (hasDiffCommand) {
    diffCommand = requireString(obj, 'diffCommand')
  } else {
    const cf = obj['changedFiles']
    if (!Array.isArray(cf) || cf.length === 0 || cf.some((f) => typeof f !== 'string' || f.trim().length === 0)) {
      throw new Error(
        'dev-review-fix: "changedFiles" must be a non-empty array of non-empty strings — ' +
        'each entry is a file the change set touched',
      )
    }
    changedFiles = cf as string[]
  }

  let dimensions = ['correctness', 'security', 'conventions', 'tests']
  if (obj['dimensions'] !== undefined) {
    const d = obj['dimensions']
    if (!Array.isArray(d) || d.length === 0 || d.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
      throw new Error(
        'dev-review-fix: "dimensions" must be a non-empty array of non-empty strings (or ' +
        'omitted to default to ["correctness", "security", "conventions", "tests"])',
      )
    }
    dimensions = d as string[]
  }

  let maxFixIterations = 4
  if (obj['maxFixIterations'] !== undefined) {
    if (typeof obj['maxFixIterations'] !== 'number' || obj['maxFixIterations'] < 1) {
      throw new Error('dev-review-fix: "maxFixIterations" must be a number >= 1')
    }
    maxFixIterations = Math.floor(obj['maxFixIterations'])
  }

  return {
    projectDir,
    testCommand,
    buildCommand,
    conventions,
    goal,
    changeSummary,
    diffCommand,
    changedFiles,
    dimensions,
    maxFixIterations,
  }
}

// ---------------------------------------------------------------------------
// Severity ordering — IN CODE, before id assignment.
//
// The verify cap (maxVerifyClaims) truncates POSITIONALLY, so whatever order
// the findings arrive in decides which ones escape verification. Sorting
// high → low first guarantees the cap can only drop the LOWEST-severity tail,
// and makes F-ids meaningful (F1 = most severe). The sort is stable, so the
// consolidator's order is preserved within a severity.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

function sortAndAssignIds(findings: ConsolidatedFinding[]): IdFinding[] {
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  )
  return sorted.map((f, i) => ({ ...f, id: `F${i + 1}` }))
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

interface FixLoopState {
  /** Queue ids the LAST check reported fixed — replaced (not merged) each
   *  iteration: a later fix can re-break an earlier finding. */
  fixedIds: string[]
  lastFailure: string
  evidence: string
  /** Suite verdict of the last COMPLETED checker read (null = none completed).
   *  Carried into the output: "every finding fixed" on a RED suite must stay
   *  visible — a fix can break an UNRELATED test or the build. */
  green: boolean | null
  /** False when the checker died AFTER the fixer mutated the tree: fixed
   *  statuses then rest on evidence predating an UNCHECKED mutation. */
  checkedAfterLastFix: boolean
}

// Locations were captured against the pre-fix tree — fixes shift lines.
const LOCATION_CAVEAT =
  'Locations are approximate — they were captured at review time and the tree may have ' +
  'shifted since; locate each issue by its summary and detail, not the line number.'

async function run(rt: WorkflowRuntime, input: DevReviewFixInput): Promise<DevReviewFixOutput> {
  const warnings: string[] = []
  const stats: Record<string, PatternStats> = {}

  // -------------------------------------------------------------------------
  // Phase 'Review' — hand-rolled fan-out + consolidation with in-code fallback
  // (see header for why this is NOT fanOutAndSynthesize).
  // -------------------------------------------------------------------------

  rt.phase('Review')

  const diffBlock =
    input.diffCommand !== null
      ? `Change set: run this command VERBATIM from ${input.projectDir} and read its output — ` +
        `it prints the diff under review:\n${input.diffCommand}\n`
      : `Change set: this project has no diff available. It touched these files — read each ` +
        `in full: ${JSON.stringify(input.changedFiles)}\n` +
        `NOTE: without a diff you cannot reliably tell new code from pre-existing code. ` +
        `Anchor on the change summary below and prefer issues you can tie to the described ` +
        `change; pre-existing issues are NOT in scope.\n`

  const contextBlock =
    `Goal of the change set: ${input.goal === '' ? '(not stated)' : input.goal}\n` +
    `Change summary: ${input.changeSummary === '' ? '(not provided)' : input.changeSummary}\n` +
    `Conventions: ${input.conventions === '' ? '(not provided)' : input.conventions}\n` +
    `Work from directory: ${input.projectDir}\n`

  const reviewResults = await rt.parallel(
    input.dimensions.map((dimension) => () =>
      rt.agent<DimensionFindings>(
        `You are a code reviewer focused on the ${dimension} dimension of one change set.\n` +
        contextBlock +
        diffBlock +
        `Read enough surrounding code to judge each issue in context. Report ONLY issues ` +
        `introduced or made worse by this change set — not pre-existing ones. An empty ` +
        `findings list is a valid answer for a clean change set.\n` +
        `Return { "findings": [{ "file": "<path>", "location": "<line/symbol>", ` +
        `"summary": "<one line>", "detail": "<what is wrong and why it matters>", ` +
        `"severity": "low"|"medium"|"high" }] }`,
        {
          schema: DIMENSION_FINDINGS_SCHEMA,
          label: `dev-review-fix:review:${dimension}`,
          phase: 'Review',
        },
      ),
    ),
  )

  const parts: Array<{ dimension: string; findings: DimensionFindings['findings'] }> = []
  for (let i = 0; i < input.dimensions.length; i++) {
    const dimension = input.dimensions[i] as string
    const r = reviewResults[i] as DimensionFindings | null
    if (r === null || r === undefined) {
      warn(rt, warnings, `dev-review-fix: reviewer for dimension "${dimension}" died — that dimension's findings are lost`)
      continue
    }
    parts.push({ dimension, findings: r.findings })
  }

  const reviewStats: PatternStats = {
    itemsIn: input.dimensions.length,
    itemsOut: parts.length,
    agentsSpawned: input.dimensions.length,
    dropped: input.dimensions.length - parts.length,
    truncated: 0,
  }
  // Registered now so the early returns below carry it; mutated by reference
  // once the consolidation agent runs.
  stats['review'] = reviewStats

  if (parts.length === 0) {
    warn(rt, warnings, 'dev-review-fix: ALL reviewers died — the review produced no findings; re-run rather than trusting this empty report')
  }

  const rawFindingCount = parts.reduce((n, p) => n + p.findings.length, 0)

  // Clean review (or total reviewer loss): deterministic early exit — no
  // consolidation, no verification, no fix agents.
  if (rawFindingCount === 0) {
    rt.phase('Report')
    return {
      goal: input.goal,
      suiteGreen: null,
      findings: [],
      tallies: { findings: 0, confirmed: 0, rejected: 0, unverified: 0, fixed: 0, unfixed: 0 },
      stats,
      warnings,
    }
  }

  // Consolidation agent — dedup across dimensions. Its death must NOT lose the
  // reviewers' work: the in-code fallback concatenates per-dimension findings
  // (duplicates possible, loudly warned).
  const consolidated = await rt.agent<ConsolidatedOutput>(
    `Consolidate the per-dimension findings into one deduplicated findings list.\n` +
    `Per-dimension findings: ${JSON.stringify(parts)}\n` +
    `Merge duplicates (the same underlying issue reported by several dimensions) into ONE ` +
    `finding listing every reporting dimension; keep the HIGHEST severity among merged ` +
    `duplicates. Do NOT invent findings and do NOT drop non-duplicates.\n` +
    `Return { "findings": [{ "file", "location", "summary", "detail", ` +
    `"severity": "low"|"medium"|"high", "dimensions": ["<dimension>"] }] }`,
    {
      schema: CONSOLIDATED_SCHEMA,
      label: 'dev-review-fix:consolidate',
      phase: 'Review',
    },
  )
  reviewStats.agentsSpawned += 1

  const concatFallback = (): ConsolidatedFinding[] =>
    parts.flatMap((p) => p.findings.map((f) => ({ ...f, dimensions: [p.dimension] })))

  let findingList: ConsolidatedFinding[]
  if (consolidated === null) {
    warn(rt, warnings, 'dev-review-fix: consolidation agent died — falling back to an in-code concat; duplicate findings across dimensions are possible')
    // Mixed semantics on purpose: 'dropped' counts lost work units — dead
    // reviewers (lost dimensions) AND a dead consolidator (lost dedup pass).
    reviewStats.dropped += 1
    findingList = concatFallback()
  } else if (consolidated.findings.length === 0) {
    // Integrity guard — the consolidator is a single chokepoint over text that
    // partly derives from the reviewed code (reviewers quote it), so a
    // returning-but-suppressing consolidator must not silently zero out the
    // review. Same fallback as a dead consolidator.
    warn(rt, warnings, `dev-review-fix: consolidation agent returned ZERO findings while reviewers reported ${rawFindingCount} — refusing the silent drop; falling back to an in-code concat (duplicates possible)`)
    findingList = concatFallback()
  } else {
    findingList = [...consolidated.findings]
    // An honest dedup can only merge ACROSS dimensions, so the consolidated
    // count can never drop below the largest single-dimension count.
    const minPlausible = Math.max(...parts.map((p) => p.findings.length))
    if (findingList.length < minPlausible) {
      warn(rt, warnings, `dev-review-fix: consolidation returned ${findingList.length} finding(s), below the largest single-dimension count (${minPlausible}) — findings were likely dropped; treat this consolidation with suspicion`)
    }
  }

  const findings = sortAndAssignIds(findingList)

  // -------------------------------------------------------------------------
  // Phase 'Verify' — adversarialVerification on each finding.
  // -------------------------------------------------------------------------

  rt.phase('Verify')

  const verifyResult = await adversarialVerification<IdFinding>(rt, {
    claims: findings,
    renderClaim: (f) =>
      `Review finding ${f.id} (severity ${f.severity}, dimensions ${f.dimensions.join('/')}):\n` +
      `File: ${f.file} — ${f.location}\n` +
      `Summary: ${f.summary}\n` +
      `Detail: ${f.detail}\n\n` +
      `IMPORTANT: Do NOT trust this finding. Open the actual code (work from ` +
      `${input.projectDir}) and re-derive whether the issue is real in the CURRENT tree. ` +
      `Refute plausible-but-wrong findings — a wrong "fix" is worse than no fix.`,
    // Severity-aware votes (F7): a low finding gets 1 refute-first vote, the
    // verdict-deciding medium/high keep the full 2-of-3 quorum.
    votesPerClaim: (f) => (f.severity === 'low' ? 1 : 3),
    maxVerifyClaims: 12,
    phase: 'Verify',
  })

  for (const w of verifyResult.warnings) warnings.push(w)
  stats['verify'] = verifyResult.stats

  // Partition by verdict. Only confirmed/partially-confirmed findings may be
  // fixed — mutating the tree on unverified evidence is the failure mode the
  // Verify phase exists to prevent.
  const fixQueue: Array<VerifiedClaim<IdFinding>> = []
  const verdictById = new Map<string, string>()
  const noteById = new Map<string, string>()
  const statusById = new Map<string, FindingStatus>()

  for (const vc of verifyResult.value) {
    verdictById.set(vc.claim.id, vc.verdict)
    if (vc.verdict === 'confirmed' || vc.verdict === 'partially-confirmed') {
      fixQueue.push(vc)
    } else if (vc.verdict === 'refuted') {
      statusById.set(vc.claim.id, 'rejected')
      // The refuting WHY must survive into the report — the human arbitrates
      // rejections (live-run lesson: a title alone is not enough to decide).
      noteById.set(
        vc.claim.id,
        vc.votes
          .flatMap((v) => (v !== null && v.verdict === 'refuted' ? [v.reason] : []))
          .join('; '),
      )
    } else if (vc.verdict === 'unverified-by-cap') {
      statusById.set(vc.claim.id, 'unverified')
      noteById.set(
        vc.claim.id,
        'not verified — beyond the maxVerifyClaims cap (the lowest-severity tail after the in-code sort); re-run with fewer findings to verify it',
      )
    } else {
      statusById.set(vc.claim.id, 'unverified')
      noteById.set(
        vc.claim.id,
        'unverifiable — the verifier votes produced no usable verdict (verifiers may have died); not fixed on unverified evidence',
      )
    }
  }

  // Findings existed but NONE reached the fix queue — that must be LOUD: a
  // dead verifier fleet would otherwise silently downgrade real findings to
  // "unverified, not fixed" and the run would look successful.
  if (fixQueue.length === 0) {
    const rejectedCount = [...statusById.values()].filter((s) => s === 'rejected').length
    const unverifiedCount = [...statusById.values()].filter((s) => s === 'unverified').length
    warn(
      rt,
      warnings,
      `dev-review-fix: ${findings.length} finding(s) but NONE reached the fix queue — ` +
      `${rejectedCount} refuted, ${unverifiedCount} unverified (dead verifiers?). Nothing will be fixed.`,
    )
  }

  // -------------------------------------------------------------------------
  // Phase 'Fix' — ONE batched TDD-style loop over the whole fix queue.
  // -------------------------------------------------------------------------

  rt.phase('Fix')

  let fixState: FixLoopState = {
    fixedIds: [],
    lastFailure: '',
    evidence: '',
    green: null,
    checkedAfterLastFix: true,
  }

  if (fixQueue.length > 0) {
    const queueIds = new Set(fixQueue.map((vc) => vc.claim.id))

    // Each queue entry restated in full with its confirming reasons — the
    // fixer's WHOLE knowledge of the review (fresh-context handoff).
    const queueBlock = JSON.stringify(
      fixQueue.map((vc) => ({
        ...vc.claim,
        verdict: vc.verdict,
        verifierReasons: vc.votes.flatMap((v) => (v !== null ? [v.reason] : [])),
      })),
    )

    const loopResult = await loopUntilDone<FixLoopState>(rt, {
      initial: fixState,
      maxIterations: input.maxFixIterations,
      body: async (rtBody, state, iteration) => {
        const next: FixLoopState = { ...state }
        const remaining = fixQueue
          .map((vc) => vc.claim.id)
          .filter((id) => !next.fixedIds.includes(id))

        // ---- fix: address the remaining findings ----
        const fix = await rtBody.agent<FixResult>(
          `You are the fixer for the confirmed review findings of one change set.\n` +
          contextBlock +
          `Findings (verified against the code — fix ALL of them): ${queueBlock}\n` +
          `Already fixed per the last check: ${JSON.stringify(next.fixedIds)}\n` +
          `Still to fix: ${JSON.stringify(remaining)}\n` +
          `Previous check failure (fix THIS first): ${next.lastFailure === '' ? '(first attempt)' : next.lastFailure}\n` +
          `${LOCATION_CAVEAT}\n` +
          `If an issue is already resolved in the current tree (e.g. fixed as a side effect ` +
          `of an earlier fix), that is a SUCCESS, not a failure: report it fixed with an ` +
          `empty filesTouched list and say so in the note.\n` +
          `Do NOT weaken, skip or delete tests to get green. Do NOT run git commands or ` +
          `create commits. Do NOT touch findings outside the list above. Do NOT change ` +
          `behavior beyond what the findings require.\n` +
          `Run ${input.testCommand} yourself and iterate locally before reporting.\n` +
          `Return { "fixed": true|false, "filesTouched": ["<path>"], "note": "<what changed>" }`,
          {
            schema: FIX_RESULT_SCHEMA,
            label: `dev-review-fix:fix:${iteration}`,
            phase: 'Fix',
          },
        )
        if (fix === null) {
          warn(rtBody, warnings, `dev-review-fix: fixer agent died (iteration ${iteration}) — running the checker anyway: the tree may already be fixed`)
        }

        // ---- check: fresh evidence over the WHOLE queue ----
        // The fixer's self-report is NEVER the source of truth. The checker
        // re-validates EVERY queue finding — including previously-fixed ones,
        // because a later fix can re-break an earlier finding while the suite
        // stays green (review findings are the issues tests do not cover).
        const check = await rtBody.agent<CheckResult>(
          `You are the independent fix checker for the review fix loop. Verify with fresh ` +
          `evidence — do NOT trust the fixer self-report below.\n` +
          `Fixer self-report (untrusted): ${fix === null ? '(fixer died — check the tree anyway: a prior iteration may already have fixed things)' : JSON.stringify(fix)}\n` +
          `Run ${input.testCommand} from ${input.projectDir} and read the ACTUAL output.\n` +
          (input.buildCommand === ''
            ? ''
            : `Also run the build: ${input.buildCommand} — a build break counts as not green.\n`) +
          `Then check EVERY finding below against the current tree — including ones ` +
          `previously reported fixed (a later fix can re-break an earlier one):\n` +
          `${queueBlock}\n` +
          `${LOCATION_CAVEAT}\n` +
          `Return { "green": true|false (the test suite), "findings": [{ "id": "<F-id>", ` +
          `"fixed": true|false }] (one entry per finding above), "evidence": "<what the run ` +
          `actually showed>", "failureSummary": "<empty string ONLY when green with nothing ` +
          `left to fix; else what remains or what broke — including breaks UNRELATED to the ` +
          `findings>" }`,
          {
            schema: CHECK_RESULT_SCHEMA,
            label: `dev-review-fix:check:${iteration}`,
            phase: 'Fix',
          },
        )
        if (check === null) {
          warn(rtBody, warnings, `dev-review-fix: checker agent died (iteration ${iteration}) — treating as not done`)
          // Keep an earlier iteration's REAL failure summary if there is one —
          // a terminal dead-checker must not clobber actionable evidence.
          if (next.lastFailure === '') {
            next.lastFailure = 'checker agent died — no fresh evidence for this iteration'
          }
          // The fixer DID run this iteration: whatever fixed-statuses survive
          // from earlier reads now predate an UNCHECKED tree mutation.
          next.checkedAfterLastFix = false
          return { state: next, done: false }
        }

        // REPLACE the fixed-set with the checker's current read (not a merge):
        // findings can go fixed → re-broken → fixed again across iterations.
        next.fixedIds = check.findings
          .filter((f) => f.fixed && queueIds.has(f.id))
          .map((f) => f.id)
        next.evidence = check.evidence
        next.lastFailure = check.failureSummary
        next.green = check.green
        next.checkedAfterLastFix = true

        const allFixed = fixQueue.every((vc) => next.fixedIds.includes(vc.claim.id))
        return { state: next, done: check.green && allFixed }
      },
    })

    for (const w of loopResult.warnings) warnings.push(w)
    stats['fix'] = loopResult.stats
    fixState = loopResult.value.state
  }

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic tallying IN CODE (no agent).
  // -------------------------------------------------------------------------

  rt.phase('Report')

  const fixedIds = new Set(fixState.fixedIds)
  const reportFindings: ReportFinding[] = findings.map((f) => {
    let status = statusById.get(f.id)
    let note = noteById.get(f.id)
    let evidence = ''
    if (status === undefined) {
      // No partition status = a fix-queue finding (the Verify partition covers
      // every other verdict); its status comes from the checker's LAST read,
      // and fixedIds was already filtered to queue ids inside the loop.
      if (fixedIds.has(f.id)) {
        status = 'fixed'
        evidence = fixState.evidence
        if (!fixState.checkedAfterLastFix) {
          // The checker died AFTER a later fixer mutated the tree: this status
          // rests on evidence that predates an unchecked mutation.
          note =
            'fixed per the last completed check, but a LATER fix iteration mutated the tree ' +
            'without a checker read (checker died) — re-verify before trusting this status'
        }
      } else {
        status = 'unfixed'
        evidence = fixState.evidence
        note =
          fixState.lastFailure === ''
            ? 'unfixed — the fix loop ended before a check confirmed it'
            : `unfixed — last check: ${fixState.lastFailure}`
      }
    }
    return {
      id: f.id,
      dimensions: f.dimensions,
      file: f.file,
      location: f.location,
      summary: f.summary,
      severity: f.severity,
      // Unreachable guard (the pattern emits a verdict per claim): if a future
      // id-mismatch bug ever fires it, 'unverifiable' is loud-ish — never
      // disguise an unaccounted finding as a benign cap truncation.
      verdict: verdictById.get(f.id) ?? 'unverifiable',
      status,
      evidence,
      ...(note !== undefined ? { note } : {}),
    }
  })

  const tallies = {
    findings: reportFindings.length,
    confirmed: fixQueue.length,
    rejected: reportFindings.filter((f) => f.status === 'rejected').length,
    unverified: reportFindings.filter((f) => f.status === 'unverified').length,
    fixed: reportFindings.filter((f) => f.status === 'fixed').length,
    unfixed: reportFindings.filter((f) => f.status === 'unfixed').length,
  }

  if (tallies.unfixed > 0) {
    warn(
      rt,
      warnings,
      `dev-review-fix: ${tallies.unfixed} finding(s) left unfixed — fix the root cause and ` +
      `relaunch with resumeFromRunId (review/verify agents replay from cache), or feed the ` +
      `failure notes into a corrective dev-plan run`,
    )
  }

  // All-fixed-but-RED guard: when every queue finding is individually fixed
  // but the final check saw a red suite/build (a fix broke something the
  // findings do not cover), the resume hint above never fires — this must
  // not read as a full success.
  if (fixQueue.length > 0 && tallies.unfixed === 0 && fixState.green === false) {
    warn(
      rt,
      warnings,
      `dev-review-fix: every fix-queue finding is reported fixed but the FINAL check was ` +
      `NOT green — a fix likely broke something outside the findings (an unrelated test or ` +
      `the build); do not merge on these tallies` +
      (fixState.lastFailure === '' ? '' : ` — last check: ${fixState.lastFailure}`),
    )
  }

  return { goal: input.goal, suiteGreen: fixState.green, findings: reportFindings, tallies, stats, warnings }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'dev-review-fix',
    description:
      'Review-and-fix third of the dev-workflow family: reviews the WHOLE change set across ' +
      'parallel dimensions (catching cross-task drift), adversarially verifies every finding ' +
      'against the actual code, fixes the confirmed ones through a batched loop whose ' +
      'independent checker re-validates ALL findings each iteration, and reports a ' +
      'deterministic fixed/unfixed/rejected/unverified tally.',
    whenToUse:
      'Use after dev-implement (or any change set) to catch what per-task checks missed. ' +
      'Pass projectDir, a verbatim testCommand, and EXACTLY ONE diff source: diffCommand ' +
      '(git projects) or changedFiles (no-git projects). Refuted and unverified findings ' +
      'are never fixed — only reported.',
    phases: [
      { title: 'Review', detail: 'Parallel per-dimension reviewers + consolidation (in-code fallback)' },
      { title: 'Verify', detail: 'Adversarially re-derive each finding from the current tree' },
      { title: 'Fix', detail: 'Batched fix loop; the checker re-validates ALL findings each iteration' },
      { title: 'Report', detail: 'Deterministic fixed/unfixed/rejected/unverified tally (in code)' },
    ],
  },
  parseInput,
  run,
})
