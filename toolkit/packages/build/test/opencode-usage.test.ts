import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error runtime launcher helper
import { spawnOpencode } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const fake = vi.hoisted(() => ({ sandbox: {} as Record<string, unknown> }))
vi.mock('../../../../plugin/bin/lib/host/lane-sandbox.mjs', async importOriginal => ({
  ...await importOriginal<object>(), resolveLaneSandbox: () => fake.sandbox,
}))
const roots: string[] = []
type UsageReader = (bin: string, args: string[], options: { timeout: number, killSignal: string }) => string
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-opencode-usage-'))); roots.push(root)
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
  it('names an unverified platform store rather than reporting zero usage', () => {
    const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
    spawnOpencode(() => f.child, 'opencode', ['run'], { cwd: f.root, env: {}, usageReceipt: f.receipt }, 'win32')
    f.child.emit('close')
    expect(f.read()).toMatchObject({ status: 'unavailable', store: null, reason: 'OpenCode store location unverified on win32' })
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
  f.start((_bin, args) => JSON.stringify(db.prepare(args[4]!).all()))
  try {
    f.child.emit('close')
    expect(f.read().sessions.map((row: { id: string }) => row.id).sort()).toEqual(['early', 'main', 'sub'])
  } finally { db.close() }
})

it('A4 keeps directory and creation-time filtering for shared-store capture', () => {
  const f = fixture(); fake.sandbox.kind = 'none'; fake.sandbox.opencodeDataDir = null
  const reader = vi.fn((_bin: string, args: string[]) => {
    expect(args[4]).toContain(`WHERE directory='${f.root}' AND time_created>=`)
    expect(args[4]).toContain('AND time_created<=')
    return '[]'
  })
  f.start(reader); f.child.emit('close')
  expect(f.read().store_kind).toBe('shared'); expect(reader).toHaveBeenCalledOnce()
})
