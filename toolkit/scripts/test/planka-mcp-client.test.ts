import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBoardCards } from '../planka-mcp-client.ts'

const MCP_URL = 'http://localhost:25478/mcp'

function response(body: string, status = 200, sessionId?: string): Response {
  return new Response(body, {
    status,
    ...(sessionId ? { headers: { 'Mcp-Session-Id': sessionId } } : {}),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchBoardCards', () => {
  it('performs the MCP handshake and maps raw cards', async () => {
    const cards = [
      {
        id: 'card-1',
        name: 'First card',
        description: null,
        labels: [{ id: 'label-1', name: 'P1' }, { id: 'label-2', name: 'feature' }],
        listName: 'Ready',
      },
    ]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), 200, 'session-1'))
      .mockResolvedValueOnce(response(''))
      .mockResolvedValueOnce(
        response(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: JSON.stringify(cards) }] },
        })}\n`),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchBoardCards({ boardId: 'board-1' })).resolves.toEqual([
      {
        id: 'card-1',
        name: 'First card',
        description: '',
        labels: ['P1', 'feature'],
        listName: 'Ready',
      },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(requests).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'planka-mcp-client', version: '1.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'find_cards', arguments: { boardId: 'board-1' } },
      },
    ])
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Mcp-Session-Id')).toBe('session-1')
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Mcp-Session-Id')).toBe('session-1')
  })

  it('accepts HTTP 202 on notifications/initialized (real MCP servers answer notifications this way, caught by a live probe against the local server on 2026-07-27 — a mocked 200 stub had silently masked this)', async () => {
    const cards = [{ id: 'card-1', name: 'First card', description: '', labels: [], listName: 'Ready' }]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), 200, 'session-1'))
      .mockResolvedValueOnce(response('', 202))
      .mockResolvedValueOnce(
        response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(cards) }] } }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchBoardCards({ boardId: 'board-1' })).resolves.toEqual(cards)
  })

  it('throws when initialize returns a non-200 status', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response('not available', 503)))

    await expect(fetchBoardCards({ boardId: 'board-1' })).rejects.toThrow('503')
  })

  it('throws when initialize omits Mcp-Session-Id', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response('{"jsonrpc":"2.0","result":{}}')))

    await expect(fetchBoardCards({ boardId: 'board-1' })).rejects.toThrow('unexpected MCP endpoint (no session id)')
  })

  it('throws when a JSON-RPC response contains an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          response('{"jsonrpc":"2.0","id":1,"result":{}}', 200, 'session-1'),
        )
        .mockResolvedValueOnce(response(''))
        .mockResolvedValueOnce(
          response('{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"failed"}}'),
        ),
    )

    await expect(fetchBoardCards({ boardId: 'board-1' })).rejects.toThrow('JSON-RPC error')
  })

  it('throws an explicit URL-bearing error when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))

    await expect(fetchBoardCards({ boardId: 'board-1', mcpUrl: MCP_URL })).rejects.toThrow(
      `server appears unreachable at ${MCP_URL}`,
    )
  })
})
