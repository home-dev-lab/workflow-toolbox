import { activityEvidence, silenceVerdict } from '../lane-deadline-core.mjs'

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
  const pids = new Set(rows.map((row) => row.pid))
  let delta = 0
  for (const row of rows) {
    const key = `${row.pid}:${row.startIdentity}`
    const previous = ctx.baselines.get(key) ?? 0
    if (row.cpuTicks < previous) return { known: false, familyTickDelta: 0 }
    delta += row.cpuTicks - previous
    current.set(key, { pid: row.pid, cpuTicks: row.cpuTicks })
  }
  for (const row of ctx.previous.values()) if (!pids.has(row.pid)) delta -= row.cpuTicks
  for (const [key, row] of current) ctx.baselines.set(key, row.cpuTicks)
  ctx.previous = current
  return { known: true, familyTickDelta: Math.max(0, delta) }
}

function observe(ctx, evidence, nowMs) {
  const size = evidence.size
  ctx.logKnown = Number.isFinite(size)
  if (ctx.logKnown && size !== ctx.size) ctx.lastActivityMs = nowMs
  if (ctx.logKnown) ctx.size = size
  observeWorktree(ctx, evidence, nowMs)
  ctx.samples.push({ monotonicMs: nowMs, ...cpuSample(ctx) })
  const boundary = nowMs - ctx.options.opts.idleWindow * 1000
  while (ctx.samples.length > 1 && ctx.samples[1].monotonicMs <= boundary) ctx.samples.shift()
  ctx.sampledAt = nowMs
}

function observeWorktree(ctx, evidence, nowMs) {
  const worktree = evidence.deadlineWorktree ?? evidence.worktree
  // The log has its own receipt-adjusted channel, including when it is the scan's newest file.
  if (worktree?.path && worktree.path === ctx.options.opts.log) return
  if (worktree?.status === 'known' && !worktree.bounded) {
    const fingerprint = JSON.stringify([worktree.at, worktree.fingerprint])
    if (fingerprint !== ctx.fingerprint) ctx.lastActivityMs = nowMs
    ctx.fingerprint = fingerprint
  }
}

export function createSilenceTracker(options, size) {
  const ctx = { options, size, logKnown: Number.isFinite(size), lastActivityMs: options.monotonicNow(), samples: [], baselines: new Map(), previous: new Map(), sampledAt: -Infinity }
  return {
    observe: (evidence, nowMs) => observe(ctx, evidence, nowMs),
    receipt: (bytes) => { if (ctx.size !== null) ctx.size += bytes },
    markActivity: () => { ctx.lastActivityMs = options.monotonicNow() },
    fresh: () => options.monotonicNow() - ctx.sampledAt < Math.min(60, options.opts.idleWindow / 4) * 1000,
    verdict: () => silenceVerdict({ nowMs: ctx.sampledAt, lastActivityMs: ctx.lastActivityMs, windowSeconds: options.opts.idleWindow, samples: ctx.samples, logKnown: ctx.logKnown, capReason: options.silenceCapReason }),
  }
}
