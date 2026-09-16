import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { detectOrphanWatchers, terminateOrphanWatchers } from '../../../../plugin/bin/lib/lane-watcher-orphans.mjs'

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
