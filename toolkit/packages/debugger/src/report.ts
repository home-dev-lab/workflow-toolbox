// PURE audit-report builder: a workflow RUN JOURNAL → an AuditReport model an
// enterprise auditor can read (cost, decisions, transcript pointers). Pure by
// contract — journal in, model out, ZERO IO — so it is fully unit-tested; the
// impure layer (audit-folder.ts / report-cli.ts) does the filesystem work and
// injects the transcript-existence signal.
//
// Honesty contract (plan F1/F3, verified against real journals):
//   - Decisions come from the ALWAYS-PRESENT workflowProgress[] agent rows,
//     enriched best-effort by result.envelope.trail (matched by stage===label).
//     The top-level `logs` array (rt.log narrator lines) is NOT a decision source
//     here — it is unstructured progress text, captured separately by observe's
//     journalToPatches as run.log entries. (Most runs leave it absent/empty; the
//     audit report intentionally ignores it rather than mining free-form strings.)
//   - When neither agents nor a trail yield anything, `decisions` is an explicit
//     empty list — the formatter says so rather than implying a complete trail.
//   - Per-agent tokens are reconciled against totalTokens; a mismatch (or any
//     agent with undefined tokens) is surfaced, never silently hidden.

import { agentEvents, type WorkflowJournal } from './journal.js'
import {
  addUsage,
  buildCompactionReport,
  emptyCompactionReport,
  emptyUsage,
  type AgentUsage,
  type CompactionReport,
  type TranscriptCompaction,
} from './transcript-usage.js'
import {
  buildToolDenialReport,
  emptyDenialReport,
  type ToolDenial,
  type ToolDenialReport,
} from './tool-denial.js'
import {
  buildExternalDelegationReport,
  emptyExternalDelegationReport,
  type DelegationScan,
  type DelegationScanInput,
  type ExternalDelegationReport,
} from './external-delegation.js'
import { isRecord, numOrNull, strOrNull } from '@workflow-toolbox/std'

/** One agent's cost line, projected from a workflow_agent row. */
export interface AgentCostRow {
  label: string
  agentId: string | null
  model: string | null
  tokens: number | null
  toolCalls: number | null
  phaseTitle: string | null
  state: string | null
  /** Billed token usage summed from this agent's transcript, injected by the impure caller
   *  (null when no transcript was present/parsed). Optional so existing literal test fixtures
   *  need not provide it; the builder always sets it. Distinct from `tokens` (a journal
   *  aggregate) — never reconciled against it. */
  usage?: AgentUsage | null
}

/** Run-level transcript token rollup: totals summed over the agents whose transcripts were
 *  parsed, plus honest coverage (how many of the identifiable agents contributed). */
export interface TokenBreakdown {
  totals: AgentUsage
  /** Distinct identifiable agents that contributed transcript usage. */
  coveredAgents: number
  /** Distinct identifiable agents (rows with a non-null agentId) — the coverage denominator. */
  totalAgents: number
}

/** Whether the per-agent token sum matches the journal's authoritative total. */
export interface TokenReconciliation {
  perAgentSum: number
  totalTokens: number | null
  /** True only when totalTokens is known, every agent reported tokens, and the sum matches. */
  reconciles: boolean
  /** totalTokens - perAgentSum, or null when totalTokens is absent. */
  delta: number | null
  /** Count of agent rows missing a numeric `tokens` field. */
  missingTokenAgents: number
}

/** One recorded step: an agent row, enriched with any envelope.trail decision. */
export interface DecisionEntry {
  stage: string
  outcome: string | null
  decision: string | null
  phaseTitle: string | null
  /** Explicit model override the pattern recorded for this stage (trail), else null.
   *  Optional so existing literal test fixtures need not provide it; the builder always
   *  sets it. */
  model?: string | null
  /** Explicit effort override the pattern recorded for this stage (trail), else null.
   *  Optional for the same fixture reason; the builder always sets it. */
  effort?: string | null
}

/** A best-effort pointer to one agent's transcript inside the audit folder. */
export interface TranscriptLink {
  agentId: string
  relativePath: string
  present: boolean
}

export interface AuditReport {
  runId: string
  taskId: string | null
  workflowName: string | null
  status: string | null
  durationMs: number | null
  defaultModel: string | null
  agentCount: number
  totalTokens: number | null
  totalToolCalls: number | null
  agents: AgentCostRow[]
  reconciliation: TokenReconciliation
  decisions: DecisionEntry[]
  transcripts: TranscriptLink[]
  /** Transcript-summed token rollup (input/output/cache), or null when no transcript usage
   *  was injected/available. Optional so existing literal test fixtures need not provide it;
   *  the builder always sets it. */
  tokenBreakdown?: TokenBreakdown | null
  /** Tool calls silently denied across the run's agents (degraded-run signal). Optional so
   *  existing literal test fixtures need not provide it; the builder always sets it (an empty
   *  report when no denial data was injected). */
  denials?: ToolDenialReport
  /** Agents that auto-compacted at their context ceiling (ADVISORY signal — softer than denials;
   *  the run still succeeded). Optional so existing literal test fixtures need not provide it; the
   *  builder always sets it (an empty report when no compaction data was injected). */
  compaction?: CompactionReport
  /** External-delegation compliance: agents routed to an external agentType that show NO real
   *  external-CLI invocation may have SELF-ANSWERED (same-family output presented as external).
   *  Optional so existing literal test fixtures need not provide it; the builder always sets it
   *  (an empty report when no delegation data was injected). */
  delegation?: ExternalDelegationReport
}

