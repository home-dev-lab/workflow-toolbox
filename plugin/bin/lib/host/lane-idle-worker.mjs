import { statSync } from 'node:fs'
import { activityEvidence, baseActivityEvidence, deadlineLine, idleVerdict } from '../lane-deadline-core.mjs'
import { bestEffortLaneDiagnostic } from './lane-diagnostics.mjs'

function logSize(log) {
  try { return statSync(log).size } catch { return null }
}

function readActivity(ctx) {
  const size = logSize(ctx.opts.log)
  let worktree
  try {
    const deadlineWorktree = (ctx.latestDeadlineWrite ?? ctx.latestWrite)(ctx.opts.dir)
    worktree = deadlineWorktree
    const snapshot = ctx.readSnapshot()
    const deadlineEvidence = activityEvidence({ snapshot, worktree: deadlineWorktree, rootPid: ctx.childPid, requireCpu: false })
    if (ctx.baseTimeoutMode) return baseActivity(deadlineEvidence, deadlineWorktree, size)
    const evidence = readIdleActivity(ctx, snapshot)
    worktree = evidence.worktree
    if (size === null) return { ...evidence, status: 'unknown', reason: 'run log size unavailable', worktree, deadlineWorktree, deadlineEvidence: { status: 'unknown' } }
    return { ...evidence, worktree, size, deadlineEvidence, deadlineWorktree }
  } catch (error) {
    return { status: 'unknown', reason: `activity read failed: ${error instanceof Error ? error.message : String(error)}`, worktree, size }
  }
}

function baseActivity(evidence, worktree, size) {
  if (size === null) return { ...evidence, status: 'unknown', reason: 'run log size unavailable', worktree }
  return { ...evidence, worktree, deadlineWorktree: worktree, size, deadlineEvidence: evidence }
}

function readIdleActivity(ctx, snapshot) {
  try {
    const worktree = (ctx.latestIdleWrite ?? ctx.latestWrite)(ctx.opts.dir)
    snapshot = ctx.readIdleSnapshot ? ctx.readIdleSnapshot() : snapshot
    return { ...activityEvidence({ snapshot, worktree, rootPid: ctx.childPid }), worktree }
  } catch { return { status: 'unknown', reason: 'idle activity read failed' } }
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
  let changed = cpuChanged(ctx, evidence)
  if (evidence.size !== null && evidence.size !== undefined) {
    if (evidence.size !== ctx.size) changed = true
    ctx.size = evidence.size
  }
  if (evidence.worktree?.status === 'known') {
    const fingerprint = evidence.worktree.fingerprint ?? evidence.worktree.at
    if (fingerprint !== ctx.worktreeFingerprint) changed = true
    ctx.worktreeFingerprint = fingerprint
    if (evidence.worktree.at !== ctx.worktreeAt) changed = true
    ctx.worktreeAt = evidence.worktree.at
  }
  return changed
}

function cpuChanged(ctx, evidence) {
  if (!evidence.cpuTimes) return false
  let changed = false
  const current = new Map()
  for (const row of evidence.cpuTimes) {
    const previous = ctx.cpuTimes?.get(row.pid)
    const sameProcess = previous && previous.startIdentity === row.startIdentity
    const baseline = sameProcess ? previous : { cpuTicks: 0, activityTicks: 0 }
    if (row.cpuTicks > baseline.cpuTicks || faultChanged(row, baseline)) changed = true
    current.set(row.pid, row)
  }
  ctx.cpuTimes = current
  return changed
}

function faultChanged(row, previous) {
  return row.activityTicks !== undefined && row.activityTicks !== previous.activityTicks
}

function refreshIdle(ctx) {
  const evidence = readActivity(ctx)
  const nowMs = ctx.monotonicNow()
  refreshDeadlineActivity(ctx, evidence, nowMs)
  const changed = activityChanged(ctx, evidence)
  // Unknown time cannot establish continuous silence; recovery starts a fresh known window.
  if (changed || (ctx.baseTimeoutMode && evidence.descendants?.length) || evidence.status === 'unknown' || ctx.status === 'unknown') {
    ctx.lastActivityMs = nowMs
    ctx.lastActivityWallMs = Date.now()
    ctx.warned = false
  }
  ctx.status = evidence.status
  return publishIdle(ctx, evidence, nowMs)
}

function refreshDeadlineActivity(ctx, evidence, nowMs) {
  const previous = ctx.deadlineActivity ?? { lastActivityMs: ctx.lastActivityMs, size: ctx.size }
  const activity = evidence.deadlineEvidence ?? { status: 'unknown' }
  const at = evidence.deadlineWorktree?.at
  const reset = deadlineActivityChanged(previous, evidence) || activity.descendants?.length || activity.status === 'unknown' || previous.status === 'unknown'
  const lastActivityMs = reset ? nowMs : previous.lastActivityMs
  ctx.deadlineActivity = { lastActivityMs, size: evidence.size, at, status: activity.status }
}

