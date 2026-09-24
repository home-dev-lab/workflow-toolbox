import type { AdversarialOptions, ResolvedAdversarialConfig } from './adversarial-verification-internal.js'

export function resolveAdversarialVerificationConfig<TClaim>(
  options: AdversarialOptions<TClaim>,
): ResolvedAdversarialConfig<TClaim> {
  const {
    claims, renderClaim, votes: votes = 3, refuteThreshold: thresholdOption,
    lenses, votesPerClaim, minValidVotes: floorOption, model, effort, phase,
    maxVerifyClaims, verifierType, cacheWarm, stageKey,
  } = options
  const refuteThreshold = thresholdOption ?? 2
  const minValidVotes = floorOption ?? 2

  if (claims.length === 0) {
    throw new Error('adversarialVerification: empty claims — provide at least one claim to verify')
  }
  if (votes < 1) {
    throw new Error(`adversarialVerification: votes must be >= 1, got ${votes}`)
  }
  if (refuteThreshold < 1) {
    throw new Error(`adversarialVerification: refuteThreshold must be >= 1, got ${refuteThreshold}`)
  }
  if (votesPerClaim === undefined && refuteThreshold > votes) {
    throw new Error(`adversarialVerification: refuteThreshold (${refuteThreshold}) must not be > votes (${votes})`)
  }
  if (!Number.isInteger(minValidVotes) || minValidVotes < 1) {
    throw new Error(`adversarialVerification: minValidVotes must be an integer >= 1, got ${String(floorOption)}`)
  }
  if (lenses !== undefined && lenses.length !== votes) {
    throw new Error(`adversarialVerification: lenses.length (${lenses.length}) must equal votes (${votes}) — each lens corresponds to one vote`)
  }
  if (lenses !== undefined && votesPerClaim !== undefined) {
    throw new Error('adversarialVerification: lenses cannot be combined with votesPerClaim — lenses require a fixed votes count (one lens per vote); use one or the other')
  }

  const perClaimVotes = claims.map((claim, index) => {
    if (votesPerClaim === undefined) return votes
    const count = votesPerClaim(claim)
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`adversarialVerification: votesPerClaim(claims[${index}]) returned ${String(count)} — must be an integer >= 1`)
    }
    return count
  })

  if (verifierType !== undefined && verifierType.trim().length === 0) {
    throw new Error('adversarialVerification: verifierType must be a non-empty subagent-type string (e.g. "magic-claude:ts-reviewer") — omit it for the standard subagent')
  }
  // Preserve the current fractional-cap behavior: applyCap performs the integer
  // check later, after the invocation has claimed its stage instance.
  if (maxVerifyClaims !== undefined && maxVerifyClaims < 1) {
    throw new Error(`adversarialVerification: maxVerifyClaims must be >= 1, got ${maxVerifyClaims}`)
  }

  return {
    claims, renderClaim, votes, refuteThreshold, lenses, perClaimVotes,
    minValidVotes, model, effort, phase, maxVerifyClaims, verifierType,
    cacheWarm, stageKey,
  }
}
