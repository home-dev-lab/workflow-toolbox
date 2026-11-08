import { randomUUID } from 'node:crypto'
import { hasDependsOnLine, parseDependsOn } from './depends-on-parser.mjs'

export { resolveBoardPointer } from './host/board-pointer.mjs'

export class BoardUnavailable extends Error {
  constructor(detail, status) {
    super(`board unavailable: ${detail}`)
    this.name = 'BoardUnavailable'
    if (status !== undefined) this.status = status
  }
}

// A failure raised before tools/call was sent. A fresh object each time: marking an error object the
// caller's fetch adapter may reuse would leak the mark into a later call that did reach the server.
class ToolNotSent extends BoardUnavailable {
  constructor(detail, status) {
    super(detail, status)
    this.toolNotSent = true
  }

  static from(error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/^board unavailable: /, '')
    const notSent = new ToolNotSent(detail, error?.status)
    if (error?.transport === true) notSent.transport = true
    return notSent
  }
}

// Only the request itself failing (no connection, or a non-OK HTTP status) is a transport failure.
// Every other BoardUnavailable is an answer the endpoint gave that could not be read.
function transportFailure(detail, status) {
  const failure = new BoardUnavailable(detail, status)
  failure.transport = true
  return failure
}

const TEXT_TOLERANT_TOOLS = new Set(['add_label_to_card', 'remove_label_from_card', 'add_comment', 'move_card'])

function routingIdentifier(value, label) {
  const id = String(value ?? '')
  // The lifecycle's existing identifier contract permits numeric board ids and filename-safe tokens.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new BoardUnavailable(`invalid ${label}`)
  return id
}

// JSON's escape token is a language constant, not the host's path separator.
const JSON_BACKSLASH = String.fromCharCode(92)
function provenanceValue(value) {
  return JSON.stringify(String(value)).replaceAll('\u2028', () => `${JSON_BACKSLASH}u2028`).replaceAll('\u2029', () => `${JSON_BACKSLASH}u2029`)
}

function independentRoutedDescription(description) {
  if (typeof description !== 'string') return false
  const declarations = description.split(/\r\n|[\r\n\u2028\u2029]/).filter(hasDependsOnLine)
  const parsed = parseDependsOn(description)
  return declarations.length === 1 && declarations[0].trim() === 'Depends-on: none'
    && parsed.ids.length === 0 && parsed.unparseable.length === 0
}

function routedDescription({ originCardId, sessionTag, l4Reason, timestamp }) {
  const description = ['Depends-on: none', '', '## Provenance',
    `Origin card: ${provenanceValue(routingIdentifier(originCardId, 'origin card id'))}`,
    `run/session: ${provenanceValue(sessionTag)}`,
    `L4 reason: ${provenanceValue(l4Reason)}`,
    `timestamp: ${provenanceValue(timestamp)}`,
    // Opaque per-call identity: a card written before this call cannot carry it, so reconciliation never adopts a copy.
    `Routing key: ${provenanceValue(randomUUID())}`,
  ].join('\n')
  if (!independentRoutedDescription(description)) throw new BoardUnavailable('invalid assembled routed dependency description; no card created')
  return description
}

function cardDescription(card) {
  return card?.description ?? card?.card?.description
}

async function verifiedRoutedDescription(created, cardId, call) {
  let description = cardDescription(created)
  if (typeof description !== 'string') {
    try {
      const readBack = await call('get_card', { cardId })
      description = cardDescription(readBack)
    } catch (error) {
      return { dependencyVerified: false, dependencyVerificationReason: `created card ${cardId} read-back failed: ${error.message}; do not retry creation` }
    }
  }
  if (!independentRoutedDescription(description)) {
    return { description, dependencyVerified: false, dependencyVerificationReason: `created card ${cardId} dependency verification failed: expected exactly one canonical Depends-on: none declaration; do not retry creation` }
  }
  return { description, dependencyVerified: true }
}

function routedProvenanceLines(description) {
  return description.split('\n').filter((line) => ['run/session: ', 'timestamp: ', 'Routing key: '].some((prefix) => line.startsWith(prefix)))
}

