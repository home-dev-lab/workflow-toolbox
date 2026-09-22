import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { makeRecord } from './envelope.js'
import { runVerifierAttempt } from './adversarial-verification-call.js'
import type {
  ClaimVotesRaw,
  ProvenanceResult,
  VerifierRoute,
} from './adversarial-verification-internal.js'
import {
  deriveProvenanceNonce,
  PROVENANCE_CHECK_SUFFIX,
  runProvenanceChecker,
} from './provenance-gate.js'
import type { DelegationExpectation } from './provenance-gate.js'
import type { StructuredCallOutcome } from './structured-salvage.js'
import type { VerifierVote } from './adversarial-verification.js'

interface RetryTarget<TClaim> {
  claim: ClaimVotesRaw<TClaim>
  voteIndex: number
}

function collectRetryTargets<TClaim>(perClaim: Array<ClaimVotesRaw<TClaim>>): Array<RetryTarget<TClaim>> {
  const targets: Array<RetryTarget<TClaim>> = []
  for (const claim of perClaim) {
    for (let voteIndex = 0; voteIndex < claim.votes.length; voteIndex++) {
      if (claim.provenanceDisqualified[voteIndex]) targets.push({ claim, voteIndex })
    }
  }
  return targets
}

async function runRetryBurst<TClaim>(
  rt: WorkflowRuntime,
  route: VerifierRoute<TClaim>,
  targets: Array<RetryTarget<TClaim>>,
): Promise<void> {
  const { config } = route
  const retryRaw = await rt.parallel(targets.map(({ claim, voteIndex }) => {
    const label = `${claim.voteStages[voteIndex]!}:retry`
    claim.retryStages[voteIndex] = label
    return async () => runVerifierAttempt(rt, {
      claim: claim.claim,
      renderClaim: config.renderClaim,
      lens: config.lenses?.[voteIndex],
      label,
      phase: config.phase,
      model: route.effectiveModel,
      effort: config.effort,
      agentType: config.verifierType,
    })
  }))
  targets.forEach((target, index) => {
    const outcome = (retryRaw[index] as StructuredCallOutcome<VerifierVote> | null) ?? null
    const label = target.claim.retryStages[target.voteIndex]!
    target.claim.retryOuts[target.voteIndex] = outcome
    target.claim.retryEffectiveStages[target.voteIndex] = outcome?.salvaged === true
      ? `${label}:salvage`
      : label
  })
}

function applyFirstGate<TClaim>(
  perClaim: Array<ClaimVotesRaw<TClaim>>,
  provenance: Map<string, 'seen' | 'absent' | 'undetermined'>,
): { absent: number; undetermined: number } {
  let absent = 0
  let undetermined = 0
  for (const claim of perClaim) {
    for (let voteIndex = 0; voteIndex < claim.votes.length; voteIndex++) {
      if (claim.votes[voteIndex] === null) continue
      const status = provenance.get(claim.effectiveStages[voteIndex]!) ?? 'undetermined'
      if (status === 'seen') continue
      claim.votes[voteIndex] = null
      claim.provenanceDisqualified[voteIndex] = true
      if (status === 'absent') absent++
      else undetermined++
    }
  }
  return { absent, undetermined }
}

function applyRetryGate<TClaim>(
  targets: Array<RetryTarget<TClaim>>,
  provenance: Map<string, 'seen' | 'absent' | 'undetermined'>,
): { recovered: number; unrecovered: number } {
  let recovered = 0
  let unrecovered = 0
  for (const { claim, voteIndex } of targets) {
    const vote = claim.retryOuts[voteIndex]?.value ?? null
    const status = provenance.get(claim.retryEffectiveStages[voteIndex]!) ?? 'undetermined'
    if (vote !== null && status === 'seen') {
      claim.retryVotes[voteIndex] = vote
      recovered++
    } else {
      if (vote !== null) claim.retryDisqualified[voteIndex] = true
      unrecovered++
    }
  }
  return { recovered, unrecovered }
}

