import { readFileSync, readdirSync } from 'node:fs'
import { deadlineLine, laneBoundLine, unattendedMaxSeconds } from '../lane-deadline-core.mjs'
import { createBaseIdleWatch, createIdleWatch } from './lane-idle-worker.mjs'
import { hostAdapter } from './adapter.mjs'
import { readLinuxIdleProcProcesses } from './linux.mjs'
import { scanDeadlineWorktree, scanIdleWorktree } from './lane-worktree-scan.mjs'
import { latestWorktreeWrite } from '../lane-supervisor-core.mjs'
import path from 'node:path'
import { accountQueueTime, authorizeBrokerTimeout, queryBrokerQueue, readLaneQueue } from './lane-suite-queue.mjs'
import { claimDecision, consumedRequestIds, readDecision, requestWasConsumed } from './lane-decision-request.mjs'
import { bestEffortLaneDiagnostic } from './lane-diagnostics.mjs'

function laneEvent(ctx) {
  return { pid: ctx.child.pid, argv: ctx.modules.argvSummary(['opencode', ...ctx.args]), worktree: ctx.opts.dir, owner: ctx.opts.owner }
}

function armTimeout(ctx, seconds) {
  ctx.deadlineAtMs = ctx.monotonicNow() + seconds * 1000
  ctx.timeoutAt = new Date(Date.now() + seconds * 1000).toISOString()
  ctx.monotonicAt = ctx.monotonicNow()
  ctx.queueSample = { queuedMs: ctx.queue?.queuedMs ?? 0, at: ctx.monotonicAt, creditedMs: 0 }
  ctx.phase = 'running'
  bestEffortLaneDiagnostic('deadline initial state', () => ctx.writeState({ state: 'running', timeoutAt: ctx.timeoutAt, decisionTransitionDueAt: new Date(Date.now() + seconds * 1000 + ctx.transitionBoundMs).toISOString(), extensionCount: ctx.extensionCount, queueWait: null }))
}

function extendLane(ctx, source, seconds, extra = {}, beforeArm = () => {}) {
  const at = new Date().toISOString(), duration = seconds() * 1000, deadlineAtMs = ctx.monotonicNow() + duration, timeoutAt = new Date(Date.now() + duration).toISOString(), count = ctx.extensionCount + 1
  ctx.writeState({ state: 'running', decision: 'extend', decisionSource: source, decidedAt: at, extensionCount: count, timeoutAt, decisionTransitionDueAt: new Date(Date.now() + duration + ctx.transitionBoundMs).toISOString(), queueWait: null, queueWaitBound: null, timeoutProtection: null, unattendedMaxSeconds: unattendedMaxSeconds(ctx.opts), ...extra, extensions: [...(ctx.current().extensions ?? []), { at, source, timeoutAt }] })
  ctx.extensionCount = count; ctx.deadlineAtMs = deadlineAtMs; ctx.timeoutAt = timeoutAt; ctx.monotonicAt = ctx.monotonicNow(); ctx.phase = 'running'
  ctx.queueSample = { queuedMs: Number.isFinite(ctx.queue?.queuedMs) ? ctx.queue.queuedMs : null, at: ctx.monotonicAt, creditedMs: 0 }
  ctx.idleStopRequested = false
  ctx.timeoutProtected = false; ctx.protectionReason = null
  beforeArm()
  ctx.idle.emit(deadlineLine('LANE_EXTENDED', { count: `${ctx.extensionCount}/${ctx.opts.maxExtensions}`, source, timeoutAt, lastActivityAt: ctx.current().idle?.status === 'known' ? ctx.idle.lastActivityAt() : 'unknown' }))
}

function abandonLane(ctx, source, evidence, receiptLines = ['TERMINATION=timeout'], decision = {}) {
  if (ctx.stopped) return
  ctx.terminating = true
  try {
    const committed = ctx.endGroup(126, { ...(receiptLines ? { receiptLines } : {}), terminal: { state: 'abandoned', decision: 'abandon', decisionSource: source, decidedAt: new Date().toISOString(), extensionCount: ctx.extensionCount, ...(evidence ? { evidence } : {}) } })
    if (committed === false) throw new Error('lane termination was not signalled')
    ctx.stopped = true
    decisionJournal(ctx, 'abandon', source, decision)
  } finally {
    ctx.terminating = false
    if (ctx.stopped) {
      bestEffortLaneDiagnostic('deadline idle cleanup', () => ctx.idle.clear())
      bestEffortLaneDiagnostic('deadline brief cleanup', () => ctx.cleanupBrief())
    }
  }
}