// The live board server removes every Depends-on line, trims leading blank lines and appends the
// canonical line at the end (mcp-planka applyDependsOn), so a stored routed card starts with its
// provenance section. Compare that leading section only: a quoted or fenced copy further down
// cannot supply identity. Indices follow routedDescription.
const SERVER_DEPENDS_ON_LINE = /^\s*Depends-on:.*$/i
const PROVENANCE = { heading: 0, origin: 1, session: 2, reason: 3, timestamp: 4, routingKey: 5 }

function leadingProvenance(description) {
  const lines = description.split(/\r\n|[\r\n\u2028\u2029]/).filter((line) => !SERVER_DEPENDS_ON_LINE.test(line))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  return lines
}

function matchesRoutedCard(card, request) {
  if (!card?.id || (card.name ?? card.title) !== request.name) return false
  const description = cardDescription(card)
  if (typeof description !== 'string') return false
  const lines = leadingProvenance(description)
  const expected = leadingProvenance(request.description)
  return [PROVENANCE.heading, PROVENANCE.session, PROVENANCE.timestamp, PROVENANCE.routingKey].every((index) => lines[index] === expected[index])
}

function collectRoutedMatches(cards, request, matches) {
  const expected = leadingProvenance(request.description)
  for (const card of cards) {
    if (!matchesRoutedCard(card, request)) continue
    const lines = leadingProvenance(cardDescription(card))
    if (lines[PROVENANCE.origin] !== expected[PROVENANCE.origin] || lines[PROVENANCE.reason] !== expected[PROVENANCE.reason]) {
      throw new BoardUnavailable(`candidate ${card.id} origin or L4 reason differs from the creation record`)
    }
    matches.set(String(card.id), card)
    if (matches.size > 1) throw new BoardUnavailable('multiple matching card identities; cannot identify the committed card uniquely')
  }
}

async function routedListName(boardId, listId, call) {
  const board = await call('get_board', { boardId, cardsSummary: true })
  const lists = board?.lists ?? board?.board?.lists
  if (!Array.isArray(lists)) throw new BoardUnavailable('malformed get_board result: no lists')
  const target = lists.find((item) => String(item.id) === listId)
  if (typeof target?.name !== 'string') throw new BoardUnavailable(`no list name for list ${listId} on board ${boardId}`)
  return target.name
}

function routedSearchPage(result) {
  const cards = Array.isArray(result) ? result : result?.cards ?? result?.items
  if (!Array.isArray(cards)) throw new BoardUnavailable('malformed find_cards result')
  return cards
}

// An endpoint that ignores offset and reports no total would otherwise answer full pages forever.
const ROUTED_SEARCH_PAGE_LIMIT = 50

async function findRoutedCard(boardId, list, request, call) {
  const limit = 100
  let offset = 0
  const matches = new Map()
  for (let page = 0; ; page += 1) {
    if (page >= ROUTED_SEARCH_PAGE_LIMIT) throw new BoardUnavailable(`find_cards page limit of ${ROUTED_SEARCH_PAGE_LIMIT} reached without an exact match`)
    const result = await call('find_cards', { boardId, list, limit, offset, includeDescription: true })
    const cards = routedSearchPage(result)
    collectRoutedMatches(cards, request, matches)
    offset += cards.length
    if (cards.length === 0) break
    if (Number.isInteger(result.total) ? offset >= result.total : cards.length < limit) break
  }
  return matches.values().next().value ?? null
}

async function reconcileRoutedCard(boardId, request, creationError, call) {
  try {
    const list = await routedListName(boardId, request.listId, call)
    const found = await findRoutedCard(boardId, list, request, call)
    if (!found) throw new Error('no exact title/provenance match returned')
    return { ...found, reconciled: true }
  } catch (error) {
    const search = `board ${boardId}, list ${request.listId}, exact title ${JSON.stringify(request.name)}; ${routedProvenanceLines(request.description).join('; ')}`
    const creationReason = creationError instanceof Error ? creationError.message : String(creationError)
    const reconciliationReason = error instanceof Error ? error.message : String(error)
    throw new BoardUnavailable(`create_card creation outcome is unknown; reconciliation search: ${search}; creation error: ${creationReason}; reconciliation failed: ${reconciliationReason}; check the board before retrying creation`)
  }
}

