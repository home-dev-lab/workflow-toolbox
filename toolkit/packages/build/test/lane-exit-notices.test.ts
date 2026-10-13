import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const MODULE = resolve(__dirname, '../../../../plugin/bin/lib/lane-exit-notices.mjs')
// Independent default-policy oracles: changing a bound must not change its test oracle.
const EXPECTED_LOOKBACK_MS = 24 * 60 * 60 * 1000
const EXPECTED_MAX_ENTRIES = 10_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-exits-')); roots.push(root)
  const stateRoot = join(root, 'host'); const dataDir = join(root, 'wt-lane-exit-notices')
  mkdirSync(stateRoot); mkdirSync(dataDir)
  const file = join(dataDir, 'test-session.json')
  const env = { ...process.env, WT_LANE_HOST_STATE: stateRoot, XDG_STATE_HOME: join(root, 'state'),
    CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_PLUGIN_DATA: join(root, 'data'), CLAUDE_CODE_SESSION_ID: 'test-session' }
  return { root, stateRoot, dataDir, file, env }
}
type Fixture = ReturnType<typeof fixture>
function record(f: Fixture, runId = '10-20', extra: Record<string, unknown> = {}, slot = 'supervision') {
  const worktree = join(f.root, 'outside-project')
  const host = join(f.stateRoot, 'a'.repeat(32)); const dir = join(host, slot)
  mkdirSync(dir, { recursive: true }); writeFileSync(join(host, 'worktree'), `${worktree}\n`)
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, worktree, owner: 'session',
    ownerSessionId: 'test-session', state: 'exited', exit: 0, exitedAt: new Date().toISOString(), ...extra }))
  return { worktree, dir }
}
const seed = (f: Fixture, entries: unknown[] = []) => writeFileSync(f.file, JSON.stringify({ version: 1, entries }))
function watch(f: Fixture, extra: Record<string, string | undefined> = {}) {
  const program = `const { createLaneExitNotices } = await import(process.argv[1]); createLaneExitNotices(JSON.parse(process.argv[2]))()`
  const settings = { stateRoot: f.stateRoot }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, pathToFileURL(MODULE).href, JSON.stringify(settings)], {
    env: { ...f.env, ...extra }, encoding: 'utf8', timeout: 30_000,
  })
  expect(result.status, result.stderr).toBe(0)
  return result
}
const exits = (stdout: string) => stdout.split('\n').filter((line) => line.startsWith('LANE exited:'))
const entries = (f: Fixture) => JSON.parse(readFileSync(f.file, 'utf8')).entries as Array<{ runId: string, at: number }>
type ScannerModule = { createLaneExitNotices: (options: Record<string, unknown>) => () => void }
async function moduleUnderTest(): Promise<ScannerModule> {
  expect(existsSync(MODULE), 'completion scanner module exists').toBe(true)
  return await import(pathToFileURL(MODULE).href) as ScannerModule
}

describe('session lane completion notices', () => {
  it('announces an external-project exit exactly once across two watcher runs', () => {
    const f = fixture(); seed(f); record(f)
    const output = watch(f).stdout + watch(f).stdout
    expect(exits(output), 'two sweeps produce exactly one completion line').toHaveLength(1)
    expect(entries(f).map((entry) => entry.runId)).toEqual(['10-20'])
  })
  it('announces an exit during watcher downtime on restart and never on the next restart', () => {
    const f = fixture(); watch(f); record(f)
    expect(exits(watch(f).stdout), 'restart finds the exit that happened without a watcher').toHaveLength(1)
    expect(exits(watch(f).stdout)).toHaveLength(0)
  })
  it('announces pilot-owned exits in named slots to their owning session', () => {
    const f = fixture(); seed(f); record(f, '10-20', { owner: 'pilot', state: 'abandoned', exit: null }, 'supervision-pilot')
    const lines = exits(watch(f).stdout)
    expect(lines, 'pilot exit is announced').toHaveLength(1)
    expect(lines[0]).toContain('owner=pilot')
  })
})

