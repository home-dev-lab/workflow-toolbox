// adversarial-verification.ts — refute-first claim verification.
//
// Flow: for each claim, rt.parallel over `votes` verifier agents.
//       Tally in code (deterministic, never trust model to count votes).
//
// §8 Risk guardrail: default model is BEST_MODEL. Anything weaker degrades quality; warn.
// §8 Cap policy: truncated claims are KEPT as 'unverified-by-cap' — a cap never
//   destroys evidence. itemsIn === itemsOut always.
//
// Why refute-first: the verifier prompt IS the pattern's core value.
//   Adversarial agents default to refuting — passive confirmation bias is
//   eliminated by instruction. [P9 — BEA announcement blog, deep-research 3P].
//
// Conventions (same as all patterns):
// - Config errors throw synchronously at entry with actionable messages.
// - Agent failures never throw out — they degrade to null, surfaced as warnings.
// - opts.phase per-call, never rt.phase() (avoids global-state races).
// - Labels: adversarialVerification:verify:<claimIndex>:<voteIndex>; a Phase B2
//   retry of a provenance-disqualified vote adds a terminal `:retry` to that label.

import { BEST_MODEL } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias, PatternCounts } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord, emitDigest } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { runCacheWarmup } from './cache-warm.js'
import { agentWithSchemaSalvage } from './structured-salvage.js'
import type { StructuredCallOutcome } from './structured-salvage.js'
import { claimStageInstance, stageBuilder } from './stage-instance.js'
import {
  externalGateExpectation,
  deriveProvenanceNonce,
  runProvenanceChecker,
  PROVENANCE_CHECK_SUFFIX,
} from './provenance-gate.js'

const STAGE = 'adversarialVerification'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = 'confirmed' | 'partially-confirmed' | 'refuted' | 'unverifiable'

/** Pattern-level verdict on a claim. Widens the agent-facing `Verdict` with
 *  'unverified-by-cap': claims cut by `maxVerifyClaims` were never tested,
 *  which is honestly distinct from 'unverifiable' (tested, all verifiers
 *  failed to decide). Agents NEVER emit 'unverified-by-cap' — only the
 *  pattern's cap-truncation append does. */
export type ClaimVerdict = Verdict | 'unverified-by-cap'

export interface VerifierVote {
  verdict: Verdict
  reason: string
}

export interface VerifiedClaim<TClaim> {
  claim: TClaim
  verdict: ClaimVerdict
  /** Raw votes in verifier order; null = verifier failed/skipped.
   *  Empty array for cap-truncated claims ('unverified-by-cap'). */
  votes: ReadonlyArray<VerifierVote | null>
}

