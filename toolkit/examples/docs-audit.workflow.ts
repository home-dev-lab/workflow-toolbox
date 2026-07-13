// docs-audit.workflow.ts — pre-release semantic documentation audit.
//
// The mechanical layer of a docs-drift defence (symbol existence, value
// anchors, export coverage) belongs in compile-time gates — cheap, always-on,
// zero judgment. What those gates CANNOT check is semantic prose: "X does Y",
// "run this before that", "the cap never destroys evidence". This workflow is
// the judgment layer for exactly those claims, built to run BEFORE a release
// (npm publish, plugin version bump) rather than on every commit.
//
// PEDAGOGY: This example teaches 4 lessons about auditing unknown-size claim
// spaces:
//
//  (1) LOOP-UNTIL-DRY DISCOVERY — the set of checkable claims in a doc corpus
//      has unknown size, so a fixed one-pass extraction undercounts the tail.
//      loopUntilDone with dryRounds runs angle-cycled extraction sweeps until
//      a full round finds nothing new (dedup vs an accumulated seen-set —
//      dedup vs SEEN, not vs confirmed, or rejected claims reappear forever).
//
//  (2) EVIDENCE-TIERED VERDICTS COME FREE — adversarialVerification's verdict
//      taxonomy IS the evidence tiering this audit needs: 'confirmed' (the
//      sources match today), 'refuted' (the doc is STALE), 'partially-confirmed'
//      (drifted in detail), 'unverifiable' (no evidence found), and the
//      pattern-owned 'unverified-by-cap' (never tested — a cap must never
//      destroy evidence). No bespoke taxonomy, no bespoke tally.
//
//  (3) SELF-REPORTED RISK AIMS THE EXPENSIVE STAGE — the extractor already
//      read the doc, so its per-claim risk tag is free. Sorting claims
//      high→medium→low BEFORE the verification cap means maxVerifyClaims cuts
//      the cheapest-to-lose claims first — a zero-agent substitute for a
//      scoring stage (scoreAndRank would cost one scorer per claim here).
//
//  (4) NO LEAN ROUTING — every role in this workflow (inventory, extract,
//      verify) must READ the repository. withLeanRouting strips tool access,
//      so it has no eligible role here; only the leaf fence applies. Lean is
//      selective by design — see pr-review's Synthesize stage for the
//      counter-example that DOES qualify.
//
//  ON LAUNCH: ALWAYS check WorkflowOutput.error. On partial failure, relaunch
//  with resumeFromRunId — completed agent() calls replay from cache, only
//  missing work re-runs. The orchestrator runs where it was launched (a
//  delegated launch runs in the SERVER's cwd), so pass repoRoot as an ABSOLUTE
//  path and let the agents read the repo themselves.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, EffortAlias, ModelAlias, AgentDefaults } from '@workflow-toolbox/runtime'
import { resolveEffort, resolveVerifierEffort } from '@workflow-toolbox/std'
import {
  adversarialVerification,
  collectTrail,
  loopUntilDone,
  probeAgentType,
  warn,
  withLeafFence,
} from '@workflow-toolbox/patterns'
import type {
  ClaimVerdict,
  LeafFenceReport,
  LoopStoppedBy,
  TrailRecord,
  VerifierVote,
} from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Per-stage effort defaults (Class B/C launch-time tuning — see parseConfig).
// Inventory is a directory-listing errand; extraction is read-and-report over
// a handful of doc files; verification is the terminal judgment gate for the
// whole audit, floor-clamped to 'high' via resolveVerifierEffort like every
// verify/judge stage in this toolkit (a launch-time override may only RAISE it).
// ---------------------------------------------------------------------------
const INVENTORY_EFFORT: EffortAlias = 'low'
const EXTRACT_EFFORT: EffortAlias = 'medium'
const VERIFY_EFFORT_DEFAULT: EffortAlias = 'high'

