import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
let server: ReturnType<typeof createServer>
const roots: string[] = []

beforeAll(async () => {
  server = createServer((_request, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(responses.shift() ?? responses.at(-1))) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(() => server.close())
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function run(env: Record<string, string>) {
  const config = mkdtempSync(join(tmpdir(), 'wt-quota-route-'))
  roots.push(config)
  const slug = process.cwd().replace(/[^A-Za-z0-9-]/g, '-')
  const project = join(config, 'projects', slug)
  writeFileSync(join(config, '.quota-cache.json'), 'untouched')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'session.jsonl'), '{"type":"assistant","message":{"model":"gpt-test"}}\n')
  const result = await new Promise<{ stdout: string, status: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [WATCH, '--poll', '5', '--timeout', '3'], { env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: 'session', WT_QUOTA_WATCH_TEST_MAX_CYCLES: '2', WT_QUOTA_WATCH_TEST_SLEEP_LOG: '', WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1' } })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ stdout, status }))
  })
  return { result, cache: readFileSync(join(config, '.quota-cache.json'), 'utf8') }
}

describe('wt-quota-watch proxy route', () => {
  it('names the proxy family and emits only its 7d threshold crossing', async () => {
    responses = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 10, window_minutes: 10080, resets_at: null }] }, { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 80, window_minutes: 10080, resets_at: null }] }]
    const { result } = await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`route=proxy ${base} family=codex`)
    expect(result.stdout).toContain('QUOTA codex 7d: 80%')
    expect(result.stdout).not.toContain('5h')
  })

  it('a drop before the previously reported reset time is a DROP with the reset unverified (card 1860461290531588066)', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString()
    const otherWindow = new Date(Date.now() + 7 * 86400000).toISOString()
    responses = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 42, window_minutes: 10080, resets_at: future }] }, { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 32, window_minutes: 10080, resets_at: otherWindow }] }]
    const { result } = await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('QUOTA DROP codex 7d: 32% (was 42%) — reset unverified')
    expect(result.stdout).toContain('capacity not asserted')
    expect(result.stdout).not.toContain('QUOTA RESET')
  })

  it('a drop once the previously reported reset time has passed is a RESET', async () => {
    const past = new Date(Date.now() - 60000).toISOString()
    const next = new Date(Date.now() + 7 * 86400000).toISOString()
    responses = [{ family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 90, window_minutes: 10080, resets_at: past }] }, { family: 'codex', state: 'ok', windows: [{ name: 'primary', used_percent: 3, window_minutes: 10080, resets_at: next }] }]
    const { result } = await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'gateway', WT_QUOTA_PROXY_ORIGINS: base })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('QUOTA RESET codex 7d: 3% (was 90%) — past the reported reset time')
    expect(result.stdout).toContain('source continuity not verified on this route — new window, capacity available')
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
