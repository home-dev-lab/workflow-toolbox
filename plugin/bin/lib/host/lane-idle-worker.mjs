import { statSync } from 'node:fs'
import { activityEvidence, deadlineLine, idleVerdict } from '../lane-deadline-core.mjs'
import { bestEffortLaneDiagnostic } from './lane-diagnostics.mjs'

function logSize(log) {
  try { return statSync(log).size } catch { return null }
}

function readActivity(ctx) {
  const size = logSize(ctx.opts.log)
  let worktree
  try {
    worktree = ctx.latestWrite(ctx.opts.dir)
    const snapshot = ctx.readSnapshot()
    const evidence = activityEvidence({ snapshot, worktree, rootPid: ctx.childPid })
    if (size === null) return { ...evidence, status: 'unknown', reason: 'run log size unavailable', worktree }
    return { ...evidence, worktree, size }
  } catch (error) {
    return { status: 'unknown', reason: `activity read failed: ${error instanceof Error ? error.message : String(error)}`, worktree, size }
  }
}

function publishIdle(ctx, evidence, nowMs) {
  const { status } = evidence
  const silentSeconds = Math.max(0, (nowMs - ctx.lastActivityMs) / 1000)
  ctx.maxSilentSeconds = Math.max(ctx.maxSilentSeconds, silentSeconds)
  const idle = { status, lastActivityAt: new Date(ctx.lastActivityWallMs).toISOString(), maxSilentSeconds: ctx.maxSilentSeconds, ...(status === 'unknown' ? { reason: evidence.reason } : {}) }
  const recorded = JSON.stringify(idle)
  if (recorded !== ctx.recorded) bestEffortLaneDiagnostic('idle state write', () => { ctx.writeState({ idle }); ctx.recorded = recorded })
  if (status === 'unknown' && !ctx.unknownWarned) {
    ctx.unknownWarned = true
    ctx.emit(deadlineLine('LANE_IDLE_UNKNOWN', { reason: JSON.stringify(evidence.reason) }))
  }
  return idleVerdict({ nowMs, lastActivityMs: ctx.lastActivityMs, windowSeconds: ctx.opts.idleWindow, enforceSeconds: ctx.opts.idleTimeout, status })
}

function activityChanged(ctx, evidence) {
  let changed = false
  if (evidence.size !== null && evidence.size !== undefined) {
    changed = evidence.size !== ctx.size
    ctx.size = evidence.size
  }
  if (evidence.worktree?.status === 'known') {
    if (evidence.worktree.at !== ctx.worktreeAt) changed = true
    ctx.worktreeAt = evidence.worktree.at
  }
  return changed
}

function refreshIdle(ctx) {
  const evidence = readActivity(ctx)
  const nowMs = ctx.monotonicNow()
  const changed = activityChanged(ctx, evidence)
  // Unknown time cannot establish continuous silence; recovery starts a fresh known window.
  if (changed || evidence.descendants?.length || evidence.status === 'unknown' || ctx.status === 'unknown') {
    ctx.lastActivityMs = nowMs
    ctx.lastActivityWallMs = Date.now()
    ctx.warned = false
  }
  ctx.status = evidence.status
  return publishIdle(ctx, evidence, nowMs)
}

function tickIdle(ctx) {
  if (ctx.closed) return
  const verdict = refreshIdle(ctx)
  if (verdict.warn && !ctx.warned) {
    ctx.warned = true
    ctx.emit(deadlineLine('LANE_IDLE_WARN', { silentSeconds: Math.floor(verdict.silentSeconds) }))
  }
  if (!verdict.stop) return
  ctx.emit(deadlineLine('LANE_IDLE_STOP', { silentSeconds: Math.floor(verdict.silentSeconds) }))
  ctx.stop()
}

export function createIdleWatch(options) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const ctx = { ...options, monotonicNow, lastActivityMs: monotonicNow(), lastActivityWallMs: options.launchedAtMs, size: logSize(options.opts.log), maxSilentSeconds: 0, warned: false, unknownWarned: false, closed: false }
  // Account only for our own bytes. Child output between ticks is still detected, while receipts
  // cannot turn their own silent stretch into activity or postpone an enforced idle stop.
  const emit = (line) => {
    if (bestEffortLaneDiagnostic('lane receipt write', () => options.appendLine(line)) && ctx.size !== null) ctx.size += Buffer.byteLength(`${line}\n`)
  }
  ctx.emit = emit
  refreshIdle(ctx)
  const interval = setInterval(() => tickIdle(ctx), Math.min(60, options.opts.idleWindow / 4) * 1000)
  interval.unref()
  return {
    refresh: () => refreshIdle(ctx),
    emit,
    lastActivityAt: () => new Date(ctx.lastActivityWallMs).toISOString(),
    clear: () => { ctx.closed = true; clearInterval(interval) },
  }
}