async function createOrReconcileRoutedCard(boardId, request, call) {
  try {
    const created = await call('create_card', request)
    const cardId = String(created?.id ?? created?.card?.id ?? '')
    if (!cardId) throw new BoardUnavailable('create_card returned no card id')
    return { created, cardId }
  } catch (error) {
    // Only a failure raised before the tool call was sent proves non-creation; a status number in a
    // tool error cannot say whether the write committed first.
    if (error instanceof ToolNotSent) {
      throw new BoardUnavailable(`create_card not created: ${error.message}`, error.status)
    }
    const created = await reconcileRoutedCard(boardId, request, error, call)
    return { created, cardId: String(created.id) }
  }
}

async function createIndependentRoutedCard({ boardContract, originCardId, sessionTag, timestamp, title, l4Reason, risk, effort, type }, call) {
  const description = routedDescription({ originCardId, sessionTag, timestamp, l4Reason })
  const listId = routingIdentifier(boardContract.listId, 'list id')
  const labelIds = [boardContract.labels.priority[risk], boardContract.labels.type[type], boardContract.labels.effort[effort], boardContract.labels.category]
  // Retain a returned or reconciled id and attempt all four labels even if dependency verification fails.
  const { created, cardId } = await createOrReconcileRoutedCard(boardContract.boardId, { listId, name: title, description, dependsOn: 'none' }, call)
  const dependencyEvidence = await verifiedRoutedDescription(created, cardId, call)
  const labelFailures = []
  for (const labelId of labelIds) {
    try {
      await call('add_label_to_card', { cardId, labelId: String(labelId) })
    } catch (error) {
      labelFailures.push({ labelId: String(labelId), error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ...created, id: cardId, ...dependencyEvidence, labelFailures }
}

// Live Planka MCP shapes measured 2026-09-19: get_card, create_card, get_board, find_cards,
// move_card, and add_comment returned JSON; add_label_to_card returned plain text (including a
// plain-text isError on 409). remove_label_from_card was unmeasured and is assumed to behave like
// add_label_to_card. Mutations known or assumed to return text accept either their text or JSON shape.
function toolResult(name, result) {
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('missing MCP result content[0].text')
  const statusMatch = /status code (\d+)/i.exec(text)
  const status = statusMatch ? Number(statusMatch[1]) : undefined
  if (result.isError === true) {
    if (name === 'add_label_to_card' && status === 409) return { text }
    throw new BoardUnavailable(text, status)
  }
  try { return JSON.parse(text) } catch {
    if (TEXT_TOLERANT_TOOLS.has(name)) return { text }
    throw new Error('malformed MCP result JSON')
  }
}

function rpcBody(body) {
  const lines = body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
  const source = lines.length ? lines.at(-1) : body
  const parsed = JSON.parse(source)
  if (!parsed || parsed.jsonrpc !== '2.0' || (!('result' in parsed) && !parsed.error)) throw new Error('malformed JSON-RPC response')
  return parsed
}

function verifyBoardResponseStatus(response) {
  if (!response?.ok) throw transportFailure(`HTTP ${response?.status ?? 'unknown'}`, response?.status)
}

function boardResponseSession(response, sessionId) {
  try {
    return response.headers?.get?.('mcp-session-id') ?? sessionId
  } catch (error) {
    throw transportFailure(error instanceof Error ? error.message : String(error))
  }
}

function createBoardRpc(url, request) {
  let sequence = 0
  let sessionId = null
  async function send(body) {
    let response
    try {
      response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify(body),
      })
    } catch (error) {
      // An adapter may already reject with a BoardUnavailable: keep it (status, single prefix), mark it.
      if (error instanceof BoardUnavailable) { error.transport = true; throw error }
      throw transportFailure(error instanceof Error ? error.message : String(error))
    }
    verifyBoardResponseStatus(response)
    sessionId = boardResponseSession(response, sessionId)
    return response
  }
  async function rpc(method, params = {}) {
    try {
      const response = await send({ jsonrpc: '2.0', id: ++sequence, method, params })
      const body = await response.text()
      const json = rpcBody(body)
      if (json.error) throw new Error(json.error.message ?? 'JSON-RPC error')
      return json.result
    } catch (error) {
      throw error instanceof BoardUnavailable ? error : new BoardUnavailable(error instanceof Error ? error.message : String(error))
    }
  }
  return { send, rpc }
}

function boardClientMethods(boardId, call, lists) {
  return {
    get boardId() { return boardId },
    async findCards({ listName, limit, offset, includeDescription = true }) {
      const result = await call('find_cards', { boardId, list: listName, limit, offset, includeDescription })
      if (!Array.isArray(result) && !Array.isArray(result?.cards) && !Array.isArray(result?.items)) throw new BoardUnavailable('malformed find_cards result')
      return result
    },
    async getCard(id) { return call('get_card', { cardId: String(id) }) },
    async addLabelToCard(id, labelId) { return call('add_label_to_card', { cardId: String(id), labelId: String(labelId) }) },
    async moveCard(id, listName) {
      const target = (await lists()).find((item) => item.name === listName)
      if (!target) throw new BoardUnavailable(`no list named ${listName} on board ${boardId}`)
      return call('move_card', { cardId: String(id), listId: target.id })
    },
    async addComment(id, text) { return call('add_comment', { cardId: String(id), text }) },
    async createRoutedCard(args) {
      return createIndependentRoutedCard(args, call)
    },
    async resolveRoutedCard(card) {
      await call('add_comment', { cardId: String(card.id), text: 'Closed by the originating pilot run: the contested item was completed in scope.' })
      const target = (await lists()).find((item) => item.name === 'NotDoing')
      if (!target) throw new BoardUnavailable(`no list named NotDoing on board ${boardId}`)
      return call('move_card', { cardId: String(card.id), listId: target.id })
    },
    async listNames() { return (await lists()).map((item) => item.name) },
    async listNameOf(listId) { return (await lists()).find((item) => item.id === String(listId))?.name ?? null },
    async listIdOf(listName) { return (await lists()).find((item) => item.name === listName)?.id ?? null },
  }
}

// Argument names follow the live Planka MCP tool schemas (tools/list, measured 2026-09-12):
// get_card {cardId}; find_cards {boardId, list, limit, offset, includeDescription}; move_card
// {cardId, listId}; add_comment {cardId, text}; get_board {boardId, cardsSummary}. The first real
// wave failed with "malformed MCP result JSON" because the client had invented `id`/`listName`.
export function createBoardClient({ url, boardId, boardIdMissingReason, fetch: request = globalThis.fetch }) {
  if (typeof request !== 'function') throw new BoardUnavailable('fetch is unavailable')
  let listsById = null
  async function lists() {
    if (listsById) return listsById
    const board = await call('get_board', { boardId, cardsSummary: true })
    const entries = board?.lists ?? board?.board?.lists
    if (!Array.isArray(entries)) throw new BoardUnavailable('malformed get_board result: no lists')
    listsById = entries.map((item) => ({ id: String(item.id), name: String(item.name) }))
    return listsById
  }
  const { send, rpc } = createBoardRpc(url, request)
  let initialized = false
  async function call(name, arguments_ = {}) {
    // Lazy on purpose: the driver prints its wave line and renders a fail-closed report on this refusal.
    if (!boardId) throw new ToolNotSent(boardIdMissingReason ?? 'boardId is required (--board-id or .claude/planka.json)')
    if (!initialized) {
      try {
        await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wt-orchestrator', version: '1.0.0' } })
        await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        initialized = true
      } catch (error) { throw ToolNotSent.from(error) }
    }
    try { return toolResult(name, await rpc('tools/call', { name, arguments: arguments_ })) }
    catch (error) { throw error instanceof BoardUnavailable ? error : new BoardUnavailable(error.message) }
  }
  return boardClientMethods(boardId, call, lists)
}
