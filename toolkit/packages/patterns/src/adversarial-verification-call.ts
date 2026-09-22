import type { EffortAlias, JsonSchema, ModelAlias, WorkflowRuntime } from '@workflow-toolbox/runtime'
import { agentWithSchemaSalvage } from './structured-salvage.js'
import type { StructuredCallOutcome } from './structured-salvage.js'
import type { VerifierVote } from './adversarial-verification.js'

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

export interface VerifierAttempt<TClaim> {
  claim: TClaim
  renderClaim: (claim: TClaim) => string
  lens: string | undefined
  label: string
  phase: string | undefined
  model: ModelAlias
  effort: EffortAlias | undefined
  agentType: string | undefined
}

export function runVerifierAttempt<TClaim>(
  rt: WorkflowRuntime,
  request: VerifierAttempt<TClaim>,
): Promise<StructuredCallOutcome<VerifierVote>> {
  const lensLine = request.lens !== undefined
    ? `\nExamine it through the lens of: ${request.lens}.`
    : ''
  const prompt =
    'Adversarially verify the following claim. Actively try to REFUTE it; ' +
    'default to "refuted" when uncertain.' + lensLine +
    `\nClaim:\n${request.renderClaim(request.claim)}`
  return agentWithSchemaSalvage<VerifierVote>(rt, prompt, {
    schema: VERIFIER_SCHEMA,
    label: request.label,
    ...(request.phase !== undefined ? { phase: request.phase } : {}),
    model: request.model,
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.agentType !== undefined ? { agentType: request.agentType } : {}),
  })
}