export async function enforceVerifierProvenance<TClaim>(
  rt: WorkflowRuntime,
  route: VerifierRoute<TClaim>,
  expectation: DelegationExpectation | null,
  perClaim: Array<ClaimVotesRaw<TClaim>>,
  emitWarning: (message: string) => void,
): Promise<ProvenanceResult> {
  const empty: ProvenanceResult = {
    checkerRecord: null,
    retryCheckerRecord: null,
    checkerSpawns: 0,
    selfAnswerCount: 0,
    undeterminedFirstPassCount: 0,
    recoveredAfterRetry: 0,
  }
  if (expectation === null) return empty

  const labels = perClaim.flatMap((claim) => claim.effectiveStages)
  if (labels.length === 0) return empty
  const { config } = route
  const checkLabel = route.stage(PROVENANCE_CHECK_SUFFIX)
  const first = await runProvenanceChecker(rt, expectation, labels, {
    label: checkLabel,
    ...(config.phase !== undefined ? { phase: config.phase } : {}),
    model: 'haiku',
    effort: 'low',
    nonce: deriveProvenanceNonce(labels, perClaim.map((claim) => config.renderClaim(claim.claim)).join(' ')),
  })
  const firstCounts = applyFirstGate(perClaim, first.map)
  if (firstCounts.absent > 0) {
    emitWarning(
      `adversarialVerification: ${firstCounts.absent} external verifier votes DISQUALIFIED — ` +
      `no ${expectation.id} CLI invocation found in the vote transcript (possible self-answer); treated as null`,
    )
  }
  if (firstCounts.undetermined > 0) {
    emitWarning(
      `adversarialVerification: ${firstCounts.undetermined} external verifier votes had UNDETERMINED provenance ` +
      `(the checker ${first.replyOk ? 'did not resolve them' : 'failed'}); fail-closed, treated as null`,
    )
  }

  const result: ProvenanceResult = {
    checkerRecord: makeRecord(checkLabel, first.replyOk, { model: 'haiku', effort: 'low' }),
    retryCheckerRecord: null,
    checkerSpawns: 1,
    selfAnswerCount: firstCounts.absent,
    undeterminedFirstPassCount: firstCounts.undetermined,
    recoveredAfterRetry: 0,
  }
  const targets = collectRetryTargets(perClaim)
  if (targets.length === 0) return result

  await runRetryBurst(rt, route, targets)
  const retryLabels = targets.map(({ claim, voteIndex }) => claim.retryEffectiveStages[voteIndex]!)
  const retryCheckLabel = route.stage(`${PROVENANCE_CHECK_SUFFIX}:retry`)
  const retry = await runProvenanceChecker(rt, expectation, retryLabels, {
    label: retryCheckLabel,
    ...(config.phase !== undefined ? { phase: config.phase } : {}),
    model: 'haiku',
    effort: 'low',
    nonce: deriveProvenanceNonce(retryLabels, perClaim.map((claim) => config.renderClaim(claim.claim)).join(' ')),
  })
  const retryCounts = applyRetryGate(targets, retry.map)
  if (retryCounts.recovered > 0) {
    emitWarning(
      `adversarialVerification: ${retryCounts.recovered} gate-nullified verifier votes RECOVERED after one retry ` +
      `(a real ${expectation.id} CLI invocation found on the re-spawn)`,
    )
  }
  if (retryCounts.unrecovered > 0) {
    emitWarning(`adversarialVerification: ${retryCounts.unrecovered} gate-nullified verifier votes remained unrecovered after one retry`)
  }
  result.retryCheckerRecord = makeRecord(retryCheckLabel, retry.replyOk, { model: 'haiku', effort: 'low' })
  result.checkerSpawns++
  result.recoveredAfterRetry = retryCounts.recovered
  return result
}
