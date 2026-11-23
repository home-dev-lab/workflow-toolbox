import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const WATCH = resolve(__dirname, '../../../../plugin/bin/wt-quota-watch.mjs')
const TOKEN = 'token-abc123abc123'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

type Seed = { key: string, fileKey: string, uuid?: string }
type Session = { configSet?: boolean, sessionFlag?: string | undefined, switchDuringProbe?: boolean, differentOsHome?: boolean, osHomeOnly?: boolean }

function competingHome(home: string) {
  const root = join(home, '.claude')
  mkdirSync(root, { recursive: true })
  const account = JSON.stringify({ oauthAccount: { accountUuid: 'competing-account' } })
  writeFileSync(join(home, '.claude.json'), account)
  writeFileSync(join(root, '.claude.json'), account)
  writeFileSync(join(root, '.quota-cache.json'), JSON.stringify({ at: Date.now(), data: {
    configDir: root, accountKey: 'login',
    accountFingerprint: createHash('sha256').update('competing-account').digest('hex').slice(0, 8),
    five_hour: { pct: 77 }, seven_day: { pct: 77 },
  } }))
  return home
}

function fixture(session: Session) {
  const home = mkdtempSync(join(tmpdir(), 'wt-quota-account-'))
  roots.push(home)
  const root = join(home, '.claude')
  mkdirSync(root)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'home-account' } }))
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'quota-fixture-account' } }))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  const nodeArgs: string[] = []
  if (session.differentOsHome) {
    env.HOME = competingHome(join(home, 'competing-home'))
    // osHomeOnly: the OS home differs from both variables, so only os.homedir() reaches the session tree.
    if (session.osHomeOnly) [env.WT_FIXTURE_OS_HOME, env.USERPROFILE] = [home, competingHome(join(home, 'competing-profile'))]
    const preload = join(root, 'os-home.mjs')
    writeFileSync(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => process.env.WT_FIXTURE_OS_HOME ?? process.env.USERPROFILE;
syncBuiltinESMExports();`)
    nodeArgs.push('--import', pathToFileURL(preload).href)
  }
  delete env.WT_SESSION_CONFIG_DIR_SET
  if (session.sessionFlag !== undefined) env.WT_SESSION_CONFIG_DIR_SET = session.sessionFlag
  delete env.CLAUDE_CONFIG_DIR
  if (session.configSet !== false) env.CLAUDE_CONFIG_DIR = root
  return { root, env, nodeArgs }
}

async function run(keys: Array<string | null>, seed?: Seed, tokenEnv = '', session: Session = {}) {
  const { root, env, nodeArgs } = fixture(session)
  const competingCache = session.differentOsHome ? readFileSync(join(env.HOME!, '.claude', '.quota-cache.json'), 'utf8') : undefined
  const probe = join(root, 'probe.mjs')
  const counter = join(root, 'counter')
  const sleep = join(root, 'sleep')
  const barrier = join(root, 'barrier')
  writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(counter)};
let n = 0; try { n = Number(readFileSync(file, 'utf8')) } catch {}
writeFileSync(file, String(n + 1));
writeFileSync(${JSON.stringify(join(root, 'child-session-flag'))}, process.env.WT_SESSION_CONFIG_DIR_SET ?? 'missing');
writeFileSync(${JSON.stringify(join(root, 'child-config-dir'))}, process.env.CLAUDE_CONFIG_DIR);
if (${Boolean(session.switchDuringProbe)} && n === 0) writeFileSync(${JSON.stringify(join(root, '.claude.json'))}, JSON.stringify({ oauthAccount: { accountUuid: 'changed-account' } }));
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
  const child = spawn(process.execPath, [...nodeArgs, WATCH, '--probe', probe, '--poll', '5', '--timeout', '3'], { env: { ...env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '', CLAUDE_CODE_OAUTH_TOKEN: tokenEnv, WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1', WT_QUOTA_WATCH_TEST_SLEEP_LOG: sleep, WT_QUOTA_WATCH_TEST_SLEEP_BARRIER: barrier, WT_QUOTA_WATCH_TEST_MAX_CYCLES: '2' } })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  try {
    await Promise.race([ready, done.then(() => { throw new Error('watcher exited before its sleep barrier') })])
    const initialCaches = readdirSync(root).filter((name) => /^\.quota-cache.*\.json$/.test(name))
    const initialLogin = initialCaches.includes('.quota-cache.json') ? JSON.parse(readFileSync(join(root, '.quota-cache.json'), 'utf8')).data : undefined
    if (seed) writeFileSync(join(root, seed.fileKey === 'login' ? '.quota-cache.json' : `.quota-cache.${seed.fileKey}.json`), JSON.stringify({ at: Date.now(), data: { configDir: root, accountKey: seed.key, accountFingerprint: createHash('sha256').update(seed.uuid ?? 'quota-fixture-account').digest('hex').slice(0, 8), five_hour: { pct: 99 }, seven_day: { pct: 99 } } }))
    else for (const name of readdirSync(root).filter((name) => /^\.quota-cache.*\.json$/.test(name))) rmSync(join(root, name))
    writeFileSync(barrier, '')
    expect(await done).toBe(0)
    return { stdout, initialCaches, initialLogin, root, childConfigDir: readFileSync(join(root, 'child-config-dir'), 'utf8'), competingCacheUntouched: competingCache === (session.differentOsHome ? readFileSync(join(env.HOME!, '.claude', '.quota-cache.json'), 'utf8') : undefined), childFlag: readFileSync(join(root, 'child-session-flag'), 'utf8'), count: Number(readFileSync(counter, 'utf8')), caches: readdirSync(root).filter((name) => /^\.quota-cache.*\.json$/.test(name)) }
  } finally { sleepWatcher!.close(); child.kill('SIGKILL') }
}

describe('quota watcher account cache', () => {
  it('never writes a token account cache', async () => {
    const result = await run([TOKEN], undefined, 'fixture-token')
    expect(result.initialCaches).toEqual([])
    expect(result.caches).toEqual([])
  })
  it('refuses a foreign login-file reading seeded after the live baseline', async () => {
    const result = await run(['login'], { key: TOKEN, fileKey: 'login' })
    expect(result.count).toBe(2)
    expect(result.stdout).not.toMatch(/^QUOTA .*99%/m)
  })
  it('reads its own token-keyed file in steady state', async () => {
    const result = await run([TOKEN], { key: TOKEN, fileKey: TOKEN }, 'fixture-token')
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
  })
  it('re-baselines on an account key change without a drop or reset', async () => {
    const result = await run([TOKEN, 'token-def456def456'], undefined, 'fixture-token')
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
    const result = await run(['../escape'], undefined, 'fixture-token')
    expect(result.initialCaches).toEqual([])
    expect(result.count).toBe(2)
    expect(result.caches).toEqual([])
    expect(result.stdout).toContain('QUOTA WATCH ARMED:')
    expect(result.stdout).not.toContain('internal watcher error')
  })
})

describe('quota watcher inherited session config decision', () => {
  it.each([
    { flag: '0', configSet: true, uuid: 'home-account', accepted: true },
    { flag: '0', configSet: true, uuid: 'quota-fixture-account', accepted: false },
    { flag: '1', configSet: false, uuid: 'quota-fixture-account', accepted: true },
    { flag: '1', configSet: false, uuid: 'home-account', accepted: false },
  ])('inherited flag $flag with configSet=$configSet: cache $uuid accepted=$accepted', async ({ flag, configSet, uuid, accepted }) => {
    const result = await run(['login'], { key: 'login', fileKey: 'login', uuid }, '', { configSet, sessionFlag: flag })
    expect(result.count, 'only the session-selected account cache may avoid a second live probe').toBe(accepted ? 1 : 2)
    expect(result.stdout.includes('99%')).toBe(accepted)
    expect(result.childFlag).toBe(flag)
  })
  it.each([
    { flag: '0', configSet: true, expected: '0' },
    { flag: '1', configSet: false, expected: '1' },
    ...[undefined, '', 'other'].flatMap((flag) => [
      { flag, configSet: true, expected: '1' },
      { flag, configSet: false, expected: '0' },
    ]),
  ])('passes decided child flag $expected for inherited=$flag and configSet=$configSet', async ({ flag, configSet, expected }) => {
    const result = await run(['login'], undefined, '', { configSet, sessionFlag: flag })
    expect(result.childFlag).toBe(expected)
  })
})

describe('quota watcher session cache identity', () => {
  it('reads the hook login cache for a pool-keyed login session', async () => {
    const result = await run([TOKEN], { key: 'login', fileKey: 'login' })
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
    expect(result.initialCaches).toEqual(['.quota-cache.json'])
  })
  it('fingerprints the home global config when the session did not set a config dir', async () => {
    const result = await run(['login'], { key: 'login', fileKey: 'login', uuid: 'home-account' }, '', { configSet: false })
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
    expect(result.childFlag).toBe('0')
  })
  it('fingerprints the config-dir global config when the session explicitly set the default dir', async () => {
    const result = await run(['login'], { key: 'login', fileKey: 'login' }, '', { configSet: true })
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
    expect(result.childFlag).toBe('1')
  })
  it('rejects a mismatched fingerprint in the pool login cache', async () => {
    const result = await run([TOKEN], { key: 'login', fileKey: 'login', uuid: 'foreign-account' })
    expect(result.count).toBe(2)
    expect(result.stdout).not.toMatch(/^QUOTA .*99%/m)
  })
  it('discards a pool login reading when identity changes across the probe', async () => {
    const result = await run([TOKEN], undefined, '', { switchDuringProbe: true })
    expect(result.stdout).toContain('reading discarded, probing again next poll')
    expect(result.initialCaches).toEqual([])
    expect(result.count).toBe(2)
  })
})

describe('quota watcher home resolution under injected win32 semantics', () => {
  it.each([
    { sessionFlag: '0', configSet: true, uuid: 'home-account', childFlag: '0' },
    { sessionFlag: '1', configSet: false, uuid: 'quota-fixture-account', childFlag: '1' },
    { sessionFlag: undefined, configSet: false, uuid: 'home-account', childFlag: '0' },
  ])('uses USERPROFILE over a competing HOME under injected win32 semantics: flag=$sessionFlag configSet=$configSet', async ({ sessionFlag, configSet, uuid, childFlag }) => {
    const result = await run(['login'], { key: 'login', fileKey: 'login', uuid }, '', { sessionFlag, configSet, differentOsHome: true })
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
    expect(result.stdout).not.toContain('77%')
    expect(result.initialLogin.accountFingerprint).toBe(createHash('sha256').update(uuid).digest('hex').slice(0, 8))
    expect(result.initialLogin.configDir).toBe(result.root)
    expect(result.childConfigDir).toBe(result.root)
    expect(result.initialCaches).toEqual(['.quota-cache.json'])
    expect(result.competingCacheUntouched).toBe(true)
    expect(result.childFlag).toBe(childFlag)
  })
  it('follows os.homedir() when it differs from both HOME and USERPROFILE', async () => {
    const result = await run(['login'], { key: 'login', fileKey: 'login', uuid: 'home-account' }, '', { configSet: false, differentOsHome: true, osHomeOnly: true })
    expect(result.count).toBe(1)
    expect(result.stdout).toContain('99%')
    expect(result.stdout).not.toContain('77%')
    expect(result.initialLogin.accountFingerprint).toBe(createHash('sha256').update('home-account').digest('hex').slice(0, 8))
    expect(result.childConfigDir).toBe(result.root)
  })
})
