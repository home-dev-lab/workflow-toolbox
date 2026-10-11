import { readFileSync, rmSync } from 'node:fs'
import { deadlineLine } from '../lane-deadline-core.mjs'
import { createIdleWatch } from './lane-idle-worker.mjs'

function laneEvent(ctx) {
  return { pid: ctx.child.pid, argv: ctx.modules.argvSummary(['opencode', ...ctx.args]), worktree: ctx.opts.dir, owner: ctx.opts.owner }
}

function armTimeout(ctx, seconds) {
  clearTimeout(ctx.timer)
  clearTimeout(ctx.graceTimer)
  ctx.timeoutAt = new Date(Date.now() + seconds * 1000).toISOString()
  ctx.writeState({ state: 'running', timeoutAt: ctx.timeoutAt, decisionTransitionDueAt: new Date(Date.parse(ctx.timeoutAt) + ctx.transitionBoundMs).toISOString(), extensionCount: ctx.extensionCount })
  ctx.timer = setTimeout(() => enterDecision(ctx), seconds * 1000)
  ctx.timer.unref()
}

function extendLane(ctx, source, seconds, extra = {}, beforeArm = () => {}) {
  ctx.extensionCount += 1
  const at = new Date().toISOString()
  ctx.writeState({ state: 'running', decision: 'extend', decisionSource: source, decidedAt: at, extensionCount: ctx.extensionCount, ...extra })
  beforeArm()
  armTimeout(ctx, seconds())
  const timeoutAt = ctx.timeoutAt
  ctx.writeState({ extensions: [...(ctx.current().extensions ?? []), { at, source, timeoutAt }] })
  ctx.idle.emit(deadlineLine('LANE_EXTENDED', { count: `${ctx.extensionCount}/${ctx.opts.maxExtensions}`, source, timeoutAt, lastActivityAt: ctx.current().idle?.status === 'known' ? ctx.idle.lastActivityAt() : 'unknown' }))
}

function abandonLane(ctx, source, evidence, receiptLines = ['TERMINATION=timeout']) {
  ctx.cleanupBrief()
  ctx.endGroup(126, { ...(receiptLines ? { receiptLines } : {}), terminal: { state: 'abandoned', decision: 'abandon', decisionSource: source, decidedAt: new Date().toISOString(), extensionCount: ctx.extensionCount, ...(evidence ? { evidence } : {}) } })
}

