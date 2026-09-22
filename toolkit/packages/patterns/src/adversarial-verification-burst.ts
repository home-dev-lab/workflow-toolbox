import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { runVerifierAttempt } from './adversarial-verification-call.js'
import type { ClaimVotesRaw, VerifierRoute } from './adversarial-verification-internal.js'
import type { StructuredCallOutcome } from './structured-salvage.js'
import type { VerifierVote } from './adversarial-verification.js'

export function runInitialVerificationBurst<TClaim>(
  rt: WorkflowRuntime,
  route: VerifierRoute<TClaim>,
  keptClaims: readonly TClaim[],
): Promise<Array<ClaimVotesRaw<TClaim>>> {
  const { config } = route
  return Promise.all(keptClaims.map(async (claim, claimIndex) => {
    const claimVotes = config.perClaimVotes[claimIndex] ?? config.votes
    const voteStages = Array.from(
      { length: claimVotes },
      (_unused, voteIndex) => route.stage(`verify:${claimIndex}:${voteIndex}`),
    )
    const rawVotes = await rt.parallel(voteStages.map((label, voteIndex) => async () =>
      runVerifierAttempt(rt, {
        claim,
        renderClaim: config.renderClaim,
        lens: config.lenses?.[voteIndex],
        label,
        phase: config.phase,
        model: route.effectiveModel,
        effort: config.effort,
        agentType: config.verifierType,
      })))
    const voteOuts = rawVotes.map((value) => value as StructuredCallOutcome<VerifierVote> | null)
    const votes = voteOuts.map((outcome) => outcome?.value ?? null)
    return {
      claim,
      claimVotes,
      voteOuts,
      votes,
      voteStages,
      effectiveStages: voteStages.map((stage, index) =>
        voteOuts[index]?.salvaged === true ? `${stage}:salvage` : stage),
      provenanceDisqualified: new Array<boolean>(votes.length).fill(false),
      retryStages: new Array<string | undefined>(votes.length).fill(undefined),
      retryEffectiveStages: new Array<string | undefined>(votes.length).fill(undefined),
      retryOuts: new Array<StructuredCallOutcome<VerifierVote> | null>(votes.length).fill(null),
      retryVotes: new Array<VerifierVote | null>(votes.length).fill(null),
      retryDisqualified: new Array<boolean>(votes.length).fill(false),
    }
  }))
}
