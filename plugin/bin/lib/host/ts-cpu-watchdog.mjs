import { createTsCpuReader } from './ts-cpu-sample.mjs'
import { createTsCpuBudget, TS_CPU_BUDGET_PCT, TS_CPU_WINDOW_MS, TS_CPU_SAMPLE_MS } from './ts-cpu-budget.mjs'
import { stopTsCpuFamily } from './ts-cpu-stop.mjs'

const pendingStops = new WeakMap()

// The launcher must let the post-signal census/report finish before forwarding
// the backend's fatal signal to itself. Ordinary closes remain synchronous.
export function afterTsCpuStop(child, callback) {
  return (...args) => {
    const pending = pendingStops.get(child)
    if (pending) void pending.then(() => callback(...args), () => callback(...args))
    else callback(...args)
  }
}

function diagnosticWriter(stderr) {
  return (message) => { try { stderr.write(`wt-tsls: CPU watchdog: ${message}\n`) } catch { /* Protocol output is independent. */ } }
}

function reportStop(context, result, breach, budgetPct) {
  const qualification = '; tracked set only; untracked descendants: unknown'
  if (result.status === 'stopped') {
    context.stop()
    const family = breach.scope === 'family' ? ' combined family' : ''
    context.diagnostic(`stopped backend and tsserver ${breach.servers.map((server) => server.pid).join(',')}: ${breach.percent.toFixed(1)}% CPU above ${budgetPct}%${family} for ${breach.overMs}ms; verified tracked pids: ${result.targets.map((target) => target.pid).join(',')}${qualification}; restart the LSP client to launch wt-tsls again`)
    context.child.emit('wt-tsls-cpu-stop', result)
    context.cleanup.resolve()
    pendingStops.delete(context.child)
  } else if (result.status === 'survived') {
    context.diagnostic(`survived: ${result.survivors.map((server) => server.pid).join(',')}; stop incomplete; retrying next sample${qualification}`)
  } else context.diagnostic(`stop unknown: ${(result.unknown ?? []).map((target) => target.pid).join(',')}; identity, process tree or census unavailable; retrying next sample${qualification}`)
}

async function retryStop(context, budgetPct) {
  const { sample, breach } = context.cleanup
  const result = await stopTsCpuFamily(context, sample, breach)
  reportStop(context, result, breach, budgetPct)
}

async function sampleAndEnforce(context, update, budgetPct) {
  if (context.cleanup) return retryStop(context, budgetPct)
  const sample = await context.readFamily(context.child.pid)
  if (!context.active()) return
  if (sample.status === 'measured' && sample.parent.identity !== context.pinned.identity) {
    context.stop()
    context.diagnostic('backend birth identity changed; supervision stopped without signalling')
    return
  }
  if (sample.status !== 'measured' && !context.unavailable) context.diagnostic(`unavailable (${sample.reason}); CPU budget is not enforced`)
  context.unavailable = sample.status !== 'measured'
  const breach = update(sample, context.now())
  if (!breach) return
  let resolve
  const pending = new Promise((done) => { resolve = done })
  context.cleanup = { sample, breach, resolve }
  pendingStops.set(context.child, pending)
  context.retain()
  await retryStop(context, budgetPct)
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
      await sampleAndEnforce(context, update, budgetPct)
    } catch { context.diagnostic('unavailable (CPU supervision read failed); CPU budget is not enforced') }
    finally { busy = false }
  }
}

function contextOptions(options, readFamily) {
  return {
    readIdentity: options.readIdentity ?? readFamily.identity, census: options.census ?? readFamily.census,
    readTree: options.readTree ?? readFamily.tree,
    kill: options.kill ?? process.kill, now: options.now ?? (() => performance.now()),
    settle: options.settle ?? (() => new Promise((resolve) => setTimeout(resolve, 20))),
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
  const context = { child, readFamily, ...contextOptions(options, readFamily), retain: () => timer.ref(),
    active: () => !stopped, stop, diagnostic: diagnosticWriter(stderr) }
  const exited = () => { if (!context.cleanup) stop() }
  child.once('exit', exited)
  child.once('close', exited)
  if (child.exitCode != null || child.signalCode != null) return { status: 'exited' }
  // Invoke at spawn, before any CPU read, and never retry/adopt a later birth.
  const birth = context.readIdentity(child.pid)
  const check = createCheck(context, birth, createTsCpuBudget({ budgetPct, windowMs, maxGapMs }), budgetPct)
  context.diagnostic(`budget ${budgetPct}% per tsserver for ${windowMs}ms, sample ${intervalMs}ms; also combined family, maximum gap ${maxGapMs}ms`)
  timer = setInterval(check, intervalMs)
  timer.unref()
  void check()
  return { status: 'monitoring' }
}