// Local copy (2nd instance, after independent-analysis) — deliberately NOT
// promoted to a runtime export yet: the Rule-of-Three flips the default at the
// 3rd consumer, and a new public export carries its own doc/versioning ripple.
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface DocsAuditInput {
  /** ABSOLUTE path to the repository to audit. Every agent reads files under
   *  this root itself (the orchestrator has no filesystem access), so the path
   *  must be valid on the machine the agents run on. */
  repoRoot: string
  /** Repo-relative doc surfaces to audit. null → an Inventory agent derives
   *  the list from `surfaceRules` (or the built-in default rules). */
  surfaces: readonly string[] | null
  /** Prose rules for the Inventory agent (only used when `surfaces` is null).
   *  null → DEFAULT_SURFACE_RULES (READMEs, docs/, skills + references,
   *  CLAUDE.md; excludes changelogs/ADRs/generated files). */
  surfaceRules: string | null
  /** Free-text context threaded into extract AND verify prompts — e.g. where
   *  a doc↔source provenance map lives, or which subsystems moved recently. */
  hints: string | null
  /** Extraction loop ceiling (loopUntilDone maxIterations). Default 3. */
  maxRounds: number
  /** Consecutive no-new-claims rounds that end extraction. Default 1. */
  dryRounds: number
  /** Doc surfaces batched per extraction agent (1..10). Default 4 — fewer,
   *  bigger agents beat one-per-surface: each spawn pays the full ambient
   *  context injection, and reading 4 docs is well within one context. */
  surfacesPerAgent: number
  /** Verification cap (adversarialVerification maxVerifyClaims). Claims cut
   *  by the cap are KEPT as 'unverified-by-cap' findings — never destroyed.
   *  Default 60. */
  maxVerifyClaims: number
  /** Verifier votes per claim. Default 3; the refute threshold is
   *  min(2, votes) so a single-vote run is decided by its one vote. */
  votes: number
  /** Verifier model override; undefined → adversarialVerification's BEST_MODEL
   *  (the pattern warns when a weaker model is chosen — §8 risk guardrail).
   *  Useful for routine (non-release) audits on a cheaper tier. */
  verifierModel: ModelAlias | undefined
  /** Optional per-ROLE reasoning-effort overrides (Class B/C, parsed by the
   *  shared `parseConfig` helper from `args.effort`). Role keys: 'inventory',
   *  'extract', 'verify'. 'verify' is floored at 'high'. null = no overrides. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
  /** Optional blanket per-agent defaults (model/effort/agentType/isolation),
   *  applied to every stage via one withAgentDefaults wrap. Per-call/pattern
   *  opts still win — the verifiers' explicit BEST_MODEL is not downgraded.
   *  Parsed from `args.perAgent` by the shared `parseConfig` helper. */
  perAgent: AgentDefaults | null
  /** Optional cross-model verifier agentType (e.g. an MCP→GPT bridge), parsed
   *  from `args.agentTypes.verify`. PROBED at run entry (probeAgentType):
   *  unavailable → graceful degrade to the standard verifier, reported in the
   *  result's `verifierProbe`, never silent. */
  verifierType: string | null
  /** Blanket opt-OUT of the default leaf-agent fence (withLeafFence). Parsed
   *  from `args.messaging`. */
  messaging: boolean
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries).
// Field order follows the structured-output discipline: short enum/path fields
// FIRST, free-prose fields last, every array and string bounded.
// ---------------------------------------------------------------------------

const INVENTORY_SCHEMA = {
  type: 'object',
  properties: {
    surfaces: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', maxLength: 300 },
    },
  },
  required: ['surfaces'],
  additionalProperties: false,
} as const satisfies JsonSchema