function decisionJournal(ctx, decision, source, request = {}) {
  bestEffortLaneDiagnostic('deadline decision journal', () => ctx.journal({ event: 'decision', decision, source, ...laneEvent(ctx), reason: request.reason ?? null, requestId: request.requestId ?? null }))
}

function refreshedGraceDefault(ctx, defaultDecision) {
  if (defaultDecision !== 'abandon' || !ctx.idleDefault || ctx.extensionCount >= ctx.opts.maxExtensions) return defaultDecision
  const verdict = ctx.idle.refresh()
  return !verdict.warn && ctx.extensionCount < ctx.opts.maxExtensions ? 'extend' : 'abandon'
}

async function graceDecision(ctx, defaultDecision, evidence) {
  defaultDecision = refreshedGraceDefault(ctx, defaultDecision)
  if (defaultDecision === 'extend') {
    if (isQueued(ctx.queue) || !await cancelExtensionFence(ctx)) return
    extendLane(ctx, 'grace-default', () => ctx.opts.timeout, { evidence }, () => decisionJournal(ctx, 'extend', 'grace-default', { reason: 'no owner decision within grace' }))
  } else {
    await automaticAbandon(ctx, 'grace-default', evidence, undefined, { reason: ctx.idleDefault ? 'lane idle at timeout' : 'extension ceiling reached' })
  }
}

async function enterDecision(ctx, reason = 'timeout-bound', extra = {}) {
  const timeoutAt = ctx.timeoutAt, decisionDueMs = ctx.monotonicNow() + ctx.opts.decisionGrace * 1000, decisionDueAt = new Date(Date.now() + ctx.opts.decisionGrace * 1000).toISOString()
  // Establish the bound before any request, observation or publication can fail.
  ctx.phase = 'decision-needed'
  ctx.grace = { timeoutAt, defaultDecision: 'abandon', dueAt: decisionDueMs }
  if (await consumePreemptiveExtension(ctx)) return
  const verdict = ctx.idle.refresh()
  const activity = ctx.deadlineWrite(ctx.opts.dir)
  const evidence = { lastWriteAt: activity.status === 'known' && activity.at ? new Date(activity.at).toISOString() : 'unknown', activityStatus: activity.status, activityBounded: activity.bounded, logTail: ctx.modules.readLogTail(ctx.opts.log), process: ctx.modules.processEvidenceStatus(ctx.child.pid) }
  ctx.idleDefault = verdict.warn
  const defaultDecision = !ctx.idleDefault && ctx.extensionCount < ctx.opts.maxExtensions ? 'extend' : 'abandon'
  ctx.grace = { timeoutAt, defaultDecision, evidence, dueAt: decisionDueMs }
  ctx.writeState({ state: 'decision-needed', timeoutAt, decisionDueAt, extensionCount: ctx.extensionCount, defaultDecision, evidence, reason, ...extra })
  ctx.idle.emit(deadlineLine('LANE_DECISION_NEEDED', { timeoutAt, decisionDueAt, defaultDecision }))
  if (ctx.idleDefault) ctx.idle.emit(deadlineLine('LANE_NOT_EXTENDED', { reason: 'idle', silentSeconds: Math.floor(verdict.silentSeconds) }))
  ctx.journal({ event: 'decision-needed', ...laneEvent(ctx), reason, evidence: { ...evidence, timeoutAt, extensionCount: ctx.extensionCount, defaultDecision } })
}

function isCurrentDecision(ctx, decision, current) {
  return decision.runId === ctx.runId && decision.timeoutAt === current.timeoutAt && current.state === 'decision-needed' && ['extend', 'abandon'].includes(decision.decision)
}

async function ownerExtension(ctx, decision) {
  const queue = await readLaneQueue(ctx)
  if (ctx.stopped) return false
  accountQueueTime(ctx, queue)
  bestEffortLaneDiagnostic('deadline queue state', () => recordPause(ctx))
  if (queue?.status === 'queued') return null
  const effective = ctx.extensionCount < ctx.opts.maxExtensions ? 'extend' : 'abandon'
  if (effective === 'extend') {
    const cancelled = await cancelExtensionFence(ctx)
    if (!cancelled) return cancelled
    const consumed = consumedRequestIds(ctx)
    if (typeof decision.requestId === 'string') consumed.add(decision.requestId)
    extendLane(ctx, 'owner', () => Number.isFinite(decision.extendSeconds) && decision.extendSeconds > 0 ? Math.min(decision.extendSeconds, 86400) : defaultOwnerSeconds(ctx, decision), { consumedExtensionIds: [...consumed] }, () => decisionJournal(ctx, 'extend', 'owner', decision))
  } else await automaticAbandon(ctx, 'extension-ceiling', null, undefined, decision)
  return true
}

