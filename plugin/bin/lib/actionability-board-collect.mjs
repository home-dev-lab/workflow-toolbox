import { remainingMilliseconds } from './actionability-refresh-deadline.mjs'

const PAGE_SIZE = 5000
const MAX_SCANS = 3

function unstable(reason) {
  const error = new Error(reason)
  error.unstable = true
  throw error
}

function checkMetadata(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.cards)) throw new Error('find_cards response has no cards[] array')
  if (!Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset) || result.offset < 0) {
    throw new Error('find_cards response has invalid pagination metadata')
  }
}

function pageShape(result, offset, total) {
  checkMetadata(result)
  if (result.offset !== offset) unstable(`find_cards returned offset ${result.offset}, expected ${offset}`)
  if (total !== null && result.total !== total) unstable(`find_cards total changed from ${total} to ${result.total} during refresh`)
  if (result.cards.length > PAGE_SIZE) unstable(`find_cards returned ${result.cards.length} cards for a ${PAGE_SIZE}-card page`)
  if (result.cards.length === 0 && offset < result.total) unstable('find_cards returned an empty page before total was reached')
  return result
}

async function scanCards(fetchPage, deadlineAt) {
  const cards = []
  let total = null
  let pages = 0
  while (total === null || cards.length < total) {
    remainingMilliseconds(deadlineAt, 'board acquisition')
    const page = pageShape(await fetchPage(cards.length, PAGE_SIZE), cards.length, total)
    total = page.total
    cards.push(...page.cards)
    pages++
    if (cards.length > total) unstable(`find_cards returned ${cards.length} cards for total ${total}`)
  }
  const ids = cards.map((card) => String(card?.id ?? ''))
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) unstable('find_cards pages contain a missing or duplicate card id')
  return { cards, pages }
}

function fingerprint(cards) {
  return JSON.stringify(cards.map((card) => [String(card.id), card.listId, card.updatedAt, String(card.description ?? '').length])
    .sort((a, b) => a[0].localeCompare(b[0])))
}

export async function collectCompleteCards(fetchPage, { deadlineAt } = {}) {
  let previous = null
  let reason = 'complete scans did not agree'
  for (let scan = 0; scan < MAX_SCANS; scan++) {
    try {
      const { cards, pages } = await scanCards(fetchPage, deadlineAt)
      if (pages === 1) return cards
      const current = fingerprint(cards)
      if (current === previous) return cards
      previous = current
      reason = 'complete scans did not agree on card id, listId, updatedAt, description length'
    } catch (error) {
      if (!error.unstable) throw error
      reason = error.message
      previous = null
    }
  }
  throw new Error(`board kept changing over ${MAX_SCANS} scans (${reason})`)
}
