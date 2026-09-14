import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error runtime helper under plugin/bin/lib/
import { fetchProxyUsage, normalizeLegacyUsage, normalizeProxyUsage, resolveRoute, windowLabel } from '../../../../plugin/bin/lib/quota-route.mjs'

let status = 200
let body: unknown = {}
let base = ''
let server: ReturnType<typeof createServer>

beforeAll(async () => {
  server = createServer((request, response) => {
    expect(request.url).toBe('/v1/internal/selected-usage')
    expect(request.headers.authorization).toBe('Bearer gateway')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(() => server.close())

describe('quota route resolution', () => {
  it('recognizes only direct Anthropic and explicitly configured proxy routes', () => {
    expect(resolveRoute({}).route).toBe('direct')
    expect(resolveRoute({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }).route).toBe('direct')
    expect(resolveRoute({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })).toMatchObject({ route: 'proxy', adapter: 'cli-proxy', base })
    expect(resolveRoute({ ANTHROPIC_BASE_URL: base, WT_QUOTA_PROXY_ORIGINS: base }).reason).toMatch(/no gateway key/)
    expect(resolveRoute({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_AUTH_TOKEN: 'other' }).route).toBe('unknown')
    expect(resolveRoute({ ANTHROPIC_BASE_URL: 'not a url' }).reason).toMatch(/not a URL/)
  })
})

describe('CLI Proxy selected usage', () => {
  it('normalizes returned windows without inventing Claude windows', async () => {
    status = 200
    body = { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 80, window_minutes: 10080, resets_at: null }] }
    const result = await fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 500 })
    expect(normalizeProxyUsage(result).windows).toMatchObject([{ key: 'primary', label: '7d', pct: 80, minutes: 10080 }])
    expect(normalizeProxyUsage(result).windows).toHaveLength(1)
  })

  it('accepts zero or multiple returned windows exactly as supplied', async () => {
    status = 200
    body = { family: 'codex', state: 'ok', windows: [] }
    await expect(fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 500 })).resolves.toMatchObject({ ok: true, windows: [] })
    body = { family: 'codex', state: 'ok', windows: [{ name: 'hourly', used_percent: 1, window_minutes: 60 }, { name: 'daily', used_percent: 2, window_minutes: 1440 }] }
    await expect(fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 500 })).resolves.toMatchObject({ windows: [{ name: 'hourly' }, { name: 'daily' }] })
  })

  it('never renders a malformed used_percent as a figure (null, empty, numeric string, out of range)', async () => {
    // LOCK — measured by claude-mem-cc-1 on the private twin, 2026-09-09: Number(null) === 0 rendered as 0 %.
    status = 200
    for (const bad of [null, '', '15', -1, 101, undefined]) {
      body = { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: bad, window_minutes: 10080 }] }
      await expect(fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 500 })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/malformed used_percent/) })
    }
    body = { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: null, window_minutes: 300 }, { name: 'secondary', used_percent: 42, window_minutes: 10080 }] }
    await expect(fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 500 })).resolves.toMatchObject({ ok: true, windows: [{ name: 'secondary', pct: 42 }] })
  })

  it.each([
    [200, { family: 'codex', state: 'unavailable' }, /provider usage unavailable/],
    [404, { state: 'unbound' }, /session not bound/],
    [409, { state: 'ambiguous' }, /several accounts/],
    [401, {}, /gateway key refused/],
    [400, {}, /bad request/],
  ])('fails closed for proxy result %s', async (nextStatus, nextBody, reason) => {
    status = nextStatus
    body = nextBody
    await expect(fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 500 })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(reason) })
  })

  it('fails closed when the proxy is unreachable or times out', async () => {
    await expect(fetchProxyUsage({ base: 'http://127.0.0.1:1', token: 'gateway', sessionId: 'session', model: 'gpt', timeoutMs: 100 })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/unreachable/) })
    await expect(fetchProxyUsage({ base, token: 'gateway', sessionId: 'session', model: 'gpt', fetchImpl: (_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), timeoutMs: 10 })).resolves.toMatchObject({ ok: false, reason: /no answer in 10 ms/ })
  })
})

describe('window normalization', () => {
  it('converts legacy windows and derives labels from duration', () => {
    expect(normalizeLegacyUsage({ five_hour: { pct: 1, resets_at: null }, seven_day: { pct: 2, resets_at: null } }).windows).toMatchObject([{ key: 'five_hour', label: '5h' }, { key: 'seven_day', label: '7d' }])
    expect([windowLabel({ name: 'x', minutes: 300 }), windowLabel({ name: 'x', minutes: 10080 }), windowLabel({ name: 'x', minutes: 1440 }), windowLabel({ name: 'x', minutes: 90 })]).toEqual(['5h', '7d', '24h', '90min'])
  })
})
