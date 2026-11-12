import { orderSuiteLockTickets as legacyOrder, numericLevel } from './suite-lock-legacy-order.mjs'
export { LIGHT_BYPASS_MAX_GRANTS, P0_BYPASS_MAX_GRANTS, BOUNDED_P0_ORDER_VERSION, effectiveLevel, numericLevel, waitedMilliseconds } from './suite-lock-legacy-order.mjs'
import { LIGHT_BYPASS_MAX_GRANTS } from './suite-lock-legacy-order.mjs'
import { displayText } from './suite-lock-display.mjs'

export const SUITE_LOCK_ORDER_VERSION = 3

function lightPassable(record, counter) {
  return typeof record.lightGrantsGeneration === 'string' && record.lightGrantsGeneration === counter?.generation
    && Number.isSafeInteger(record.lightGrantsAtQueue) && counter.grants >= record.lightGrantsAtQueue
    && counter.grants - record.lightGrantsAtQueue < LIGHT_BYPASS_MAX_GRANTS
}

function tierFor(record, precedence, now) {
  if (record.priority === 'release') return 0
  return Date.parse(precedence?.[record.project]?.until) > now ? 1 : 2
}

function reasonLine(reason, number) {
  const bonus = reason.sizeBonus ? ' +1' : reason.bonusWithheld ? ' bonus withheld (previous S overrun)' : ' +0'
  const tier = ['release', 'project precedence', 'normal'][reason.tier]
  return `rank P${reason.rankLevel} (declared P${reason.declared}, size ${reason.size}${bonus}), project ${reason.project}, turn ${reason.projectTurn}, ticket ${number}, tier ${tier}, ${reason.light ? 'light' : 'exclusive'}, ${reason.passable ? 'light-passable' : 'bounded lane'}`
}

function rankFacts(record, context) {
  const { lightCounter, turns = {}, history = {}, precedence = {}, now } = context
  const project = typeof record.project === 'string' ? record.project : ''
  const size = ['S', 'M', 'L'].includes(record.size) ? record.size : 'L'
  const bonusWithheld = size === 'S' && history[project]?.overran === true
  const sizeBonus = size === 'S' && !bonusWithheld
  const rankLevel = Math.max(0, record.level - Number(sizeBonus))
  const passable = lightPassable(record, lightCounter)
  const projectTurn = Object.hasOwn(turns, project) ? turns[project] : 0
  const tier = tierFor(record, precedence, now)
  return { tier, declared: record.level, rankLevel, size, sizeBonus, bonusWithheld,
    light: record.light === true, passable, project, projectTurn }
}

/** Pure v3 key: all clients rank the same ticket against the same shared snapshot. */
export function rankSuiteLockTicket({ number, record }, context) {
  const reason = rankFacts(record, context)
  const lane = reason.light || !reason.passable ? 0 : 1
  reason.line = displayText(reasonLine(reason, number))
  return { key: [reason.tier, reason.rankLevel, lane, lane === 0 ? 0 : reason.projectTurn, number], reason, effectiveLevel: reason.rankLevel }
}

function compareKeys(left, right) {
  for (let index = 0; index < left.key.length; index += 1) {
    const difference = left.key[index] - right.key[index]
    if (difference !== 0) return difference
  }
  return 0
}

function legacyReason(ticket) {
  const record = ticket.record ?? {}
  const declared = numericLevel(record.level) ? `P${record.level}` : 'unspecified'
  const level = numericLevel(ticket.effectiveLevel) ? `P${ticket.effectiveLevel}` : 'compatibility'
  const size = record.size ?? 'L'
  const project = record.project ?? 'unspecified (older client)'
  const tier = record.priority === 'release' ? 0 : 2
  const line = displayText(`rank ${level} (declared ${declared}, size ${size} bonus inactive in legacy order), project ${project}, ticket ${ticket.number}, tier ${tier === 0 ? 'release' : 'normal'}, project alternation inactive`)
  return { tier, declared: record.level, rankLevel: ticket.effectiveLevel, project, size, sizeBonus: false, line }
}

export function orderSuiteLockTickets(tickets, counter, now, p0Counter, context = {}) {
  if (!tickets.every(({ record }) => numericLevel(record?.level) && typeof record.levelOrderVersion === 'number' && record.levelOrderVersion >= SUITE_LOCK_ORDER_VERSION)) {
    const ordered = legacyOrder(tickets, counter, now, p0Counter)
    return { ...ordered, tickets: ordered.tickets.map((ticket) => ({ ...ticket, reason: legacyReason(ticket) })) }
  }
  const snapshot = { ...context, lightCounter: context.lightCounter ?? counter, now }
  const ranked = tickets.map((ticket) => ({ ...ticket, ...rankSuiteLockTicket(ticket, snapshot) }))
  ranked.sort(compareKeys)
  return { order: 'levels', levelOrder: 'rank-v3', tickets: ranked }
}