describe('session lane completion notices', () => {
  it('never records missing or foreign owner session ids', () => {
    const f = fixture(); seed(f); record(f, '10-20', { ownerSessionId: null }); record(f, '30-40', { ownerSessionId: 'foreign' })
    expect(exits(watch(f).stdout)).toHaveLength(0)
    expect(entries(f)).toEqual([])
  })
  it('disables completion scanning without a session id', () => {
    const f = fixture(); record(f)
    const result = watch(f, { CLAUDE_CODE_SESSION_ID: undefined })
    expect(exits(result.stdout)).toHaveLength(0)
    expect(result.stderr, 'missing session id is explicitly disabled').toContain('completion notices disabled')
    expect(existsSync(f.file)).toBe(false)
  })
  it.each(['missing', 'corrupt'])('baselines pre-existing exits once with a %s announced file', (kind) => {
    const f = fixture(); if (kind === 'corrupt') writeFileSync(f.file, '{bad')
    record(f); record(f, '30-40', { state: 'launch-failed' })
    const result = watch(f)
    expect(result.stdout, 'first-use baseline avoids a per-lane flood').toContain('LANE exit-watch baseline: 2 finished lanes recorded, not announced')
    expect(exits(result.stdout)).toHaveLength(0)
    expect(entries(f)).toHaveLength(2)
    expect(watch(f).stdout).not.toContain('LANE exit-watch baseline:')
    if (kind === 'corrupt') expect(result.stderr).toContain('completion scan failed')
  })
})

describe('session lane completion notices', () => {
  it('renders report presence and keeps hostile record text on one line', () => {
    const f = fixture(); seed(f); const { worktree } = record(f, '10-20', { owner: 'pilot\nextra' })
    mkdirSync(join(worktree, '.lane'), { recursive: true }); writeFileSync(join(worktree, '.lane', 'report.md'), 'done')
    const first = exits(watch(f).stdout)
    expect(first, 'report-bearing exit is announced').toHaveLength(1)
    expect(first[0], 'existing report is present').toContain(`report=${join(worktree, '.lane', 'report.md')} present`)
    expect(first).toHaveLength(1)
    rmSync(join(worktree, '.lane', 'report.md')); record(f, '30-40')
    expect(exits(watch(f).stdout)[0]).toContain(`report=${join(worktree, '.lane', 'report.md')} absent`)
  })
  it('persists across a change of configuration directory', () => {
    const f = fixture(); seed(f); record(f)
    expect(exits(watch(f).stdout), 'first configuration announces exit').toHaveLength(1)
    expect(exits(watch(f, { CLAUDE_CONFIG_DIR: join(f.root, 'other-config'), CLAUDE_PLUGIN_DATA: join(f.root, 'other-data') }).stdout)).toHaveLength(0)
  })
  it('rejects unsafe session identifiers without writing outside the notice directory', () => {
    const f = fixture(); record(f)
    const result = watch(f, { CLAUDE_CODE_SESSION_ID: '../unsafe' })
    expect(result.stderr, 'unsafe session identifier is disabled').toContain('completion notices disabled')
    expect(existsSync(join(f.root, 'unsafe.json'))).toBe(false)
  })
})

describe('session lane completion notices', () => {
  it('announces both-gone nonterminal records but leaves unknown identity silent', async () => {
    const f = fixture(); seed(f); record(f, '10-20', { state: 'running', exit: null, exitedAt: null })
    record(f, '30-40', { state: 'running' })
    const { createLaneExitNotices } = await moduleUnderTest(); const lines: string[] = []
    const sweep = createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: (line: string) => lines.push(line),
      classifyLane: (value: { runId: string }) => ({ worker: 'gone', child: value.runId === '10-20' ? 'gone' : 'unknown' }) })
    sweep(); sweep()
    expect(exits(lines.join('\n'))).toHaveLength(1)
    expect(lines[0]).toContain('state=running exit=unknown at=unknown')
  })
  it('prunes expired entries on writes and enforces the entry cap', async () => {
    const f = fixture(); const { createLaneExitNotices } = await moduleUnderTest()
    const now = Date.now()
    seed(f, [{ runId: 'expired', at: now - EXPECTED_LOOKBACK_MS - 1 },
      ...Array.from({ length: EXPECTED_MAX_ENTRIES }, (_, n) => ({ runId: `old-${n}`, at: now - 1000 + n / EXPECTED_MAX_ENTRIES }))])
    record(f)
    createLaneExitNotices({ ...f, sessionId: 'test-session', clock: () => now, stdout: () => {} })()
    expect(entries(f)).toHaveLength(EXPECTED_MAX_ENTRIES)
    expect(entries(f).map((entry) => entry.runId)).not.toContain('expired')
    expect(entries(f).map((entry) => entry.runId)).not.toContain('old-0')
    expect(entries(f).map((entry) => entry.runId)).toContain('10-20')
  })
})

