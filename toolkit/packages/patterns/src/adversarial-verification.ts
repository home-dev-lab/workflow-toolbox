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
// - Labels: adversarialVerification:verify:<claimIndex>:<voteIndex>.

import { BEST_MODEL } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, ModelAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'

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
   *  other consumer. Validate shape only; the runtime owns registry membership. */
  verifierType?: string
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
    phase,
    maxVerifyClaims,
    verifierType,
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

  // Per-claim trail records, written by claim INDEX (order-independent writes),
  // flattened after the global barrier — claim completion order is
  // non-deterministic under the real async runtime; indexed writes are not.
  const trailByClaim: TrailRecord[][] = []

  const verifiedKept: Array<VerifiedClaim<TClaim>> = await Promise.all(
    (keptClaims as readonly TClaim[]).map(async (claim, claimIndex) => {
      // keptClaims is a prefix of claims, so indices align with perClaimVotes.
      const claimVotes = perClaimVotes[claimIndex] ?? votesOpt
      const voteThunks = Array.from({ length: claimVotes }, (_: unknown, voteIndex: number) => {
        return async (): Promise<VerifierVote | null> => {
          const lens = lenses !== undefined ? lenses[voteIndex] : undefined
          const prompt = buildVerifierPrompt(claim, lens)

          const opts: {
            schema: JsonSchema
            label: string
            phase?: string
            model?: ModelAlias
            agentType?: string
          } = {
            schema: VERIFIER_SCHEMA,
            label: `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
            ...(phase !== undefined ? { phase } : {}),
            model: effectiveModel,
            ...(verifierType !== undefined ? { agentType: verifierType } : {}),
          }

          agentsSpawned++
          return rt.agent<VerifierVote>(prompt, opts)
        }
      })

      const rawVotes = await rt.parallel(voteThunks)
      const votes: Array<VerifierVote | null> = rawVotes.map(
        (v): VerifierVote | null => v as VerifierVote | null,
      )

      // Trail records built in vote-index order AFTER the rt.parallel barrier,
      // and stored by claim INDEX — pushing straight to `trail` from inside
      // this callback would interleave claims in completion order, which is
      // non-deterministic under the real async runtime (FakeRuntime's
      // synchronous resolution would mask it). One record per agentsSpawned++.
      // NOTE: model is ALWAYS recorded here because effectiveModel is always
      // passed explicitly to rt.agent — even the 'opus' default is an explicit
      // argument, not an omission. This is the intentional model-sensitivity
      // audit behaviour for adversarialVerification.
      const claimRecords: TrailRecord[] = []
      for (let voteIndex = 0; voteIndex < votes.length; voteIndex++) {
        const vote = votes[voteIndex] ?? null
        claimRecords.push(makeRecord(
          `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
          vote !== null,
          {
            model: effectiveModel,
            ...(vote !== null ? { decision: vote.verdict } : {}),
          },
        ))
      }
      trailByClaim[claimIndex] = claimRecords

      // -------------------------------------------------------------------
      // Deterministic tally in code — never trust the model to count votes.
      //
      // nonNull = votes that returned an object
      // - if nonNull.length === 0 → 'unverifiable'  (failed verifiers —
      //     never drop the claim; failure is distinct from refutation)
      // - else if count(verdict === 'refuted') >= refuteThreshold → 'refuted'
      //     (adversarial kill — enough verifiers actively disproved it)
      // - else if every nonNull vote is 'confirmed' → 'confirmed'
      //     (unanimous confirmation — no dissent)
      // - else → 'partially-confirmed'
      //     (mixed evidence — some confirmed, some not, some uncertain)
      // -------------------------------------------------------------------

      const nonNull = votes.filter((v): v is VerifierVote => v !== null)
      // The scalar threshold can exceed a low-vote claim's count — clamp per
      // claim so a 1-vote claim is decided by its single vote. min(2,3)=2:
      // identical to the scalar behavior at the defaults.
      const effectiveThreshold = Math.min(refuteThreshold, claimVotes)
      let verdict: Verdict

      if (nonNull.length === 0) {
        // All verifiers failed — claim is unverifiable (not refuted)
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

      return { claim, verdict, votes }
    }),
  )

  // Flatten per-claim records in claim-index order — deterministic regardless
  // of which claim group finished first. (.flat() also skips any hole safely.)
  trail.push(...trailByClaim.flat())

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

  return { value, stats, warnings, trail }
}
