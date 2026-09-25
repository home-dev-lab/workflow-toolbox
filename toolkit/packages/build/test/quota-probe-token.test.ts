import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = resolve(__dirname, '../../../../plugin/bin/wt-quota-probe.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(withCredentials = true) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-token-'))
  roots.push(root)
  const config = join(root, 'config')
  mkdirSync(config)
  if (withCredentials) writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'saved credential' } }))
  const stub = join(root, 'fetch-stub.mjs')
  writeFileSync(stub, `
globalThis.fetch = async (_url, options) => {
  const usedSession = options.headers.Authorization === \`Bearer \${process.env.CLAUDE_CODE_OAUTH_TOKEN}\`
  if (process.env.STUB_MODE === 'refuse-session' && usedSession) return { ok: false, status: 401 }
  if (!usedSession) return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 42 }, seven_day: { utilization: 84 } }) }
  return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 7 }, seven_day: { utilization: 9 } }) }
}
`)
  return { config, stub }
}

function run(config: string, stub: string, mode: string) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, CLI], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_OAUTH_TOKEN: 'session credential', STUB_MODE: mode },
  })
}

describe('quota probe session token', () => {
  it('uses CLAUDE_CODE_OAUTH_TOKEN even when no credentials file exists', () => {
    const f = fixture(false)
    const result = run(f.config, f.stub, 'accept-session')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ five_hour: { pct: 7 }, seven_day: { pct: 9 } })
  })

  it('reports a refused session token instead of falling back to another account', () => {
    const f = fixture()
    const result = run(f.config, f.stub, 'refuse-session')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage endpoint failed: HTTP 401')
    expect(result.stdout).toBe('')
    expect(`${result.stdout}${result.stderr}`).not.toContain('session credential')
  })
})