export interface BuildReportOptions {
  /** agentIds whose `agent-<id>.jsonl` transcript exists on disk (injected by the
   * impure caller; the builder stays pure). Absent → all links marked not-present. */
  presentTranscripts?: Set<string>
  /** Per-agent billed token usage parsed from transcripts, keyed by agentId (injected by the
   * impure caller — keep the builder pure). The caller MUST only include agents with non-empty
   * usage, so an entry's presence == that agent counts toward coverage. */
  usageByAgent?: Map<string, AgentUsage>
  /** Per-agent tool denials parsed from transcripts, keyed by agentId (injected by the impure
   * caller). Absent → an empty denial report. The builder resolves each denial's phase label
   * from the journal's agent rows before rolling them up. */
  denialsByAgent?: Map<string, ToolDenial[]>
  /** Per-agent auto-compaction parsed from transcripts, keyed by agentId (injected by the impure
   * caller). Absent → an empty compaction report. The builder resolves each agent's phase label
   * from the journal's rows before rolling them up. */
  compactionByAgent?: Map<string, TranscriptCompaction>
  /** Per-agent external delegation read from the `agent-<id>.meta.json` sidecars (injected by
   * the impure caller). `scan` is the external-CLI invocation scan, null when the agentType has
   * no registered signature. Absent → an empty delegation report. The builder resolves each
   * agent's phase label from the journal's rows before rolling them up. */
  delegationByAgent?: Map<string, DelegationScan>
}

interface TrailEnrichment {
  outcome: string | null
  decision: string | null
  model: string | null
  effort: string | null
}

/** Index result.envelope.trail by `stage`, tolerant of any non-envelope result shape.
 *  CONFLICT-AWARE (same class as the observe-side effort-attribution HIGH): pattern stage
 *  strings carry no per-invocation salt, so a pattern invoked twice in one composition
 *  emits identical stages — the old unguarded set() enriched Decisions with the LAST
 *  call's entry. A stage recurring with DIFFERENT enrichment values is dropped entirely
 *  (ambiguous attribution — no enrichment beats a wrong one); recurring identically stays. */
function readEnvelopeTrail(result: unknown): Map<string, TrailEnrichment> {
  const map = new Map<string, TrailEnrichment>()
  const conflicted = new Set<string>()
  if (!isRecord(result)) return map
  const envelope = result['envelope']
  if (!isRecord(envelope)) return map
  const trail = envelope['trail']
  if (!Array.isArray(trail)) return map
  for (const entry of trail) {
    if (!isRecord(entry)) continue
    const stage = strOrNull(entry['stage'])
    if (stage === null || conflicted.has(stage)) continue
    const enrichment: TrailEnrichment = {
      outcome: strOrNull(entry['outcome']),
      decision: strOrNull(entry['decision']),
      model: strOrNull(entry['model']),
      effort: strOrNull(entry['effort']),
    }
    const seen = map.get(stage)
    if (seen === undefined) {
      map.set(stage, enrichment)
    } else if (
      seen.outcome !== enrichment.outcome ||
      seen.decision !== enrichment.decision ||
      seen.model !== enrichment.model ||
      seen.effort !== enrichment.effort
    ) {
      map.delete(stage)
      conflicted.add(stage)
    }
  }
  return map
}

/**
 * Build the audit report for a parsed workflow journal. Never throws: every field is
 * read defensively and degrades to null / an empty list on a sparse or odd journal.
 */
