// @workflow-toolbox/debugger — diagnose a Claude Code Workflow run from its on-disk journal and
// recommend a resumeFromRunId fix. Pure, journal-first analysis core.
export {
  parseJournal,
  agentEvents,
  doneAgents,
  incompleteAgents,
  retriedAgents,
  type WorkflowJournal,
  type WorkflowAgentEvent,
  type WorkflowPhaseEvent,
  type WorkflowProgressEvent,
  type WorkflowStatus,
} from './journal.js'
export {
  diagnoseRun,
  type Diagnosis,
  type DiagnosisMode,
  type DiagnosisStats,
  type Finding,
  type FindingKind,
  type ResumeRecommendation,
} from './diagnose.js'
export { formatDiagnosis, type FormatContext } from './format.js'
export {
  buildAuditReport,
  type AuditReport,
  type AgentCostRow,
  type TokenReconciliation,
  type DecisionEntry,
  type TranscriptLink,
  type BuildReportOptions,
} from './report.js'
export { formatAuditReportMarkdown, type AuditFormatContext } from './report-format.js'
// The main barrel exposes only the result-shape TYPES (consumers read `AuditReport.denials`).
// The pure scanner FUNCTIONS (classifyDenial / parseTranscriptDenials / buildToolDenialReport /
// emptyDenialReport) live behind the dedicated `@workflow-toolbox/debugger/tool-denial` subpath —
// consumed by @workflow-toolbox/observe's ingest + the observe-ui pipeline view — so they're
// reachable without widening this main entry (which stays the result-shape contract).
export type { DenialKind, DenialRecovery, ToolDenial, ToolDenialReport } from './tool-denial.js'
// Same split for external delegation: types here, the pure scanner functions
// (expectationForAgentType / isExternalCliCommand / parseTranscriptExternalCalls /
// buildExternalDelegationReport / emptyExternalDelegationReport) behind
// `@workflow-toolbox/debugger/external-delegation` — consumed by the observe-ui agent panel.
export type {
  AgentDelegation,
  DelegationExpectation,
  DelegationScan,
  DelegationScanInput,
  ExternalCallScan,
  ExternalDelegationReport,
  UnknownDelegation,
} from './external-delegation.js'
export type { CompactionReport, CompactionAgent, CompactionEvent } from './transcript-usage.js'