function defaultOwnerSeconds(ctx, decision) { return decision.preemptive ? Math.min(ctx.opts.timeout, 86400) : ctx.opts.timeout }

async function cancelExtensionFence(ctx) {
  // A timed-out verdict reply may have fenced admission without acknowledging it.
  // Resume only after the broker confirms cancellation, even with no local fence.
  const reply = await ctx.cancelTimeout()
  if (!reply) return null // Live broker uncertainty stays protected; an explicit refusal does not.
  if (!reply.cancelled || ctx.stopped) return false
  ctx.timeoutFence = null
  return true
}

async function ownerDecision(ctx) {
  const current = ctx.current()
  const pending = readDecision(`${ctx.decisionFile}.claimed`) ?? readDecision(ctx.decisionFile)
  if (!pending || !isCurrentDecision(ctx, pending, current)) return
  const claim = claimDecision(ctx.decisionFile)
  if (!claim) return
  const decision = claim.decision
  if (unusableDecision(ctx, decision)) { claim.remove(); return }
  if (!isCurrentDecision(ctx, decision, current)) return
  if (decision.decision === 'extend') {
    const handled = await ownerExtension(ctx, decision)
    if (handled !== true) return handled === null
  } else {
    abandonLane(ctx, 'owner', null, null, decision)
  }
  claim.remove()
  return true
}

function unusableDecision(ctx, decision) { return !decision || requestWasConsumed(ctx, decision) }

async function consumePreemptiveExtension(ctx) {
  // A consumed crash-window claim can coexist with the next public request.
  // Inspect at most those two slots; no unbounded retry under a busy publisher.
  for (let slot = 0; slot < 2; slot += 1) {
    const claim = claimDecision(ctx.decisionFile)
    if (!claim) return false
    const decision = claim.decision
    if (pendingOwnerDecision(ctx, decision)) return false
    if (!validPreemptive(ctx, decision) || requestWasConsumed(ctx, decision)) { claim.remove(); continue }
    const handled = await ownerExtension(ctx, decision)
    if (handled === true) claim.remove()
    return handled !== false
  }
  return false
}

function validPreemptive(ctx, decision) { return decision?.runId === ctx.runId && decision.preemptive && decision.decision === 'extend' && typeof decision.requestId === 'string' }

function pendingOwnerDecision(ctx, decision) { return decision && !decision.preemptive && isCurrentDecision(ctx, decision, ctx.current()) }

function deadlineError(error) {
  bestEffortLaneDiagnostic('deadline transition', () => { throw error })
}

function recordPause(ctx) {
  resumeQueueBudget(ctx)
  const queued = ctx.queue?.status === 'queued', wasPaused = Boolean(ctx.paused)
  if (queued !== wasPaused) {
    ctx.writeState({ ...pauseBound(ctx, queued), timeoutAt: ctx.timeoutAt, decisionTransitionDueAt: new Date(Date.now() + ctx.deadlineAtMs - ctx.monotonicNow() + ctx.transitionBoundMs).toISOString(), queueWait: ctx.queue, remainingTimeoutMs: Math.max(0, ctx.deadlineAtMs - ctx.monotonicNow()) })
    ctx.paused = queued
    if (queued) ctx.queueJournalPending = ctx.queue
  }
  if (ctx.queueJournalPending) {
    ctx.idle.emit(laneBoundLine(ctx.opts, 'queue-dependent'))
    ctx.idle.emit(deadlineLine('LANE_EXTENDED', { count: `${ctx.extensionCount}/${ctx.opts.maxExtensions}`, source: 'suite-lock-queue', timeoutAt: ctx.timeoutAt }))
    ctx.journal({ event: 'decision', decision: 'extend', source: 'suite-lock-queue', ...laneEvent(ctx), evidence: ctx.queueJournalPending })
    ctx.queueJournalPending = null
  }
}

