import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { detectOrphanWatchers, terminateOrphanWatchers } from '../../../../plugin/bin/lib/lane-watcher-orphans.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyIdleHelper, IDLE_HELPER_SAFE_TO_STOP_SECONDS } from '../../../../plugin/bin/lib/resolved-binary.mjs'

const WATCHER = resolve(__dirname, '../../../../plugin/bin/wt-lane-orphan-watch.mjs')

function withTempDir(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-orphan-watch-'))
  try { return run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

function processFixture(procRoot: string, pid: number, { argv, cwd, ppid = 1, startTime = pid }: { argv: string[], cwd: string, ppid?: number, startTime?: number }) {
  const dir = join(procRoot, String(pid))
  mkdirSync(dir)
  writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`)
  const fields = Array.from({ length: 20 }, () => '0')
  fields[0] = 'S'
  fields[1] = String(ppid)
  fields[19] = String(startTime)
  writeFileSync(join(dir, 'stat'), `${pid} (node) ${fields.join(' ')}\n`)
  symlinkSync(cwd, join(dir, 'cwd'))
}

describe('lane orphan watcher self-detection', () => {
  it('emits once for a helper older than five minutes and not for a live helper at the boundary', () => withTempDir((root) => {
    const fixture = join(root, 'helpers.json')
    writeFileSync(fixture, JSON.stringify([
      { pid: 701, argv: ['/usr/bin/codex', 'app-server'], elapsedMs: 300_001, startTime: 11 },
      { pid: 701, argv: ['/usr/bin/codex', 'app-server'], elapsedMs: 300_001, startTime: 11 },
      { pid: 702, argv: ['/usr/bin/codex', 'app-server'], elapsedMs: 300_000, startTime: 12 },
    ]))

    const result = spawnSync(process.execPath, [WATCHER, '--project', root, '--once'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: join(root, 'state'), WT_LANE_WATCH_TEST_HELPERS: fixture },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.match(/IDLE HELPER safe to stop/g)).toHaveLength(1)
    expect(result.stdout).toContain('pid=701')
    expect(result.stdout).not.toContain('pid=702')
  }))

  it('attributes a slotted lane and emits its decision-needed event', () => withTempDir((root) => {
    const fixture = join(root, 'helpers.json')
    writeFileSync(fixture, '[]')
    const supervision = join(root, '.lane', 'supervision-critic-Z')
    mkdirSync(supervision, { recursive: true })
    writeFileSync(join(supervision, 'current.json'), JSON.stringify({ version: 1, runId: '10-20' }))
    writeFileSync(join(supervision, '10-20.json'), JSON.stringify({
      runId: '10-20', state: 'decision-needed', owner: 'session', ownerSessionId: 'slot-owner',
      worktree: root, workerPid: 2_147_483_646, childPid: 2_147_483_647,
      timeoutAt: '2026-09-21T12:00:00.000Z', decisionDueAt: '2026-09-21T12:05:00.000Z',
      defaultDecision: 'extend', workerArgv: [], evidence: {},
    }))

    const result = spawnSync(process.execPath, [WATCHER, '--project', root, '--once'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'slot-owner', XDG_STATE_HOME: join(root, 'state'), WT_LANE_WATCH_TEST_HELPERS: fixture },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('LANE decision-needed:')
    expect(result.stdout).not.toContain('unattributed opencode')
    expect(result.stdout).toContain('--slot \'critic-Z\' --decision extend')
  }))

  it('uses the same strict five-minute boundary for a Windows command line', () => {
    const classify = (ageSeconds: number) => classifyIdleHelper({
      argv: [], command: 'C:\\tools\\codex.exe app-server', ageSeconds, relatedToTask: false,
      thresholdSeconds: IDLE_HELPER_SAFE_TO_STOP_SECONDS,
    })
    expect(classify(300)).toMatchObject({ helper: true, safeToStop: false })
    expect(classify(300.001)).toMatchObject({ helper: true, safeToStop: true })
  })

  it('names and signals only a watcher with deleted cwd and init parent', () => withTempDir((root) => {
    const procRoot = join(root, 'proc')
    mkdirSync(procRoot)
    const watcherArgv = ['/usr/bin/node', '/plugin/bin/wt-lane-orphan-watch.mjs']
    processFixture(procRoot, 101, { argv: watcherArgv, cwd: '/tmp/doomed (deleted)' })
    processFixture(procRoot, 102, { argv: watcherArgv, cwd: '/tmp/live' })
    processFixture(procRoot, 103, { argv: ['/usr/bin/opencode', '--version'], cwd: '/tmp/other (deleted)' })
    processFixture(procRoot, 104, { argv: watcherArgv, cwd: '/tmp/not-reparented (deleted)', ppid: 77 })
    processFixture(procRoot, 105, { argv: watcherArgv, cwd: '/tmp/self (deleted)' })
    const signaled: Array<[number, string]> = []

    const result = terminateOrphanWatchers({ procRoot, platform: 'linux', selfPid: 105, kill: (pid: number, signal: string) => { signaled.push([pid, signal]) } })

    expect(result.status).toBe('known')
    expect(result.orphans.map((row: { pid: number }) => row.pid)).toEqual([101])
    expect(result.reports.map((row: { pid: number }) => row.pid)).toEqual([104])
    expect(result.killed).toEqual([101])
    expect(signaled).toEqual([[101, 'SIGTERM']])
  }))

  it('revalidates identity and both orphan discriminators before signaling the exact pid', () => withTempDir((root) => {
    const procRoot = join(root, 'proc')
    mkdirSync(procRoot)
    processFixture(procRoot, 201, { argv: ['/usr/bin/node', '/plugin/bin/wt-lane-orphan-watch.mjs'], cwd: '/tmp/doomed (deleted)', startTime: 10 })
    const signaled: number[] = []

    const first = detectOrphanWatchers({ procRoot, platform: 'linux', selfPid: 999 })
    writeFileSync(join(procRoot, '201', 'stat'), `201 (node) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 11\n`)
    const result = terminateOrphanWatchers({ procRoot, platform: 'linux', selfPid: 999, candidates: first.orphans, kill: (pid: number) => { signaled.push(pid) } })

    expect(result.killed).toEqual([])
    expect(signaled).toEqual([])
  }))

  it('reports a watcher whose cwd cannot be classified instead of signaling it', () => withTempDir((root) => {
    const procRoot = join(root, 'proc')
    mkdirSync(procRoot)
    processFixture(procRoot, 301, { argv: ['/usr/bin/node', '/plugin/bin/wt-lane-orphan-watch.mjs'], cwd: '/tmp/unknown' })
    unlinkSync(join(procRoot, '301', 'cwd'))
    const signaled: number[] = []

    const result = terminateOrphanWatchers({ procRoot, platform: 'linux', selfPid: 999, kill: (pid: number) => { signaled.push(pid) } })

    expect(result.reports).toMatchObject([{ pid: 301, reason: 'cwd unreadable; no signal sent' }])
    expect(signaled).toEqual([])
  }))

  it('returns unavailable rather than zero orphans without Linux procfs', () => {
    expect(detectOrphanWatchers({ platform: 'darwin' })).toEqual({
      status: 'unavailable',
      reason: 'watcher orphan detection unavailable on this platform: /proc required',
      orphans: [],
      reports: [],
    })
  })
})
