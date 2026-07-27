/*
 * This is a genuinely cross-platform module (Linux/Windows/macOS): it uses only
 * global fetch() and no child_process, shell, or OS-specific path handling.
 * Connection failures throw explicitly; they never silently return a plausible
 * empty or default value.
 */

export interface BoardCard {
  id: string
  name: string
  description: string
  labels: string[]
  listName: string
}

export interface FetchBoardOptions {
  mcpUrl?: string
  boardId: string
}

interface JsonRpcResponse {
  result?: {
    content?: unknown
  }
  error?: unknown
}

interface RawCard {
  id: string
  name: string
  description?: string | null
  labels?: Array<{ name: string }> | null
  listName?: string | null
}

const DEFAULT_MCP_URL = 'http://localhost:25478/mcp'
const BODY_PREVIEW_LENGTH = 300

function bodyPreview(body: string): string {
  return body.slice(0, BODY_PREVIEW_LENGTH)
}

function parseMcpBody(body: string): JsonRpcResponse | undefined {
  const dataLines = body.split(/\r?\n/).filter((line) => line.startsWith('data:'))
  const json = dataLines.length > 0 ? dataLines[dataLines.length - 1]!.slice(5).trim() : body.trim()

  if (!json) return undefined
  return JSON.parse(json) as JsonRpcResponse
}

async function mcpRequest(
  mcpUrl: string,
  sessionId: string | undefined,
  method: string,
  params: unknown,
  id?: number,
): Promise<{ body: string; parsed: JsonRpcResponse | undefined; sessionId: string | undefined }> {
  let response: Response
  try {
    response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
    })
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`Planka MCP server appears unreachable at ${mcpUrl}${detail}`)
  }

  const body = await response.text()
  // A JSON-RPC NOTIFICATION (id === undefined, e.g. `notifications/initialized`) has no
  // response payload by design — the MCP HTTP transport correctly answers 202 Accepted
  // with an empty body, never 200. Only a call WITH an id (initialize, tools/call) must
  // be 200 with a parseable JSON-RPC response.
  if (id === undefined) {
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`${method} HTTP ${response.status}: ${bodyPreview(body)}`)
    }
    return { body, parsed: undefined, sessionId: response.headers.get('Mcp-Session-Id') ?? sessionId }
  }

  if (response.status !== 200) {
    throw new Error(`${method} HTTP ${response.status}: ${bodyPreview(body)}`)
  }

  let parsed: JsonRpcResponse | undefined
  try {
    parsed = parseMcpBody(body)
  } catch {
    throw new Error(`${method} returned an unreadable MCP response: ${bodyPreview(body)}`)
  }

  if (parsed?.error !== undefined) {
    throw new Error(`${method} JSON-RPC error: ${JSON.stringify(parsed.error)}`)
  }

  return {
    body,
    parsed,
    sessionId: response.headers.get('Mcp-Session-Id') ?? sessionId,
  }
}

export async function fetchBoardCards(opts: FetchBoardOptions): Promise<BoardCard[]> {
  const mcpUrl = opts.mcpUrl ?? DEFAULT_MCP_URL
  const initialized = await mcpRequest(
    mcpUrl,
    undefined,
    'initialize',
    {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'planka-mcp-client', version: '1.0.0' },
    },
    1,
  )

  if (!initialized.sessionId) {
    throw new Error('unexpected MCP endpoint (no session id)')
  }

  await mcpRequest(mcpUrl, initialized.sessionId, 'notifications/initialized', {})
  const toolResponse = await mcpRequest(
    mcpUrl,
    initialized.sessionId,
    'tools/call',
    { name: 'find_cards', arguments: { boardId: opts.boardId } },
    2,
  )

  const content = toolResponse.parsed?.result?.content
  const textItem = Array.isArray(content)
    ? content.find((item): item is { text: string } => {
        return typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string'
      })
    : undefined

  if (!textItem) {
    throw new Error(`tools/call result content is not parseable JSON: ${bodyPreview(toolResponse.body)}`)
  }

  let cards: RawCard[]
  try {
    const parsed = JSON.parse(textItem.text) as unknown
    if (!Array.isArray(parsed)) throw new Error('expected an array')
    cards = parsed as RawCard[]
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`tools/call result content is not parseable JSON${detail}`)
  }

  return cards.map((card) => ({
    id: card.id,
    name: card.name,
    description: card.description ?? '',
    labels: (card.labels ?? []).map((label) => label.name),
    listName: card.listName ?? '',
  }))
}
