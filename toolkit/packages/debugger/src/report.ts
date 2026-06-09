// PURE audit-report builder: a workflow RUN JOURNAL → an AuditReport model an
// enterprise auditor can read (cost, decisions, transcript pointers). Pure by
// contract — journal in, model out, ZERO IO — so it is fully unit-tested; the
// impure layer (audit-folder.ts / report-cli.ts) does the filesystem work and
// injects the transcript-existence signal.
//
// Honesty contract (plan F1/F3, verified against real journals):
//   - Decisions come from the ALWAYS-PRESENT workflowProgress[] agent rows,
//     enriched best-effort by result.envelope.trail (matched by stage===label).
//     The top-level `logs` array is NOT a decision source (verified empty / dead).
//   - When neither agents nor a trail yield anything, `decisions` is an explicit
//     empty list — the formatter says so rather than implying a complete trail.
//   - Per-agent tokens are reconciled against totalTokens; a mismatch (or any
//     agent with undefined tokens) is surfaced, never silently hidden.

import { agentEvents, type WorkflowJournal } from './journal.js'
import { addUsage, emptyUsage, type AgentUsage } from './transcript-usage.js'
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
}

export interface BuildReportOptions {
  /** agentIds whose `agent-<id>.jsonl` transcript exists on disk (injected by the
   * impure caller; the builder stays pure). Absent → all links marked not-present. */
  presentTranscripts?: Set<string>
  /** Per-agent billed token usage parsed from transcripts, keyed by agentId (injected by the
   * impure caller — keep the builder pure). The caller MUST only include agents with non-empty
   * usage, so an entry's presence == that agent counts toward coverage. */
  usageByAgent?: Map<string, AgentUsage>
}

interface TrailEnrichment {
  outcome: string | null
  decision: string | null
}

/** Index result.envelope.trail by `stage`, tolerant of any non-envelope result shape. */
function readEnvelopeTrail(result: unknown): Map<string, TrailEnrichment> {
  const map = new Map<string, TrailEnrichment>()
  if (!isRecord(result)) return map
  const envelope = result['envelope']
  if (!isRecord(envelope)) return map
  const trail = envelope['trail']
  if (!Array.isArray(trail)) return map
  for (const entry of trail) {
    if (!isRecord(entry)) continue
    const stage = strOrNull(entry['stage'])
    if (stage === null) continue
    map.set(stage, { outcome: strOrNull(entry['outcome']), decision: strOrNull(entry['decision']) })
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
  }
}
