import type { PatternCounts } from '@workflow-toolbox/runtime'
import type { PatternStats } from './envelope.js'
import type { ClaimVerdict, VerifiedClaim, VerifierVote } from './adversarial-verification.js'

export function appendTruncatedClaims<TClaim>(
  verified: Array<VerifiedClaim<TClaim>>,
  claims: readonly TClaim[],
  keptCount: number,
): Array<VerifiedClaim<TClaim>> {
  const truncated = claims.slice(keptCount).map((claim) => ({
    claim,
    verdict: 'unverified-by-cap' as ClaimVerdict,
    votes: [] as ReadonlyArray<VerifierVote | null>,
  }))
  return [...verified, ...truncated]
}

export function countNullVotes<TClaim>(verified: Array<VerifiedClaim<TClaim>>): {
  nullVoteCount: number
  allNullClaimsCount: number
} {
  let nullVoteCount = 0
  let allNullClaimsCount = 0
  for (const claim of verified) {
    const nulls = claim.votes.filter((vote) => vote === null).length
    nullVoteCount += nulls
    if (nulls === claim.votes.length) allNullClaimsCount++
  }
  return { nullVoteCount, allNullClaimsCount }
}

export function buildAdversarialStats(
  claimCount: number,
  agentsSpawned: number,
  nullVoteCount: number,
  truncated: number,
): PatternStats {
  return {
    itemsIn: claimCount,
    itemsOut: claimCount,
    agentsSpawned,
    dropped: nullVoteCount,
    truncated,
  }
}

const DIGEST_KEY: Record<ClaimVerdict, keyof PatternCounts['adversarialVerification']> = {
  confirmed: 'confirmed',
  refuted: 'refuted',
  'partially-confirmed': 'partiallyConfirmed',
  unverifiable: 'unverifiable',
  'unverified-by-cap': 'unverifiedByCap',
}

export function buildAdversarialCounts<TClaim>(
  value: Array<VerifiedClaim<TClaim>>,
  claimCount: number,
): PatternCounts['adversarialVerification'] {
  const counts: PatternCounts['adversarialVerification'] = {
    claims: claimCount,
    confirmed: 0,
    refuted: 0,
    partiallyConfirmed: 0,
    unverifiable: 0,
    unverifiedByCap: 0,
  }
  for (const verdict of Object.keys(DIGEST_KEY) as ClaimVerdict[]) {
    counts[DIGEST_KEY[verdict]] = value.filter((claim) => claim.verdict === verdict).length
  }
  return counts
}
