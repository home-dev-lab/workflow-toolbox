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

export function createBoardClient({ url, fetch: request = globalThis.fetch }) {
  if (typeof request !== 'function') throw new BoardUnavailable('fetch is unavailable')
  let sequence = 0
  let initialized = false
  let sessionId = null
  async function rpc(method, params = {}) {
    let response
    try {
      response = await request(url, {
        method: 'POST',
         headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      })
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
      sessionId = response.headers?.get?.('mcp-session-id') ?? sessionId
      const body = await response.text()
       const json = rpcBody(body)
      if (json.error) throw new Error(json.error.message ?? 'JSON-RPC error')
      return json.result
    } catch (error) {
      throw new BoardUnavailable(error instanceof Error ? error.message : String(error))
    }
  }
  async function call(name, arguments_ = {}) {
    if (!initialized) {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wt-orchestrator', version: '1.0.0' } })
      initialized = true
    }
    try { return resultText(await rpc('tools/call', { name, arguments: arguments_ })) }
    catch (error) { throw error instanceof BoardUnavailable ? error : new BoardUnavailable(error.message) }
  }
  return {
    async findCards({ listName, limit, offset }) {
      const result = await call('find_cards', { list: listName, limit, offset })
      if (!Array.isArray(result) && !Array.isArray(result?.cards) && !Array.isArray(result?.items)) throw new BoardUnavailable('malformed find_cards result')
      return result
    },
    async getCard(id) { return call('get_card', { id }) },
    async moveCard(id, listName) { return call('move_card', { id, listName }) },
    async addComment(id, text) { return call('add_comment', { id, text }) },
    async listNames() {
      const board = await call('get_board', {})
      return (board.lists ?? board.list ?? board).map?.((item) => item.name ?? item) ?? []
    },
  }
}
