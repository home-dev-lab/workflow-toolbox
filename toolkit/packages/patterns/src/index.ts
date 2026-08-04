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
export { reducedLenses } from './reduced-lenses.js'
export { untrusted, renderSourceRefs } from './untrusted.js'
export type { RenderSourceRefsOptions } from './untrusted.js'

export {
  agentWithSchemaSalvage,
  describeSchemaConstraints,
  extractJsonObject,
  validateAgainstSchema,
  repairToSchema,
} from './structured-salvage.js'
export type { StructuredCallOutcome, SchemaViolation } from './structured-salvage.js'

export { autoSelectEffort, deterministicEffortOf } from './auto-effort.js'
export type { AutoSelectEffortOptions, AutoSelectEffortResult, EffortSignals, EffortWorkItem } from './auto-effort.js'

export { probeAgentType } from './probe-agent-type.js'
export type { AgentTypeProbe, AgentTypeProbeReport, ProbeAgentTypeOptions } from './probe-agent-type.js'

// isExternalBridgeType is the SINGLE source of truth for "is this agentType
// an external CLI bridge (opencode/codex family), not a Claude specialist" —
// adversarialVerification's own haiku-vs-BEST_MODEL fan decision already
// keys off the SAME registry (adversarial-verification.ts:376,390, via the
// richer `externalGateExpectation`, kept un-exported here — its expectation
// record is provenance-gate's own internal contract, not a public
// commitment). Exported at the package root (card #1826112535493871358) so a
// composition author outside this package can reuse the SAME discriminator
// instead of hand-rolling a second, driftable registry of bridge names —
// deliberately the narrow boolean, minimal public surface.
export { isExternalBridgeType } from './provenance-gate.js'

export { withLeafFence, LEAF_AGENT_TYPE } from './leaf-fence.js'
export type { WithLeafFenceOptions, LeafFenceReport } from './leaf-fence.js'

export { withLeanRouting, LEAN_AGENT_TYPE } from './lean-routing.js'
export type { WithLeanRoutingOptions, LeanRoutingReport } from './lean-routing.js'

export { classifyAndAct } from './classify-and-act.js'
export type { ClassifyAndActOptions, ActionSpec } from './classify-and-act.js'

export { dagExecute } from './dag-execute.js'
export type { DagNode, DagExecuteOptions, DagNodeResult, DagExecuteResult } from './dag-execute.js'

export { serializeDagArtifact, parseDagArtifact } from './dag-artifact.js'
export type { DagArtifact, DagArtifactNode, SerializeDagArtifactInput } from './dag-artifact.js'

export { describeBudgetedShape, budgetTotals, makeBudgetedShape } from './budgeted-shape.js'
export type { BudgetedStage, BudgetedShape } from './budgeted-shape.js'

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
