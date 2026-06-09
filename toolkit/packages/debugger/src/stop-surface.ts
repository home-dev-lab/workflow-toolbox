// PURE rendering of the Stop-hook output for one or more finished workflow runs.
// Implements the HYBRID surfacing the user chose: ALWAYS a `systemMessage` notice; a
// `decision:"block"` + compact `reason` ONLY when the run looks like trouble. Block is
// driven by a POSITIVE trouble set (never by negating completed-ok — a journal read a
// beat early reads `in-progress`, which must NOT block). No IO — unit-tested; the
// impure entry feeds it the parsed journal's report + diagnosis.

import type { AuditReport } from './report.js'
import type { Diagnosis, DiagnosisMode } from './diagnose.js'

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

/** A finished run with a readable journal: the always-on notice, plus (when trouble) a
 * compact reason fed back to Claude. */
export function buildFullSurface(input: FullSurfaceInput): StopSurface {
  const { runId, report, diagnosis, diskDir } = input
  const block = isTrouble(diagnosis.mode)

  const notice =
    `DWT audit · ${runId} (${cell(report.workflowName)}) ${cell(report.status)} · ` +
    `${report.agentCount} agents · ${tok(report.totalTokens)} tok · ${report.decisions.length} decisions ` +
    `→ pnpm dwt:report ${runId}` +
    (diskDir !== null ? ` · written to ${diskDir}` : '')

  if (!block) return { systemMessage: notice, block: false, reason: '' }

  const recon = report.reconciliation
  const reconNote = recon.reconciles
    ? 'reconciled'
    : `UNRECONCILED (Δ ${recon.delta === null ? '—' : recon.delta.toLocaleString('en-US')}, ` +
      `${recon.missingTokenAgents} agent(s) missing tokens)`
  const lines: string[] = [
    `⚠ Workflow run ${runId} (${cell(report.workflowName)}) needs attention — ${diagnosis.headline}`,
    `cost: ${report.agentCount} agents · ${tok(report.totalTokens)} tok (${reconNote}) · ${tok(report.totalToolCalls)} tool calls`,
  ]
  if (diagnosis.findings.length > 0) {
    lines.push('findings:')
    for (const f of diagnosis.findings) lines.push(`  - [${f.kind}] ${f.detail}`)
  }
  lines.push(`Full audit: pnpm dwt:report ${runId}${diskDir !== null ? ` (written to ${diskDir})` : ''}`)

  return { systemMessage: notice, block: true, reason: lines.join('\n') }
}

/** A finished run whose journal is not yet readable: a one-line user notice, no block. */
export function buildProvisionalSurface(task: { id: string; name: string | null }): StopSurface {
  return {
    systemMessage:
      `DWT audit · workflow "${cell(task.name)}" (task ${task.id}) finished — journal not yet readable; ` +
      `run pnpm dwt:report latest shortly for cost + traceability.`,
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
