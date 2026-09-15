import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WATCH = join(ROOT, 'plugin/bin/wt-quota-watch.mjs')
let responses: Array<{ family: string, state: string, windows: Array<{ name: string, used_percent: number, window_minutes: number, resets_at: string | null }> }> = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 10, window_minutes: 10080, resets_at: null }] }]
let base = ''
const requests: string[] = []
const requestTrail = () => `fixture requests:\n${requests.join('\n') || '(none)'}`
let server: ReturnType<typeof createServer>
const roots: string[] = []

beforeAll(async () => {
  // Every request is recorded: three full-suite failures on 2026-09-14 showed a probe answered by an
  // exhausted queue (empty body) with no way to tell which client sent the extra request. A failing
  // assertion now prints each request: order, peer port, the session/model the client sent, what it got.
  server = createServer((request, res) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const body = responses.shift() ?? responses.at(-1)
      let sent = '-'
      try { const parsed = JSON.parse(raw); sent = `session=${parsed.session_id ?? parsed.sessionId ?? '-'} model=${parsed.model ?? '-'}` } catch { sent = `raw=${raw.slice(0, 80) || '(empty)'}` }
      requests.push(`#${requests.length + 1} ${new Date().toISOString()} ${request.method} ${request.url} peer=${request.socket.remotePort} ${sent} remaining=${responses.length} answered=${body === undefined ? 'EMPTY' : `${body.windows?.[0]?.used_percent}%`}`)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(() => server.close())
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function run(env: Record<string, string>) {
  const config = mkdtempSync(join(tmpdir(), 'wt-quota-route-'))
  roots.push(config)
  requests.length = 0
  const slug = process.cwd().replace(/[^A-Za-z0-9-]/g, '-')
  const project = join(config, 'projects', slug)
  writeFileSync(join(config, '.quota-cache.json'), 'untouched')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'session.jsonl'), '{"type":"assistant","message":{"model":"gpt-test"}}\n')
  const result = await new Promise<{ stdout: string, status: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [WATCH, '--poll', '5', '--timeout', '3'], { env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: 'session', WT_QUOTA_WATCH_TEST_MAX_CYCLES: '2', WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(config, 'sleep.log'), WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1' } })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ stdout, status }))
  })
  return { result, cache: readFileSync(join(config, '.quota-cache.json'), 'utf8') }
}

describe.sequential('wt-quota-watch proxy route', () => {
  it('relay sessions print the skip line and leave the config state untouched', async () => {
    const config = mkdtempSync(join(tmpdir(), 'wt-quota-relay-'))
    roots.push(config)
    const result = await new Promise<{ stdout: string; status: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [WATCH, '--poll', '5'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config, WT_SESSION_ROLE: 'relay' } })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.on('error', reject)
      child.on('close', (status) => resolve({ stdout, status }))
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("QUOTA WATCH NOT ARMED: relay session (WT_SESSION_ROLE=relay) — this session only relays; it cannot act on this watcher's events\n")
    expect(readdirSync(config)).toEqual([])
  })

  it('names the proxy family and emits only its 7d threshold crossing', async () => {
    responses = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 10, window_minutes: 10080, resets_at: null }] }, { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 80, window_minutes: 10080, resets_at: null }] }]
    const { result } = await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`route=proxy ${base} family=codex`)
    expect(result.stdout, requestTrail()).toContain('QUOTA codex 7d: 80%')
    expect(result.stdout).not.toContain('5h')
  })

  it('a drop before the previously reported reset time is a DROP with the reset unverified (card 1860461290531588066)', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString()
    const otherWindow = new Date(Date.now() + 7 * 86400000).toISOString()
    responses = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 42, window_minutes: 10080, resets_at: future }] }, { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 32, window_minutes: 10080, resets_at: otherWindow }] }]
    const { result } = await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })
    expect(result.status).toBe(0)
    expect(result.stdout, requestTrail()).toContain('QUOTA DROP codex 7d: 32% (was 42%) — reset unverified')
    expect(result.stdout).toContain('capacity not asserted')
    expect(result.stdout).not.toContain('QUOTA RESET')
  })

  it('a drop once the previously reported reset time has passed is still a DROP on the proxy route (no identity signal)', async () => {
    const past = new Date(Date.now() - 60000).toISOString()
    const next = new Date(Date.now() + 7 * 86400000).toISOString()
    responses = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 90, window_minutes: 10080, resets_at: past }] }, { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 3, window_minutes: 10080, resets_at: next }] }]
    const { result } = await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })
    expect(result.status).toBe(0)
    expect(result.stdout, requestTrail()).toContain('QUOTA DROP codex 7d: 3% (was 90%) — reset likely but unverified: past the reported reset time')
    expect(result.stdout).toContain('source continuity not verified on this route')
    expect(result.stdout).not.toContain('QUOTA RESET')
  })

  it('stays alive and explicitly degraded for an unknown route', async () => {
    const { result } = await run({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_AUTH_TOKEN: 'other' })
    expect(result.stdout).toContain('QUOTA WATCH DEGRADED: route http://127.0.0.1:4000 has no quota source')
    expect(result.stdout).not.toMatch(/QUOTA (claude|codex) /)
  })

  it('degrades when the proxy is down and does not write the Claude cache', async () => {
    const { result, cache } = await run({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: 'http://127.0.0.1:1' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('QUOTA WATCH DEGRADED: http://127.0.0.1:1 unreachable')
    expect(result.stdout).not.toContain('probe returned')
    expect(cache).toBe('untouched')
  })
})
