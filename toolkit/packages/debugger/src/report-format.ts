// Pure markdown rendering of an AuditReport — the body of the audit folder's
// report.md. Kept pure (report + optional context → string) so it is fully
// unit-tested; the CLI/writer just persist or print the string.
//
// Honesty contract: an empty decision trail and absent transcripts render as
// explicit lines, and a token mismatch renders a visible caveat — the report
// never implies completeness it does not have.

import type { AuditReport } from './report.js'
import type { AgentUsage } from './transcript-usage.js'

export interface AuditFormatContext {
  /** Absolute path the journal was read from (shown for orientation). */
  journalPath?: string
  /** Caller-injected timestamp string (kept out of the pure layer for determinism). */
  generatedAt?: string
}

function num(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US')
}

function cell(s: string | null): string {
  return s === null || s === '' ? '—' : s
}

/** One token cell: the formatted count, or "—" when this agent had no transcript usage. */
function usageCell(u: AgentUsage | null | undefined, key: keyof AgentUsage): string {
  return u === null || u === undefined ? '—' : num(u[key])
}

export function formatAuditReportMarkdown(r: AuditReport, ctx: AuditFormatContext = {}): string {
  const lines: string[] = []

  lines.push(`# Workflow Audit Report — ${cell(r.workflowName)}`)
  lines.push('')
  lines.push(`- **Run ID:** ${r.runId}`)
  lines.push(`- **Task ID:** ${cell(r.taskId)}`)
  lines.push(`- **Status:** ${cell(r.status)}`)
  lines.push(`- **Duration:** ${num(r.durationMs)} ms`)
  lines.push(`- **Default model:** ${cell(r.defaultModel)}`)
  lines.push(`- **Agents:** ${r.agentCount}`)
  lines.push(`- **Total tokens:** ${num(r.totalTokens)}`)
  lines.push(`- **Total tool calls:** ${num(r.totalToolCalls)}`)
  if (ctx.generatedAt !== undefined) lines.push(`- **Generated:** ${ctx.generatedAt}`)
  if (ctx.journalPath !== undefined) lines.push(`- **Journal:** ${ctx.journalPath}`)

  // Cost by agent
  lines.push('')
  lines.push('## Cost by agent')
  lines.push('')
  if (r.agents.length === 0) {
    lines.push('_No agent activity recorded for this run._')
  } else {
    lines.push('| Stage | Model | Tokens | Tool calls | Phase |')
    lines.push('|-------|-------|-------:|-----------:|-------|')
    for (const a of r.agents) {
      lines.push(`| ${cell(a.label)} | ${cell(a.model)} | ${num(a.tokens)} | ${num(a.toolCalls)} | ${cell(a.phaseTitle)} |`)
    }
  }

  // Token reconciliation
  lines.push('')
  const rec = r.reconciliation
  if (rec.reconciles) {
    lines.push(`**Token reconciliation:** Σ per-agent ${num(rec.perAgentSum)} = total ${num(rec.totalTokens)} ✓`)
  } else {
    const parts = [`⚠ **Token reconciliation: does not reconcile** — Σ per-agent ${num(rec.perAgentSum)} vs total ${num(rec.totalTokens)}`]
    if (rec.delta !== null) parts.push(`(delta ${num(rec.delta)})`)
    if (rec.missingTokenAgents > 0) parts.push(`; ${rec.missingTokenAgents} agent(s) missing token data`)
    lines.push(parts.join(' '))
  }

  // Token usage by agent (from transcripts). Kept SEPARATE from the journal-aggregate "Cost
  // by agent" table above so the two measures are never visually conflated.
  lines.push('')
  lines.push('## Token usage by agent (from transcripts)')
  lines.push('')
  const tb = r.tokenBreakdown
  if (tb === null || tb === undefined) {
    lines.push('_No transcript token usage available (transcripts not captured or pruned)._')
  } else {
    lines.push('| Stage | Input | Output | Cache read | Cache write |')
    lines.push('|-------|------:|-------:|-----------:|------------:|')
    for (const a of r.agents) {
      lines.push(
        `| ${cell(a.label)} | ${usageCell(a.usage, 'inputTokens')} | ${usageCell(a.usage, 'outputTokens')} | ${usageCell(a.usage, 'cacheReadTokens')} | ${usageCell(a.usage, 'cacheCreationTokens')} |`,
      )
    }
    lines.push('')
    lines.push(
      `**Totals (from ${tb.coveredAgents} of ${tb.totalAgents} transcripts):** ` +
        `input ${num(tb.totals.inputTokens)} · output ${num(tb.totals.outputTokens)} · ` +
        `cache-read ${num(tb.totals.cacheReadTokens)} · cache-write ${num(tb.totals.cacheCreationTokens)}`,
    )
    lines.push('')
    lines.push(
      "_These are per-turn billed tokens summed across each agent's tool-use turns — a different " +
        'measure from the journal `Tokens` column above (not reconciled). Cache figures dwarf it ' +
        'because every turn re-bills its cached context._',
    )
  }

  // Decisions
  lines.push('')
  lines.push('## Decisions')
  lines.push('')
  if (r.decisions.length === 0) {
    lines.push('_No structured decision trail recorded for this run._')
  } else {
    lines.push('| Stage | Outcome | Decision | Phase |')
    lines.push('|-------|---------|----------|-------|')
    for (const d of r.decisions) {
      lines.push(`| ${cell(d.stage)} | ${cell(d.outcome)} | ${cell(d.decision)} | ${cell(d.phaseTitle)} |`)
    }
  }

  // Transcripts
  lines.push('')
  lines.push('## Transcripts')
  lines.push('')
  if (r.transcripts.length === 0) {
    lines.push('_No transcripts available (none captured, or pruned by the >30-day cleanup)._')
  } else {
    for (const t of r.transcripts) {
      lines.push(
        t.present
          ? `- ✓ ${t.relativePath}`
          : `- ✗ ${t.relativePath} — not captured (may have been pruned by the >30-day cleanup)`,
      )
    }
  }

  return lines.join('\n') + '\n'
}