function resumeQueueBudget(ctx) {
  if (ctx.deadlineAtMs <= ctx.monotonicNow()) { ctx.queueResumePending = false; return }
  if (ctx.phase === 'decision-needed') { ctx.phase = 'running'; ctx.queueResumePending = true }
  if (!ctx.queueResumePending) return
  ctx.writeState({ state: 'running', timeoutAt: ctx.timeoutAt, decisionDueAt: null })
  ctx.queueResumePending = false
}

function pauseBound(ctx, queued) {
  if (queued) return { unattendedMaxSeconds: null, queueWaitBound: 'suite-lock-no-progress' }
  return { unattendedMaxSeconds: ctx.timeoutProtected ? null : unattendedMaxSeconds(ctx.opts), queueWaitBound: ctx.timeoutProtected ? 'suite-lock-wait-or-hold' : null }
}

async function automaticAbandon(ctx, ...args) {
  const verdict = await ctx.authorizeTimeout()
  if (ctx.stopped) return
  if (verdict?.terminate === true) {
    ctx.timeoutFence = args
    try { abandonLane(ctx, ...args) } finally {
      if (!ctx.stopped && (await ctx.cancelTimeout())?.cancelled) ctx.timeoutFence = null
    }
  } else {
    ctx.timeoutProtected = true
    const reason = verdict?.reason ?? 'broker-unavailable-lease-unknown'
    if (ctx.protectionReason === reason) return
    bestEffortLaneDiagnostic('deadline broker protection', () => {
      ctx.writeState({ timeoutProtection: reason, unattendedMaxSeconds: null, queueWaitBound: 'suite-lock-wait-or-hold' })
      ctx.idle.emit(laneBoundLine(ctx.opts, 'queue-dependent'))
      ctx.protectionReason = reason
    })
  }
}

async function deadlineTick(ctx) {
  if (ctx.stopped || ctx.tickInFlight) return
  ctx.tickInFlight = true
  return runDeadlineTick(ctx)
}

async function runDeadlineTick(ctx) {
  let retry = false
  try {
    if (ctx.timeoutFence) { await retryTimeoutFence(ctx); return }
    const queue = await readLaneQueue(ctx)
    if (ctx.stopped) return
    accountQueueTime(ctx, queue)
    bestEffortLaneDiagnostic('deadline queue state', () => recordPause(ctx))
    if (ctx.idleStopRequested) {
      ctx.idleStopRequested = false
      await automaticAbandon(ctx, 'idle', null, ['TERMINATION=idle'])
      return
    }
    if (ctx.phase === 'decision-needed') {
      if (await ownerDecision(ctx) || await consumePreemptiveExtension(ctx)) return
      if (graceDue(ctx)) await graceDecision(ctx, ctx.grace.defaultDecision, ctx.grace.evidence)
    } else if (timeoutDue(ctx, queue)) await enterDecision(ctx)
  } catch (error) { retry = true; await deadlineFailure(ctx, error) }
  finally { ctx.tickInFlight = false; scheduleDeadline(ctx, retry) }
}

async function retryTimeoutFence(ctx) {
  if (await ownerDecision(ctx) || await consumePreemptiveExtension(ctx)) return
  await automaticAbandon(ctx, ...ctx.timeoutFence)
}

function graceDue(ctx) { return ctx.phase === 'decision-needed' && ctx.monotonicNow() >= ctx.grace.dueAt }

function timeoutDue(ctx, queue) { return ctx.phase !== 'decision-needed' && !isQueued(queue) && ctx.monotonicNow() >= ctx.deadlineAtMs }

async function deadlineFailure(ctx, error) {
  deadlineError(error)
  if (!ctx.stopped && terminationDue(ctx)) {
    try { await automaticAbandon(ctx, 'grace-default', ctx.grace.evidence) } catch (failure) { deadlineError(failure) }
  }
}

function isQueued(queue) { return queue?.status === 'queued' }

function scheduleDeadline(ctx, retry = false) {
  if (ctx.stopped || ctx.tickInFlight) return
  clearTimeout(ctx.timer)
  const due = ctx.phase === 'decision-needed' ? ctx.grace.dueAt : ctx.deadlineAtMs
  if (ctx.idleStopRequested) { queueMicrotask(() => deadlineTick(ctx)); return }
  let delay
  if (due <= ctx.monotonicNow()) delay = ctx.paused || ctx.timeoutProtected || retry ? 100 : 1
  else delay = Math.min(100, due - ctx.monotonicNow())
  ctx.timer = setTimeout(() => deadlineTick(ctx), delay)
  ctx.timer.unref()
}

