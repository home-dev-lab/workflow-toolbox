import { makeRecord } from './envelope.js'
import type { TrailRecord } from './envelope.js'
import type { ClaimVotesRaw, VerifierRoute } from './adversarial-verification-internal.js'
import type { VerifiedClaim, VerifierVote, Verdict } from './adversarial-verification.js'

interface TallyResult {
  verdict: Verdict
  floored: boolean
}

function tallyVerifierVotes(
  votes: readonly (VerifierVote | null)[],
  claimVotes: number,
  refuteThreshold: number,
  minValidVotes: number,
): TallyResult {
  const valid = votes.filter((vote): vote is VerifierVote => vote !== null)
  const threshold = Math.min(refuteThreshold, claimVotes)
  const floor = Math.min(minValidVotes, claimVotes)
  let verdict: Verdict
  if (valid.length === 0) verdict = 'unverifiable'
  else if (valid.filter((vote) => vote.verdict === 'refuted').length >= threshold) verdict = 'refuted'
  else if (valid.every((vote) => vote.verdict === 'confirmed')) verdict = 'confirmed'
  else verdict = 'partially-confirmed'
  const floored = (verdict === 'confirmed' || verdict === 'refuted') && valid.length < floor
  return { verdict: floored ? 'partially-confirmed' : verdict, floored }
}

interface ClaimProjection<TClaim> {
  verified: VerifiedClaim<TClaim>
  originalTrail: TrailRecord[]
  retryTrail: TrailRecord[]
  warnings: string[]
  attemptsSpawned: number
  floored: boolean
}

function originalDecision(vote: VerifierVote | null, disqualified: boolean): { decision?: string } {
  if (vote !== null) return { decision: vote.verdict }
  if (disqualified) return { decision: 'disqualified-no-provenance' }
  return {}
}

function retryDecision(recovered: VerifierVote | null, disqualified: boolean): { decision?: string } {
  if (recovered !== null) return { decision: 'retried-after-disqualification' }
  if (disqualified) return { decision: 'disqualified-no-provenance' }
  return {}
}

function projectClaim<TClaim>(
  route: VerifierRoute<TClaim>,
  claim: ClaimVotesRaw<TClaim>,
): ClaimProjection<TClaim> {
  const originalTrail: TrailRecord[] = []
  const retryTrail: TrailRecord[] = []
  const warnings: string[] = []
  let attemptsSpawned = 0
  for (let voteIndex = 0; voteIndex < claim.votes.length; voteIndex++) {
    const outcome = claim.voteOuts[voteIndex] ?? null
    const vote = claim.votes[voteIndex] ?? null
    const stage = claim.voteStages[voteIndex]!
    attemptsSpawned += outcome?.spawns ?? 1
    originalTrail.push(makeRecord(stage, vote !== null, {
      model: route.effectiveModel,
      ...(route.config.effort !== undefined ? { effort: route.config.effort } : {}),
      ...originalDecision(vote, claim.provenanceDisqualified[voteIndex] ?? false),
    }))
    if (outcome?.salvageAttempted === true) {
      originalTrail.push(makeRecord(`${stage}:salvage`, outcome.salvaged, {
        model: route.effectiveModel,
        ...(route.config.effort !== undefined ? { effort: route.config.effort } : {}),
      }))
    }
    for (const message of outcome?.warnings ?? []) warnings.push(`adversarialVerification: ${message}`)

    const retryStage = claim.retryStages[voteIndex]
    if (retryStage === undefined) continue
    const retryOutcome = claim.retryOuts[voteIndex] ?? null
    const recovered = claim.retryVotes[voteIndex] ?? null
    attemptsSpawned += retryOutcome?.spawns ?? 1
    retryTrail.push(makeRecord(retryStage, recovered !== null, {
      model: route.effectiveModel,
      ...(route.config.effort !== undefined ? { effort: route.config.effort } : {}),
      ...retryDecision(recovered, claim.retryDisqualified[voteIndex] ?? false),
    }))
    if (retryOutcome?.salvageAttempted === true) {
      retryTrail.push(makeRecord(`${retryStage}:salvage`, retryOutcome.salvaged, {
        model: route.effectiveModel,
        ...(route.config.effort !== undefined ? { effort: route.config.effort } : {}),
      }))
    }
    for (const message of retryOutcome?.warnings ?? []) warnings.push(`adversarialVerification: ${message}`)
  }

  const mergedVotes = claim.votes.map((vote, index) => vote ?? claim.retryVotes[index] ?? null)
  const tally = tallyVerifierVotes(
    mergedVotes,
    claim.claimVotes,
    route.config.refuteThreshold,
    route.config.minValidVotes,
  )
  return {
    verified: { claim: claim.claim, verdict: tally.verdict, votes: mergedVotes },
    originalTrail,
    retryTrail,
    warnings,
    attemptsSpawned,
    floored: tally.floored,
  }
}

export interface AuditProjection<TClaim> {
  verified: Array<VerifiedClaim<TClaim>>
  originalTrail: TrailRecord[]
  retryTrail: TrailRecord[]
  warnings: string[]
  attemptsSpawned: number
  flooredCount: number
}

export function projectVerifiedClaims<TClaim>(
  route: VerifierRoute<TClaim>,
  perClaim: Array<ClaimVotesRaw<TClaim>>,
): AuditProjection<TClaim> {
  const projected = perClaim.map((claim) => projectClaim(route, claim))
  return {
    verified: projected.map((claim) => claim.verified),
    originalTrail: projected.flatMap((claim) => claim.originalTrail),
    retryTrail: projected.flatMap((claim) => claim.retryTrail),
    warnings: projected.flatMap((claim) => claim.warnings),
    attemptsSpawned: projected.reduce((total, claim) => total + claim.attemptsSpawned, 0),
    flooredCount: projected.filter((claim) => claim.floored).length,
  }
}
