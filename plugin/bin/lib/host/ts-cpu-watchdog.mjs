import { createTsCpuReader } from './ts-cpu-sample.mjs'
import { createTsCpuBudget, TS_CPU_BUDGET_PCT, TS_CPU_WINDOW_MS, TS_CPU_SAMPLE_MS } from './ts-cpu-budget.mjs'

// Runs in the launcher, so a synchronous tsserver loop cannot stall this timer.

function stopFamily(child, sample, offender, readFamily, kill) {
  const current = readFamily(child.pid)
  if (current.status !== 'measured' || current.parent.identity !== sample.parent.identity) return false
  if (!current.servers.some((server) => server.identity === offender.identity)) return false
  // TLS is launched as an isolated POSIX session/group leader. One group signal
  // stops both servers and transport, including a replacement forked mid-sample.
  if (current.parent.pgid !== child.pid) return false
  try { kill(-child.pid, 'SIGKILL'); return true } catch { return false }
}

export function monitorTsserverCpu(child, stderr, {
  readFamily = createTsCpuReader(), now = () => performance.now(), kill = process.kill,
  intervalMs = TS_CPU_SAMPLE_MS, budgetPct = TS_CPU_BUDGET_PCT, windowMs = TS_CPU_WINDOW_MS,
} = {}) {
  const update = createTsCpuBudget({ budgetPct, windowMs })
  let timer, unavailable = false, stopped = false
  const diagnostic = (message) => { try { stderr.write(`wt-tsls: CPU watchdog: ${message}\n`) } catch { /* Protocol output is independent. */ } }
  const check = () => {
    if (stopped) return
    const sample = readFamily(child.pid)
    if (sample.status !== 'measured' && !unavailable) diagnostic(`unavailable (${sample.reason}); CPU budget is not enforced`)
    unavailable = sample.status !== 'measured'
    const breach = update(sample, now())
    if (!breach) return
    if (!stopFamily(child, sample, breach.server, readFamily, kill)) {
      diagnostic('stop unavailable (process identity changed or signal failed); retrying next sample')
      return
    }
    stopped = true
    clearInterval(timer)
    diagnostic(`stopped backend and tsserver ${breach.server.pid}: ${breach.percent.toFixed(1)}% CPU above ${budgetPct}% for ${breach.overMs}ms; restart the LSP client to launch wt-tsls again`)
  }
  diagnostic(`budget ${budgetPct}% per tsserver for ${windowMs}ms, sample ${intervalMs}ms`)
  check()
  timer = setInterval(check, intervalMs)
  timer.unref()
  child.once('close', () => { stopped = true; clearInterval(timer) })
  return { status: 'monitoring' }
}
