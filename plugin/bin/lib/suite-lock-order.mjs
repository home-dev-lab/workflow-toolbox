import { orderSuiteLockTickets as legacyOrder, numericLevel } from './suite-lock-legacy-order.mjs'
export { LIGHT_BYPASS_MAX_GRANTS, P0_BYPASS_MAX_GRANTS, BOUNDED_P0_ORDER_VERSION, effectiveLevel, numericLevel, waitedMilliseconds } from './suite-lock-legacy-order.mjs'
import { LIGHT_BYPASS_MAX_GRANTS } from './suite-lock-legacy-order.mjs'
import { displayText } from './suite-lock-display.mjs'
import { compareKeys, normalizeSuiteLockProject, ticketPassable } from './suite-lock-rank-common.mjs'

export const SUITE_LOCK_ORDER_VERSION = 4

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

/** Pure rank facts; the block merge below enforces project turns and bounded light passes. */
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

function mergeRankBlock(tickets) {
  const exclusive = tickets.filter((ticket) => !ticket.reason.light)
    .sort((a, b) => a.reason.projectTurn - b.reason.projectTurn || a.number - b.number)
  const lights = tickets.filter((ticket) => ticket.reason.light).sort((a, b) => a.number - b.number)
  const ordered = []
  while (exclusive.length || lights.length) {
    const blocked = lights.length && exclusive.some((ticket) => !ticket.reason.passable && ticket.number < lights[0].number)
    ordered.push(lights.length && !blocked ? lights.shift() : exclusive.shift())
  }
  return ordered
}

// Each tier/level is independent. All exclusives share project-turn order; a light
// may pass them only while no earlier exhausted exclusive remains in this snapshot.
function mergeRankBlocks(ranked) {
  const groups = new Map()
  for (const ticket of ranked) {
    const group = `${ticket.key[0]}:${ticket.key[1]}`
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(ticket)
  }
  return [...groups.values()].flatMap(mergeRankBlock)
}

export function orderSuiteLockTickets(tickets, counter, now, p0Counter, context = {}) {
  if (!tickets.every(({ record }) => numericLevel(record?.level) && typeof record.levelOrderVersion === 'number' && record.levelOrderVersion >= SUITE_LOCK_ORDER_VERSION)) {
    const ordered = legacyOrder(tickets, counter, now, p0Counter)
    return { ...ordered, tickets: ordered.tickets.map((ticket) => ({ ...ticket, reason: legacyReason(ticket) })) }
  }
  const snapshot = { ...context, lightCounter: context.lightCounter ?? counter, now }
  const ranked = tickets.map((ticket) => ({ ...ticket, ...rankSuiteLockTicket(ticket, snapshot) }))
  ranked.sort(compareKeys)
  return { order: 'levels', levelOrder: 'rank-v4', tickets: mergeRankBlocks(ranked) }
}
