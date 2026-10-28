import { createTsCpuReader } from './ts-cpu-sample.mjs'
import { createTsCpuBudget, TS_CPU_BUDGET_PCT, TS_CPU_WINDOW_MS, TS_CPU_SAMPLE_MS } from './ts-cpu-budget.mjs'

function diagnosticWriter(stderr) {
  return (message) => { try { stderr.write(`wt-tsls: CPU watchdog: ${message}\n`) } catch { /* Protocol output is independent. */ } }
}

function warnBreach(context, breach, budgetPct) {
  if (!breach || context.warned) return
  context.warned = true
  const scope = breach.scope === 'family' ? 'combined tsserver family' : 'tsserver'
  const pids = breach.servers.map((server) => server.pid).join(',')
  context.diagnostic(`CPU budget exceeded: ${scope} ${pids}: ${breach.percent.toFixed(1)}% CPU, ${(breach.percent - budgetPct).toFixed(1)} percentage points above ${budgetPct}% for ${breach.overMs}ms; stop is disabled in this version; sampling continues`)
}

async function sampleAndWarn(context, update, budgetPct) {
  const sample = await context.readFamily(context.child.pid)
  if (!context.active()) return
  if (sample.status === 'measured' && sample.parent.identity !== context.pinned.identity) {
    context.stop()
    context.diagnostic('backend birth identity changed; supervision stopped without signalling')
    return
  }
  if (sample.status !== 'measured' && !context.unavailable) context.diagnostic(`unavailable (${sample.reason}); CPU budget is not enforced`)
  context.unavailable = sample.status !== 'measured'
  warnBreach(context, update(sample, context.now()), budgetPct)
}

function createCheck(context, birth, update, budgetPct) {
  let busy = false
  return async () => {
    if (!context.active() || busy) return
    busy = true
    try {
      const identity = await birth
      if (!context.active()) return
      if (identity.status !== 'measured') {
        context.stop()
        context.diagnostic(`birth identity unavailable (${identity.reason}); CPU budget is not enforced`)
        return
      }
      context.pinned ??= { ...identity.process }
      await sampleAndWarn(context, update, budgetPct)
    } catch { context.diagnostic('unavailable (CPU supervision read failed); CPU budget is not enforced') }
    finally { busy = false }
  }
}

export function monitorTsserverCpu(child, stderr, options = {}) {
  const readFamily = options.readFamily ?? createTsCpuReader()
  const intervalMs = options.intervalMs ?? TS_CPU_SAMPLE_MS
  const budgetPct = options.budgetPct ?? TS_CPU_BUDGET_PCT
  const windowMs = options.windowMs ?? TS_CPU_WINDOW_MS
  const maxGapMs = 3 * intervalMs
  let timer, stopped = false
  const stop = () => { stopped = true; clearInterval(timer) }
  const context = { child, readFamily, readIdentity: options.readIdentity ?? readFamily.identity,
    now: options.now ?? (() => performance.now()),
    active: () => !stopped, stop, diagnostic: diagnosticWriter(stderr) }
  child.once('exit', stop)
  child.once('close', stop)
  if (child.exitCode != null || child.signalCode != null) return { status: 'exited' }
  // Invoke at spawn, before any CPU read, and never retry/adopt a later birth.
  const birth = context.readIdentity(child.pid)
  const check = createCheck(context, birth, createTsCpuBudget({ budgetPct, windowMs, maxGapMs }), budgetPct)
  context.diagnostic(`budget ${budgetPct}% per tsserver for ${windowMs}ms, sample ${intervalMs}ms; also combined family, maximum gap ${maxGapMs}ms; warn only; stop is disabled in this version`)
  timer = setInterval(check, intervalMs)
  timer.unref()
  void check()
  return { status: 'monitoring' }
}
