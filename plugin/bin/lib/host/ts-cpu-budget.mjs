// Accepted over-budget intervals; missing evidence pauses, bounded gaps reset.
export const TS_CPU_BUDGET_PCT = 100
export const TS_CPU_WINDOW_MS = 120_000
export const TS_CPU_SAMPLE_MS = 5000

function advance(prior, server, now, options) {
  const elapsed = prior ? now - prior.at : 0
  const delta = prior ? server.cpuMs - prior.cpuMs : 0
  const anchor = { at: now, cpuMs: server.cpuMs, overMs: 0, percent: 0 }
  if (!prior || elapsed <= 0 || elapsed > options.maxGapMs || delta < 0) return anchor
  const percent = delta / elapsed * 100
  // Neither the outage nor the recovery interval contributes time or CPU.
  // A measured at-or-under-budget recovery still disproves a sustained streak.
  if (prior.paused) return { ...anchor, overMs: percent > options.budgetPct ? prior.overMs : 0 }
  return { ...anchor, percent, overMs: percent > options.budgetPct ? prior.overMs + elapsed : 0 }
}

function pause(prior, now, maxGapMs) {
  if (!prior || now - prior.at > maxGapMs) return undefined
  return { ...prior, paused: true }
}

function retainMissing(previous, next, now, maxGapMs) {
  for (const [key, prior] of previous) {
    if (next.has(key)) continue
    const state = pause(prior, now, maxGapMs)
    if (state) next.set(key, state)
  }
  return next
}

const containsMembers = (members, subset) => subset.every((server) => members.some((member) => member.identity === server.identity))
const regressed = (members, servers) => members.some((before) => servers.some((server) => server.identity === before.identity && server.cpuMs < before.cpuMs))
const provablyIdle = (members, servers) => containsMembers(servers, members) && servers.every((server) => server.cpuMs === (members.find((before) => before.identity === server.identity)?.cpuMs ?? 0))

function familyContinuity(prior, servers, parent, now, maxGapMs) {
  if (!prior || prior.parent !== parent.identity || now - prior.at > maxGapMs) return { reset: true }
  const subset = containsMembers(prior.members, servers)
  return { reset: regressed(prior.members, servers),
    stable: subset && servers.length === prior.members.length,
    missing: subset && servers.length < prior.members.length }
}

function advanceFamily(prior, sample, now, options) {
  const { servers, parent } = sample
  const continuity = familyContinuity(prior, servers, parent, now, options.maxGapMs)
  if (continuity.missing && !continuity.reset) return pause(prior, now, options.maxGapMs)
  if (!servers.length) return undefined
  const cpuMs = servers.reduce((sum, server) => sum + server.cpuMs, 0)
  // A changed membership invalidates this delta, not already accepted intervals.
  const state = advance(continuity.stable && !continuity.reset ? prior : undefined, { cpuMs }, now, options)
  if (!continuity.stable && !continuity.reset && !provablyIdle(prior.members, servers)) state.overMs = prior.overMs
  return { ...state, parent: parent.identity, members: servers }
}

function breached(state, options) {
  return state && !state.paused && state.percent > options.budgetPct && state.overMs >= options.windowMs
}

function advanceServers(previous, sample, now, options) {
  const next = new Map()
  let breach
  for (const server of sample.servers) {
    const key = `${sample.parent.identity}/${server.identity}`
    const state = advance(previous.get(key), server, now, options)
    next.set(key, state)
    if (breached(state, options)) breach ??= { scope: 'server', server, servers: [server], percent: state.percent, overMs: state.overMs }
  }
  return { next: retainMissing(previous, next, now, options.maxGapMs), breach }
}

// One core is 100%; multicore CPU is deliberately not divided by host core count.
export function createTsCpuBudget({ budgetPct = TS_CPU_BUDGET_PCT, windowMs = TS_CPU_WINDOW_MS, maxGapMs = 3 * TS_CPU_SAMPLE_MS } = {}) {
  const options = { budgetPct, windowMs, maxGapMs }
  let previous = new Map(), family
  return (sample, now) => {
    if (sample.status !== 'measured') {
      previous = retainMissing(previous, new Map(), now, maxGapMs)
      family = pause(family, now, maxGapMs)
      return undefined
    }
    const { next, breach } = advanceServers(previous, sample, now, options)
    family = advanceFamily(family, sample, now, options)
    previous = next
    if (!breach && breached(family, options)) return { scope: 'family', server: sample.servers[0], servers: sample.servers, percent: family.percent, overMs: family.overMs }
    return breach
  }
}
