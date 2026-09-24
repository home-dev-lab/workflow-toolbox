// adversarial-verification.ts — public API and phase orchestration for
// refute-first claim verification.

import { BEST_MODEL } from '@workflow-toolbox/runtime'
import type { EffortAlias, ModelAlias, WorkflowRuntime } from '@workflow-toolbox/runtime'
import { projectVerifiedClaims } from './adversarial-verification-audit.js'
import { runInitialVerificationBurst } from './adversarial-verification-burst.js'
import { resolveAdversarialVerificationConfig } from './adversarial-verification-config.js'
import { enforceVerifierProvenance } from './adversarial-verification-provenance.js'
import {
  appendTruncatedClaims,
  buildAdversarialCounts,
  buildAdversarialStats,
  countNullVotes,
} from './adversarial-verification-summary.js'
import { runCacheWarmup } from './cache-warm.js'
import { applyCap, emitDigest, warn } from './envelope.js'
import type { PatternResult, TrailRecord } from './envelope.js'
import { withEnvelopeContract } from './envelope-contract.js'
import { externalGateExpectation } from './provenance-gate.js'
import { claimStageInstance, stageBuilder } from './stage-instance.js'
import type { ProvenanceResult, ResolvedAdversarialConfig } from './adversarial-verification-internal.js'

const STAGE = 'adversarialVerification'

export type Verdict = 'confirmed' | 'partially-confirmed' | 'refuted' | 'unverifiable'

/** Pattern-level verdict. Cap-cut claims were never tested and are distinct
 * from claims whose verifier attempts all failed. */
export type ClaimVerdict = Verdict | 'unverified-by-cap'

export interface VerifierVote {
  verdict: Verdict
  reason: string
}

export interface VerifiedClaim<TClaim> {
  claim: TClaim
  verdict: ClaimVerdict
  /** Raw votes in verifier order; null means failed or disqualified. Cap-cut
   * claims have an empty array. */
  votes: ReadonlyArray<VerifierVote | null>
}

export interface AdversarialVerificationOptions<TClaim> {
  claims: readonly TClaim[]
  renderClaim: (claim: TClaim) => string
  /** Default 3; must be >= 1. */
  votes?: number
  /** Default 2; clamped per claim when votesPerClaim is used. */
  refuteThreshold?: number
  /** One perspective per scalar vote. Cannot be combined with votesPerClaim. */
  lenses?: readonly string[]
  /** Evaluated exactly once for every input claim before capping. */
  votesPerClaim?: (claim: TClaim) => number
  /** Minimum surviving valid votes for a confident result. Default 2; 1 disables. */
  minValidVotes?: number
  /** Defaults to BEST_MODEL, except external relay wrappers default to haiku. */
  model?: ModelAlias
  effort?: EffortAlias
  phase?: string
  /** Cap-cut claims remain in output as unverified-by-cap. */
  maxVerifyClaims?: number
  /** Optional specialist or external-relay subagent type for every verifier. */
  verifierType?: string
  /** Run one same-route cache warmup before the concurrent burst. Default true. */
  cacheWarm?: boolean
  /** Stable invocation discriminator. Invalid keys warn and use the auto counter. */
  stageKey?: string
}

function resolveVerifierModel<TClaim>(
  rt: WorkflowRuntime,
  config: ResolvedAdversarialConfig<TClaim>,
  external: boolean,
  warnings: string[],
): ModelAlias {
  const effectiveModel = config.model ?? (external ? 'haiku' : BEST_MODEL)
  if (!external && config.model !== undefined && config.model !== BEST_MODEL) {
    warn(
      rt,
      warnings,
      `adversarialVerification: verifier model downgraded to "${config.model}" — verification quality is model-sensitive`,
    )
  }
  return effectiveModel
}

function warnForTruncation(
  rt: WorkflowRuntime,
  warnings: string[],
  truncated: number,
  claims: number,
  cap: number | undefined,
): void {
  if (truncated === 0) return
  warn(
    rt,
    warnings,
    `adversarialVerification: ${truncated} of ${claims} claims truncated by ` +
    `maxVerifyClaims=${cap ?? '?'} — kept as unverified-by-cap`,
  )
}

async function warmVerifierCache<TClaim>(
  rt: WorkflowRuntime,
  config: ResolvedAdversarialConfig<TClaim>,
  effectiveModel: ModelAlias,
  stage: (suffix?: string) => string,
  warnings: string[],
  trail: TrailRecord[],
): Promise<number> {
  if (!(config.cacheWarm ?? true)) return 0
  trail.push(await runCacheWarmup(rt, warnings, stage('warm'), STAGE, {
    ...(config.phase !== undefined ? { phase: config.phase } : {}),
    model: effectiveModel,
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    ...(config.verifierType !== undefined ? { agentType: config.verifierType } : {}),
  }))
  return 1
}

