import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const hostUrl = new URL('../../../../plugin/bin/lib/host/procfs.mjs', import.meta.url).href
const host = await import(/* @vite-ignore */ hostUrl).catch(() => null)
// @ts-expect-error ESM runtime module
import { classifyLane } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-host-procfs-'))
  roots.push(root)
  const pid = '42'
  const dir = join(root, pid)
  mkdirSync(join(dir, 'fd'), { recursive: true })
  mkdirSync(join(dir, 'fdinfo'))
  for (const [name, value] of Object.entries({
    cmdline: 'node\0worker\0', stat: '42 (worker) S 1 42', status: 'Name:\tworker\nPPid:\t1\n',
    environ: 'CLAUDE_CODE_SESSION_ID=test\0', cwd: 'working-directory',
    'fd/1': 'task.output', 'fdinfo/1': 'flags:\t0100001\n',
  })) writeFileSync(join(dir, name), value)
  writeFileSync(join(root, 'uptime'), '123.45 1.00\n')
  writeFileSync(join(root, 'loadavg'), '1.25 2.50 3.00 1/2 42\n')
  const procfs = host!.createProcfs({ root, platform: 'linux', readlink: (file: string) => readFileSync(file, 'utf8') })
  return { root, pid, dir, procfs }
}

describe('host procfs operations', () => {
  it('ships the procfs host module', () => {
    expect(host, 'procfs reads have a shipped host boundary').not.toBeNull()
  })

  it('reads process records and directory metadata from an injected tree', () => {
    const { procfs, pid } = fixture()
    expect(procfs.rootExists()).toBe(true)
    expect(procfs.listProcesses()).toEqual(expect.arrayContaining([pid]))
    expect(procfs.processDirectoryStat(pid).isDirectory()).toBe(true)
    expect(procfs.readCommandLine(pid).toString()).toBe('node\0worker\0')
    expect(procfs.readProcessStat(pid, 'utf8')).toBe('42 (worker) S 1 42')
    expect(procfs.readProcessStatus(pid, 'utf8')).toContain('PPid:\t1')
    expect(procfs.readEnvironment(pid).toString()).toContain('CLAUDE_CODE_SESSION_ID=test\0')
    expect(procfs.readWorkingDirectory(pid)).toBe('working-directory')
  })

  it('owns descriptor listings, targets, and mode reads', () => {
    const { procfs, pid } = fixture()
    expect(procfs.listDescriptors(pid, { withFileTypes: true }).map((entry: { name: string }) => entry.name)).toEqual(['1'])
    expect(procfs.readDescriptorTarget(pid, 1)).toBe('task.output')
    expect(procfs.readDescriptorInfo(pid, '1', 'utf8')).toBe('flags:\t0100001\n')
  })

  it('reads host-wide uptime and load without rounding', () => {
    const { procfs } = fixture()
    expect(procfs.readUptime('utf8')).toBe('123.45 1.00\n')
    expect(procfs.readLoadAverage('utf8')).toBe('1.25 2.50 3.00 1/2 42\n')
  })

})

