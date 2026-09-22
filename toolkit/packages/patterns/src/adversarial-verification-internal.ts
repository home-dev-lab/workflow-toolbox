import type { EffortAlias, ModelAlias } from '@workflow-toolbox/runtime'
import type { TrailRecord } from './envelope.js'
import type { StructuredCallOutcome } from './structured-salvage.js'
import type { AdversarialVerificationOptions, VerifierVote } from './adversarial-verification.js'

export interface ResolvedAdversarialConfig<TClaim> {
  claims: readonly TClaim[]
  renderClaim: (claim: TClaim) => string
  votes: number
  refuteThreshold: number
  lenses: readonly string[] | undefined
  perClaimVotes: number[]
  minValidVotes: number
  model: ModelAlias | undefined
  effort: EffortAlias | undefined
  phase: string | undefined
  maxVerifyClaims: number | undefined
  verifierType: string | undefined
  cacheWarm: boolean | undefined
  stageKey: string | undefined
}

export interface VerifierRoute<TClaim> {
  config: ResolvedAdversarialConfig<TClaim>
  effectiveModel: ModelAlias
  stage: (suffix?: string) => string
}

export interface ClaimVotesRaw<TClaim> {
  claim: TClaim
  claimVotes: number
  voteOuts: Array<StructuredCallOutcome<VerifierVote> | null>
  votes: Array<VerifierVote | null>
  voteStages: string[]
  effectiveStages: string[]
  provenanceDisqualified: boolean[]
  retryStages: Array<string | undefined>
  retryEffectiveStages: Array<string | undefined>
  retryOuts: Array<StructuredCallOutcome<VerifierVote> | null>
  retryVotes: Array<VerifierVote | null>
  retryDisqualified: boolean[]
}

export interface ProvenanceResult {
  checkerRecord: TrailRecord | null
  retryCheckerRecord: TrailRecord | null
  checkerSpawns: number
  selfAnswerCount: number
  undeterminedFirstPassCount: number
  recoveredAfterRetry: number
}

export type AdversarialOptions<TClaim> = AdversarialVerificationOptions<TClaim>
