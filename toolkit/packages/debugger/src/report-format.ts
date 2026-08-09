// Pure markdown rendering of an AuditReport — the body of the audit folder's
// report.md. Kept pure (report + optional context → string) so it is fully
// unit-tested; the CLI/writer just persist or print the string.
//
// Honesty contract: an empty decision trail and absent transcripts render as
// explicit lines, and a token mismatch renders a visible caveat — the report
// never implies completeness it does not have.

import type { AuditReport } from './report.js'
import type { AgentUsage } from './transcript-usage.js'
import { recoveryVias } from './tool-denial.js'

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
  if (s === null || s === '') return '—'
  // Escape the markdown table delimiter so untrusted content (e.g. a denied Bash command
  // containing a pipe — very common) cannot inject extra columns and corrupt / mask a row.
  return s.replace(/\|/g, '\\|')
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

  // Tool denials (degraded-run signal) — surfaced right after the summary so a blind run is
  // the first thing the reader sees, not buried below the cost tables.
  lines.push('')
  lines.push('## Tool denials')
  lines.push('')
  const den = r.denials
  if (den === undefined || den.total === 0) {
    lines.push('_No tool denials detected — no agent was blocked from a tool it asked for._')
  } else {
    const groups = den.bySignature.map((g) => `${g.signature} ×${g.count}`).join(', ')
    // Recovery-awareness (denied+recovered ≠ denied+blind): when every denial carries a
    // recovery signal, the banner names the recovery instead of claiming blindness — the
    // per-denial table below still lists everything (annotate, never suppress).
    if (den.allRecovered) {
      const vias = recoveryVias(den).join(', ')
      lines.push(
        `⚠ **${den.total} tool call(s) DENIED across ${den.agentsAffected} agent(s) — ALL show a RECOVERY ` +
          `signal** (the agent later succeeded via ${vias}): ${groups}. ` +
          'Verify the recovery covered the same intent.',
      )
    } else {
      lines.push(
        `⚠ **${den.total} tool call(s) DENIED across ${den.agentsAffected} agent(s)** — this run may be ` +
          `DEGRADED (an agent silently could not use a tool it asked for): ${groups}.` +
        (den.recoveredCount > 0 ? ` ${den.recoveredCount} of ${den.total} show a recovery signal.` : ''),
      )
    }
    lines.push('')
    lines.push('| Stage | Tool | Attempted | Denial | Reason | Recovered |')
    lines.push('|-------|------|-----------|--------|--------|-----------|')
    for (const d of den.denials) {
      lines.push(
        `| ${cell(d.label ?? null)} | ${cell(d.tool)} | ${cell(d.detail || null)} | ${cell(d.kind)} | ${cell(d.reason)} | ${
          d.recovered !== undefined ? `via ${cell(d.recovered.via)}` : '—'
        } |`,
      )
    }
  }

  // External delegation (compliance signal — same severity family as denials). An agent routed
  // to an external agentType that never invoked the external CLI may have SELF-ANSWERED: its
  // output is then same-family (Claude) presented as external. The entry probe can't catch this
  // (availability ≠ per-call compliance), so the transcript scan here is the mechanical net.
  // Report-only: it flags, it never gates.
  lines.push('')
  lines.push('## External delegation')
  lines.push('')
  const del = r.delegation
  if (del === undefined || (del.delegatedAgents === 0 && del.unknown.length === 0)) {
    lines.push('_No external delegation requested — no agent ran under an external agentType._')
  } else {
    if (del.flagged) {
      lines.push(
        `⚠ **${del.withoutCli.length} of ${del.delegatedAgents} delegated agent(s) show NO external-CLI ` +
          `tool_use** — the wrapper may have SELF-ANSWERED (output is same-family, presented as external). ` +
          'Verify from the agent transcript before trusting these outputs as decorrelated.',
      )
    } else if (del.delegatedAgents > 0) {
      lines.push(
        `✓ ${del.delegatedAgents} delegated agent(s) — every one shows a real external-CLI invocation.`,
      )
    }
    if (del.agents.length > 0) {
      lines.push('')
      lines.push('| Stage | Agent type | CLI | Calls | First command |')
      lines.push('|-------|-----------|-----|------:|---------------|')
      for (const a of del.agents) {
        lines.push(
          `| ${cell(a.label ?? null)} | ${cell(a.agentType)} | ${a.cliSeen ? '✓' : '⚠ NONE'} | ${a.cliCalls} | ${cell(a.firstCommand)} |`,
        )
      }
    }
    if (del.unknown.length > 0) {
      lines.push('')
      lines.push(
        `ℹ ${del.unknown.length} delegation(s) to agentType(s) with no registered CLI signature — ` +
          `compliance not judged: ${del.unknown.map((u) => u.agentType).join(', ')}.`,
      )
    }
  }

  // Auto-compaction (ADVISORY — softer than the tool-denial DEGRADED signal above). The run
  // SUCCEEDED, but an agent reached its context limit mid-run and summarized history away, so its
  // later output rests on a lossy recall. Surfaced as guidance to re-scope (fan out more / read less
  // per agent), NOT as a failure — hence ℹ, never ⚠/DEGRADED.
  //
  // NO hardcoded window size: an agent's context limit is model-dependent (Haiku/Sonnet-default
  // ~200k, Opus / Sonnet-1M / next-gen ~1M) and the compact_boundary event does NOT carry it — so
  // we surface only the MEASURED peak (preTokens), which IS the effective ceiling that agent hit.
  // This also keeps the advisory correct for an external/agentic subagent whose window differs.
  lines.push('')
  lines.push('## Auto-compaction')
  lines.push('')
  const comp = r.compaction
  if (comp === undefined || comp.agentsCompacted === 0) {
    lines.push('_No agent compacted its context — every agent stayed within its window._')
  } else {
    lines.push(
      `ℹ **${comp.agentsCompacted} agent(s) compacted their context** (peak ~${num(comp.peakTokens)} tokens) — an ` +
        `agent's context window filled up mid-run, so Claude Code auto-compacted it: the earliest ` +
        `~${num(comp.droppedTokens)} tokens of its history were replaced with a short summary. The agent then kept ` +
        `working from that summary instead of the original detail, so anything it produced afterward may be less ` +
        `accurate. The run still SUCCEEDED — a heads-up to fan out more / read less per agent, not a failure.`,
    )
    lines.push('')
    lines.push('| Stage | Peak tokens | Dropped | Trigger |')
    lines.push('|-------|------------:|--------:|---------|')
    for (const a of comp.agents) {
      lines.push(`| ${cell(a.label ?? null)} | ${num(a.peakTokens)} | ${num(a.droppedTokens)} | ${cell(a.trigger)} |`)
    }
  }

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
    lines.push('| Stage | Outcome | Decision | Model | Effort | Phase |')
    lines.push('|-------|---------|----------|-------|--------|-------|')
    for (const d of r.decisions) {
      lines.push(
        `| ${cell(d.stage)} | ${cell(d.outcome)} | ${cell(d.decision)} | ${cell(d.model ?? null)} | ${cell(d.effort ?? null)} | ${cell(d.phaseTitle)} |`,
      )
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
          // Deliberately names NO cause. The report has no run timestamp, so it cannot tell a
          // pruned transcript (>30-day cleanup) from one that never existed — an agent whose
          // call errored before writing anything leaves the same absence. Naming the cleanup
          // here told readers a specific, plausible, wrong cause on minutes-old runs.
          : `- ✗ ${t.relativePath} — not captured (no transcript file; cause not recorded)`,
      )
    }
  }

  return lines.join('\n') + '\n'
}
