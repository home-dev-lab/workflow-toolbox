// adversarial-verification.ts — refute-first claim verification.
//
// Flow: for each claim, rt.parallel over `votes` verifier agents.
//       Tally in code (deterministic, never trust model to count votes).
//
// §8 Risk guardrail: default model is 'opus'. Non-opus degrades quality; warn.
// §8 Cap policy: truncated claims are KEPT as 'unverifiable' — a cap never
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

import type { WorkflowRuntime, JsonSchema, ModelAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = 'confirmed' | 'partially-confirmed' | 'refuted' | 'unverifiable'

export interface VerifierVote {
  verdict: Verdict
  reason: string
}

export interface VerifiedClaim<TClaim> {
  claim: TClaim
  verdict: Verdict
  /** Raw votes in verifier order; null = verifier failed/skipped.
   *  Empty array for cap-truncated claims. */
  votes: ReadonlyArray<VerifierVote | null>
}

export interface AdversarialVerificationOptions<TClaim> {
  claims: readonly TClaim[]
  renderClaim: (claim: TClaim) => string
  votes?: number           // default 3, must be >= 1
  refuteThreshold?: number // default 2, must be >= 1 and <= votes
  /** Optional perspective diversity: one lens per vote (length MUST === votes).
   *  A claim can fail in more than one way — distinct lenses catch failure
   *  modes plain redundancy can't, e.g. for a code-review finding:
   *  `['correctness', 'security', 'does-it-reproduce']`. Omit for N identical
   *  refute-first verifiers. */
  lenses?: readonly string[]
  model?: ModelAlias       // default 'opus'
  phase?: string
  maxVerifyClaims?: number // cap; truncated claims kept as 'unverifiable'
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
    model,
    phase,
    maxVerifyClaims,
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

  if (refuteThreshold > votesOpt) {
    throw new Error(
      `adversarialVerification: refuteThreshold (${refuteThreshold}) must not be > votes (${votesOpt})`,
    )
  }

  if (lenses !== undefined && lenses.length !== votesOpt) {
    throw new Error(
      `adversarialVerification: lenses.length (${lenses.length}) must equal votes (${votesOpt}) — each lens corresponds to one vote`,
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
  // §8 Model-sensitivity guardrail: default 'opus'. Non-opus → warning.
  // Verification quality is model-sensitive: weaker models are less reliably
  // adversarial and more likely to confirm by default.
  // -------------------------------------------------------------------------

  const effectiveModel: ModelAlias = model ?? 'opus'
  if (model !== undefined && model !== 'opus') {
    warn(
      rt, warnings,
      `adversarialVerification: verifier model downgraded to "${model}" — verification quality is model-sensitive`,
    )
  }

  // -------------------------------------------------------------------------
  // Apply cap. Truncated claims are appended to output as 'unverifiable'
  // (keep-unverified-rather-than-drop, §8 — a cap never destroys evidence).
  // -------------------------------------------------------------------------

  const { kept: keptClaims, truncated } = applyCap(claims, maxVerifyClaims)

  if (truncated > 0) {
    warn(
      rt, warnings,
      `adversarialVerification: ${truncated} of ${claims.length} claims truncated by maxVerifyClaims=${maxVerifyClaims ?? '?'} — kept as unverifiable`,
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
      const voteThunks = Array.from({ length: votesOpt }, (_: unknown, voteIndex: number) => {
        return async (): Promise<VerifierVote | null> => {
          const lens = lenses !== undefined ? lenses[voteIndex] : undefined
          const prompt = buildVerifierPrompt(claim, lens)

          const opts: {
            schema: JsonSchema
            label: string
            phase?: string
            model?: ModelAlias
          } = {
            schema: VERIFIER_SCHEMA,
            label: `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
            ...(phase !== undefined ? { phase } : {}),
            model: effectiveModel,
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
      let verdict: Verdict

      if (nonNull.length === 0) {
        // All verifiers failed — claim is unverifiable (not refuted)
        verdict = 'unverifiable'
      } else if (nonNull.filter(v => v.verdict === 'refuted').length >= refuteThreshold) {
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
  // Append truncated claims as unverifiable with empty votes (§8).
  // They are present in the output so callers know evidence was withheld.
  // -------------------------------------------------------------------------

  const truncatedClaims: Array<VerifiedClaim<TClaim>> = (
    claims.slice(keptClaims.length) as TClaim[]
  ).map(claim => ({ claim, verdict: 'unverifiable' as Verdict, votes: [] as ReadonlyArray<VerifierVote | null> }))

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
    if (nullsInClaim === votesOpt) {
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
  // - dropped = null verifier votes (lost WORK UNITS, not lost claims)
  // - truncated = cap-cut claims (kept but not actively verified)
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
