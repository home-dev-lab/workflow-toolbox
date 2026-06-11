// @workflow-toolbox/patterns — public API (envelope + 7 patterns)
//
// Naming convention (deliberate, do not "unify"): each pattern speaks its
// DOMAIN language — `claims` (adversarialVerification), `tasks`
// (fanOutAndSynthesize), `angles` (tournament), `items` (classifyAndAct) —
// and caps are named after what they cap (`maxVerifyClaims`, `maxSubtasks`).
// P7/ACI asks for UNAMBIGUOUS names, not uniform ones: domain names tell the
// composition author what the pattern semantically expects; flattening them
// to generic `items` would trade signal for plumbing uniformity.

export type { PatternStats, PatternResult } from './envelope.js'
export { warn, applyCap } from './envelope.js'
export { relativizeUnder } from './paths.js'

export { classifyAndAct } from './classify-and-act.js'
export type { ClassifyAndActOptions, ActionSpec } from './classify-and-act.js'

export { generateAndFilter } from './generate-and-filter.js'
export type { GenerateAndFilterOptions } from './generate-and-filter.js'

export { fanOutAndSynthesize } from './fan-out-and-synthesize.js'
export type { FanOutAndSynthesizeOptions } from './fan-out-and-synthesize.js'

export { adversarialVerification } from './adversarial-verification.js'
export type {
  AdversarialVerificationOptions,
  VerifierVote,
  VerifiedClaim,
  Verdict,
  ClaimVerdict,
} from './adversarial-verification.js'

export { tournament } from './tournament.js'
export type { TournamentOptions, RankedAttempt } from './tournament.js'

export { loopUntilDone } from './loop-until-done.js'
export type {
  LoopUntilDoneOptions,
  LoopStopConditions,
  LoopTick,
  LoopOutcome,
  LoopStoppedBy,
} from './loop-until-done.js'

export { planAndExecute } from './plan-and-execute.js'
export type { PlanAndExecuteOptions, PlannedSubtask } from './plan-and-execute.js'
