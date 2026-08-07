import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-lane-activity.mjs')
const LANE_PROBE = join(REPO_ROOT, 'plugin/bin/wt-lane-probe.mjs')
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/lane-activity', import.meta.url))

type WorktreeEntry = {
  worktree: string
  currentSubTask: string | null
  currentSubTaskAt: string | null
  logReadable: boolean
  logUnreadableReason: string | null
  session: { id: string; model: unknown; tokensInput: number; tokensTotal: number } | null
  storeReadable: boolean
  storeUnreadableReason: string | null
  process: { alive: boolean | 'unknown' }
  stall: { verdict: string; reason: string }
}

type Verdict = {
  exitCode: number
  json: {
    platform?: string
    dataDirSupported?: boolean
    dataDir?: string | null
    dataDirReason?: string | null
    worktrees?: WorktreeEntry[]
  }
}

function run(args: string[]): Verdict {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    return { exitCode: 0, json: JSON.parse(stdout.trim().split('\n').pop()!) }
  } catch (error) {
    const failed = error as Error & { status?: number; stdout?: string | Buffer }
    const stdout = typeof failed.stdout === 'string' ? failed.stdout : String(failed.stdout ?? '')
    return { exitCode: failed.status ?? 2, json: stdout.trim() ? JSON.parse(stdout.trim().split('\n').pop()!) : {} }
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeWorktreeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-lane-activity-worktree-'))
  dirs.push(dir)
  return dir
}

