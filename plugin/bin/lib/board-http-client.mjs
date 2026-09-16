export class BoardUnavailable extends Error {
  constructor(detail) {
    super(`board unavailable: ${detail}`)
    this.name = 'BoardUnavailable'
  }
}

function resultText(result) {
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('missing MCP result content[0].text')
  try { return JSON.parse(text) } catch { throw new Error('malformed MCP result JSON') }
}

function rpcBody(body) {
  const lines = body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
  const source = lines.length ? lines.at(-1) : body
  const parsed = JSON.parse(source)
  if (!parsed || parsed.jsonrpc !== '2.0' || (!('result' in parsed) && !parsed.error)) throw new Error('malformed JSON-RPC response')
  return parsed
}

// Argument names follow the live Planka MCP tool schemas (tools/list, measured 2026-09-12):
// get_card {cardId}; find_cards {boardId, list, limit, offset, includeDescription}; move_card
// {cardId, listId}; add_comment {cardId, text}; get_board {boardId, cardsSummary}. The first real
// wave failed with "malformed MCP result JSON" because the client had invented `id`/`listName`.
export function createBoardClient({ url, boardId, fetch: request = globalThis.fetch }) {
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
  let sequence = 0
  let initialized = false
  let sessionId = null
  async function send(body) {
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify(body),
      })
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
      sessionId = response.headers?.get?.('mcp-session-id') ?? sessionId
      return response
    } catch (error) {
      throw error instanceof BoardUnavailable ? error : new BoardUnavailable(error instanceof Error ? error.message : String(error))
    }
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
  async function call(name, arguments_ = {}) {
    // Lazy on purpose: the driver prints its wave line and renders a fail-closed report on this refusal.
    if (!boardId) throw new BoardUnavailable('boardId is required (--board-id or .claude/planka.json)')
    if (!initialized) {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wt-orchestrator', version: '1.0.0' } })
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      initialized = true
    }
    try { return resultText(await rpc('tools/call', { name, arguments: arguments_ })) }
    catch (error) { throw error instanceof BoardUnavailable ? error : new BoardUnavailable(error.message) }
  }
  return {
    async findCards({ listName, limit, offset }) {
      const result = await call('find_cards', { boardId, list: listName, limit, offset, includeDescription: true })
      if (!Array.isArray(result) && !Array.isArray(result?.cards) && !Array.isArray(result?.items)) throw new BoardUnavailable('malformed find_cards result')
      return result
    },
    async getCard(id) { return call('get_card', { cardId: String(id) }) },
    async moveCard(id, listName) {
      const target = (await lists()).find((item) => item.name === listName)
      if (!target) throw new BoardUnavailable(`no list named ${listName} on board ${boardId}`)
      return call('move_card', { cardId: String(id), listId: target.id })
    },
    async addComment(id, text) { return call('add_comment', { cardId: String(id), text }) },
    async createRoutedCard({ boardContract, originCardId, sessionTag, timestamp, title, l4Reason, risk, effort, type }) {
      // The Planka MCP `create_card` schema is closed (listId, name, description, dependsOn, dueDate, position):
      // labels are NOT create_card fields — an unknown field is refused by the server. The four labels the board
      // rules require (priority, type, effort, category) are therefore added one call each, after creation.
      const created = await call('create_card', {
        listId: boardContract.listId,
        name: title,
        description: `## Provenance\nOrigin card: ${originCardId}; run/session: ${sessionTag}; L4 reason: ${l4Reason}; timestamp: ${timestamp}`,
        dependsOn: { cardId: String(originCardId) },
      })
      const cardId = String(created?.id ?? created?.card?.id ?? '')
      if (!cardId) throw new BoardUnavailable('create_card returned no card id')
      for (const labelId of [boardContract.labels.priority[risk], boardContract.labels.type[type], boardContract.labels.effort[effort], boardContract.labels.category]) {
        await call('add_label_to_card', { cardId, labelId: String(labelId) })
      }
      return created
    },
    async resolveRoutedCard(card) {
      await call('add_comment', { cardId: String(card.id), text: 'Closed by the originating pilot run: the contested item was completed in scope.' })
      const target = (await lists()).find((item) => item.name === 'NotDoing')
      if (!target) throw new BoardUnavailable(`no list named NotDoing on board ${boardId}`)
      return call('move_card', { cardId: String(card.id), listId: target.id })
    },
    async listNames() { return (await lists()).map((item) => item.name) },
    async listNameOf(listId) { return (await lists()).find((item) => item.id === String(listId))?.name ?? null },
  }
}