export interface AdversarialVerificationOptions<TClaim> {
  claims: readonly TClaim[]
  renderClaim: (claim: TClaim) => string
  votes?: number           // default 3, must be >= 1
  refuteThreshold?: number // default 2, must be >= 1; must be <= votes unless votesPerClaim is set (then it is clamped per claim instead)
  /** Optional perspective diversity: one lens per vote (length MUST === votes).
   *  A claim can fail in more than one way — distinct lenses catch failure
   *  modes plain redundancy can't, e.g. for a code-review finding:
   *  `['correctness', 'security', 'does-it-reproduce']`. Omit for N identical
   *  refute-first verifiers. Cannot be combined with `votesPerClaim`. */
  lenses?: readonly string[]
  /** Optional per-claim vote count — spend fewer verifiers on low-stakes
   *  claims (e.g. severity-aware: `(f) => f.severity === 'low' ? 1 : 3`).
   *  The pattern never parses claim contents; the caller closes over its own
   *  fields. Must return an integer >= 1; evaluated exactly once per input
   *  claim, validated for ALL claims synchronously at entry (nothing spawns
   *  on a bad mapping). Overrides `votes` per claim; the refute threshold is
   *  clamped per claim to `min(refuteThreshold, claimVotes)`, so a 1-vote
   *  claim is decided by its single vote. Because the scalar `votes` is fully
   *  overridden, `refuteThreshold` is NOT validated against it when this
   *  option is set — a mapping may exceed `votes` (e.g. `() => 5` with the
   *  default of 3). Cannot be combined with `lenses` (lenses require one
   *  fixed vote count). */
  votesPerClaim?: (claim: TClaim) => number
  model?: ModelAlias       // default BEST_MODEL ('opus')
  /** Per-verifier reasoning effort. Omit to inherit the session effort. */
  effort?: EffortAlias
  phase?: string
  maxVerifyClaims?: number // cap; truncated claims kept as 'unverified-by-cap'
  /** Optional specialist subagent type to route EVERY verifier agent to (via the
   *  Agent tool's `agentType`); omit (undefined) for the standard subagent. The
   *  routing is surfaced on the agent call only — the trail is intentionally NOT
   *  extended (kept minimal; the `model` field already covers model-sensitivity
   *  auditing, the pattern's load-bearing audit concern).
   *
   *  v2.2 flexibility knob — NOT a proven quality win. The A/B that motivated the
   *  family's agentType knobs measured a ~50% false-positive rate on a specialist
   *  REVIEWER, and a refute-first verifier benefits LESS from domain specialization
   *  than a producer does ("specialize the producer, not the skeptic"). Provided
   *  for callers who want it; NEVER hard-code a private (e.g. `magic-claude:*`) type
   *  as a default in a published artifact — the runtime THROWS on an unknown
   *  agentType (with the available-agents list), and a private type breaks every
   *  other consumer. Validate shape only; the runtime owns registry membership.
   *
   *  PREMIER USE — cross-model decorrelation (NOT the specialist-reviewer caveat
   *  above): routing to a NON-Claude wrapper here is the one real lever against
   *  same-model correlated errors. A same-model verifier shares the producer's
   *  priors; a different-model verifier does not. On a machine with the `codex`
   *  plugin, `verifierType: 'codex:codex-rescue'` routes every verifier through the
   *  Codex app-server so a GPT model answers — and it honors this pattern's
   *  structured VERIFIER_SCHEMA (proven from inside a workflow: the wrapper
   *  forwards to codex then emits the {verdict,reason} object). Caveat: it depends
   *  on a local codex setup + login and is NOT portable — for a SHIPPED workflow,
   *  prefer an MCP→model endpoint as the cross-model verifier. See the
   *  cross-model-verify example. */
  verifierType?: string
  /** Before the concurrent verifier burst (every claim's votes launch
   *  together via nested rt.parallel calls, all under ONE uniform model — the
   *  resolved `model` above), fire a single throwaway warmup agent on that
   *  same model, await it, THEN launch the full burst — mechanism (b),
   *  "warmup-agent", chosen here (over peeling out one real vote) so every
   *  real verifier stays fully concurrent: votes default to only 3, and
   *  verification quality/latency is this pattern's core value, so losing one
   *  real vote to serial execution would cost proportionally more than
   *  elsewhere. A failed/null warmup only warns; the real burst always
   *  proceeds. Heuristic cost lever, not a correctness change. **Default
   *  true**; set `cacheWarm: false` to opt OUT when wall-clock latency
   *  matters more than token/cache cost. See @workflow-toolbox/patterns'
   *  cache-warm.ts. */
  cacheWarm?: boolean
  /** Per-invocation stage/label discriminator (card #1816036725248493168):
   *  when this pattern is invoked more than once on the SAME rt object — the
   *  flagship case is a caller running one adversarialVerification per lens
   *  on a reused rt, e.g. pr-review's per-lens Verify stage — each
   *  invocation's stage/label strings collide by default. This pins a
   *  stable, author-meaningful suffix (` #<stageKey>`) instead of the
   *  auto-assigned per-invocation counter, applied to every verifier label
   *  AND the cache-warm label. Must match the charset/shape rule
   *  claimStageInstance canonically enforces (letters, digits, underscore,
   *  dot, hyphen, 1-32 chars, not purely numeric — see stage-instance.ts's
   *  STAGE_KEY_PATTERN, the ONE source of truth for this rule); an
   *  invalid key is reported as a warning and the invocation falls back to
   *  the auto counter (never throws). The auto counter is deterministic for
   *  SEQUENTIALLY invoked patterns only — concurrent same-pattern
   *  invocations (e.g. inside a caller's own rt.pipeline/rt.parallel, one
   *  lens per pipeline item with no barrier between items) get
   *  completion-order numbers, so pass stageKey there for a stable,
   *  resume-safe discriminator. */
  stageKey?: string
}

// ---------------------------------------------------------------------------
// Vote control schema — owned by the pattern.
// The enum constrains verifier agents to return only valid verdict values.
// ---------------------------------------------------------------------------

const VERIFIER_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['confirmed', 'partially-confirmed', 'refuted', 'unverifiable'],
    },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Refute-first claim verification: each claim gets `votes` parallel verifier
 *  agents instructed to actively disprove it; the verdict is tallied in code
 *  (deterministic — never trust the model to count votes). Claims are NEVER
 *  dropped: itemsIn === itemsOut always; cap-truncated claims come back as
 *  'unverified-by-cap' with empty votes.
 *
 *  @example
 *  ```ts
 *  import { FakeRuntime } from '@workflow-toolbox/runtime'
 *  import { adversarialVerification } from '@workflow-toolbox/patterns'
 *
 *  // 1 claim × 3 votes = 3 verifier agents (responses consumed in call order)
 *  const rt = new FakeRuntime({
 *    responses: [
 *      { verdict: 'confirmed', reason: 'ok' },
 *      { verdict: 'confirmed', reason: 'ok' },
 *      { verdict: 'refuted', reason: 'counterexample' },
 *    ],
 *  })
 *
 *  const result = await adversarialVerification(rt, {
 *    claims: ['the cache is invalidated on write'],
 *    renderClaim: (claim) => claim,
 *    votes: 3,
 *    refuteThreshold: 2,
 *  })
 *
 *  // 1 refutation < threshold 2, not unanimous → 'partially-confirmed'
 *  for (const { claim, verdict, votes } of result.value) {
 *    rt.log(`${verdict}: ${claim} (${votes.filter((v) => v !== null).length} votes in)`)
 *  }
 *  rt.log(`verifiers spawned: ${result.stats.agentsSpawned}`) // claims × votes = 3
 *  for (const warning of result.warnings) rt.log(warning)
 *  ```
 */