export function buildAuditReport(journal: WorkflowJournal, opts: BuildReportOptions = {}): AuditReport {
  const present = opts.presentTranscripts ?? new Set<string>()
  const usageByAgent = opts.usageByAgent
  const events = agentEvents(journal)
  const trail = readEnvelopeTrail(journal.result)

  const agents: AgentCostRow[] = events.map((a) => {
    const agentId = strOrNull(a.agentId)
    return {
      label: strOrNull(a.label) ?? '(unlabeled)',
      agentId,
      model: strOrNull(a.model),
      tokens: numOrNull(a.tokens),
      toolCalls: numOrNull(a.toolCalls),
      phaseTitle: strOrNull(a.phaseTitle),
      state: strOrNull(a.state),
      usage: agentId !== null && usageByAgent ? (usageByAgent.get(agentId) ?? null) : null,
    }
  })

  // Roll transcript usage over DISTINCT identifiable agentIds (not over rows) so a duplicate
  // or retried agentId can never double-count. coveredAgents = ids with usage; totalAgents =
  // identifiable rows (null-id agents can never be covered, so they don't inflate the
  // denominator). Null when nothing was injected/covered → the formatter says so.
  let tokenBreakdown: TokenBreakdown | null = null
  if (usageByAgent && usageByAgent.size > 0) {
    const identifiableIds = new Set(
      agents.map((a) => a.agentId).filter((id): id is string => id !== null),
    )
    let totals = emptyUsage()
    let coveredAgents = 0
    for (const id of identifiableIds) {
      const u = usageByAgent.get(id)
      if (u) {
        totals = addUsage(totals, u)
        coveredAgents++
      }
    }
    if (coveredAgents > 0) tokenBreakdown = { totals, coveredAgents, totalAgents: identifiableIds.size }
  }

  // Decisions: one per agent row (the executed steps), enriched by the trail when the
  // stage matches the label. No agent rows → [] (the formatter then says "no structured
  // decision trail"); a trail-only path is deliberately omitted as speculative — no
  // realistic journal has zero agents yet a populated envelope trail.
  const decisions: DecisionEntry[] = agents.map((a) => {
    const enr = trail.get(a.label)
    return {
      stage: a.label,
      // Merge precedence: a trail outcome wins; when the trail says nothing (no entry,
      // or an entry without an `outcome` string) we derive it from the agent state —
      // "ok" for a done agent is more informative than a deliberately-null trail outcome.
      outcome: enr?.outcome ?? (a.state === 'done' ? 'ok' : a.state),
      decision: enr?.decision ?? null,
      phaseTitle: a.phaseTitle,
      model: enr?.model ?? null,
      effort: enr?.effort ?? null,
    }
  })

  const tokensWithValue = agents.filter((a) => a.tokens !== null)
  const perAgentSum = tokensWithValue.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
  const totalTokens = numOrNull(journal.totalTokens)
  const missingTokenAgents = agents.length - tokensWithValue.length
  const reconciliation: TokenReconciliation = {
    perAgentSum,
    totalTokens,
    reconciles: totalTokens !== null && missingTokenAgents === 0 && perAgentSum === totalTokens,
    delta: totalTokens !== null ? totalTokens - perAgentSum : null,
    missingTokenAgents,
  }

  const transcripts: TranscriptLink[] = agents
    .filter((a): a is AgentCostRow & { agentId: string } => a.agentId !== null)
    .map((a) => ({
      agentId: a.agentId,
      relativePath: `transcripts/agent-${a.agentId}.jsonl`,
      present: present.has(a.agentId),
    }))

  // agentId → phase label, resolved once from the journal rows and shared by the denial and
  // compaction rollups below (both enrich transcript-derived signals with the run-phase label).
  const labelById = new Map<string, string>()
  for (const a of agents) if (a.agentId !== null) labelById.set(a.agentId, a.label)

  // Tool denials: enrich each injected denial with its agent's phase label, then roll up.
  // No injection → an explicit empty report (degraded: false).
  let denials: ToolDenialReport = emptyDenialReport()
  if (opts.denialsByAgent && opts.denialsByAgent.size > 0) {
    const enriched: ToolDenial[][] = []
    for (const [agentId, list] of opts.denialsByAgent) {
      const label = labelById.get(agentId)
      enriched.push(label === undefined ? list : list.map((d) => ({ ...d, label })))
    }
    denials = buildToolDenialReport(enriched)
  }

  // Auto-compaction (ADVISORY): enrich each injected agent's compaction with its phase label, then
  // roll up. No injection → an explicit empty report (compacted: false).
  let compaction: CompactionReport = emptyCompactionReport()
  if (opts.compactionByAgent && opts.compactionByAgent.size > 0) {
    const enriched: { agentId: string; label?: string; compaction: TranscriptCompaction }[] = []
    for (const [agentId, c] of opts.compactionByAgent) {
      const label = labelById.get(agentId)
      enriched.push(label === undefined ? { agentId, compaction: c } : { agentId, label, compaction: c })
    }
    compaction = buildCompactionReport(enriched)
  }

  // External delegation: enrich each injected agent's delegation with its phase label, then
  // roll up. No injection → an explicit empty report (flagged: false).
  let delegation: ExternalDelegationReport = emptyExternalDelegationReport()
  if (opts.delegationByAgent && opts.delegationByAgent.size > 0) {
    const inputs: DelegationScanInput[] = []
    for (const [agentId, d] of opts.delegationByAgent) {
      const label = labelById.get(agentId)
      inputs.push(
        label === undefined
          ? { agentId, agentType: d.agentType, scan: d.scan }
          : { agentId, label, agentType: d.agentType, scan: d.scan },
      )
    }
    delegation = buildExternalDelegationReport(inputs)
  }

  return {
    runId: journal.runId,
    taskId: strOrNull(journal.taskId),
    workflowName: strOrNull(journal.workflowName),
    status: strOrNull(journal.status),
    durationMs: numOrNull(journal.durationMs),
    defaultModel: strOrNull(journal.defaultModel),
    agentCount: agents.length,
    totalTokens,
    totalToolCalls: numOrNull(journal.totalToolCalls),
    agents,
    reconciliation,
    decisions,
    transcripts,
    tokenBreakdown,
    denials,
    compaction,
    delegation,
  }
}