describe('session lane completion notices', () => {
  it('skips old supervision directories and expired terminal records in recent directories', () => {
    const f = fixture(); seed(f)
    const old = new Date(Date.now() - EXPECTED_LOOKBACK_MS - 1000)
    const { dir } = record(f); utimesSync(dir, old, old)
    expect(exits(watch(f).stdout)).toHaveLength(0)
    record(f, '30-40', { exitedAt: old.toISOString() })
    expect(exits(watch(f).stdout).map((line) => /runId=(\S+)/.exec(line)?.[1])).toEqual(['10-20'])
  })
  it('reports an unreadable scan once and retries without throwing', async () => {
    const f = fixture(); seed(f); const { createLaneExitNotices } = await moduleUnderTest(); const errors: string[] = []
    rmSync(f.stateRoot, { recursive: true }); writeFileSync(f.stateRoot, 'not a directory')
    const sweep = createLaneExitNotices({ ...f, sessionId: 'test-session', stderr: (line: string) => errors.push(line) })
    expect(() => { sweep(); sweep() }).not.toThrow()
    expect(errors).toHaveLength(1)
    rmSync(f.stateRoot); mkdirSync(f.stateRoot); record(f)
    const lines: string[] = []
    createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: (line: string) => lines.push(line) })()
    expect(exits(lines.join('\n'))).toHaveLength(1)
  })
})

describe('session lane completion notices', () => {
  it('never reannounces entries evicted by the cap after a restart', async () => {
    const f = fixture(); seed(f); const { createLaneExitNotices } = await moduleUnderTest()
    for (const id of ['10-20', '30-40', '50-60']) record(f, id)
    const lines: string[] = []
    const options = { ...f, sessionId: 'test-session', maxEntries: 2, stdout: (line: string) => lines.push(line) }
    const sweep = createLaneExitNotices(options); sweep(); sweep(); createLaneExitNotices(options)()
    expect(exits(lines.join('\n'))).toHaveLength(3)
    expect(entries(f)).toHaveLength(2)
  })
  it('retries failed persistence without swallowing the completion notice', async () => {
    const f = fixture(); seed(f); record(f); const { createLaneExitNotices } = await moduleUnderTest()
    const lines: string[] = []; const errors: string[] = []; let attempts = 0
    const sweep = createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: (line: string) => lines.push(line),
      stderr: (line: string) => errors.push(line), write: (file: string, value: unknown) => {
        if (attempts++ === 0) throw new Error('write refused')
        writeFileSync(file, JSON.stringify(value))
      } })
    sweep(); expect(exits(lines.join('\n'))).toHaveLength(1); sweep(); sweep()
    expect(exits(lines.join('\n'))).toHaveLength(2)
    expect(errors).toHaveLength(1)
  })
})

