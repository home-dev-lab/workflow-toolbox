// Pure human-readable report rendering for a Diagnosis. Kept pure (Diagnosis +
// optional context → string) so it is fully unit-tested; the CLI just prints it.

import type { Diagnosis } from './diagnose.js'

export interface FormatContext {
  /** Absolute path the journal was read from (shown for orientation). */
  journalPath?: string
  /** The session that produced the run (derived from the journal path by the resolver).
   * Surfaced next to the same-session resume warning so the user can check at a glance. */
  sessionId?: string
}

export function formatDiagnosis(d: Diagnosis, ctx: FormatContext = {}): string {
  const lines: string[] = []
  const s = d.stats

  lines.push(`[${d.mode}] ${d.headline}`)
  lines.push(`  run ${s.runId}  ·  workflow ${s.workflowName}  ·  status ${s.status}`)
  lines.push(
    `  agents: ${s.doneAgents} done, ${s.incompleteAgents} incomplete, ${s.retriedAgents} retried` +
      `  ·  ${s.totalTokens.toLocaleString('en-US')} tok  ·  ${s.totalToolCalls} tool calls  ·  ${s.durationMs} ms`,
  )
  if (ctx.journalPath) lines.push(`  journal: ${ctx.journalPath}`)

  if (d.findings.length > 0) {
    lines.push('')
    lines.push('FINDINGS')
    for (const f of d.findings) lines.push(`  - [${f.kind}] ${f.detail}`)
  }

  lines.push('')
  if (d.resume.recommended) {
    lines.push('RESUME — recommended')
    lines.push(`  ${d.resume.rationale}`)
    lines.push(`  Workflow({ scriptPath, resumeFromRunId: "${s.runId}" })`)
    if (d.resume.sameSessionOnly) {
      lines.push(
        ctx.sessionId
          ? `  ⚠ same session only — cache replays only in session ${ctx.sessionId}.`
          : '  ⚠ same session only — cache replays only in the session that produced the run.',
      )
    }
  } else {
    lines.push('RESUME — not recommended')
    lines.push(`  ${d.resume.rationale}`)
  }

  // When the run actually ran agents, point at the sibling cost/traceability tool —
  // dwt:report drills into per-agent cost + opens each agent's transcript. (doneAgents
  // and incompleteAgents partition every agent row, so their sum is the agent count.)
  if (s.doneAgents + s.incompleteAgents > 0) {
    lines.push('')
    lines.push(`for per-agent cost + transcripts: pnpm dwt:report ${s.runId}`)
  }

  return lines.join('\n')
}
