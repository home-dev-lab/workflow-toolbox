// PURE rendering of the Stop-hook output for one or more finished workflow runs.
// Implements the HYBRID surfacing the user chose: ALWAYS a `systemMessage` notice; a
// `decision:"block"` + compact `reason` ONLY when the run looks like trouble. Block is
// driven by a POSITIVE trouble set (never by negating completed-ok — a journal read a
// beat early reads `in-progress`, which must NOT block). No IO — unit-tested; the
// impure entry feeds it the parsed journal's report + diagnosis.

import type { AuditReport } from './report.js'
import type { Diagnosis, DiagnosisMode } from './diagnose.js'
import { recoveryVias } from './tool-denial.js'

/** Trouble = a conclusive failure mode that warrants grabbing Claude. `completed-ok`
 * and the inconclusive `in-progress` are NOT trouble. */
export function isTrouble(mode: DiagnosisMode): boolean {
  return mode === 'agent-died' || mode === 'script-throw' || mode === 'schema-retries'
}

export interface StopSurface {
  systemMessage: string
  block: boolean
  reason: string
}

export interface SurfaceDecision {
  surface: 'full' | 'provisional' | 'none'
  block: boolean
  /** True once the run is resolved for good (delivered, or given up after MAX tries) —
   * the caller then records it as reported and stops re-evaluating it. */
  conclusive: boolean
}

/**
 * Decide what to emit for a completion candidate, given its diagnosis (or null when the
 * journal is not yet readable) and how many Stops we've now tried to resolve it.
 *  - parsed + not in-progress → full report, block iff trouble, conclusive.
 *  - missing / unparseable / in-progress → a one-time provisional notice, never block;
 *    conclusive only once `tries` hits MAX (so we never retry a vanished run forever).
 */
export function decideSurface(diagnosis: Diagnosis | null, tries: number, max = 3): SurfaceDecision {
  if (diagnosis !== null && diagnosis.mode !== 'in-progress') {
    return { surface: 'full', block: isTrouble(diagnosis.mode), conclusive: true }
  }
  return { surface: tries <= 1 ? 'provisional' : 'none', block: false, conclusive: tries >= max }
}

function tok(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US')
}

function cell(s: string | null): string {
  return s === null || s === '' ? '—' : s
}

export interface FullSurfaceInput {
  runId: string
  report: AuditReport
  diagnosis: Diagnosis
  /** Absolute audit-folder path when one was written, else null. */
  diskDir: string | null
}

/** A finished run with a readable journal: the always-on notice, plus a compact reason fed back
 * to Claude when the run is trouble OR DEGRADED (any tool call was silently denied — a blind
 * review/plan/impl looks `completed-ok` in the journal, so denials are an independent block
 * trigger on top of `isTrouble`). Auto-compaction adds a softer ADVISORY suffix to the notice
 * (an agent over-scoped and summarized history away — the run still succeeded) but, unlike a
 * denial, NEVER blocks: it is guidance to re-scope, not a degraded-output warning. */