describe('completion notice interruption and retention locks', () => {
  it('prints every completion before recording the batch as announced', async () => {
    const f = fixture(); seed(f); record(f); record(f, '30-40')
    const { createLaneExitNotices } = await moduleUnderTest(); const calls: string[] = []
    createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: () => calls.push('stdout'),
      write: () => calls.push('write') })()
    expect(calls, 'all completion output precedes the archive write').toEqual(['stdout', 'stdout', 'write'])
  })
  it('prints again after a writer throws following completion output', async () => {
    const f = fixture(); seed(f); record(f)
    const { createLaneExitNotices } = await moduleUnderTest(); const lines: string[] = []; const calls: string[] = []
    const sweep = createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: (line: string) => {
      calls.push('stdout'); lines.push(line)
    }, stderr: () => {}, write: () => { calls.push('write'); throw new Error('interrupted write') } })
    sweep()
    expect(calls, 'the failed writer is reached only after output').toEqual(['stdout', 'write'])
    sweep()
    expect(exits(lines.join('\n')), 'failed persistence leaves the printed run eligible').toHaveLength(2)
    expect(entries(f)).toEqual([])
  })
  it('removes only expired regular other-session archives on a write', async () => {
    const f = fixture(); seed(f); const now = Date.now(); const day = 24 * 60 * 60 * 1000
    const files = ['old-session.json', 'recent-session.json', 'unrelated.txt', 'invalid.name.json']
    for (const name of files) {
      const file = join(f.dataDir, name); writeFileSync(file, '{}')
      const at = new Date(now - (name === 'recent-session.json' ? 1 : 8) * day); utimesSync(file, at, at)
    }
    mkdirSync(join(f.dataDir, 'directory.json'))
    symlinkSync(join(f.dataDir, 'unrelated.txt'), join(f.dataDir, 'link.json'))
    const ownAt = new Date(now - 8 * day); utimesSync(f.file, ownAt, ownAt)
    const { createLaneExitNotices } = await moduleUnderTest()
    createLaneExitNotices({ ...f, sessionId: 'test-session', clock: () => now, stdout: () => {} })()
    expect(existsSync(join(f.dataDir, 'old-session.json')), 'eight-day inactive session archive is removed').toBe(false)
    for (const name of [...files.slice(1), 'directory.json', 'link.json', 'test-session.json']) {
      expect(existsSync(join(f.dataDir, name)), `${name} is retained`).toBe(true)
    }
  })
})

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable completion record locks', () => {
  it('continues past an unlistable supervision directory and reports it once', async () => {
    const f = fixture(); seed(f); const { dir } = record(f)
    record(f, '30-40', {}, 'supervision-pilot'); chmodSync(dir, 0)
    try {
      const { createLaneExitNotices } = await moduleUnderTest(); const lines: string[] = []; const errors: string[] = []
      const sweep = createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: (line: string) => lines.push(line),
        stderr: (line: string) => errors.push(line) })
      sweep(); sweep()
      expect(exits(lines.join('\n')), 'an unlistable directory cannot abort another directory').toHaveLength(1)
      expect(errors).toHaveLength(1); expect(errors[0]).toContain(dir)
      expect(entries(f).map((entry) => entry.runId)).toEqual(['30-40'])
    } finally { chmodSync(dir, 0o700) }
  })
  it('never reads an expired record inside a recent supervision directory', () => {
    const f = fixture(); seed(f); const { dir } = record(f, '10-20')
    const file = join(dir, '10-20.json'); chmodSync(file, 0)
    const old = new Date(Date.now() - EXPECTED_LOOKBACK_MS - 1000); utimesSync(file, old, old)
    record(f, '30-40')
    const result = watch(f)
    expect(exits(result.stdout), 'recent exit survives the unreadable expired record').toHaveLength(1)
    expect(result.stderr).toBe('')
  })
  it('skips an unreadable foreign record and reports its path only once', async () => {
    const f = fixture(); seed(f); const { dir } = record(f, '10-20', { ownerSessionId: 'foreign' })
    const file = join(dir, '10-20.json'); chmodSync(file, 0)
    record(f, '30-40', {}, 'supervision-pilot')
    const { createLaneExitNotices } = await moduleUnderTest(); const lines: string[] = []; const errors: string[] = []
    const sweep = createLaneExitNotices({ ...f, sessionId: 'test-session', stdout: (line: string) => lines.push(line),
      stderr: (line: string) => errors.push(line) })
    sweep()
    expect(exits(lines.join('\n')), 'unreadable foreign record cannot abort owned completion delivery').toHaveLength(1)
    expect(errors).toHaveLength(1); expect(errors[0]).toContain(file)
    expect(entries(f).map((entry) => entry.runId)).toEqual(['30-40'])
    sweep(); expect(errors, 'the same unreadable path is reported once across sweeps').toHaveLength(1)
  })
})

describe('completion record filesystem race locks', () => {
  it.each([['statSync', 'ENOENT'], ['readFileSync', 'ENOENT'], ['readFileSync', 'EISDIR']])(
    'isolates %s failures with %s and reports each path once', (operation, code) => {
      const f = fixture(); seed(f); const { dir } = record(f, '10-20', { ownerSessionId: 'foreign' })
      record(f, '30-40', {}, 'supervision-pilot'); const file = join(dir, '10-20.json')
      const program = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        const original = fs[process.argv[3]];
        fs[process.argv[3]] = (...args) => {
          if (args[0] === process.argv[2]) throw Object.assign(new Error('injected record failure'), { code: process.argv[4] });
          return original(...args);
        }; syncBuiltinESMExports();
        const { createLaneExitNotices } = await import(process.argv[1]);
        const sweep = createLaneExitNotices({ stateRoot: process.env.WT_LANE_HOST_STATE }); sweep(); sweep();`
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', program,
        pathToFileURL(MODULE).href, file, operation, code], { env: f.env, encoding: 'utf8', timeout: 30_000 })
      expect(result.status, result.stderr).toBe(0)
      expect(exits(result.stdout), 'a failed record cannot abort another directory').toHaveLength(1)
      expect(result.stderr.trim().split('\n'), 'one diagnostic per failed record path').toHaveLength(1)
      expect(result.stderr).toContain(file)
      expect(entries(f).map((entry) => entry.runId)).toEqual(['30-40'])
    })
})