export async function adversarialVerification<TClaim>(
  rt: WorkflowRuntime,
  options: AdversarialVerificationOptions<TClaim>,
): Promise<PatternResult<Array<VerifiedClaim<TClaim>>>> {
  const {
    claims,
    renderClaim,
    votes: votesOpt = 3,
    refuteThreshold: refuteThresholdOpt,
    lenses,
    votesPerClaim,
    model,
    effort,
    phase,
    maxVerifyClaims,
    verifierType,
    cacheWarm,
    stageKey,
  } = options

  const refuteThreshold = refuteThresholdOpt ?? 2

  // -------------------------------------------------------------------------
  // Synchronous validation — throw with actionable messages
  // -------------------------------------------------------------------------

  if (claims.length === 0) {
    throw new Error(
      'adversarialVerification: empty claims — provide at least one claim to verify',
    )
  }

  if (votesOpt < 1) {
    throw new Error(
      `adversarialVerification: votes must be >= 1, got ${votesOpt}`,
    )
  }

  if (refuteThreshold < 1) {
    throw new Error(
      `adversarialVerification: refuteThreshold must be >= 1, got ${refuteThreshold}`,
    )
  }

  // With votesPerClaim the scalar `votes` is fully overridden per claim and
  // the threshold is clamped per claim (min(refuteThreshold, claimVotes)), so
  // comparing against the scalar would spuriously reject valid configs (e.g.
  // votesPerClaim: () => 5 with refuteThreshold: 4 and the default votes of 3).
  if (votesPerClaim === undefined && refuteThreshold > votesOpt) {
    throw new Error(
      `adversarialVerification: refuteThreshold (${refuteThreshold}) must not be > votes (${votesOpt})`,
    )
  }

  if (lenses !== undefined && lenses.length !== votesOpt) {
    throw new Error(
      `adversarialVerification: lenses.length (${lenses.length}) must equal votes (${votesOpt}) — each lens corresponds to one vote`,
    )
  }

  if (lenses !== undefined && votesPerClaim !== undefined) {
    throw new Error(
      'adversarialVerification: lenses cannot be combined with votesPerClaim — lenses require a fixed votes count (one lens per vote); use one or the other',
    )
  }

  // Per-claim vote counts, evaluated EXACTLY ONCE per input claim (pre-cap)
  // and validated for ALL claims before any agent spawns — a bad mapping
  // anywhere fails fast regardless of maxVerifyClaims.
  const perClaimVotes: number[] = claims.map((claim, i) => {
    if (votesPerClaim === undefined) return votesOpt
    const n = votesPerClaim(claim)
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `adversarialVerification: votesPerClaim(claims[${i}]) returned ${String(n)} — must be an integer >= 1`,
      )
    }
    return n
  })

  if (verifierType !== undefined && verifierType.trim().length === 0) {
    throw new Error(
      'adversarialVerification: verifierType must be a non-empty subagent-type string (e.g. "magic-claude:ts-reviewer") — omit it for the standard subagent',
    )
  }

  // applyCap throws synchronously when maxVerifyClaims < 1
  if (maxVerifyClaims !== undefined && maxVerifyClaims < 1) {
    throw new Error(
      `adversarialVerification: maxVerifyClaims must be >= 1, got ${maxVerifyClaims}`,
    )
  }

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  const warnings: string[] = []
  const trail: TrailRecord[] = []

  // Claim this invocation's stage/label salt NOW — after every synchronous
  // validation throw above and before the first await (card
  // #1816036725248493168, amendment A8).
  const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, stageKey)
  if (stageKeyWarning !== undefined) warn(rt, warnings, stageKeyWarning)
  const stg = stageBuilder(STAGE, salt)

  // -------------------------------------------------------------------------
  // §8 Model-sensitivity guardrail: default BEST_MODEL; explicitly choosing
  // anything else → warning. Verification quality is model-sensitive: weaker
  // models are less reliably adversarial and more likely to confirm by default.
  // -------------------------------------------------------------------------

  const effectiveModel: ModelAlias = model ?? BEST_MODEL
  if (model !== undefined && model !== BEST_MODEL) {
    warn(
      rt, warnings,
      `adversarialVerification: verifier model downgraded to "${model}" — verification quality is model-sensitive`,
    )
  }

  // -------------------------------------------------------------------------
  // Apply cap. Truncated claims are appended to output as 'unverified-by-cap'
  // (keep-unverified-rather-than-drop, §8 — a cap never destroys evidence).
  // -------------------------------------------------------------------------

  const { kept: keptClaims, truncated } = applyCap(claims, maxVerifyClaims)

  if (truncated > 0) {
    warn(
      rt, warnings,
      `adversarialVerification: ${truncated} of ${claims.length} claims truncated by maxVerifyClaims=${maxVerifyClaims ?? '?'} — kept as unverified-by-cap`,
    )
  }

  // -------------------------------------------------------------------------
  // Verifier prompt — OWNED by the pattern.
  // The refute-first framing IS the pattern's value: we instruct the model
  // to actively try to disprove, defaulting to 'refuted' under uncertainty.
  // This eliminates confirmation bias from the verification process.
  // -------------------------------------------------------------------------

  function buildVerifierPrompt(claim: TClaim, lens: string | undefined): string {
    const lensLine = lens !== undefined ? `\nExamine it through the lens of: ${lens}.` : ''
    return (
      `Adversarially verify the following claim. Actively try to REFUTE it; ` +
      `default to "refuted" when uncertain.` +
      lensLine +
      `\nClaim:\n${renderClaim(claim)}`
    )
  }

  // -------------------------------------------------------------------------
  // Verify kept claims: map each claim to a parallel group of vote thunks.
  // All claim groups are processed concurrently (Promise.all over the map).
  // -------------------------------------------------------------------------

  // Cache-warm (mechanism b): one throwaway agent on the SAME model (+
  // verifierType) as the whole burst below, awaited BEFORE the burst launches.
  // Recorded first in `trail` (deterministic: always precedes the barrier).
  // Label is `${STAGE}:warm` — deliberately NOT nested under `:verify:` so a
  // caller filtering real verifier calls by the natural
  // `startsWith('adversarialVerification:verify:')` prefix never sweeps the
  // warmup call in (real labels are `adversarialVerification:verify:<claim>:
  // <vote>`, one level deeper).
  if (cacheWarm ?? true) {
    agentsSpawned++
    // A7: the warmup LABEL is salted (via the shared builder), but the 4th
    // `patternName` arg stays the BARE STAGE — it is a prose prefix in
    // runCacheWarmup's own warn() message, not a stage id.
    trail.push(await runCacheWarmup(rt, warnings, stg('warm'), STAGE, {
      ...(phase !== undefined ? { phase } : {}),
      model: effectiveModel,
      ...(effort !== undefined ? { effort } : {}),
      ...(verifierType !== undefined ? { agentType: verifierType } : {}),
    }))
  }

  // Per-claim trail records, written by claim INDEX (order-independent writes),
  // flattened after the global barrier — claim completion order is
  // non-deterministic under the real async runtime; indexed writes are not.
  const trailByClaim: TrailRecord[][] = []

  // Per-claim RETRY trail records (Phase B2), buffered the same way. Kept separate from
  // trailByClaim so the final trail stays temporally faithful: [warm?, votes, firstChecker?,
  // retries, secondChecker?] — the retries run AFTER the first checker.
  const retryTrailByClaim: TrailRecord[][] = []

  // Per-claim salvage diagnostics, buffered the same way for the same reason.
  const warningsByClaim: string[][] = []

  // Intermediate per-claim vote results collected in Phase A. The trail and the
  // tally are DEFERRED to Phase C because the provenance gate (Phase B) may
  // nullify votes between running them and counting them.
  interface ClaimVotesRaw {
    claim: TClaim
    claimVotes: number
    voteOuts: Array<StructuredCallOutcome<VerifierVote> | null>
    votes: Array<VerifierVote | null>      // mutable — the gate nullifies in place
    voteStages: string[]
    // The transcript the CREDITED value actually came from: the base vote label, OR
    // `${voteStage}:salvage` when the value was salvaged (agentWithSchemaSalvage respawns
    // under a `:salvage` label — the CLI invocation, if any, is in THAT transcript). The
    // provenance checker MUST scan this effective label, not the base one, or a self-answer
    // in the salvage respawn is credited on the original's CLI call (and vice-versa).
    effectiveStages: string[]
    provenanceDisqualified: boolean[]       // written by Phase B, read by Phase C's trail
    // Phase B2 (retry) — parallel per-vote arrays, populated ONLY for gate-disqualified
    // votes (never mutating `votes`/`voteOuts`, so the original disqualification stays
    // recorded verbatim in Phase C). `retryStages[vi] !== undefined` marks a retried vote.
    retryStages: Array<string | undefined>  // the `:retry` label of the re-spawn
    retryEffectiveStages: Array<string | undefined> // the retry's effective (salvage-aware) label
    retryOuts: Array<StructuredCallOutcome<VerifierVote> | null> // the re-spawn's outcome
    retryVotes: Array<VerifierVote | null>  // recovered vote (real vote + provenance seen), else null
    retryDisqualified: boolean[]            // the retry self-answered AGAIN (real vote, no provenance)
  }

  // ---- Phase A: run every kept claim's votes concurrently; collect raw outcomes.
  const perClaim: ClaimVotesRaw[] = await Promise.all(
    (keptClaims as readonly TClaim[]).map(async (claim, claimIndex): Promise<ClaimVotesRaw> => {
      // keptClaims is a prefix of claims, so indices align with perClaimVotes.
      const claimVotes = perClaimVotes[claimIndex] ?? votesOpt
      // Built ONCE per (claimIndex, voteIndex) call site, reused for BOTH the
      // rt.agent label (in the thunk below) and makeRecord's stage (in the
      // post-barrier tally loop) — card #1816036725248493168, amendment A8.
      const voteStages: string[] = Array.from(
        { length: claimVotes },
        (_: unknown, voteIndex: number) => stg(`verify:${claimIndex}:${voteIndex}`),
      )
      const voteThunks = Array.from({ length: claimVotes }, (_: unknown, voteIndex: number) => {
        return async (): Promise<StructuredCallOutcome<VerifierVote>> => {
          const lens = lenses !== undefined ? lenses[voteIndex] : undefined
          const prompt = buildVerifierPrompt(claim, lens)

          const opts: {
            schema: JsonSchema
            label: string
            phase?: string
            model?: ModelAlias
            effort?: EffortAlias
            agentType?: string
          } = {
            schema: VERIFIER_SCHEMA,
            label: voteStages[voteIndex]!,
            ...(phase !== undefined ? { phase } : {}),
            model: effectiveModel,
            ...(effort !== undefined ? { effort } : {}),
            ...(verifierType !== undefined ? { agentType: verifierType } : {}),
          }

          return agentWithSchemaSalvage<VerifierVote>(rt, prompt, opts)
        }
      })

      const rawVotes = await rt.parallel(voteThunks)
      // A thunk that threw (budget) resolves to null — one spawn, no salvage.
      const voteOuts: Array<StructuredCallOutcome<VerifierVote> | null> = rawVotes.map(
        (v): StructuredCallOutcome<VerifierVote> | null => v as StructuredCallOutcome<VerifierVote> | null,
      )
      const votes: Array<VerifierVote | null> = voteOuts.map((o) => o?.value ?? null)

      return {
        claim,
        claimVotes,
        voteOuts,
        votes,
        voteStages,
        // A salvaged vote's credited value came from the `:salvage` respawn transcript —
        // point the provenance checker THERE (card #1824029483854726303 fix round).
        effectiveStages: voteStages.map((s, vi) =>
          voteOuts[vi]?.salvaged === true ? `${s}:salvage` : s,
        ),
        provenanceDisqualified: new Array<boolean>(votes.length).fill(false),
        retryStages: new Array<string | undefined>(votes.length).fill(undefined),
        retryEffectiveStages: new Array<string | undefined>(votes.length).fill(undefined),
        retryOuts: new Array<StructuredCallOutcome<VerifierVote> | null>(votes.length).fill(null),
        retryVotes: new Array<VerifierVote | null>(votes.length).fill(null),
        retryDisqualified: new Array<boolean>(votes.length).fill(false),
      }
    }),
  )

  // ---- Phase B: provenance gate. Arms ONLY when the verifier was routed to a
  // REGISTERED external agentType (opencode / codex) — `verifierType` routes
  // EVERY verifier, so under an external type every vote is external and one
  // global checker covers all vote labels; a plain Claude verifier is NEVER
  // gated. A wrapper can silently SELF-ANSWER (emit a valid verdict without ever
  // shelling out to the external CLI); the checker reads each vote's transcript
  // and any vote with no proof of a real CLI invocation is DISQUALIFIED
  // (nullified → the existing unverifiable/null path). Fail-CLOSED on undetermined
  // provenance: an external verdict is never credited without provenance.
  const gateExpectation = externalGateExpectation(verifierType)
  let checkerRecord: TrailRecord | null = null
  if (gateExpectation !== null) {
    // Scan the EFFECTIVE label of each vote (the salvage transcript when the value was
    // salvaged), so provenance is attributed to the transcript that actually produced the
    // credited value — not the original's (card #1824029483854726303 fix round).
    const allLabels = perClaim.flatMap((pc) => pc.effectiveStages)
    if (allLabels.length > 0) {
      agentsSpawned++
      // Deliberately NOT under `:verify:` (like `:warm`) so a caller filtering
      // real verifier calls by the `:verify:` prefix never sweeps the checker in.
      const checkLabel = stg(PROVENANCE_CHECK_SUFFIX)
      const { map: provMap, replyOk } = await runProvenanceChecker(rt, gateExpectation, allLabels, {
        label: checkLabel,
        ...(phase !== undefined ? { phase } : {}),
        model: 'haiku',
        effort: 'low',
        // Fold rendered claim content into the nonce so two runs with the same vote SHAPE
        // but different claims get different anchors (cross-family review 2026-07-21).
        nonce: deriveProvenanceNonce(allLabels, perClaim.map((pc) => renderClaim(pc.claim)).join(' ')),
      })
      // One checker spawn → one trail record (outcome = a usable reply came back).
      checkerRecord = makeRecord(checkLabel, replyOk, { model: 'haiku', effort: 'low' })

      let disqualifiedCount = 0
      let undeterminedCount = 0
      for (const pc of perClaim) {
        for (let voteIndex = 0; voteIndex < pc.votes.length; voteIndex++) {
          if (pc.votes[voteIndex] === null) continue // already failed — nothing to gate
          const provenance = provMap.get(pc.effectiveStages[voteIndex]!) ?? 'undetermined'
          if (provenance === 'seen') continue // real CLI invocation — credited
          pc.votes[voteIndex] = null           // disqualify → flows to the null/unverifiable path
          pc.provenanceDisqualified[voteIndex] = true
          if (provenance === 'absent') disqualifiedCount++
          else undeterminedCount++
        }
      }
      if (disqualifiedCount > 0) {
        warn(rt, warnings,
          `adversarialVerification: ${disqualifiedCount} external verifier votes DISQUALIFIED — ` +
          `no ${gateExpectation.id} CLI invocation found in the vote transcript (possible self-answer); treated as null`)
      }
      if (undeterminedCount > 0) {
        warn(rt, warnings,
          `adversarialVerification: ${undeterminedCount} external verifier votes had UNDETERMINED provenance ` +
          `(the checker ${replyOk ? 'did not resolve them' : 'failed'}); fail-closed, treated as null`)
      }
    }
  }

  // ---- Phase B2: retry gate-disqualified votes ONCE (card #1824029483854726303).
  // A vote nullified by the provenance gate (absent OR undetermined provenance — a
  // possible self-answer, NOT a plain agent failure) gets exactly ONE fresh re-spawn
  // under the SAME claim/lens/verifier config; a SECOND provenance checker then re-reads
  // ONLY the retried labels. A retry that returns a real vote WITH provenance is RECOVERED
  // (folded into the tally + the public votes below); a retry that self-answers again (or
  // fails) leaves the vote null. Bounded by construction: one retry per disqualified vote,
  // never a retry-of-a-retry (retries ≤ disqualified ≤ total votes) — a per-vote bound, not
  // an order-dependent global budget that could starve the all-null claims this feature
  // exists to recover. Arms only under an external agentType (the sole source of
  // disqualifications), so a plain-Claude run is byte-identical to pre-retry behaviour.
  let retryCheckerRecord: TrailRecord | null = null
  if (gateExpectation !== null) {
    interface RetryTarget { pc: ClaimVotesRaw; voteIndex: number }
    const retryTargets: RetryTarget[] = []
    for (const pc of perClaim) {
      for (let voteIndex = 0; voteIndex < pc.votes.length; voteIndex++) {
        if (pc.provenanceDisqualified[voteIndex]) retryTargets.push({ pc, voteIndex })
      }
    }

    if (retryTargets.length > 0) {
      // One fresh verifier per disqualified vote, all concurrent. Same prompt/lens/schema/
      // model/effort/agentType as the original vote — only the label differs (terminal
      // `:retry`, so the checker scanner's trailing-quote label marker never confuses
      // `…:<vi>` with `…:<vi>:retry`).
      const retryThunks = retryTargets.map(({ pc, voteIndex }) => {
        const stage = `${pc.voteStages[voteIndex]!}:retry`
        pc.retryStages[voteIndex] = stage
        return async (): Promise<StructuredCallOutcome<VerifierVote> | null> => {
          const lens = lenses !== undefined ? lenses[voteIndex] : undefined
          const prompt = buildVerifierPrompt(pc.claim, lens)
          const opts: {
            schema: JsonSchema
            label: string
            phase?: string
            model?: ModelAlias
            effort?: EffortAlias
            agentType?: string
          } = {
            schema: VERIFIER_SCHEMA,
            label: stage,
            ...(phase !== undefined ? { phase } : {}),
            model: effectiveModel,
            ...(effort !== undefined ? { effort } : {}),
            ...(verifierType !== undefined ? { agentType: verifierType } : {}),
          }
          return agentWithSchemaSalvage<VerifierVote>(rt, prompt, opts)
        }
      })

      const retryRaw = await rt.parallel(retryThunks)
      retryTargets.forEach((t, i) => {
        const out = (retryRaw[i] as StructuredCallOutcome<VerifierVote> | null) ?? null
        t.pc.retryOuts[t.voteIndex] = out
        // Same salvage-aware effective label as the first pass: if the retry's credited
        // value came from ITS `:salvage` respawn, scan that transcript, not the base retry.
        const retryStage = t.pc.retryStages[t.voteIndex]!
        t.pc.retryEffectiveStages[t.voteIndex] = out?.salvaged === true ? `${retryStage}:salvage` : retryStage
      })

      // Second checker over ONLY the retried labels — a distinct label (still NOT under
      // `:verify:`) and a distinct nonce (retry labels differ from the first pass) so the
      // two checker passes never collide in the transcript scan.
      const retryLabels = retryTargets.map((t) => t.pc.retryEffectiveStages[t.voteIndex]!)
      agentsSpawned++
      const retryCheckLabel = stg(`${PROVENANCE_CHECK_SUFFIX}:retry`)
      const { map: retryProvMap, replyOk: retryReplyOk } = await runProvenanceChecker(
        rt, gateExpectation, retryLabels, {
          label: retryCheckLabel,
          ...(phase !== undefined ? { phase } : {}),
          model: 'haiku',
          effort: 'low',
          nonce: deriveProvenanceNonce(retryLabels, perClaim.map((pc) => renderClaim(pc.claim)).join(' ')),
        },
      )
      retryCheckerRecord = makeRecord(retryCheckLabel, retryReplyOk, { model: 'haiku', effort: 'low' })

      // Apply recovery: a retried vote counts ONLY if it returned a real vote AND the
      // second checker saw a real CLI invocation for it. Everything else stays null.
      let recoveredCount = 0
      let unrecoveredCount = 0
      for (const { pc, voteIndex } of retryTargets) {
        const retryVote = pc.retryOuts[voteIndex]?.value ?? null
        const provenance = retryProvMap.get(pc.retryEffectiveStages[voteIndex]!) ?? 'undetermined'
        if (retryVote !== null && provenance === 'seen') {
          pc.retryVotes[voteIndex] = retryVote // recovered → folded into the tally + public votes
          recoveredCount++
        } else {
          if (retryVote !== null) pc.retryDisqualified[voteIndex] = true // self-answered again
          unrecoveredCount++
        }
      }
      if (recoveredCount > 0) {
        warn(rt, warnings,
          `adversarialVerification: ${recoveredCount} gate-nullified verifier votes RECOVERED after one retry ` +
          `(a real ${gateExpectation.id} CLI invocation found on the re-spawn)`)
      }
      if (unrecoveredCount > 0) {
        warn(rt, warnings,
          `adversarialVerification: ${unrecoveredCount} gate-nullified verifier votes remained unrecovered after one retry`)
      }
    }
  }

  // ---- Phase C: build trail records (post-gate outcome bits) and tally, in
  // deterministic claim-index / vote-index order — independent of Phase A's
  // completion order.
  //
  // NOTE: model is ALWAYS recorded here because effectiveModel is always passed
  // explicitly to rt.agent — even the 'opus' default is an explicit argument, not
  // an omission. This is the intentional model-sensitivity audit behaviour for
  // adversarialVerification. One record per agentsSpawned++.
  const verifiedKept: Array<VerifiedClaim<TClaim>> = perClaim.map((pc, claimIndex) => {
    const claimRecords: TrailRecord[] = []
    const claimRetryRecords: TrailRecord[] = []
    const claimWarnings: string[] = []
    for (let voteIndex = 0; voteIndex < pc.votes.length; voteIndex++) {
      const out = pc.voteOuts[voteIndex] ?? null
      const vote = pc.votes[voteIndex] ?? null
      const stage = pc.voteStages[voteIndex]!
      agentsSpawned += out?.spawns ?? 1
      claimRecords.push(makeRecord(
        stage,
        vote !== null,
        {
          model: effectiveModel,
          ...(effort !== undefined ? { effort } : {}),
          // A surviving vote records its verdict; a gate-nullified vote records the
          // control reason (so the trail distinguishes a self-answer disqualification
          // from a plain agent failure); a plain failure records neither. The ORIGINAL
          // record ALWAYS reflects the first-pass outcome — a Phase B2 recovery does NOT
          // rewrite it (the recovered vote is a separate `:retry` record below), so the
          // disqualification stays auditable.
          ...(vote !== null
            ? { decision: vote.verdict }
            : pc.provenanceDisqualified[voteIndex]
              ? { decision: 'disqualified-no-provenance' }
              : {}),
        },
      ))
      if (out !== null && out.salvageAttempted) {
        claimRecords.push(makeRecord(
          `${stage}:salvage`,
          out.salvaged,
          {
            model: effectiveModel,
            ...(effort !== undefined ? { effort } : {}),
          },
        ))
      }
      for (const message of out?.warnings ?? []) claimWarnings.push(`${STAGE}: ${message}`)

      // Phase B2 retry record for a gate-disqualified vote. `retried-after-disqualification`
      // marks a RECOVERED retry (real vote + provenance); a retry that self-answered again
      // carries `disqualified-no-provenance` (like any disqualification, its `:retry` stage
      // suffix flags it as a retry attempt); a plain agent failure on the retry records
      // neither. The recovered verdict itself lives in the public votes array (folded below).
      const retryStage = pc.retryStages[voteIndex]
      if (retryStage !== undefined) {
        const retryOut = pc.retryOuts[voteIndex] ?? null
        const recovered = pc.retryVotes[voteIndex] ?? null
        agentsSpawned += retryOut?.spawns ?? 1
        claimRetryRecords.push(makeRecord(
          retryStage,
          recovered !== null,
          {
            model: effectiveModel,
            ...(effort !== undefined ? { effort } : {}),
            ...(recovered !== null
              ? { decision: 'retried-after-disqualification' }
              : pc.retryDisqualified[voteIndex]
                ? { decision: 'disqualified-no-provenance' }
                : {}),
          },
        ))
        if (retryOut !== null && retryOut.salvageAttempted) {
          claimRetryRecords.push(makeRecord(
            `${retryStage}:salvage`,
            retryOut.salvaged,
            {
              model: effectiveModel,
              ...(effort !== undefined ? { effort } : {}),
            },
          ))
        }
        for (const message of retryOut?.warnings ?? []) claimWarnings.push(`${STAGE}: ${message}`)
      }
    }
    trailByClaim[claimIndex] = claimRecords
    retryTrailByClaim[claimIndex] = claimRetryRecords
    warningsByClaim[claimIndex] = claimWarnings

    // Fold recovered retry votes (Phase B2) into the vote set used for BOTH the tally and
    // the public `votes` array: a disqualified slot that a retry recovered now carries the
    // recovered vote; every other slot is unchanged. The ORIGINAL votes array is never
    // mutated, so the disqualification trail above stays intact.
    const mergedVotes: Array<VerifierVote | null> = pc.votes.map(
      (v, i) => (v !== null ? v : pc.retryVotes[i] ?? null),
    )

    // -------------------------------------------------------------------
    // Deterministic tally in code — never trust the model to count votes.
    // Runs on votes AFTER the provenance gate (disqualified votes are null).
    //
    // nonNull = votes that returned an object AND passed the provenance gate
    // - if nonNull.length === 0 → 'unverifiable'  (failed/disqualified verifiers —
    //     never drop the claim; failure is distinct from refutation)
    // - else if count(verdict === 'refuted') >= refuteThreshold → 'refuted'
    //     (adversarial kill — enough verifiers actively disproved it)
    // - else if every nonNull vote is 'confirmed' → 'confirmed'
    //     (unanimous confirmation — no dissent)
    // - else → 'partially-confirmed'
    //     (mixed evidence — some confirmed, some not, some uncertain)
    // -------------------------------------------------------------------

    const nonNull = mergedVotes.filter((v): v is VerifierVote => v !== null)
    // The scalar threshold can exceed a low-vote claim's count — clamp per
    // claim so a 1-vote claim is decided by its single vote. min(2,3)=2:
    // identical to the scalar behavior at the defaults.
    const effectiveThreshold = Math.min(refuteThreshold, pc.claimVotes)
    let verdict: Verdict

    if (nonNull.length === 0) {
      // All verifiers failed or were disqualified — claim is unverifiable (not refuted)
      verdict = 'unverifiable'
    } else if (nonNull.filter(v => v.verdict === 'refuted').length >= effectiveThreshold) {
      // Adversarial kill: refutation threshold reached
      verdict = 'refuted'
    } else if (nonNull.every(v => v.verdict === 'confirmed')) {
      // Unanimous confirmation across all non-null verifiers
      verdict = 'confirmed'
    } else {
      // Mixed: at least one non-confirmed, not enough refutations
      verdict = 'partially-confirmed'
    }

    return { claim: pc.claim, verdict, votes: mergedVotes }
  })

  // Flatten per-claim records in claim-index order — deterministic regardless
  // of which claim group finished first. (.flat() also skips any hole safely.)
  trail.push(...trailByClaim.flat())
  // The provenance checker's own record (one spawn) sits after the vote records,
  // matching its temporal order (it runs after the vote barrier).
  if (checkerRecord !== null) trail.push(checkerRecord)
  // Phase B2 retry records, then the second checker's record — temporally after the
  // first checker (the retries run once the first gate identified disqualified votes).
  // Empty (both) when no vote was disqualified, so a no-retry run is byte-identical.
  trail.push(...retryTrailByClaim.flat())
  if (retryCheckerRecord !== null) trail.push(retryCheckerRecord)
  // Salvage diagnostics, in deterministic claim/vote order after the barrier.
  for (const message of warningsByClaim.flat()) warn(rt, warnings, message)

  // -------------------------------------------------------------------------
  // Append truncated claims as 'unverified-by-cap' with empty votes (§8).
  // They are present in the output so callers know evidence was withheld.
  // 'unverified-by-cap' (never tested — cap cut it, votes: []) is nominally
  // distinct from the tally path's 'unverifiable' (tested, all verifiers
  // failed — votes: non-empty array of nulls).
  // -------------------------------------------------------------------------

  const truncatedClaims: Array<VerifiedClaim<TClaim>> = (
    claims.slice(keptClaims.length) as TClaim[]
  ).map(claim => ({ claim, verdict: 'unverified-by-cap' as ClaimVerdict, votes: [] as ReadonlyArray<VerifierVote | null> }))

  const value: Array<VerifiedClaim<TClaim>> = [...verifiedKept, ...truncatedClaims]

  // -------------------------------------------------------------------------
  // Post-verification warnings
  // -------------------------------------------------------------------------

  // Count null votes across all verified claims
  let nullVoteCount = 0
  let allNullClaimsCount = 0
  for (const verified of verifiedKept) {
    const nullsInClaim = verified.votes.filter(v => v === null).length
    nullVoteCount += nullsInClaim
    // Compare against the CLAIM's own vote count (votes.length), not the
    // scalar default — vote counts vary per claim under votesPerClaim.
    if (nullsInClaim === verified.votes.length) {
      allNullClaimsCount++
    }
  }

  if (nullVoteCount > 0) {
    warn(
      rt, warnings,
      `adversarialVerification: ${nullVoteCount} verifier votes returned null across ${verifiedKept.length} claims`,
    )
  }

  if (allNullClaimsCount > 0) {
    warn(
      rt, warnings,
      `adversarialVerification: ${allNullClaimsCount} claims left unverifiable (all verifiers failed)`,
    )
  }

  // -------------------------------------------------------------------------
  // Stats semantics (documented):
  // - itemsIn = claims.length (always = itemsOut — claims NEVER dropped)
  // - itemsOut = claims.length (always — truncated claims are kept, just unverified)
  // - dropped = null verifier votes (lost WORK UNITS, not lost claims);
  //   an all-null claim stays in the output as 'unverifiable'
  // - truncated = cap-cut claims (kept but never verified — they carry the
  //   'unverified-by-cap' verdict, votes: [], and get NO trail records, so
  //   trail.length === agentsSpawned still holds)
  // - agentsSpawned = verifier calls actually made (on kept claims only).
  //   BY DESIGN it excludes the `truncated * votes` calls withheld by the cap —
  //   reconciling agentsSpawned against itemsIn * votes will show the gap; the
  //   truncation warning is the explicit signal for it (§7 no-silent-caps).
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: claims.length,
    itemsOut: claims.length,   // claims never dropped — always equal
    agentsSpawned,
    dropped: nullVoteCount,    // null votes = lost work units
    truncated,
  }

  // Phase digest: the FULL verdict tally across all claims. The five buckets partition
  // `value` (one verdict per claim, incl. cap-truncated) so they always sum to `claims`;
  // a consumer showing only confirmed+refuted would silently drop partially-confirmed /
  // unverifiable / unverified-by-cap (the defect this widening fixed). The bucket→key map
  // is a Record<ClaimVerdict, string> and the counts are built by iterating it, so a future
  // sixth ClaimVerdict is a COMPILE error here (a missing key), never a silent undercount.
  // DIGEST_KEY values are typed against the shared counts contract → a verdict mapped to a
  // non-existent count key is a COMPILE error, and a future sixth ClaimVerdict still forces a
  // mapping via Record<ClaimVerdict, …>.
  const DIGEST_KEY: Record<ClaimVerdict, keyof PatternCounts['adversarialVerification']> = {
    confirmed: 'confirmed',
    refuted: 'refuted',
    'partially-confirmed': 'partiallyConfirmed',
    unverifiable: 'unverifiable',
    'unverified-by-cap': 'unverifiedByCap',
  }
  // Typed to the contract shape (NO cast): the literal makes all six keys mandatory — drop the
  // `claims` seed or a verdict key and it is a compile error — and the loop overwrites the five
  // verdict buckets (indexing the closed type by DIGEST_KEY's `keyof`-typed values is allowed).
  const counts: PatternCounts['adversarialVerification'] = {
    claims: claims.length,
    confirmed: 0,
    refuted: 0,
    partiallyConfirmed: 0,
    unverifiable: 0,
    unverifiedByCap: 0,
  }
  for (const verdict of Object.keys(DIGEST_KEY) as ClaimVerdict[]) {
    counts[DIGEST_KEY[verdict]] = value.filter(v => v.verdict === verdict).length
  }
  emitDigest(rt, { stage: STAGE, ...(phase !== undefined ? { phase } : {}), counts })

  return { value, stats, warnings, trail }
}
