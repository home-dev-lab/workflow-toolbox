// A bounded run of consecutive over-budget samples, independent of server requests.
export const TS_CPU_BUDGET_PCT = 100
export const TS_CPU_WINDOW_MS = 120_000
export const TS_CPU_SAMPLE_MS = 5000

function advance(prior, server, now, budgetPct) {
  const elapsed = prior ? now - prior.at : 0
  const delta = prior ? server.cpuMs - prior.cpuMs : 0
  const percent = elapsed > 0 ? delta / elapsed * 100 : 0
  const overMs = delta >= 0 && percent > budgetPct ? (prior?.overMs ?? 0) + elapsed : 0
  return { at: now, cpuMs: server.cpuMs, overMs, percent }
}

// One core is 100%; multicore CPU is deliberately not divided by host core count.
export function createTsCpuBudget({ budgetPct = TS_CPU_BUDGET_PCT, windowMs = TS_CPU_WINDOW_MS } = {}) {
  let previous = new Map()
  return (sample, now) => {
    const next = new Map()
    let breach
    if (sample.status === 'measured') for (const server of sample.servers) {
      const key = `${sample.parent.identity}/${server.identity}`
      const state = advance(previous.get(key), server, now, budgetPct)
      next.set(key, state)
      if (state.overMs >= windowMs) breach ??= { server, percent: state.percent, overMs: state.overMs }
    }
    previous = next
    return breach
  }
}