function deadlineActivityChanged(previous, evidence) {
  return evidence.size !== previous.size || (evidence.deadlineWorktree?.status === 'known' && evidence.deadlineWorktree.at !== previous.at)
}

function refreshDeadline(ctx) {
  if (ctx.baseTimeoutMode) return refreshIdle(ctx)
  refreshIdle(ctx)
  return idleVerdict({ nowMs: ctx.monotonicNow(), lastActivityMs: ctx.deadlineActivity.lastActivityMs, windowSeconds: ctx.opts.idleWindow, enforceSeconds: 0, status: ctx.deadlineActivity.status })
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
    if (bestEffortLaneDiagnostic('lane receipt write', () => options.appendLine(line)) && ctx.size !== null) {
      const bytes = Buffer.byteLength(`${line}\n`)
      ctx.size += bytes
      if (ctx.deadlineActivity?.size !== undefined) ctx.deadlineActivity.size += bytes
    }
  }
  ctx.emit = emit
  refreshIdle(ctx)
  const interval = setInterval(() => tickIdle(ctx), Math.min(60, options.opts.idleWindow / 4) * 1000)
  interval.unref()
  return {
    refresh: () => refreshIdle(ctx),
    refreshDeadline: () => refreshDeadline(ctx),
    emit,
    lastActivityAt: () => new Date(ctx.lastActivityWallMs).toISOString(),
    clear: () => { ctx.closed = true; clearInterval(interval) },
  }
}

// Base watch bodies are kept separate so idle-only fields cannot change default decisions.
function readBaseActivity(ctx) {
  const size = logSize(ctx.opts.log)
  let worktree
  try {
    worktree = ctx.latestWrite(ctx.opts.dir)
    const snapshot = ctx.readSnapshot()
    const evidence = baseActivityEvidence({ snapshot, worktree, rootPid: ctx.childPid })
    if (size === null) return { ...evidence, status: 'unknown', reason: 'run log size unavailable', worktree }
    return { ...evidence, worktree, size }
  } catch (error) {
    return { status: 'unknown', reason: `activity read failed: ${error instanceof Error ? error.message : String(error)}`, worktree, size }
  }
}

function baseActivityChanged(ctx, evidence) {
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

function refreshBaseIdle(ctx) {
  const evidence = readBaseActivity(ctx)
  const nowMs = ctx.monotonicNow()
  const changed = baseActivityChanged(ctx, evidence)
  // Unknown time cannot establish continuous silence; recovery starts a fresh known window.
  if (changed || evidence.descendants?.length || evidence.status === 'unknown' || ctx.status === 'unknown') {
    ctx.lastActivityMs = nowMs
    ctx.lastActivityWallMs = Date.now()
    ctx.warned = false
  }
  ctx.status = evidence.status
  return publishIdle(ctx, evidence, nowMs)
}

function tickBaseIdle(ctx) {
  if (ctx.closed) return
  const verdict = refreshBaseIdle(ctx)
  if (verdict.warn && !ctx.warned) {
    ctx.warned = true
    ctx.emit(deadlineLine('LANE_IDLE_WARN', { silentSeconds: Math.floor(verdict.silentSeconds) }))
  }
  if (!verdict.stop) return
  ctx.emit(deadlineLine('LANE_IDLE_STOP', { silentSeconds: Math.floor(verdict.silentSeconds) }))
  ctx.stop()
}

export function createBaseIdleWatch(options) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const ctx = { ...options, monotonicNow, lastActivityMs: monotonicNow(), lastActivityWallMs: options.launchedAtMs, size: logSize(options.opts.log), maxSilentSeconds: 0, warned: false, unknownWarned: false, closed: false }
  // Account only for our own bytes. Child output between ticks is still detected, while receipts
  // cannot turn their own silent stretch into activity or postpone an enforced idle stop.
  const emit = (line) => {
    if (bestEffortLaneDiagnostic('lane receipt write', () => options.appendLine(line)) && ctx.size !== null) ctx.size += Buffer.byteLength(`${line}\n`)
  }
  ctx.emit = emit
  refreshBaseIdle(ctx)
  const interval = setInterval(() => tickBaseIdle(ctx), Math.min(60, options.opts.idleWindow / 4) * 1000)
  interval.unref()
  return {
    refresh: () => refreshBaseIdle(ctx),
    emit,
    lastActivityAt: () => new Date(ctx.lastActivityWallMs).toISOString(),
    clear: () => { ctx.closed = true; clearInterval(interval) },
  }
}