// Builds a fake opencode data dir (opencode.db + log/opencode.log) so the CLI can be exercised
// without a live opencode install. Loads the REAL captured fixture rows (see
// fixtures/lane-activity/README.md) so the CLI-level assertions exercise the exact same schema
// shape as the unit-level core tests, just through the full process boundary.
function makeDataDir({ withStore = true, withLog = true, worktreePath }: { withStore?: boolean; withLog?: boolean; worktreePath: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-lane-activity-datadir-'))
  dirs.push(dir)

  if (withStore) {
    const dbPath = join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(readFileSync(join(FIXTURES_DIR, 'schema.sql'), 'utf8'))
    const rows = readFileSync(join(FIXTURES_DIR, 'real-session-rows.sql'), 'utf8').replaceAll('/tmp/fixture-worktree', worktreePath)
    db.exec(rows)
    db.close()
  }

  if (withLog) {
    mkdirSync(join(dir, 'log'), { recursive: true })
    const log = readFileSync(join(FIXTURES_DIR, 'real-log-tail.txt'), 'utf8').replaceAll('/tmp/fixture-worktree', worktreePath)
    writeFileSync(join(dir, 'log', 'opencode.log'), log)
  }

  return dir
}

describe('wt-lane-activity.mjs — usage', () => {
  it('exits 2 when no --worktree is given', () => {
    const result = run(['--pattern', 'anything'])
    expect(result.exitCode).toBe(2)
  })
})

describe('wt-lane-activity.mjs — happy path against a fake data dir built from the REAL fixture', () => {
  it('names the current sub-task from the log AND reports tokens/model from the store, for a worktree with no live process', () => {
    const worktree = makeWorktreeDir()
    const dataDir = makeDataDir({ worktreePath: worktree })

    const result = run(['--worktree', worktree, '--data-dir', dataDir, '--pattern', `no-such-process-${Date.now()}`])

    expect(result.exitCode).toBe(0)
    const entry = result.json.worktrees?.[0]
    expect(entry).toBeDefined()
    expect(entry?.storeReadable).toBe(true)
    expect(entry?.session?.tokensInput).toBe(4016)
    expect(entry?.session?.tokensTotal).toBe(4016 + 12 + 11)
    expect(entry?.logReadable).toBe(true)
    expect(entry?.currentSubTask).toBe('project copy refresh done')
    // no live process matched --pattern -> the store/log probe correctly separates from liveness
    expect(entry?.process.alive).toBe(false)
    expect(entry?.stall.verdict).toBe('gone')
  })
})

describe('wt-lane-activity.mjs — degraded paths (invariant 3 & 4: unknown, never a guessed zero)', () => {
  it('ABSENT store: storeReadable:false with a stated reason, session:null — never a fabricated zero-token session', () => {
    const worktree = makeWorktreeDir()
    const dataDir = makeDataDir({ withStore: false, worktreePath: worktree })

    const result = run(['--worktree', worktree, '--data-dir', dataDir, '--pattern', `no-such-process-${Date.now()}`])

    const entry = result.json.worktrees?.[0]
    expect(entry?.storeReadable).toBe(false)
    expect(entry?.storeUnreadableReason).toBeTruthy()
    expect(entry?.session).toBeNull()
  })

  it('UNREADABLE store (present but corrupt): storeReadable:false with a stated reason, never a crash', () => {
    const worktree = makeWorktreeDir()
    const dataDir = mkdtempSync(join(tmpdir(), 'wt-lane-activity-corrupt-'))
    dirs.push(dataDir)
    writeFileSync(join(dataDir, 'opencode.db'), 'this is not a sqlite file')

    const result = run(['--worktree', worktree, '--data-dir', dataDir, '--pattern', `no-such-process-${Date.now()}`])

    expect(result.exitCode).toBe(0)
    const entry = result.json.worktrees?.[0]
    expect(entry?.storeReadable).toBe(false)
    expect(entry?.storeUnreadableReason).toBeTruthy()
    expect(entry?.session).toBeNull()
  })

  it('store present but LOG missing: logReadable:false, currentSubTask:null — store fields still populate independently', () => {
    const worktree = makeWorktreeDir()
    const dataDir = makeDataDir({ withLog: false, worktreePath: worktree })

    const result = run(['--worktree', worktree, '--data-dir', dataDir, '--pattern', `no-such-process-${Date.now()}`])

    const entry = result.json.worktrees?.[0]
    expect(entry?.logReadable).toBe(false)
    expect(entry?.currentSubTask).toBeNull()
    expect(entry?.storeReadable).toBe(true)
    expect(entry?.session?.tokensInput).toBe(4016)
  })

  it('BOTH store and log present but EMPTY (no row/line for this worktree): readable:true, but session/activity are null, never fabricated', () => {
    const worktree = makeWorktreeDir()
    const otherWorktree = makeWorktreeDir() // fixture rows are written under a DIFFERENT worktree path
    const dataDir = makeDataDir({ worktreePath: otherWorktree })

    const result = run(['--worktree', worktree, '--data-dir', dataDir, '--pattern', `no-such-process-${Date.now()}`])

    const entry = result.json.worktrees?.[0]
    expect(entry?.storeReadable).toBe(true)
    expect(entry?.session).toBeNull()
    expect(entry?.logReadable).toBe(true)
    expect(entry?.currentSubTask).toBeNull()
    // neither source produced a timestamp for THIS worktree -> stall must be unknown, not "gone"-by-default alone
    expect(entry?.stall.verdict === 'unknown' || entry?.stall.verdict === 'gone').toBe(true)
  })

  it('data dir unsupported on this platform (forced via a bogus explicit --data-dir path that does not exist): both sources report unreadable with reasons, never silence', () => {
    const worktree = makeWorktreeDir()
    const missingDataDir = join(tmpdir(), `wt-lane-activity-missing-${Date.now()}`)

    const result = run(['--worktree', worktree, '--data-dir', missingDataDir, '--pattern', `no-such-process-${Date.now()}`])

    expect(result.exitCode).toBe(0)
    const entry = result.json.worktrees?.[0]
    expect(entry?.storeReadable).toBe(false)
    expect(entry?.storeUnreadableReason).toBeTruthy()
    expect(entry?.logReadable).toBe(false)
    expect(entry?.logUnreadableReason).toBeTruthy()
  })
})

describe('wt-lane-activity.mjs — process-alive integration (delegates to wt-lane-probe.mjs, does not reimplement it)', () => {
  it('reports process.alive:true and a non-"gone" stall verdict when a real matching process is running in the worktree', async () => {
    const worktree = makeWorktreeDir()
    const dataDir = makeDataDir({ worktreePath: worktree })
    const marker = `wt-lane-activity-fixture-${Date.now()}`
    const fixtureDir = mkdtempSync(join(tmpdir(), 'wt-lane-activity-proc-'))
    dirs.push(fixtureDir)
    const fixtureScript = join(fixtureDir, 'sleep.mjs')
    writeFileSync(fixtureScript, 'setInterval(() => {}, 1000)\n')
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [fixtureScript, marker], { cwd: worktree, stdio: 'ignore' })
    try {
      // wait for pgrep to see it (same wait strategy as lane-probe.test.ts)
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        try {
          const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()
          if (out) break
        } catch {
          // not visible yet
        }
        await new Promise((r) => setTimeout(r, 50))
      }

      const result = run(['--worktree', worktree, '--data-dir', dataDir, '--pattern', marker, '--lane-probe-script', LANE_PROBE])

      const entry = result.json.worktrees?.[0]
      expect(entry?.process.alive).toBe(true)
      expect(entry?.stall.verdict).not.toBe('gone')
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('wt-lane-activity.mjs — cross-platform verdict', () => {
  it('non-linux without --data-dir/OPENCODE_DATA_DIR: dataDirSupported:false with a stated reason, never a guessed path', () => {
    if (process.platform === 'linux') return // this branch only fires off the Linux default path
    const worktree = makeWorktreeDir()
    const result = run(['--worktree', worktree, '--pattern', `no-such-process-${Date.now()}`])
    expect(result.json.dataDirSupported).toBe(false)
    expect(result.json.dataDirReason).toBeTruthy()
  })
})
