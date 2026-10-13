// Queue policy is pure: one snapshot and one clock produce one service order.
export const LIGHT_BYPASS_MAX_GRANTS = 8
// Declared P0 versus aging. Aging alone lifts every P1/P2 ticket to P0 within an hour, after which a declared
// P0 orders nothing. A P1/P2 ticket is therefore floored at P1 while fewer than P0_BYPASS_MAX_GRANTS declared-P0
// admissions have been counted (lock root `p0-grants`) since it queued. The bound: beyond FIFO-with-aging, such
// a ticket is passed by at most 16 counted P0 admissions (each one P0 hold), plus the existing light and release
// passes; after the 16th it ages to P0 and joins the P0 tickets in ticket-number order. A P0 admission whose
// count cannot be written removes the counter instead, which resets the floor of EVERY waiting ticket (none is
// P0-passable any more, so all age as before); if the removal fails too, the admission fails. A lost or replaced
// counter likewise makes a ticket not passable: its priority is erased, it is never starved. A count bound, not a time bound: in a backed-up
// queue every ticket is old, and a time bound would erase declared priority exactly when it matters.
export const P0_BYPASS_MAX_GRANTS = 16
// Every ticket written by a client that orders by the bounded key carries this marker. While any live ticket
// lacks it, every client orders by the legacy key, which is exactly what the older client computes.
export const BOUNDED_P0_ORDER_VERSION = 2
const LEVEL_AGING_STEP_MS = 30 * 60 * 1000
// No environment or process-local setting may change this machine-wide aging step.
export const numericLevel = (level) => Number.isInteger(level) && level >= 0 && level <= 2
const isOlderClientTicket = (record) => !(record && (record.light === true || 'lightGrantsAtQueue' in record))
const NO_COUNTER = { generation: null, grants: 0 }

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

function p0Passable(record, p0Counter) {
  const queuedAt = record.p0GrantsAtQueue
  return typeof record.p0GrantsGeneration === 'string' && record.p0GrantsGeneration === p0Counter.generation
    && Number.isSafeInteger(queuedAt) && p0Counter.grants >= queuedAt && p0Counter.grants - queuedAt < P0_BYPASS_MAX_GRANTS
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

// The level a ticket is ordered by under the bounded key: a declared P0 stays 0, a P1/P2 ages no lower than P1
// while it is still P0-passable.
function boundedLevel(record, now, p0Counter) {
  const aged = effectiveLevel(record, now)
  if (record.level === 0) return aged
  return Math.max(p0Passable(record, p0Counter) ? 1 : 0, aged)
}

function levelRank(record, counter, now) {
  // Every exclusive becomes unpassable after one aging step, including declared P0.
  // Release remains above them: starvation protection assumes finite release arrivals.
  const waited = waitedMilliseconds(record.startedAt, now)
  if (record.priority !== 'release' && record.light !== true && (waited === null || waited >= LEVEL_AGING_STEP_MS)) return 0
  return ticketRank(record, counter)
}

const boundedTicket = ({ record }) => typeof record.levelOrderVersion === 'number' && record.levelOrderVersion >= BOUNDED_P0_ORDER_VERSION

// The key every client of one mode computes identically; `level` is the level the ticket is ordered by.
function sortKey(mode, { number, record }, counter, now) {
  if (mode.compatible) return { key: [0, mode.byNumberOnly ? 0 : ticketRank(record, counter), number] }
  const level = mode.bounded ? boundedLevel(record, now, mode.p0Counter) : effectiveLevel(record, now)
  return { key: [record.priority === 'release' ? -1 : level, levelRank(record, counter, now), number], effectiveLevel: level }
}

function compareKeys(left, right) {
  for (let index = 0; index < left.key.length; index += 1) {
    const difference = left.key[index] - right.key[index]
    if (difference !== 0) return difference
  }
  return 0
}

function levelOrderName(mode) {
  if (mode.compatible) return null
  return mode.bounded ? 'bounded-p0' : 'legacy'
}

export function orderSuiteLockTickets(tickets, counter, now, p0Counter = NO_COUNTER) {
  tickets = tickets.map((ticket) => ({ ...ticket, record: ticket.record && typeof ticket.record === 'object' ? ticket.record : null }))
  const compatible = tickets.some(({ record }) => !numericLevel(record?.level))
  const mode = { compatible, byNumberOnly: compatible && tickets.some(({ record }) => isOlderClientTicket(record)),
    bounded: !compatible && tickets.every(boundedTicket), p0Counter }
  const ranked = tickets.map((ticket) => ({ ...ticket, ...sortKey(mode, ticket, counter, now) }))
  ranked.sort(compareKeys)
  return { order: compatible ? 'compatible' : 'levels', levelOrder: levelOrderName(mode), tickets: ranked }
}
