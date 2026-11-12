import { orderSuiteLockTickets as legacyOrder, numericLevel } from './suite-lock-legacy-order.mjs'
export { LIGHT_BYPASS_MAX_GRANTS, P0_BYPASS_MAX_GRANTS, BOUNDED_P0_ORDER_VERSION, effectiveLevel, numericLevel, waitedMilliseconds } from './suite-lock-legacy-order.mjs'
import { LIGHT_BYPASS_MAX_GRANTS } from './suite-lock-legacy-order.mjs'
import { displayText } from './suite-lock-display.mjs'
import { compareKeys, normalizeSuiteLockProject, ticketPassable } from './suite-lock-rank-common.mjs'

export const SUITE_LOCK_ORDER_VERSION = 3

function tierFor(record, project, precedence, now) {
  if (record.priority === 'release') return 0
  return Date.parse(precedence?.[project]?.until) > now ? 1 : 2
}

function reasonLine(reason, number) {
  const bonus = reason.sizeBonus ? ' +1' : reason.bonusWithheld ? ' bonus withheld (previous S overrun)' : ' +0'
  const tier = ['release', 'project precedence', 'normal'][reason.tier]
  return `rank P${reason.rankLevel} (declared P${reason.declared}, size ${reason.size}${bonus}), project ${reason.project}, turn ${reason.projectTurn}, ticket ${number}, tier ${tier}, ${reason.light ? 'light' : 'exclusive'}, ${reason.passable ? 'light-passable' : 'bounded lane'}`
}

function sizeFacts(record, history, project) {
  const size = ['S', 'M', 'L'].includes(record.size) ? record.size : 'L'
  const bonusWithheld = record.light !== true && size === 'S' && history[project]?.overran === true
  const sizeBonus = record.light !== true && size === 'S' && !bonusWithheld
  return { size, bonusWithheld, sizeBonus }
}

function rankFacts(record, context) {
  const { lightCounter, turns = {}, history = {}, precedence = {}, now } = context
  const project = normalizeSuiteLockProject(record.project)
  const { size, bonusWithheld, sizeBonus } = sizeFacts(record, history, project)
  const rankLevel = Math.max(0, record.level - Number(sizeBonus))
  const passable = ticketPassable(record, lightCounter, LIGHT_BYPASS_MAX_GRANTS)
  const projectTurn = Object.hasOwn(turns, project) ? turns[project] : 0
  const tier = tierFor(record, project, precedence, now)
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

function legacyReason(ticket) {
  const record = ticket.record ?? {}
  const declared = numericLevel(record.level) ? `P${record.level}` : 'unspecified'
  const level = numericLevel(ticket.effectiveLevel) ? `P${ticket.effectiveLevel}` : 'compatibility'
  const size = record.size ?? 'L'
  const project = record.project ?? 'unspecified (older client)'
  const line = displayText(`rank ${level} (declared ${declared}, size ${size} bonus inactive in legacy order), project ${project}, ticket ${ticket.number}, project alternation inactive`)
  return { declared: record.level, rankLevel: ticket.effectiveLevel, project, size, sizeBonus: false, line }
}

// Preserve each light's ticket-number slot. Only exhausted exclusives within the same
// tier and level exchange slots, using a permutation derived entirely from this snapshot.
function alternateExhausted(ranked) {
  const groups = new Map()
  for (const [index, ticket] of ranked.entries()) {
    if (ticket.key[2] !== 0 || ticket.reason.light) continue
    const group = `${ticket.key[0]}:${ticket.key[1]}`
    if (!groups.has(group)) groups.set(group, { slots: [], tickets: [] })
    groups.get(group).slots.push(index)
    groups.get(group).tickets.push(ticket)
  }
  for (const { slots, tickets } of groups.values()) {
    tickets.sort((a, b) => a.reason.projectTurn - b.reason.projectTurn || a.number - b.number)
    slots.forEach((slot, index) => { ranked[slot] = tickets[index] })
  }
  return ranked
}

export function orderSuiteLockTickets(tickets, counter, now, p0Counter, context = {}) {
  if (!tickets.every(({ record }) => numericLevel(record?.level) && typeof record.levelOrderVersion === 'number' && record.levelOrderVersion >= SUITE_LOCK_ORDER_VERSION)) {
    const ordered = legacyOrder(tickets, counter, now, p0Counter)
    return { ...ordered, tickets: ordered.tickets.map((ticket) => ({ ...ticket, reason: legacyReason(ticket) })) }
  }
  const snapshot = { ...context, lightCounter: context.lightCounter ?? counter, now }
  const ranked = tickets.map((ticket) => ({ ...ticket, ...rankSuiteLockTicket(ticket, snapshot) }))
  ranked.sort(compareKeys)
  return { order: 'levels', levelOrder: 'rank-v3', tickets: alternateExhausted(ranked) }
}
