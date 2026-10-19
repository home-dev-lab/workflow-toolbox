import { displayArgv, displayText } from './suite-lock-display.mjs'
import { effectiveLevel, numericLevel, orderSuiteLockTickets, waitedMilliseconds } from './suite-lock-order.mjs'
import { suiteLockLightHoldSeconds, suiteLockLongHoldSeconds } from './suite-lock-priority.mjs'

const finite = (value) => Number.isFinite(value) ? value : null
const pidNumber = (value) => Number.isSafeInteger(value) && value > 0 ? value : null
const OLDER_BROKER_QUEUE = 'queue unavailable from an older broker'
const LEGACY_LEVEL_ORDER = 'queue legacy level order: a queued client predates bounded P0 order; declared P0 does not pass aged tickets until it leaves'
function safeValue(value, depth = 0) {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return displayText(value)
  if (typeof value === 'number') return finite(value)
  if (Array.isArray(value)) return value.map((field) => safeValue(field, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [displayText(key), safeValue(field, depth + 1)]))
  }
  return value
}
function safeArgv(argv) {
  if (!Array.isArray(argv)) return null
  return argv.map((field) => field !== null && typeof field === 'object' ? '[unknown]' : displayText(field))
}
function safeHolder(holder) {
  if (!holder) return null
  const fields = safeValue(holder)
  return { ...fields, pid: pidNumber(holder.pid), level: numericLevel(holder.level) ? holder.level : null,
    argv: safeArgv(holder.argv),
    startedAt: typeof holder.startedAt === 'string' ? displayText(holder.startedAt) : undefined,
    startTime: finite(holder.startTime) }
}

// An ordered ticket shows the level it was ordered by; stale tickets and compatible order recompute it.
function queueEntry(ticket, position, now) {
  const record = ticket.record
  return { position, number: finite(ticket.number), pid: pidNumber(record?.pid),
    level: numericLevel(record?.level) ? record.level : null,
    effectiveLevel: ticket.effectiveLevel === undefined ? effectiveLevel(record, now) : ticket.effectiveLevel,
    light: record?.light === true, release: record?.priority === 'release',
    waitedMs: waitedMilliseconds(record?.startedAt, now), stale: ticket.stale, argv: displayArgv(safeArgv(record?.argv)) }
}

export function suiteLockStatusSnapshot(current, tickets, counter, now, env, p0Counter) {
  const live = tickets.filter((ticket) => !ticket.stale)
  const ordered = orderSuiteLockTickets(live, counter, now, p0Counter)
  const stale = tickets.filter((ticket) => ticket.stale).sort((left, right) => left.number - right.number)
  const ageMs = current.held ? waitedMilliseconds(current.holder?.startedAt, now) : null
  const longHoldBoundS = suiteLockLongHoldSeconds(env)
  const lightHoldBoundS = suiteLockLightHoldSeconds(env)
  return { ...current, holder: safeHolder(current.holder), ageMs, level: numericLevel(current.holder?.level) ? current.holder.level : null,
    lightPastClass: current.holder?.light === true && ageMs !== null && ageMs > lightHoldBoundS * 1000, lightHoldBoundS,
    longHold: ageMs !== null && ageMs > longHoldBoundS * 1000, longHoldBoundS, order: ordered.order, levelOrder: ordered.levelOrder,
    queue: [...ordered.tickets, ...stale].map((ticket, index) => queueEntry(ticket, index + 1, now)) }
}

function formatSuiteLockDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

function queueLevel(entry) {
  const level = numericLevel(entry.effectiveLevel) ? `P${entry.effectiveLevel}` : 'level unspecified'
  const declared = entry.level !== entry.effectiveLevel && numericLevel(entry.level) ? ` (declared P${entry.level})` : ''
  return level + declared
}
function queueKind(entry) {
  if (entry.release) return 'release'
  return entry.light ? 'light' : 'exclusive'
}
function queueLine(entry) {
  return `  ${finite(entry.position) ?? 'unknown'}. ${queueLevel(entry)} ${queueKind(entry)}${entry.stale ? ' stale' : ''}, pid ${pidNumber(entry.pid) ?? 'unknown'}, waiting ${formatSuiteLockDuration(entry.waitedMs)} (${displayText(entry.argv)})`
}
function holderHeadline(current, holderText) {
  const level = numericLevel(current.level) ? ', P' + current.level : ''
  const suffix = `, held ${formatSuiteLockDuration(current.ageMs)}${level}`
  return current.stale ? `suite lock held by a stale holder (gone or expired): ${holderText}${suffix}; \`wt-suite-lock release\` clears it` : `suite lock held: ${holderText}${suffix}`
}
function longHoldLine(current) {
  return `long hold: pid ${pidNumber(current.holder?.pid) ?? 'unknown'} held ${formatSuiteLockDuration(current.ageMs)}, above the ${finite(current.longHoldBoundS) ?? 'unknown'} s bound; the lock never pre-empts a holder`
}

function lightHoldLine(current) {
  return `light lease past its class: pid ${pidNumber(current.holder?.pid) ?? 'unknown'} held ${formatSuiteLockDuration(current.ageMs)}, above the ${finite(current.lightHoldBoundS) ?? 'unknown'} s bound (${displayArgv(safeArgv(current.holder?.argv))}); the lock never pre-empts a holder`
}

function orderLines(current) {
  if (current.order === 'compatible') return ['queue compatibility order: exact older-client ordering while a live ticket has no level']
  return current.order === 'levels' && current.levelOrder === 'legacy' ? [LEGACY_LEVEL_ORDER] : []
}

export function formatSuiteLockStatus(current, holderText) {
  const queue = Array.isArray(current.queue) ? current.queue : []
  const waiting = queue.filter((entry) => !entry.stale).length
  const free = waiting ? `suite lock free; ${waiting} wait` : 'suite lock free'
  const lines = [current.legacyStatus ?? (current.held ? holderHeadline(current, holderText) : free)]
  if (current.longHold) lines.push(longHoldLine(current))
  if (current.lightPastClass && !current.stale) lines.push(lightHoldLine(current))
  lines.push(...orderLines(current))
  if (!Array.isArray(current.queue)) lines.push(OLDER_BROKER_QUEUE)
  lines.push(...queue.map(queueLine))
  return lines.map(displayText).join('\n') + '\n'
}

export function suiteLockStatusJson(current) {
  const { held, holder, stale, ageMs, level, longHold, longHoldBoundS, lightPastClass, lightHoldBoundS, order, levelOrder, queue } = current
  const status = current.legacyStatus ?? (Array.isArray(queue) ? null : OLDER_BROKER_QUEUE)
  return { held, holder: safeHolder(holder), ...(stale === undefined ? {} : { stale }), ageMs, level, longHold, longHoldBoundS, lightPastClass, lightHoldBoundS, order,
    ...(levelOrder === undefined ? {} : { levelOrder }), queue: Array.isArray(queue) ? safeValue(queue) : null, ...(status ? { status: displayText(status) } : {}) }
}