describe('host procfs injected readers', () => {
  it('passes bounded-reader arguments and resolved cwd through the injected seam', () => {
    const { root, pid } = fixture()
    const readFile = vi.fn(() => 'bounded')
    const realpath = vi.fn(() => 'resolved-cwd')
    const procfs = host!.createProcfs({ root, platform: 'linux', readFile, realpath })
    expect(procfs.readCommandLine(pid, 4096, false)).toBe('bounded')
    expect(readFile).toHaveBeenCalledWith(join(root, pid, 'cmdline'), 4096, false)
    expect(procfs.resolveWorkingDirectory(pid)).toBe('resolved-cwd')
    expect(realpath).toHaveBeenCalledWith(join(root, pid, 'cwd'))
  })

  it('preserves a listing-to-read exit race and reports the vanished pid absent', () => {
    const { root, dir, pid } = fixture()
    const table = host!.readProcfsProcessTable({ root, platform: 'linux' })
    expect(table.entries).toContain(pid)
    rmSync(dir, { recursive: true })
    expect(() => table.readCommandLine(pid)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(host!.procfsProcessPresence(pid, { root, platform: 'linux' })).toEqual({ status: 'absent' })
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('keeps %s unreadable evidence unknown, never absent', (code) => {
    const { root, pid } = fixture()
    const denied = () => { throw Object.assign(new Error('unreadable'), { code }) }
    const procfs = host!.createProcfs({ root, platform: 'linux', readFile: denied })
    expect(() => procfs.readCommandLine(pid)).toThrow(expect.objectContaining({ code }))
    expect(host!.procfsProcessPresence(pid, { root, platform: 'linux', stat: denied })).toEqual({ status: 'unknown', code })
    expect(host!.procfsProcessExists(pid, { root, platform: 'linux', stat: denied })).toBeNull()
  })

})

describe('host procfs presence', () => {
  it.each(['ENOENT', 'ENOTDIR', 'ESRCH'])('names %s as an absent pid', (code) => {
    const stat = () => { throw Object.assign(new Error('gone'), { code }) }
    expect(host!.procfsProcessPresence(42, { platform: 'linux', stat })).toEqual({ status: 'absent' })
    expect(host!.procfsProcessExists(42, { platform: 'linux', stat })).toBe(false)
  })

  it('reports an extant pid present', () => {
    const { root, pid } = fixture()
    expect(host!.procfsProcessPresence(pid, { root, platform: 'linux' })).toEqual({ status: 'present' })
    expect(host!.procfsProcessExists(pid, { root, platform: 'linux' })).toBe(true)
  })

  it.each(['darwin', 'win32', 'freebsd'])('names procfs unavailable on %s without reading', (platform) => {
    const { root } = fixture()
    const readFile = vi.fn()
    const readdir = vi.fn()
    const stat = vi.fn()
    const readlink = vi.fn()
    const realpath = vi.fn()
    const procfs = host!.createProcfs({ root, platform, readFile, readdir, stat, readlink, realpath })
    for (const [name, operation] of Object.entries(procfs)) {
      if (typeof operation !== 'function') continue
      expect(() => operation(42, 1), `${name} must name unavailable`).toThrow(expect.objectContaining({ code: 'PROCFS_UNAVAILABLE', message: `procfs unavailable on ${platform}` }))
    }
    expect(host!.procfsProcessPresence(42, { platform, stat })).toEqual({ status: 'unavailable' })
    expect(readFile).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(readlink).not.toHaveBeenCalled()
    expect(realpath).not.toHaveBeenCalled()
  })

})

describe('host procfs roots and permissions', () => {
  it('keeps the injected listing root spelling and options intact', () => {
    const readdir = vi.fn(() => [])
    const procfs = host!.createProcfs({ root: 'fake-tree/', platform: 'linux', readdir })
    procfs.listProcesses({ withFileTypes: true })
    expect(readdir).toHaveBeenCalledWith('fake-tree/', { withFileTypes: true })
  })

  it('supplies the default Linux root while keeping reads fully injectable', () => {
    const readFile = vi.fn(() => '0.125 0.25 0.5')
    const procfs = host!.createProcfs({ platform: 'linux', readFile })
    expect(procfs.readLoadAverage('utf8')).toBe('0.125 0.25 0.5')
    expect(readFile).toHaveBeenCalledWith('/proc/loadavg', 'utf8')
  })

  // Permission bits are an actual Linux syscall lock; root bypasses them and Windows does not model them.
  it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('keeps an unreadable process directory unknown in the lane classifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-procfs-denied-'))
    roots.push(root)
    mkdirSync(join(root, '42'))
    const record = { runId: 'fixture', state: 'running', workerPid: 42, workerArgv: ['node'], workerStartTime: 100, childPid: null, childArgv: null }
    chmodSync(root, 0)
    try {
      expect(classifyLane(record, { platform: 'linux', procRoot: root, inspect: () => null }).status,
        'EACCES is unreadable evidence, never a gone lane').toBe('unknown')
    } finally { chmodSync(root, 0o700) }
  })
})
