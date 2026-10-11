import { statSync } from 'node:fs'
import { activityEvidence, deadlineLine, idleVerdict } from '../lane-deadline-core.mjs'

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
  const idle = { status, lastActivityAt: new Date(ctx.lastActivityMs).toISOString(), maxSilentSeconds: ctx.maxSilentSeconds, ...(status === 'unknown' ? { reason: evidence.reason } : {}) }
  const recorded = JSON.stringify(idle)
  if (recorded !== ctx.recorded) { ctx.recorded = recorded; ctx.writeState({ idle }) }
  if (status === 'unknown' && !ctx.unknownWarned) {
    ctx.unknownWarned = true
    ctx.emit(deadlineLine('LANE_IDLE_UNKNOWN', { reason: JSON.stringify(evidence.reason) }))
  }
  return idleVerdict({ nowMs, lastActivityMs: ctx.lastActivityMs, windowSeconds: ctx.opts.idleWindow, enforceSeconds: ctx.opts.idleTimeout, status })
}

function refreshIdle(ctx) {
  const evidence = readActivity(ctx)
  const nowMs = Date.now()
  const previous = ctx.lastActivityMs
  if (evidence.size !== null && evidence.size !== undefined) {
    if (evidence.size !== ctx.size) ctx.lastActivityMs = Math.max(ctx.lastActivityMs, nowMs)
    ctx.size = evidence.size
  }
  if (evidence.worktree?.status === 'known') ctx.lastActivityMs = Math.max(ctx.lastActivityMs, evidence.worktree.at ?? 0)
  if (evidence.descendants?.length) ctx.lastActivityMs = Math.max(ctx.lastActivityMs, nowMs)
  if (ctx.lastActivityMs > previous) ctx.warned = false
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
  const ctx = { ...options, lastActivityMs: options.launchedAtMs, size: logSize(options.opts.log), maxSilentSeconds: 0, warned: false, unknownWarned: false, closed: false }
  // Account only for our own bytes. Child output between ticks is still detected, while receipts
  // cannot turn their own silent stretch into activity or postpone an enforced idle stop.
  const emit = (line) => {
    if (options.appendLine(line) && ctx.size !== null) ctx.size += Buffer.byteLength(`${line}\n`)
  }
  ctx.emit = emit
  refreshIdle(ctx)
  const interval = setInterval(() => tickIdle(ctx), Math.min(60, options.opts.idleWindow / 4) * 1000)
  interval.unref()
  return {
    refresh: () => refreshIdle(ctx),
    emit,
    lastActivityAt: () => new Date(ctx.lastActivityMs).toISOString(),
    clear: () => { ctx.closed = true; clearInterval(interval) },
  }
}