type InventoryOutput = FromSchema<typeof INVENTORY_SCHEMA>

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        properties: {
          surface: { type: 'string', maxLength: 300 },
          kind: { enum: ['behavior', 'instruction', 'boundary', 'cross-reference', 'other'] },
          risk: { enum: ['high', 'medium', 'low'] },
          quote: { type: 'string', maxLength: 400 },
          claim: { type: 'string', maxLength: 400 },
          checkHint: { type: 'string', maxLength: 250 },
        },
        required: ['surface', 'kind', 'risk', 'quote', 'claim', 'checkHint'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ExtractOutput = FromSchema<typeof EXTRACT_SCHEMA>
type AuditClaim = ExtractOutput['claims'][number]

// ---------------------------------------------------------------------------
// Extraction angles — deterministic diversity under the sandbox bans.
// Each round emphasizes a different class of checkable statement; cycling by
// round index is the reproducible substitute for randomness.
// ---------------------------------------------------------------------------

const ANGLES: readonly string[] = [
  'behavioral contracts — what the doc says the code DOES: flows, defaults, failure modes, degradation semantics',
  'instructions and examples — commands, snippets, config keys, file paths the reader is told to use',
  'boundaries and guarantees — caps, invariants, ordering/precedence promises, compatibility and limitation statements',
]

function angleForRound(round: number): string {
  return ANGLES[round % ANGLES.length] ?? ANGLES[0] ?? ''
}

const DEFAULT_SURFACE_RULES =
  'Include every always-read documentation surface a consumer or an authoring model relies on:\n' +
  '- README files at the repository root and one directory level down;\n' +
  '- every markdown file under a docs/ directory (public docs), EXCLUDING ADR archives and dated records;\n' +
  '- every skill SKILL.md and its references/*.md (e.g. under plugin/skills/);\n' +
  '- the repository\'s CLAUDE.md files.\n' +
  'Exclude: CHANGELOGs, LICENSE files, generated artifacts, node_modules, and historical narrative marked as such.'

// ---------------------------------------------------------------------------
// Loop state — JSON-serializable (arrays, not Sets: the state must survive
// resume replay byte-identically).
// ---------------------------------------------------------------------------

interface ExtractState {
  claims: AuditClaim[]
  seenKeys: string[]
  rounds: number
}

const RISK_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 }

function claimKey(c: AuditClaim): string {
  return c.surface + ' ' + c.quote.toLowerCase().replace(/\s+/g, ' ').trim()
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

export interface DocsAuditFinding {
  surface: string
  kind: string
  risk: string
  quote: string
  claim: string
  checkHint: string
  verdict: ClaimVerdict
  votes: ReadonlyArray<VerifierVote | null>
}

export interface DocsAuditOutput {
  repoRoot: string
  /** The audited doc surfaces (as provided, or as the Inventory agent derived). */
  surfaces: readonly string[]
  inventorySource: 'input' | 'agent'
  /** Extraction rounds actually run. */
  rounds: number
  /** true only when extraction went DRY (a full round found nothing new) —
   *  'maxIterations' means the claim space was NOT exhausted. Honest, never
   *  collapsed into a boolean success. */
  extractionComplete: boolean
  stoppedBy: LoopStoppedBy
  /** Unique claims discovered across all rounds (=== summary.total). */
  claimsSeen: number
  summary: {
    total: number
    confirmed: number
    /** refuted — the doc statement no longer matches the sources. */
    stale: number
    partiallyStale: number
    unverifiable: number
    unverifiedByCap: number
  }
  /** Every NON-confirmed claim, risk-sorted, with its verdict and raw votes. */
  findings: DocsAuditFinding[]
  /** Cross-model verifier probe outcome; null when no verifierType requested. */
  verifierProbe: { requested: string; available: boolean; reason: string | null } | null
  /** Leaf-agent fence outcome (withLeafFence). */
  leafFence: LeafFenceReport
  /** Combined Extract+Verify trail (collectTrail, in phase order). */
  envelope: { trail: TrailRecord[] }
  warnings: string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable errors
// ---------------------------------------------------------------------------

function parsePositiveInt(
  obj: Record<string, unknown>,
  field: string,
  fallback: number,
  max?: number,
): number {
  const raw = obj[field]
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`docs-audit: "${field}" must be an integer >= 1, got ${JSON.stringify(raw)}`)
  }
  if (max !== undefined && raw > max) {
    throw new Error(`docs-audit: "${field}" must be <= ${max}, got ${raw}`)
  }
  return raw
}

function parseOptionalString(obj: Record<string, unknown>, field: string): string | null {
  const raw = obj[field]
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`docs-audit: "${field}" must be a non-empty string when provided`)
  }
  return raw
}