export function buildFullSurface(input: FullSurfaceInput): StopSurface {
  const { runId, report, diagnosis, diskDir } = input
  const trouble = isTrouble(diagnosis.mode)
  const degraded = report.denials?.degraded ?? false
  const compacted = report.compaction?.compacted ?? false
  // Same severity family as a denial: a delegated agent with NO external-CLI call may have
  // self-answered, so the "external" verdicts may be same-family — degraded-output class.
  const selfAnswered = report.delegation?.flagged ?? false
  const block = trouble || degraded || selfAnswered // compaction is advisory-only — deliberately NOT a block trigger

  let notice =
    `DWT audit · ${runId} (${cell(report.workflowName)}) ${cell(report.status)} · ` +
    `${report.agentCount} agents · ${tok(report.totalTokens)} tok · ${report.decisions.length} decisions ` +
    `→ pnpm wt:report ${runId}` +
    (diskDir !== null ? ` · written to ${diskDir}` : '')
  if (degraded && report.denials) {
    notice += ` · ⚠ ${report.denials.total} tool denial(s)/${report.denials.agentsAffected} agent(s)`
  }
  if (selfAnswered && report.delegation) {
    notice += ` · ⚠ ${report.delegation.withoutCli.length}/${report.delegation.delegatedAgents} delegated agent(s) NO external CLI`
  }
  if (compacted && report.compaction) {
    notice += ` · ℹ ${report.compaction.agentsCompacted} agent(s) compacted context (peak ~${tok(report.compaction.peakTokens)} tok)`
  }

  if (!block) return { systemMessage: notice, block: false, reason: '' }

  const lines: string[] = []
  if (trouble) {
    const recon = report.reconciliation
    const reconNote = recon.reconciles
      ? 'reconciled'
      : `UNRECONCILED (Δ ${recon.delta === null ? '—' : recon.delta.toLocaleString('en-US')}, ` +
        `${recon.missingTokenAgents} agent(s) missing tokens)`
    lines.push(`⚠ Workflow run ${runId} (${cell(report.workflowName)}) needs attention — ${diagnosis.headline}`)
    lines.push(
      `cost: ${report.agentCount} agents · ${tok(report.totalTokens)} tok (${reconNote}) · ${tok(report.totalToolCalls)} tool calls`,
    )
    if (diagnosis.findings.length > 0) {
      lines.push('findings:')
      for (const f of diagnosis.findings) lines.push(`  - [${f.kind}] ${f.detail}`)
    }
  }
  if (degraded && report.denials) {
    const d = report.denials
    const groups = d.bySignature.map((g) => `${g.signature} ×${g.count}`).join(', ')
    // Recovery-awareness: denied+recovered ≠ denied+blind. When EVERY denial carries a
    // recovery signal (the same agent later succeeded via an equivalent tool), soften the
    // wording — but never suppress the denial list, and keep blocking: "same intent" is a
    // heuristic only a human can confirm.
    if (d.allRecovered) {
      const vias = recoveryVias(d).join(', ')
      lines.push(
        `⚠ Workflow run ${runId} (${cell(report.workflowName)}) — ${d.total} tool call(s) DENIED across ` +
          `${d.agentsAffected} agent(s) (${groups}), but ALL show a RECOVERY signal: the agent(s) later ` +
          `succeeded via ${vias}.`,
      )
      lines.push('  Verify the recovery covered the same intent; the full denial list is in the audit report.')
    } else {
      lines.push(
        `⚠ Workflow run ${runId} (${cell(report.workflowName)}) may be DEGRADED — ${d.total} tool call(s) ` +
          `silently DENIED across ${d.agentsAffected} agent(s): ${groups}.`,
      )
      lines.push(
        '  An agent could not use a tool it asked for (e.g. read the diff / run a test) — its output may be blind.',
      )
      if (d.recoveredCount > 0) {
        lines.push(
          `  (${d.recoveredCount} of ${d.total} show a recovery signal — the agent later succeeded via an equivalent tool.)`,
        )
      }
    }
  }
  if (selfAnswered && report.delegation) {
    const d = report.delegation
    const types = [...new Set(d.withoutCli.map((a) => a.agentType))].join(', ')
    lines.push(
      `⚠ Workflow run ${runId} (${cell(report.workflowName)}) requested EXTERNAL delegation (${types}) but ` +
        `${d.withoutCli.length} of ${d.delegatedAgents} routed agent(s) show NO external-CLI tool_use — ` +
        'the wrapper may have SELF-ANSWERED, so those verdicts may be same-family, not external.',
    )
    lines.push('  Verify from the agent transcript(s) before trusting them as decorrelated; details in the audit report.')
  }
  lines.push(`Full audit: pnpm wt:report ${runId}${diskDir !== null ? ` (written to ${diskDir})` : ''}`)

  return { systemMessage: notice, block: true, reason: lines.join('\n') }
}

/** A finished run whose journal is not yet readable: a one-line user notice, no block. */
export function buildProvisionalSurface(task: { id: string; name: string | null }): StopSurface {
  return {
    systemMessage:
      `DWT audit · workflow "${cell(task.name)}" (task ${task.id}) finished — journal not yet readable; ` +
      `run pnpm wt:report latest shortly for cost + traceability.`,
    block: false,
    reason: '',
  }
}

export interface HookOutput {
  systemMessage?: string
  decision?: 'block'
  reason?: string
}

/** Combine the surfaces for every run that finished on this Stop: join the notices,
 * and block (with concatenated reasons) if ANY of them is trouble. */
export function mergeStopSurfaces(surfaces: StopSurface[]): HookOutput {
  const out: HookOutput = {}
  const messages = surfaces.map((s) => s.systemMessage).filter((m) => m.length > 0)
  if (messages.length > 0) out.systemMessage = messages.join('\n')
  const blocking = surfaces.filter((s) => s.block && s.reason.length > 0)
  if (blocking.length > 0) {
    out.decision = 'block'
    out.reason = blocking.map((s) => s.reason).join('\n\n')
  }
  return out
}

/** Serialize the hook output. An empty object is the inert "do nothing" response. */
export function renderHookOutput(out: HookOutput): string {
  return Object.keys(out).length === 0 ? '{}' : JSON.stringify(out)
}
