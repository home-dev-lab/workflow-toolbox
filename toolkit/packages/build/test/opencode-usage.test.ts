import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error runtime launcher helper
import { spawnOpencode } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'
// @ts-expect-error runtime host helper
import { defaultOpenCodeDb } from '../../../../plugin/bin/lib/host/opencode-session-store.mjs'

const fake = vi.hoisted(() => ({ sandbox: {} as Record<string, unknown> }))
vi.mock('../../../../plugin/bin/lib/host/lane-sandbox.mjs', async importOriginal => ({
  ...await importOriginal<object>(), resolveLaneSandbox: () => fake.sandbox,
}))
const roots: string[] = []
function launchFixture() {
  const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
  const alias = join(f.root, 'alias'); symlinkSync(f.root, alias, 'junction')
  const start = (reader: UsageReader, requested = alias, spawn = () => f.child) => spawnOpencode(spawn, 'opencode', ['run', '--dir', requested], { cwd: f.root, usageReceipt: f.receipt, usageReader: reader })
  return { ...f, alias, start, launch: () => JSON.parse(readFileSync(`${f.receipt}.launch.json`, 'utf8')) }
}
type UsageReader = (bin: string, args: string[], options: { timeout: number, killSignal: string }) => string
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wt-opencode-usage-'))); roots.push(root)
  const data = join(root, 'private'); mkdirSync(data)
  const receipt = join(root, 'run.log.usage.json'); const child = new EventEmitter()
  const dispose = vi.fn(() => rmSync(data, { recursive: true, force: true }))
  fake.sandbox = { kind: 'bwrap', line: 'lane sandbox: bwrap', opencodeDataDir: data, wrap: (bin: string, args: string[]) => [bin, args], dispose }
  const start = (usageReader?: UsageReader) => spawnOpencode(() => child, 'opencode', ['run', '--dir', root], { cwd: root, usageReceipt: receipt, usageReader })
  const read = () => existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : undefined
  return { root, data, receipt, child, dispose, start, read }
}

  it('captures private rows before disposal and before later close listeners', () => {
    const f = fixture()
    const reader = vi.fn((_bin: string, args: string[], options: { timeout: number, killSignal: string }) => {
      expect(existsSync(f.data)).toBe(true)
      expect(args.slice(0, 4)).toEqual(['-readonly', '-json', '--', join(f.data, 'opencode.db')])
      expect(args[4]).not.toContain('WHERE')
      expect(options.timeout).toBe(10_000)
      expect(options.killSignal).toBe('SIGKILL')
      return JSON.stringify([{ id: 'private-session', tokens_input: 3, tokens_output: 7, tokens_cache_read: 5 }])
    })
    f.start(reader)
    f.child.once('close', () => { expect(f.read()?.status).toBe('ok'); expect(f.dispose).toHaveBeenCalledOnce() })
    f.child.emit('close')
    expect(f.read()).toMatchObject({ version: 1, receipt_for: 'run.log.usage.json', source: 'opencode session store', sandbox: 'bwrap', store_kind: 'private', directory: f.root, sessions: [{ id: 'private-session' }] })
    expect(reader).toHaveBeenCalledOnce()
  })
  it('reads actual sqlite rows including committed WAL before removing the store', async ctx => {
    let sqlite: typeof import('node:sqlite') | undefined
    try { sqlite = await import('node:sqlite') } catch { /* older Node may provide only the CLI */ }
    if (!sqlite && spawnSync('sqlite3', ['--version']).error) ctx.skip('neither sqlite3 CLI nor node:sqlite is available')
    const f = fixture(); const db = join(f.data, 'opencode.db')
    let writer: InstanceType<typeof import('node:sqlite').DatabaseSync> | undefined
    const reader = sqlite ? (_bin: unknown, args: unknown) => {
      const values = args as string[]
      expect(existsSync(`${db}-wal`)).toBe(true)
      const connection = new sqlite!.DatabaseSync(values[3]!, { readOnly: true })
      try { return JSON.stringify(connection.prepare(values[4]!).all()) } finally { connection.close(); writer?.close(); writer = undefined }
    } : undefined
    f.start(reader)
    const now = Date.now()
    const sql = `PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT,directory TEXT,model TEXT,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER,time_created INTEGER,time_updated INTEGER); INSERT INTO session VALUES('real','${f.root.replaceAll("'", "''")}', '{"providerID":"openai","id":"gpt"}',3,7,11,5,0,${now},${now});`
    writer = sqlite ? new sqlite.DatabaseSync(db) : undefined
    try {
      if (writer) writer.exec(sql)
      else expect(spawnSync('sqlite3', [db, sql]).status).toBe(0)
      f.child.emit('close')
      expect(f.read()).toMatchObject({ status: 'ok', sessions: [{ id: 'real', tokens_input: 3, tokens_cache_read: 5, tokens_output: 7 }] })
      expect(existsSync(f.data)).toBe(false)
    } finally { try { writer?.close() } catch { /* the store may already have been removed by dispose */ } }
  })
  it.each(['reader error', 'invalid json', 'hung reader', 'missing CLI'])('writes unavailable and disposes on %s', reason => {
    const f = fixture()
    const reader = (_bin: unknown, _args: unknown, options: unknown) => {
      if (reason === 'invalid json') return '{'
      if (reason === 'missing CLI') throw Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' })
      if (reason === 'hung reader') {
        expect(options).toMatchObject({ timeout: 10_000, killSignal: 'SIGKILL' })
        return execFileSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options as { timeout: number, encoding: 'utf8' })
      }
      throw new Error(reason)
    }
    f.start(reader)
    expect(() => f.child.emit('close')).not.toThrow()
    expect(f.read()).toMatchObject({ status: 'unavailable', reason: expect.any(String), sessions: [] })
    if (reason === 'hung reader') expect(f.read()?.reason).toMatch(/ETIMEDOUT|timed out/)
    if (reason === 'missing CLI') expect(f.read()?.reason).toBe('sqlite3 not found')
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('never overwrites a receipt already owned by an earlier capture', () => {
    const f = fixture(); writeFileSync(f.receipt, 'original receipt')
    const reader = vi.fn(() => '[]')
    f.start(reader); expect(() => f.child.emit('close')).not.toThrow()
    expect(readFileSync(f.receipt, 'utf8')).toBe('original receipt')
    expect(reader).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('always disposes when the receipt destination cannot be written', () => {
    const f = fixture(); mkdirSync(f.receipt)
    const reader = vi.fn(() => '[]')
    f.start(reader); expect(() => f.child.emit('close')).not.toThrow()
    expect(reader).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('labels an unsandboxed store shared', () => {
    const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
    f.start(() => '[]'); f.child.emit('close')
    expect(f.read()?.store_kind).toBe('shared')
  })
  it('L4 names a missing sqlite3 on win32 instead of reporting zero usage', () => {
    const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
    const reader = vi.fn(() => { throw Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' }) })
    spawnOpencode(() => f.child, 'opencode', ['run'], { cwd: f.root, env: { USERPROFILE: 'C:\\Users\\u' }, usageReceipt: f.receipt, usageReader: reader }, 'win32')
    f.child.emit('close')
    expect(f.read()).toMatchObject({ status: 'unavailable', store: 'C:\\Users\\u\\.local\\share\\opencode\\opencode.db', reason: 'sqlite3 not found', sessions: [] })
    expect(reader).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('captures a synchronous child too without leaking host options into spawn', () => {
    const f = fixture()
    spawnOpencode((_bin: string, _args: string[], options: Record<string, unknown>) => {
      expect(options).not.toHaveProperty('usageReceipt'); expect(options).not.toHaveProperty('usageReader')
      return { status: 0 }
    }, 'opencode', ['run'], { cwd: f.root, usageReceipt: f.receipt, usageReader: () => '[]' })
    expect(f.read()?.status).toBe('ok'); expect(f.dispose).toHaveBeenCalledOnce()
  })

it('A1 stamps the receipt basename even when capture is unavailable', () => {
  const f = fixture(); f.start(() => { throw new Error('reader failed') }); f.child.emit('close')
  expect(f.read()).toMatchObject({ receipt_for: 'run.log.usage.json', status: 'unavailable' })
})

it('A4 captures every private-store session including subdirectories and pre-start rows', async ctx => {
  let sqlite: typeof import('node:sqlite') | undefined
  try { sqlite = await import('node:sqlite') } catch { ctx.skip('node:sqlite unavailable for private-store SQL regression') }
  const f = fixture(); const db = new sqlite!.DatabaseSync(join(f.data, 'opencode.db'))
  db.exec('CREATE TABLE session(id TEXT,directory TEXT,model TEXT,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER,time_created INTEGER,time_updated INTEGER)')
  const insert = db.prepare('INSERT INTO session VALUES(?,?,NULL,3,7,0,5,0,?,?)')
  insert.run('main', f.root, Date.now(), Date.now()); insert.run('sub', join(f.root, 'sub'), Date.now(), Date.now()); insert.run('early', f.root, 1, Date.now())
  db.close()
  f.start((_bin, args) => {
    const reader = new sqlite!.DatabaseSync(args[3]!, { readOnly: true })
    try { return JSON.stringify(reader.prepare(args[4]!).all()) } finally { reader.close() }
  })
  f.child.emit('close')
  expect(f.read()).toMatchObject({ status: 'ok' })
  expect(f.read().sessions.map((row: { id: string }) => row.id).sort()).toEqual(['early', 'main', 'sub'])
})

it('A4 keeps directory and creation-time filtering for shared-store capture', () => {
  const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
  const reader = vi.fn<(bin: string, args: string[]) => string>(() => '[]')
  f.start(reader); f.child.emit('close')
  expect(f.read()).toMatchObject({ store_kind: 'shared', status: 'ok' }); expect(reader).toHaveBeenCalledOnce()
  expect(reader.mock.calls[0]?.[1][4]).toContain(`WHERE directory='${f.root}' AND time_created>=`)
  expect(reader.mock.calls[0]?.[1][4]).toContain('AND time_created<=')
})

it.each([
  { platform: 'linux', env: { HOME: '/h' }, expected: '/h/.local/share/opencode/opencode.db' },
  { platform: 'darwin', env: { HOME: '/h' }, expected: '/h/.local/share/opencode/opencode.db' },
  { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u', HOME: '/ignored' }, expected: 'C:\\Users\\u\\.local\\share\\opencode\\opencode.db' },
  { platform: 'darwin', env: { HOME: '/h', XDG_DATA_HOME: 'relative' }, expected: '/h/.local/share/opencode/opencode.db' },
  { platform: 'linux', env: { HOME: '/h', XDG_DATA_HOME: 'relative' }, expected: '/h/.local/share/opencode/opencode.db' },
  { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u', XDG_DATA_HOME: 'relative' }, expected: 'C:\\Users\\u\\.local\\share\\opencode\\opencode.db' },
  { platform: 'darwin', env: { HOME: '/h', XDG_DATA_HOME: '/data' }, expected: '/data/opencode/opencode.db' },
  { platform: 'linux', env: { HOME: '/h', XDG_DATA_HOME: '/data' }, expected: '/data/opencode/opencode.db' },
  { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u', XDG_DATA_HOME: 'D:\\data' }, expected: 'D:\\data\\opencode\\opencode.db' },
  { platform: 'win32', env: { WT_OPENCODE_DB: 'override.db' }, expected: 'override.db' },
])('L1 resolves the OpenCode data path for $platform with $env', ({ platform, env, expected }) => {
  expect(defaultOpenCodeDb({ platform, env })).toBe(expected)
  expect(defaultOpenCodeDb({ platform, env, dbPath: 'explicit.db' })).toBe('explicit.db')
})

it('L1 captures shared-store usage on darwin using the documented path', () => {
  const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
  const reader = vi.fn(() => '[]')
  spawnOpencode(() => f.child, 'opencode', ['run'], { cwd: f.root, env: { HOME: '/h' }, usageReceipt: f.receipt, usageReader: reader }, 'darwin')
  f.child.emit('close')
  expect(reader).toHaveBeenCalledOnce()
  expect(f.read()).toMatchObject({ status: 'ok', store_kind: 'shared', store: '/h/.local/share/opencode/opencode.db' })
})

it.each(['linux', 'darwin', 'win32'])('L1 falls back to os.homedir on %s when its home variable is absent', platform => {
  const home = platform === 'win32' ? 'C:\\Users\\fallback' : '/fallback'
  const lookup = vi.spyOn(os, 'homedir').mockReturnValue(home)
  const expected = platform === 'win32' ? `${home}\\.local\\share\\opencode\\opencode.db` : `${home}/.local/share/opencode/opencode.db`
  expect(defaultOpenCodeDb({ platform, env: {} })).toBe(expected)
  expect(lookup).toHaveBeenCalledOnce()
})

it('K1 captures a shared alias row instead of publishing an empty receipt', () => {
  const f = launchFixture()
  f.start((_bin, args) => args[4]!.includes(`directory='${f.alias}'`) ? '[{"id":"alias-row"}]' : '[]')
  f.child.emit('close')
  expect(f.read().sessions).toEqual([{ id: 'alias-row' }])
  expect(f.read()).toMatchObject({ directory: f.root, alias_binding: 'stable', launch: { requested: f.alias, realpath: f.root, spellings: [f.alias, f.root], store_kind: 'shared' } })
})

it('K1b captures retargeted alias rows with an unstable binding', () => {
  const f = launchFixture(); f.start(() => '[{"id":"alias-row"}]')
  const foreign = join(f.root, 'foreign'); mkdirSync(foreign); rmSync(f.alias); symlinkSync(foreign, f.alias, 'junction')
  f.child.emit('close')
  expect(f.read()).toMatchObject({ directory: f.root, alias_binding: 'retargeted', sessions: [{ id: 'alias-row' }] })
})

it('K5 resolves relative symlink parent traversal by the OS without evidencing a relative spelling', () => {
  const f = launchFixture(); const target = join(f.root, 'nested', 'child'); mkdirSync(target, { recursive: true })
  rmSync(f.alias); symlinkSync(target, f.alias, 'junction')
  const requested = `alias${sep}..`; const expected = realpathSync.native(`${f.root}${sep}${requested}`)
  f.start(() => '[]', requested); f.child.emit('close')
  expect(f.read()).toMatchObject({ directory: expected, launch: { requested, realpath: expected, spellings: [expected] } })
})

it('K6 publishes a private create-once launch record before invoking spawn', () => {
  const f = launchFixture()
  f.start(() => '[]', f.alias, () => {
    expect(f.launch()).toMatchObject({ version: 1, launch_for: 'run.log.usage.json', realpath: f.root, recorded_at: expect.any(Number) })
    if (process.platform !== 'win32') expect(statSync(`${f.receipt}.launch.json`).mode & 0o777).toBe(0o600)
    return f.child
  })
})

it('K6 preserves an existing launch record and proceeds with the current launch evidence', () => {
  const f = launchFixture(); writeFileSync(`${f.receipt}.launch.json`, 'original')
  const spawn = vi.fn(() => f.child); f.start(() => '[]', f.alias, spawn); f.child.emit('close')
  expect(spawn).toHaveBeenCalledOnce(); expect(readFileSync(`${f.receipt}.launch.json`, 'utf8')).toBe('original')
  expect(f.read().launch.requested).toBe(f.alias)
})
