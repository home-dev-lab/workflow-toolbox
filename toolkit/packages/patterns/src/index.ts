// @workflow-toolbox/patterns — public API (envelope + 9 patterns)
//
// Naming convention (deliberate, do not "unify"): each pattern speaks its
// DOMAIN language — `claims` (adversarialVerification), `tasks`
// (fanOutAndSynthesize), `angles` (tournament), `items` (classifyAndAct),
// `chunks` (chunkedAnalysis) — and caps are named after what they cap
// (`maxVerifyClaims`, `maxSubtasks`, `maxChunks`).
// P7/ACI asks for UNAMBIGUOUS names, not uniform ones: domain names tell the
// composition author what the pattern semantically expects; flattening them
// to generic `items` would trade signal for plumbing uniformity.

export type { PatternStats, PatternResult, TrailRecord } from './envelope.js'
export { warn, applyCap, emitDigest, collectTrail, makeRecord } from './envelope.js'
export { relativizeUnder } from './paths.js'

export { probeAgentType } from './probe-agent-type.js'
export type { AgentTypeProbe, AgentTypeProbeReport, ProbeAgentTypeOptions } from './probe-agent-type.js'

export { withLeafFence, LEAF_AGENT_TYPE } from './leaf-fence.js'
export type { WithLeafFenceOptions, LeafFenceReport } from './leaf-fence.js'

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

export { scoreAndRank } from './score-and-rank.js'
export type {
  ScoreAndRankOptions,
  ScoreDimension,
  ScoreCutoff,
  ScoredItem,
} from './score-and-rank.js'

export { chunkedAnalysis, chunkText } from './chunked-analysis.js'
export type {
  ChunkedAnalysisOptions,
  ChunkedAnalysisResult,
  ChunkingOptions,
} from './chunked-analysis.js'