function parseInput(raw: unknown): DocsAuditInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'docs-audit: input must be an object with at least a "repoRoot" field — received: ' +
      (raw === null ? 'null' : typeof raw),
    )
  }
  const obj = raw as Record<string, unknown>

  if (obj['repoRoot'] === undefined) {
    throw new Error(
      'docs-audit: missing required field "repoRoot" — provide the ABSOLUTE path to the repository to audit',
    )
  }
  if (typeof obj['repoRoot'] !== 'string' || obj['repoRoot'].trim().length === 0) {
    throw new Error(
      'docs-audit: "repoRoot" must be a non-empty string — the ABSOLUTE path to the repository to audit',
    )
  }
  const repoRoot = obj['repoRoot'].trim()

  let surfaces: readonly string[] | null = null
  if (obj['surfaces'] !== undefined && obj['surfaces'] !== null) {
    if (!Array.isArray(obj['surfaces']) || obj['surfaces'].length === 0) {
      throw new Error(
        'docs-audit: "surfaces" must be a non-empty array of repo-relative paths when provided ' +
        '(omit it to let the Inventory agent derive the list)',
      )
    }
    for (let i = 0; i < obj['surfaces'].length; i++) {
      const s = (obj['surfaces'] as unknown[])[i]
      if (typeof s !== 'string' || s.trim().length === 0) {
        throw new Error(`docs-audit: surfaces[${i}] must be a non-empty string`)
      }
    }
    // Dedup while preserving order — a duplicated surface would double-extract.
    surfaces = [...new Set((obj['surfaces'] as string[]).map((s) => s.trim()))]
  }

  let verifierModel: ModelAlias | undefined
  if (obj['verifierModel'] !== undefined) {
    if (
      typeof obj['verifierModel'] !== 'string' ||
      !(MODEL_ALIASES as readonly string[]).includes(obj['verifierModel'])
    ) {
      throw new Error(
        `docs-audit: "verifierModel" must be one of ${MODEL_ALIASES.join(', ')}`,
      )
    }
    verifierModel = obj['verifierModel'] as ModelAlias
  }

  // Recognized config slices (effort/perAgent/agentTypes/messaging) go through
  // the shared parseConfig helper; it ignores this workflow's bespoke keys.
  const cfg = parseConfig(obj)

  return {
    repoRoot,
    surfaces,
    surfaceRules: parseOptionalString(obj, 'surfaceRules'),
    hints: parseOptionalString(obj, 'hints'),
    maxRounds: parsePositiveInt(obj, 'maxRounds', 3),
    dryRounds: parsePositiveInt(obj, 'dryRounds', 1),
    surfacesPerAgent: parsePositiveInt(obj, 'surfacesPerAgent', 4, 10),
    maxVerifyClaims: parsePositiveInt(obj, 'maxVerifyClaims', 60),
    votes: parsePositiveInt(obj, 'votes', 3),
    verifierModel,
    effort: cfg.effort ?? null,
    perAgent: cfg.perAgent ?? null,
    verifierType: cfg.agentTypes?.['verify'] ?? null,
    messaging: cfg.messaging === true,
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function inventoryPrompt(input: DocsAuditInput): string {
  return (
    `Inventory the documentation surfaces of the repository at ${input.repoRoot}.\n\n` +
    `Rules for what counts as a surface:\n${input.surfaceRules ?? DEFAULT_SURFACE_RULES}\n\n` +
    (input.hints !== null ? `Extra context:\n${input.hints}\n\n` : '') +
    `List the actual directories to find every matching file that EXISTS — never guess a path.\n` +
    `Return { "surfaces": ["<repo-relative path>", ...] } using forward slashes, relative to ${input.repoRoot}.`
  )
}

function extractPrompt(
  input: DocsAuditInput,
  group: readonly string[],
  round: number,
  angle: string,
): string {
  return (
    `Extract checkable claims from documentation — extraction round ${round}.\n` +
    `Repository root: ${input.repoRoot} (all surface paths below are relative to it; read the files from this root).\n\n` +
    `Doc surfaces assigned to YOU in this task:\n` +
    group.map((s) => `  - ${s}`).join('\n') + '\n\n' +
    (input.hints !== null ? `Extra context:\n${input.hints}\n\n` : '') +
    `A claim is a statement a reader would RELY ON that can be CHECKED against the repository's ` +
    `current sources: behavior descriptions ("X does Y"), instructions and examples (commands, ` +
    `config keys, snippets, file paths), boundaries and guarantees (caps, defaults, invariants, ` +
    `compatibility statements). Focus on SEMANTIC prose. Skip: purely mechanical anchors ` +
    `(bare symbol-name existence, literal number equalities) that compile-time gates already pin; ` +
    `opinions and marketing; dated historical narrative (changelogs, ADRs, content marked historical).\n\n` +
    `Angle emphasis for THIS round: ${angle}.\n\n` +
    `For each claim return: surface (the repo-relative doc path it came from — one of the assigned ` +
    `surfaces above), kind, risk (impact if the claim turned out stale: would a reader be misled ` +
    `into broken usage?), quote (EXACT substring copied from the doc), claim (the checkable ` +
    `assertion in your own words), checkHint (where in the sources to verify it).\n` +
    `Return at most 25 claims — the HIGHEST-risk ones you found.`
  )
}

function renderAuditClaim(repoRoot: string, hints: string | null): (c: AuditClaim) => string {
  return (c) =>
    `Documentation-drift audit — verdict for ONE documentation claim.\n` +
    `Repository root: ${repoRoot}.\n` +
    `Doc surface: ${c.surface}\n` +
    `Quote (exact text from the doc): "${c.quote}"\n` +
    `Claim to check: ${c.claim}\n` +
    `Where to look first: ${c.checkHint}\n` +
    (hints !== null ? `Extra context:\n${hints}\n` : '') +
    `Read the ACTUAL current sources under the repository root (grep/read files; use git read-only ` +
    `if helpful) and decide:\n` +
    `- confirmed: the sources today match the claim;\n` +
    `- partially-confirmed: partly accurate but imprecise or drifted in detail;\n` +
    `- refuted: the doc statement is STALE or wrong versus the current sources;\n` +
    `- unverifiable: you could not locate relevant evidence either way (say what you looked for).\n` +
    `Cite the file paths (and line numbers where possible) your verdict rests on in "reason".`
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt00: WorkflowRuntime, input: DocsAuditInput): Promise<DocsAuditOutput> {
  // Default leaf-agent fence: every agent this workflow spawns denies
  // SendMessage by default (see @workflow-toolbox/patterns' withLeafFence).
  // No withLeanRouting here — every role reads the repository (PEDAGOGY 4).
  const { rt: rt0, report: leafFence } = await withLeafFence(rt00, {
    phase: 'Fence',
    disabled: input.messaging,
    ...(input.perAgent !== null ? { perAgent: input.perAgent } : {}),
  })

  // Class-A one-wiring-point: blanket per-agent defaults reach every stage;
  // per-call/pattern opts (the verifiers' explicit model) still win.
  const rt = input.perAgent !== null ? withAgentDefaults(rt0, input.perAgent) : rt0

  const warnings: string[] = []

  const inventoryEffort = resolveEffort(input.effort?.['inventory'], INVENTORY_EFFORT)
  const extractEffort = resolveEffort(input.effort?.['extract'], EXTRACT_EFFORT)
  const verifyEffort = resolveVerifierEffort(input.effort?.['verify'], VERIFY_EFFORT_DEFAULT)

  // Optional cross-model verifier — probed, never trusted blind: an
  // unavailable agentType degrades to the standard verifier with a report.
  let verifierProbe: DocsAuditOutput['verifierProbe'] = null
  let resolvedVerifierType: string | null = null
  if (input.verifierType !== null) {
    const probe = await probeAgentType(rt, input.verifierType, { phase: 'Fence' })
    resolvedVerifierType = probe.agentType ?? null
    verifierProbe = { requested: input.verifierType, available: probe.available, reason: probe.reason }
  }

  // -------------------------------------------------------------------------
  // Phase 'Inventory' — surface list: provided, or derived by one cheap agent.
  //
  // The surface list is the audit's coverage contract. When the caller knows
  // it (e.g. a repo pins its always-read surfaces in a CI gate), passing it
  // skips the agent entirely. Otherwise one low-effort agent derives it from
  // the rules — dynamically, so a doc added yesterday is audited today without
  // any manifest edit.
  // -------------------------------------------------------------------------

  rt.phase('Inventory')

  let surfaces: readonly string[]
  let inventorySource: DocsAuditOutput['inventorySource']

  if (input.surfaces !== null) {
    surfaces = input.surfaces
    inventorySource = 'input'
  } else {
    const inv = await rt.agent<InventoryOutput>(inventoryPrompt(input), {
      schema: INVENTORY_SCHEMA,
      label: 'docs-audit:inventory',
      phase: 'Inventory',
      effort: inventoryEffort,
    })
    if (inv === null) {
      throw new Error(
        'docs-audit: the inventory agent failed — relaunch with resumeFromRunId, or pass an ' +
        'explicit "surfaces" array to skip inventory entirely',
      )
    }
    const cleaned = [...new Set(inv.surfaces.map((s) => s.trim()).filter((s) => s.length > 0))]
    if (cleaned.length === 0) {
      throw new Error(
        'docs-audit: inventory returned no surfaces — the surface rules matched nothing under ' +
        `${input.repoRoot}. Review "surfaceRules" or pass an explicit "surfaces" array.`,
      )
    }
    surfaces = cleaned
    inventorySource = 'agent'
  }

  // -------------------------------------------------------------------------
  // Phase 'Extract' — loop-until-dry claim discovery (PEDAGOGY 1).
  //
  // Each iteration is one angle-cycled sweep over ALL surfaces, batched
  // surfacesPerAgent per extractor. Fresh claims are deduped against the
  // accumulated seen-set (surface + normalized quote); a sweep with zero
  // fresh claims is a dry round. dryRounds ends extraction as COMPLETE;
  // maxRounds ends it as a CEILING — the two are reported distinctly.
  // -------------------------------------------------------------------------

  rt.phase('Extract')

  const surfaceSet = new Set(surfaces)
  const groups = chunk(surfaces, input.surfacesPerAgent)

  const loopResult = await loopUntilDone<ExtractState>(rt, {
    maxIterations: input.maxRounds,
    dryRounds: input.dryRounds,
    initial: { claims: [], seenKeys: [], rounds: 0 },
    body: async (loopRt, state) => {
      const round = state.rounds + 1
      const angle = angleForRound(state.rounds)

      const results = await loopRt.parallel(
        groups.map((group, gi) => () =>
          loopRt.agent<ExtractOutput>(extractPrompt(input, group, round, angle), {
            schema: EXTRACT_SCHEMA,
            label: `docs-audit:extract:${round}:${gi}`,
            phase: 'Extract',
            effort: extractEffort,
          }),
        ),
      )

      const seen = new Set(state.seenKeys)
      const freshClaims: AuditClaim[] = []
      const freshKeys: string[] = []

      for (let gi = 0; gi < results.length; gi++) {
        const res = results[gi]
        if (res === null || res === undefined) {
          warn(
            rt, warnings,
            `docs-audit [Extract]: extractor ${round}:${gi} failed — its surfaces contribute ` +
            `nothing this round (${(groups[gi] ?? []).join(', ')})`,
          )
          continue
        }
        for (const claim of res.claims) {
          if (!surfaceSet.has(claim.surface)) {
            // Mechanical guard: an extractor may only report on its assigned
            // corpus — a claim pinned to an unknown surface is unusable
            // (verification could not attribute the finding to a doc).
            warn(
              rt, warnings,
              `docs-audit [Extract]: dropped a claim citing "${claim.surface}" — not in the ` +
              `audited surface set`,
            )
            continue
          }
          const key = claimKey(claim)
          if (seen.has(key)) continue
          seen.add(key)
          freshClaims.push(claim)
          freshKeys.push(key)
        }
      }

      if (freshClaims.length === 0) {
        return {
          state: { ...state, rounds: round },
          done: false,
          progressed: false,
        }
      }

      rt.log(`docs-audit: round ${round} (+${freshClaims.length} claims, ${state.claims.length + freshClaims.length} total)`)
      return {
        state: {
          claims: [...state.claims, ...freshClaims],
          seenKeys: [...state.seenKeys, ...freshKeys],
          rounds: round,
        },
        done: false,
        progressed: true,
      }
    },
  })

  for (const w of loopResult.warnings) warnings.push(w)

  const { state: finalState, stoppedBy } = loopResult.value

  // -------------------------------------------------------------------------
  // Phase 'Verify' — refute-first, evidence-tiered (PEDAGOGY 2 + 3).
  //
  // Claims are risk-sorted high→low BEFORE the pattern call so that
  // maxVerifyClaims (applyCap keeps the FIRST N) cuts the cheapest-to-lose
  // claims — and the cut ones survive as 'unverified-by-cap' findings.
  // -------------------------------------------------------------------------

  const sortedClaims = finalState.claims
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      (RISK_ORDER[a.c.risk] ?? ANGLES.length) - (RISK_ORDER[b.c.risk] ?? ANGLES.length) || a.i - b.i,
    )
    .map((x) => x.c)

  const verifyResult = await adversarialVerification<AuditClaim>(rt, {
    claims: sortedClaims,
    renderClaim: renderAuditClaim(input.repoRoot, input.hints),
    votes: input.votes,
    refuteThreshold: Math.min(2, input.votes),
    maxVerifyClaims: input.maxVerifyClaims,
    effort: verifyEffort,
    phase: 'Verify',
    ...(input.verifierModel !== undefined ? { model: input.verifierModel } : {}),
    ...(resolvedVerifierType !== null ? { verifierType: resolvedVerifierType } : {}),
  })

  for (const w of verifyResult.warnings) warnings.push(w)

  // -------------------------------------------------------------------------
  // Phase 'Report' — deterministic aggregation, honest at every edge:
  // stoppedBy verbatim, cap-cuts as findings, extractionComplete only on dry.
  // -------------------------------------------------------------------------

  rt.phase('Report')

  const verdictCount = (v: ClaimVerdict): number =>
    verifyResult.value.filter((r) => r.verdict === v).length

  const findings: DocsAuditFinding[] = verifyResult.value
    .filter((r) => r.verdict !== 'confirmed')
    .map((r) => ({ ...r.claim, verdict: r.verdict, votes: r.votes }))

  const summary: DocsAuditOutput['summary'] = {
    total: verifyResult.value.length,
    confirmed: verdictCount('confirmed'),
    stale: verdictCount('refuted'),
    partiallyStale: verdictCount('partially-confirmed'),
    unverifiable: verdictCount('unverifiable'),
    unverifiedByCap: verdictCount('unverified-by-cap'),
  }

  rt.log(
    `docs-audit: ${summary.total} claims — ${summary.confirmed} confirmed, ${summary.stale} stale, ` +
    `${summary.partiallyStale} partial, ${summary.unverifiable} unverifiable, ` +
    `${summary.unverifiedByCap} unverified-by-cap`,
  )

  return {
    repoRoot: input.repoRoot,
    surfaces,
    inventorySource,
    rounds: finalState.rounds,
    // HONEST: complete only when a full sweep found nothing new — a
    // maxIterations stop means the claim space was NOT exhausted.
    extractionComplete: stoppedBy === 'dryRounds',
    stoppedBy,
    claimsSeen: finalState.claims.length,
    summary,
    findings,
    verifierProbe,
    leafFence,
    envelope: { trail: collectTrail(loopResult, verifyResult) },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'docs-audit',
    description:
      'Pre-release semantic docs audit: inventories doc surfaces, extracts checkable claims in ' +
      'loop-until-dry rounds, then refute-first verifies each claim against the actual sources ' +
      'with evidence-tiered verdicts (confirmed / stale / partially-stale / unverifiable).',
    whenToUse:
      'Use BEFORE a release (npm publish, plugin version bump) to catch documentation whose prose ' +
      'has drifted from the implementation — the semantic layer compile-time doc gates cannot ' +
      'check. Pass repoRoot (absolute); optionally surfaces, hints (e.g. a provenance map ' +
      'location), and sizing knobs. Findings are remediation input, e.g. for doc-rewrite.',
    phases: [
      { title: 'Fence', detail: 'Leaf-fence + optional cross-model verifier probe' },
      { title: 'Inventory', detail: 'Derive or validate the audited doc-surface list' },
      { title: 'Extract', detail: 'Loop-until-dry claim extraction: angle-cycled sweeps, deduped against seen' },
      { title: 'Verify', detail: 'Refute-first adversarial verification of each claim against the sources' },
      { title: 'Report', detail: 'Deterministic verdict aggregation — stale findings, honest caps and stops' },
    ],
  },
  parseInput,
  run,
})
