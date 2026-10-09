import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const WATCH = resolve(__dirname, '../../../../plugin/bin/wt-quota-watch.mjs')
const TOKEN = 'token-abc123abc123'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function run(keys: Array<string | null>, seed?: { key: string, fileKey: string }, tokenEnv = '') {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-account-'))
  roots.push(root)
  const probe = join(root, 'probe.mjs')
  const counter = join(root, 'counter')
  const sleep = join(root, 'sleep')
  const barrier = join(root, 'barrier')
  writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(counter)};
let n = 0; try { n = Number(readFileSync(file, 'utf8')) } catch {}
writeFileSync(file, String(n + 1));
const key = ${JSON.stringify(keys)}[Math.min(n, ${keys.length - 1})];
console.log(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, ...(key === null ? {} : { accountKey: key }), five_hour: { pct: n ? 10 : 40 }, seven_day: { pct: n ? 10 : 40 } }));`)
  writeFileSync(sleep, '')
  let sleepWatcher: ReturnType<typeof watch>
  const ready = new Promise<void>((resolve) => {
    sleepWatcher = watch(sleep, () => {
      if (readFileSync(sleep, 'utf8').trim() === '') return
      sleepWatcher.close()
      resolve()
    })
  })
  const child = spawn(process.execPath, [WATCH, '--probe', probe, '--poll', '5', '--timeout', '3'], { env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '', CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: tokenEnv, WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1', WT_QUOTA_WATCH_TEST_SLEEP_LOG: sleep, WT_QUOTA_WATCH_TEST_SLEEP_BARRIER: barrier, WT_QUOTA_WATCH_TEST_MAX_CYCLES: '2' } })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  try {
    await Promise.race([ready, done.then(() => { throw new Error('watcher exited before its sleep barrier') })])
    const initialCaches = readdirSync(root).filter((name) => /^\.quota-cache.*\.json$/.test(name))
    if (seed) writeFileSync(join(root, seed.fileKey === 'login' ? '.quota-cache.json' : `.quota-cache.${seed.fileKey}.json`), JSON.stringify({ at: Date.now(), data: { configDir: root, accountKey: seed.key, five_hour: { pct: 99 }, seven_day: { pct: 99 } } }))
    else for (const name of readdirSync(root).filter((name) => /^\.quota-cache.*\.json$/.test(name))) rmSync(join(root, name))
    writeFileSync(barrier, '')
    expect(await done).toBe(0)
    return { stdout, initialCaches, count: Number(readFileSync(counter, 'utf8')), caches: readdirSync(root).filter((name) => /^\.quota-cache.*\.json$/.test(name)) }
  } finally { sleepWatcher!.close(); child.kill('SIGKILL') }
}

describe('quota watcher account cache', () => {
  it('never writes a token account cache', async () => {
    const result = await run([TOKEN])
    expect(result.initialCaches).toEqual([])
    expect(result.caches).toEqual([])
  })
  it('refuses a foreign login-file reading seeded after the live baseline', async () => {
    const result = await run(['login'], { key: TOKEN, fileKey: 'login' })
    expect(result.count).toBe(2)
    expect(result.stdout).not.toMatch(/^QUOTA .*99%/m)
  })
  it('reads its own token-keyed file in steady state', async () => {
    const result = await run([TOKEN], { key: TOKEN, fileKey: TOKEN })
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
  })
  it('re-baselines on an account key change without a drop or reset', async () => {
    const result = await run([TOKEN, 'token-def456def456'])
    expect(result.stdout).toContain('QUOTA ACCOUNT CHANGED:')
    expect(result.stdout).not.toMatch(/QUOTA (DROP|RESET)/)
  })
  it('does not cache ambiguous legacy readings in a token session', async () => {
    const result = await run([null], { key: 'login', fileKey: 'login' }, 'fixture-token')
    expect(result.initialCaches).toEqual([])
    expect(result.count).toBe(2)
    expect(result.stdout).not.toMatch(/^QUOTA .*99%/m)
  })
  it('unsafe account keys leave live probing and notices working', async () => {
    const result = await run(['../escape'])
    expect(result.initialCaches).toEqual([])
    expect(result.count).toBe(2)
    expect(result.caches).toEqual([])
    expect(result.stdout).toContain('QUOTA WATCH ARMED:')
    expect(result.stdout).not.toContain('internal watcher error')
  })
})