function graceDecision(ctx, timeoutAt, defaultDecision, evidence) {
  try {
    const current = ctx.current()
    if (current.runId !== ctx.runId || current.state !== 'decision-needed' || current.timeoutAt !== timeoutAt) return
    if (defaultDecision === 'extend') {
      extendLane(ctx, 'grace-default', () => ctx.opts.timeout, { evidence }, () => ctx.journal({ event: 'decision', decision: 'extend', source: 'grace-default', ...laneEvent(ctx), reason: 'no owner decision within grace' }))
    } else {
      ctx.journal({ event: 'decision', decision: 'abandon', source: 'grace-default', ...laneEvent(ctx), reason: ctx.idleDefault ? 'lane idle at timeout' : 'extension ceiling reached' })
      abandonLane(ctx, 'grace-default', evidence)
    }
  } catch (error) {
    process.stderr.write(`wt-lane: grace transition failed: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.cleanupBrief()
    ctx.endGroup(126, { terminal: { state: 'abandoned', decision: 'abandon', decisionSource: 'grace-error', exit: 126 } })
  }
}

function enterDecision(ctx, reason = 'timeout-bound', extra = {}) {
  clearTimeout(ctx.graceTimer)
  const timeoutAt = ctx.timeoutAt ?? new Date().toISOString()
  const verdict = ctx.idle.refresh()
  const activity = ctx.modules.latestWorktreeWrite(ctx.opts.dir)
  const evidence = { lastWriteAt: activity.status === 'known' && activity.at ? new Date(activity.at).toISOString() : 'unknown', activityStatus: activity.status, activityBounded: activity.bounded, logTail: ctx.modules.readLogTail(ctx.opts.log), process: ctx.modules.processEvidenceStatus(ctx.child.pid) }
  ctx.idleDefault = verdict.warn
  const defaultDecision = !ctx.idleDefault && ctx.extensionCount < ctx.opts.maxExtensions ? 'extend' : 'abandon'
  const decisionDueAt = new Date(Date.now() + ctx.opts.decisionGrace * 1000).toISOString()
  ctx.writeState({ state: 'decision-needed', timeoutAt, decisionDueAt, extensionCount: ctx.extensionCount, defaultDecision, evidence, reason, ...extra })
  ctx.idle.emit(deadlineLine('LANE_DECISION_NEEDED', { timeoutAt, decisionDueAt, defaultDecision }))
  if (ctx.idleDefault) ctx.idle.emit(deadlineLine('LANE_NOT_EXTENDED', { reason: 'idle', silentSeconds: Math.floor(verdict.silentSeconds) }))
  ctx.journal({ event: 'decision-needed', ...laneEvent(ctx), reason, evidence: { ...evidence, timeoutAt, extensionCount: ctx.extensionCount, defaultDecision } })
  ctx.graceTimer = setTimeout(() => graceDecision(ctx, timeoutAt, defaultDecision, evidence), ctx.opts.decisionGrace * 1000)
  ctx.graceTimer.unref()
}

function isCurrentDecision(ctx, decision, current) {
  return decision.runId === ctx.runId && decision.timeoutAt === current.timeoutAt && current.state === 'decision-needed' && ['extend', 'abandon'].includes(decision.decision)
}

function ownerExtension(ctx, decision) {
  const effective = ctx.extensionCount < ctx.opts.maxExtensions ? 'extend' : 'abandon'
  ctx.journal({ event: 'decision', decision: effective, source: effective === 'extend' ? 'owner' : 'extension-ceiling', ...laneEvent(ctx), reason: decision.reason ?? null })
  if (effective === 'extend') {
    extendLane(ctx, 'owner', () => Number.isFinite(decision.extendSeconds) && decision.extendSeconds > 0 ? Math.min(decision.extendSeconds, 86400) : ctx.opts.timeout)
  } else abandonLane(ctx, 'extension-ceiling')
}

function ownerDecision(ctx) {
  let decision
  try { decision = JSON.parse(readFileSync(ctx.decisionFile, 'utf8')) } catch { return }
  const current = ctx.current()
  if (!isCurrentDecision(ctx, decision, current)) return
  rmSync(ctx.decisionFile, { force: true })
  clearTimeout(ctx.graceTimer)
  if (decision.decision === 'extend') {
    ownerExtension(ctx, decision)
  } else {
    ctx.journal({ event: 'decision', decision: 'abandon', source: 'owner', ...laneEvent(ctx), reason: decision.reason ?? null })
    clearInterval(ctx.decisions)
    abandonLane(ctx, 'owner', null, null)
  }
}

export function createLaneDeadline(options) {
  const ctx = { ...options, extensionCount: 0, timeoutAt: options.firstTimeoutAt }
  const clear = () => {
    clearTimeout(ctx.timer)
    clearTimeout(ctx.graceTimer)
    clearInterval(ctx.decisions)
    ctx.idle.clear()
  }
  ctx.idle = createIdleWatch({ ...options, latestWrite: (dir) => ctx.modules.latestWorktreeWrite(dir), readSnapshot: () => ctx.modules.hostAdapter.readProcessSnapshot(), stop: () => abandonLane(ctx, 'idle', null, ['TERMINATION=idle']) })
  armTimeout(ctx, ctx.opts.timeout)
  ctx.decisions = setInterval(() => ownerDecision(ctx), 100)
  ctx.decisions.unref()
  return { clear }
}
