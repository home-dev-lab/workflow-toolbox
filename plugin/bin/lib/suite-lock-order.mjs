// Queue policy is pure: one snapshot and one clock produce one service order.
export const LIGHT_BYPASS_MAX_GRANTS = 8
const LEVEL_AGING_STEP_MS = 30 * 60 * 1000
// No environment or process-local setting may change this machine-wide aging step.
export const numericLevel = (level) => Number.isInteger(level) && level >= 0 && level <= 2
const isOlderClientTicket = (record) => !(record && (record.light === true || 'lightGrantsAtQueue' in record))

function ticketRank(record, counter) {
  if (record?.priority === 'release') return -1
  if (record?.light === true) return 0
  return ticketPassable(record, counter) ? 1 : 0
}

function ticketPassable(record, counter) {
  const queuedAt = record?.lightGrantsAtQueue
  return typeof record?.lightGrantsGeneration === 'string' && record.lightGrantsGeneration === counter.generation
    && Number.isSafeInteger(queuedAt) && counter.grants >= queuedAt && counter.grants - queuedAt < LIGHT_BYPASS_MAX_GRANTS
}

export function waitedMilliseconds(startedAt, now) {
  const since = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN
  return Number.isFinite(since) ? Math.max(0, now - since) : null
}

export function effectiveLevel(record, now) {
  if (!numericLevel(record?.level)) return null
  const waited = waitedMilliseconds(record.startedAt, now)
  return waited === null ? 0 : Math.max(0, record.level - Math.floor(waited / LEVEL_AGING_STEP_MS))
}

function levelRank(record, counter, now) {
  // Fully aged tickets cannot be passed again, even by new P0 light arrivals.
  // Release remains above them: starvation protection assumes finite release arrivals.
  if (record.level > 0 && effectiveLevel(record, now) === 0) return 0
  return ticketRank(record, counter)
}

export function orderSuiteLockTickets(tickets, counter, now) {
  const compatible = tickets.some(({ record }) => !numericLevel(record?.level))
  const byNumberOnly = compatible && tickets.some(({ record }) => isOlderClientTicket(record))
  const key = ({ number, record }) => {
    if (compatible) return [0, byNumberOnly ? 0 : ticketRank(record, counter), number]
    return [record.priority === 'release' ? -1 : effectiveLevel(record, now), levelRank(record, counter, now), number]
  }
  const ranked = tickets.map((ticket) => ({ ...ticket, key: key(ticket) }))
  ranked.sort((left, right) => {
    for (let index = 0; index < left.key.length; index += 1) {
      const difference = left.key[index] - right.key[index]
      if (difference !== 0) return difference
    }
    return 0
  })
  return { order: compatible ? 'compatible' : 'levels', tickets: ranked }
}
