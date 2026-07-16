// @workflow-toolbox/comm — the wt-comm v0 file-message protocol. See ../README.md for the
// normative spec (id grammar, lifecycle outcomes, reader posture, settlement coherence).
// ids: fnv1a32 stays module-internal (an implementation detail of the mint formula);
// fold is public — the teaching pack's mint recipe is specified in terms of it.
export {
  assertSafeMessageId,
  decisionIdFor,
  retryIdFor,
  isValidDecisionId,
  fold,
  mintQuestionId,
  mintDigestId,
} from './ids.js'
export * from './schemas.js'
export * from './paths.js'
// validate: canonicalize stays module-internal (the reader-posture engine behind
// parseMessage — consumers get the posture through the parsers, never raw).
export {
  parseMessage,
  validateDecisionAgainstQuestion,
  validateSettlement,
  parseAckMarker,
  parseSettlementMarker,
} from './validate.js'
export type { ParseFailureReason, ParseMessageResult, SettlementClaim } from './validate.js'
export * from './fs.js'
