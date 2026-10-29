import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, expect, it as test } from 'vitest'
// @ts-expect-error runtime module
import { fixture, repository, sweepModule } from '../../../test-support/worktree-sweep-fixture.mjs'
// @ts-expect-error runtime module
import { createProcfs } from '../../../../plugin/bin/lib/host/procfs.mjs'
const url = sweepModule('bin/lib/host/sweep-processes.mjs')
const host = await import(/* @vite-ignore */ url).catch(() => null)
const scanUrl = sweepModule('bin/lib/worktree-sweep/scan.mjs')
const sweep = await import(/* @vite-ignore */ scanUrl).catch(() => null)
const reportUrl = sweepModule('bin/lib/worktree-sweep/report.mjs')
const reporting = await import(/* @vite-ignore */ reportUrl).catch(() => null)
const it = test.skipIf(process.platform === 'win32')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const f = fixture(execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]); roots.push(f.root)
  const dir = repository(f)
  const pid = join(f.procRoot, '42'); mkdirSync(join(pid, 'fd'), { recursive: true })
  symlinkSync(f.project, join(pid, 'cwd')); symlinkSync('/', join(pid, 'root'))
  symlinkSync(process.execPath, join(pid, 'exe'))
  writeFileSync(join(pid, 'maps'), ''); writeFileSync(join(pid, 'cmdline'), 'node\0')
  return { ...f, dir, pid }
}

  it('ships a host-perimeter holder scanner', () => { expect(host).not.toBeNull() })
  it.each(['cwd', 'root', 'exe', 'fd', 'maps', 'argv'])('G14 %s inside the entry is live', kind => {
    const f = setup()
    if (kind === 'fd') symlinkSync(join(f.dir, 'tracked'), join(f.pid, 'fd', '4'))
    else if (kind === 'maps') writeFileSync(join(f.pid, 'maps'), `0040-0050 r--p 0000 00:00 1 ${join(f.dir, 'tracked')}\n`)
    else if (kind === 'argv') writeFileSync(join(f.pid, 'cmdline'), 'node\0--script=.claude/worktrees/clean/tracked\0')
    else {
      rmSync(join(f.pid, kind)); symlinkSync(kind === 'exe' ? join(f.dir, 'tracked') : f.dir, join(f.pid, kind))
    }
    expect(sweep!.scanProject(f.options).entries[0]).toMatchObject({ verdict: 'KEEP', reason: 'live' })
  })
  it('G14 own-uid partial unreadability is unknown, not non-dumpable', () => {
    const f = setup()
    const denied = Object.assign(new Error('EACCES: permission denied, readlink fixture/cwd'), { code: 'EACCES', errno: -13, syscall: 'readlink' })
    f.options.procfs = createProcfs({ root: f.procRoot, platform: 'linux', readlink: (p: string) => {
      if (p.endsWith('/exe')) throw denied
      return readlinkSync(p)
    } })
    expect(sweep!.scanProject(f.options).entries[0]).toMatchObject({ verdict: 'KEEP', reason: 'unknown-process' })
  })
  it('G15 foreign unreadable and own non-dumpable processes are counted separately', () => {
    const f = setup()
    const denied = () => { throw Object.assign(new Error('EACCES: permission denied, readlink fixture/cwd'), { code: 'EACCES', errno: -13, syscall: 'readlink' }) }
    f.options.procfs = createProcfs({ root: f.procRoot, platform: 'linux', readlink: denied, readdir: (p: string) => {
      if (p.endsWith('/fd')) return denied()
      return ['1', '42', '43', '44']
    }, stat: (p: string) => ({ uid: p.endsWith('/1') ? -1 : f.options.uid }) })
    const report = sweep!.scanProject(f.options)
    expect(report).toMatchObject({ entries: [{ verdict: 'ELIGIBLE (report only)' }], summary: { foreignUnreadable: 1, nonDumpable: 3 } })
    expect(reporting!.summaryLine(report)).toContain('3 non-dumpable, 1 foreign-unreadable')
  })
  it('G14 a same-device magic-link inode mismatch is unknown', () => {
    const f = setup()
    const dev = lstatSync(f.source, { bigint: true }).dev
    f.options.statPath = () => ({ dev, ino: 2n })
    f.options.procfs = { ...f.options.procfs, statWorkingDirectory: () => ({ dev, ino: 3n }) }
    expect(sweep!.scanProject(f.options).entries[0]).toMatchObject({ verdict: 'KEEP', reason: 'unknown-process' })
  })
  it('D4 other-device mount-layout mismatches are excluded and counted', () => {
    const f = setup(); const dev = lstatSync(f.source, { bigint: true }).dev
    f.options.statPath = () => ({ dev: dev + 2n, ino: 1n })
    const magic = () => ({ dev: dev + 1n, ino: 3n })
    f.options.procfs = { ...f.options.procfs, statWorkingDirectory: magic, statRootDirectory: magic, statExecutable: magic }
    expect(sweep!.scanProject(f.options)).toMatchObject({ entries: [{ verdict: 'ELIGIBLE (report only)' }], summary: { mismatchExcluded: 1 } })
  })
  it('G16 a namespace name and visible members do not prove host membership', () => {
    const f = setup()
    expect(host!.hostNamespaceEvidence(f.options)).toMatchObject({ status: 'unknown', reason: 'not in the host PID namespace' })
  })
  it('G14 a present recorded lane pid is KEEP live', () => {
    const f = setup(); mkdirSync(join(f.dir, '.lane')); writeFileSync(join(f.dir, '.lane', 'pid'), '42\n')
    expect(sweep!.scanProject(f.options).entries[0]).toMatchObject({ verdict: 'KEEP', reason: 'live' })
  })
  it('G22 Windows has no holder source', () => {
    const f = setup()
    expect(sweep!.scanProject({ ...f.options, platform: 'win32' }).entries[0]).toMatchObject({ verdict: 'KEEP', reason: 'holders unknown on Windows' })
  })
  it('G22 Darwin requires successful lsof and an own-cwd witness', () => {
    const f = setup()
    for (const result of [{ status: 1, stdout: '' }, { status: 0, stdout: 'p42\nfcwd\nn/elsewhere\n' }]) {
      expect(sweep!.scanProject({ ...f.options, platform: 'darwin', lsofRun: () => result }).entries[0]).toMatchObject({ verdict: 'KEEP', reason: 'lsof missing or own-cwd witness unavailable' })
    }
    expect(host!.scanSweepProcesses({ ...f.options, platform: 'darwin', pid: 42, cwd: f.project,
      lsofRun: () => ({ status: 0, stdout: `p42\nfcwd\nn${f.project}\n` }) }).status).toBe('known')
    expect(sweep!.scanProject({ ...f.options, platform: 'darwin', pid: 42, cwd: f.project,
      lsofRun: () => ({ status: 0, stdout: `p42\nfcwd\nn${f.project}\n` }) }).entries[0].verdict).toBe('ELIGIBLE (report only)')
  })
