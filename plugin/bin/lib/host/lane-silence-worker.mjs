import { activityEvidence, silenceVerdict } from '../lane-deadline-core.mjs'
import { statSync } from 'node:fs'

function cpuSample(ctx) {
  try {
    const readSnapshot = ctx.options.readSilenceSnapshot ?? ctx.options.readIdleSnapshot ?? ctx.options.readSnapshot
    const snapshot = readSnapshot()
    const evidence = activityEvidence({ snapshot, rootPid: ctx.options.childPid, worktree: { status: 'known' } })
    if (evidence.status !== 'known') return { known: false, familyTickDelta: 0 }
    return familyDelta(ctx, evidence.cpuTimes)
  } catch { return { known: false, familyTickDelta: 0 } }
}

function familyDelta(ctx, rows) {
  const current = new Map()
  let delta = 0
  for (const row of rows) {
    const key = `${row.pid}:${row.startIdentity}`
    const previous = ctx.baselines.get(key)
    if (previous !== undefined && row.cpuTicks < previous) return { known: false, familyTickDelta: 0 }
    if (previous !== undefined) delta += row.cpuTicks - previous
    current.set(key, row.cpuTicks)
  }
  ctx.baselines = current
  return { known: true, familyTickDelta: delta, familyIdentity: JSON.stringify([...current.keys()].sort()) }
}

function observeLog(ctx, size, nowMs) {
  ctx.logKnown = Number.isFinite(size)
  // Output seen after the last full sample is still activity: its quiet time clamps to zero in the verdict.
  if (ctx.logKnown && size !== ctx.size) ctx.lastActivityMs = nowMs
  if (ctx.logKnown) ctx.size = size
}

function observe(ctx, evidence, nowMs) {
  observeLog(ctx, evidence.size, nowMs)
  observeWorktree(ctx, evidence, nowMs)
  ctx.samples.push({ monotonicMs: nowMs, ...cpuSample(ctx) })
  const boundary = nowMs - ctx.options.opts.idleWindow * 1000
  while (ctx.samples.length > 1 && ctx.samples[1].monotonicMs <= boundary) ctx.samples.shift()
  ctx.sampledAt = nowMs
}

function observeWorktree(ctx, evidence, nowMs) {
  const worktree = evidence.worktree ?? evidence.deadlineWorktree
  if (worktree?.status !== 'known' || worktree.bounded) return
  // A receipt moves the log's mtime, so a newest time is compared only when the newest file is not the log
  // (or an alias of it). A fingerprint is always compared; this assumes it leaves out the log's own metadata,
  // as the idle scan's exclusions do. Each value keeps its own history, so a switch of the newest path alone
  // is not activity.
  const logNewest = sameLogIdentity(worktree.path, ctx.options.opts.log)
  const fingerprintChanged = observeFingerprint(ctx, worktree.fingerprint)
  if (fingerprintChanged || (!logNewest && worktree.at !== ctx.worktreeAt)) ctx.lastActivityMs = nowMs
  if (!logNewest) ctx.worktreeAt = worktree.at
}

function observeFingerprint(ctx, value) {
  if (value === undefined) return false
  const fingerprint = JSON.stringify(value), changed = fingerprint !== ctx.fingerprint
  ctx.fingerprint = fingerprint
  return changed
}

function sameLogIdentity(file, log) {
  if (!file) return false
  try {
    const candidate = statSync(file, { bigint: true }), source = statSync(log, { bigint: true })
    return candidate.dev === source.dev && candidate.ino === source.ino
  } catch { return false }
}

export function createSilenceTracker(options, size) {
  const ctx = { options, size, logKnown: Number.isFinite(size), lastActivityMs: options.monotonicNow(), samples: [], baselines: new Map(), sampledAt: -Infinity }
  return {
    observe: (evidence, nowMs) => observe(ctx, evidence, nowMs),
    observeLog: (size) => observeLog(ctx, size, options.monotonicNow()),
    receipt: (bytes) => { if (ctx.size !== null) ctx.size += bytes },
    markActivity: () => { ctx.lastActivityMs = options.monotonicNow() },
    fresh: () => options.monotonicNow() - ctx.sampledAt < Math.min(60, options.opts.idleWindow / 4) * 1000,
    verdict: () => silenceVerdict({ nowMs: ctx.sampledAt, lastActivityMs: ctx.lastActivityMs, windowSeconds: options.opts.idleWindow, samples: ctx.samples, logKnown: ctx.logKnown, capReason: options.silenceCapReason }),
  }
}