function terminationDue(ctx) { return ctx.phase === 'decision-needed' && ctx.monotonicNow() >= ctx.grace.dueAt }

export function createLaneDeadline(options) {
  const ctx = { ...options, monotonicNow: options.monotonicNow ?? (() => performance.now()), writeState: retryableStateWriter(options), readSuiteQueue: options.readSuiteQueue ?? ((id) => queryBrokerQueue(options.child.laneSandbox?.suiteBroker, id)), extensionCount: 0, timeoutAt: options.firstTimeoutAt, deadlineWrite: deadlineWriter(options.modules) }
  ctx.authorizeTimeout = options.authorizeTimeout ?? (() => authorizeBrokerTimeout(options.child.laneSandbox?.suiteBroker, ctx.runId))
  ctx.cancelTimeout = options.cancelTimeout ?? (() => options.child.laneSandbox?.suiteBroker ? queryBrokerQueue(options.child.laneSandbox.suiteBroker, ctx.runId, 'cancel') : { cancelled: true })
  const clear = (terminationConfirmed = false) => {
    // The launcher clears before signalling. That clear is provisional until its
    // adapter returns; a confirmed terminal outcome remains final even on error.
    if (ctx.terminating && !terminationConfirmed) return
    ctx.stopped = true
    clearTimeout(ctx.timer)
    ctx.idle.clear()
  }
  const watchOptions = { ...options, writeState: (extra) => { if (!terminationDue(ctx)) return options.writeState(extra) }, latestWrite: ctx.deadlineWrite, readSnapshot: () => ctx.modules.hostAdapter.readProcessSnapshot(), stop: () => { ctx.idleStopRequested = true; if (!ctx.tickInFlight) scheduleDeadline(ctx) } }
  ctx.idle = ctx.opts.idleTimeout > 0 ? idleDeadlineWatch(watchOptions) : createBaseIdleWatch(watchOptions)
  armTimeout(ctx, ctx.opts.timeout)
  scheduleDeadline(ctx)
  return { clear }
}

function retryableStateWriter(options) {
  return (extra) => {
    const before = options.current()
    try { return options.writeState(extra) } catch (error) {
      const rollback = Object.fromEntries(Object.keys(extra).map((key) => [key, before[key]]))
      try { options.writeState(rollback) } catch { /* Restore the in-memory closure even when storage is still unavailable. */ }
      throw error
    }
  }
}

function idleDeadlineWatch(options) {
  const watch = createIdleWatch({ ...options, latestDeadlineWrite: options.latestWrite, latestIdleWrite: (dir) => scanIdleWorktree(dir, { excludedFiles: supervisorFiles(options) }), readIdleSnapshot: () => idleSnapshot(options.modules) })
  return { ...watch, refresh: watch.refreshDeadline }
}

function idleSnapshot(modules) {
  if (modules.hostAdapter !== hostAdapter || hostAdapter.platform !== 'linux') return modules.hostAdapter.readProcessSnapshot()
  return readLinuxIdleProcProcesses({ readFile: readFileSync, readDirectory: readdirSync, observedAt: Date.now() })
}

function deadlineWriter(modules) {
  // Preserve the injected scanner seam; the installed scanner always uses the base channel.
  return modules.latestWorktreeWrite === latestWorktreeWrite ? scanDeadlineWorktree : modules.latestWorktreeWrite
}

function supervisorFiles(options) {
  const files = [options.opts.log, ...usageReceiptFiles(options.opts.log), ...(options.supervisorFiles ?? []), ...(options.receiptFiles ?? [])]
  if (options.decisionFile?.endsWith('.decision.json')) {
    files.push(options.decisionFile.replace(/\.decision\.json$/, '.json'))
    files.push(path.dirname(options.decisionFile))
    files.push(path.join(path.dirname(options.decisionFile), 'current.json'))
  }
  return files
}

function usageReceiptFiles(log) {
  const dir = path.dirname(log)
  const names = new Set([`${path.basename(log)}.usage.json`, `${path.basename(log)}.usage.json.launch.json`])
  // Positively establish absent optional receipts by listing; a failed listing is unknown.
  return readdirSync(dir).filter((name) => names.has(name)).map((name) => path.join(dir, name))
}