function warnForSelfAnswerToll(
  rt: WorkflowRuntime,
  warnings: string[],
  effectiveModel: ModelAlias,
  provenance: ProvenanceResult,
  totalExternalVotes: number,
  expectationId: string | undefined,
): void {
  const unprovenanced = provenance.selfAnswerCount + provenance.undeterminedFirstPassCount
  if (expectationId === undefined || unprovenanced === 0) return
  const stillNull = unprovenanced - provenance.recoveredAfterRetry
  warn(
    rt,
    warnings,
    `adversarialVerification: SELF-ANSWER TOLL — ${unprovenanced} of ${totalExternalVotes} external ` +
    `verifier votes returned a verdict with NO credited ${expectationId} CLI invocation ` +
    `(${provenance.selfAnswerCount} confirmed self-answer, ` +
    `${provenance.undeterminedFirstPassCount} undetermined); each spent the wrapper's full budget ` +
    `(wrapper model=${effectiveModel}) before the provenance gate nullified it — ` +
    `${provenance.recoveredAfterRetry} recovered on retry, ${stillNull} remain null. ` +
    `At audit scale keep the wrapper model 'haiku' to bound this cost.`,
  )
}

function warnForDiagnostics(
  rt: WorkflowRuntime,
  warnings: string[],
  nullVoteCount: number,
  allNullClaimsCount: number,
  verifiedClaims: number,
  flooredCount: number,
  minValidVotes: number,
): void {
  if (nullVoteCount > 0) {
    warn(rt, warnings, `adversarialVerification: ${nullVoteCount} verifier votes returned null across ${verifiedClaims} claims`)
  }
  if (allNullClaimsCount > 0) {
    warn(rt, warnings, `adversarialVerification: ${allNullClaimsCount} claims left unverifiable (all verifiers failed)`)
  }
  if (flooredCount > 0) {
    warn(
      rt,
      warnings,
      `adversarialVerification: ${flooredCount} claims demoted to partially-confirmed by the ` +
      `confidence floor (fewer than minValidVotes=${minValidVotes} surviving valid votes) — ` +
      `set minValidVotes:1 to disable`,
    )
  }
}

/** Refute-first claim verification. Claims are never dropped: cap-cut claims
 * remain visible and all verdict tallying is deterministic code. */
export async function adversarialVerification<TClaim>(
  runtime: WorkflowRuntime,
  options: AdversarialVerificationOptions<TClaim>,
): Promise<PatternResult<Array<VerifiedClaim<TClaim>>>> {
  const rt = withEnvelopeContract(runtime)
  const config = resolveAdversarialVerificationConfig(options)
  const warnings: string[] = []
  const trail: TrailRecord[] = []
  let agentsSpawned = 0

  // Stage claim intentionally follows config validation but precedes applyCap:
  // a fractional cap currently fails late and consumes this invocation slot.
  const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, config.stageKey)
  if (stageKeyWarning !== undefined) warn(rt, warnings, stageKeyWarning)
  const stage = stageBuilder(STAGE, salt)

  const gateExpectation = externalGateExpectation(config.verifierType)
  const effectiveModel = resolveVerifierModel(rt, config, gateExpectation !== null, warnings)

  const { kept: keptClaims, truncated } = applyCap(config.claims, config.maxVerifyClaims)
  warnForTruncation(rt, warnings, truncated, config.claims.length, config.maxVerifyClaims)
  agentsSpawned += await warmVerifierCache(rt, config, effectiveModel, stage, warnings, trail)

  const route = { config, effectiveModel, stage }
  const perClaim = await runInitialVerificationBurst(rt, route, keptClaims)
  const provenance = await enforceVerifierProvenance(
    rt,
    route,
    gateExpectation,
    perClaim,
    (message) => warn(rt, warnings, message),
  )
  agentsSpawned += provenance.checkerSpawns

  const totalExternalVotes = perClaim.reduce((total, claim) => total + claim.votes.length, 0)
  warnForSelfAnswerToll(
    rt, warnings, effectiveModel, provenance, totalExternalVotes, gateExpectation?.id,
  )

  const projection = projectVerifiedClaims(route, perClaim)
  agentsSpawned += projection.attemptsSpawned
  trail.push(...projection.originalTrail)
  if (provenance.checkerRecord !== null) trail.push(provenance.checkerRecord)
  trail.push(...projection.retryTrail)
  if (provenance.retryCheckerRecord !== null) trail.push(provenance.retryCheckerRecord)
  for (const message of projection.warnings) warn(rt, warnings, message)

  const value = appendTruncatedClaims(projection.verified, config.claims, keptClaims.length)
  const { nullVoteCount, allNullClaimsCount } = countNullVotes(projection.verified)
  warnForDiagnostics(
    rt, warnings, nullVoteCount, allNullClaimsCount, projection.verified.length,
    projection.flooredCount, config.minValidVotes,
  )

  const stats = buildAdversarialStats(
    config.claims.length,
    agentsSpawned,
    nullVoteCount,
    truncated,
  )
  emitDigest(rt, {
    stage: STAGE,
    ...(config.phase !== undefined ? { phase: config.phase } : {}),
    counts: buildAdversarialCounts(value, config.claims.length),
  })
  return { value, stats, warnings, trail }
}
