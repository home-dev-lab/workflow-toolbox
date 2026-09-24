import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { readLinuxProcProcesses } from '../../../../plugin/bin/lib/host/linux.mjs'

const EVIDENCE_ROOT = resolve(import.meta.dirname, '../../../../probes/host-platform/evidence')
const COMMITTED_EVIDENCE_ROOT = resolve(import.meta.dirname, '../../../../probes/host-platform/evidence')
const platforms = ['linux', 'darwin', 'win32'] as const
const labels = { linux: 'ubuntu-latest', darwin: 'macos-latest', win32: 'windows-latest' } as const
const seedWrongFake = process.env.WT_SEED_WRONG_HOST_FAKE === '1'
const useRealHost = process.env.WT_HOST_CONTRACT_REAL === '1'
const activePlatforms = useRealHost ? platforms.filter((platform) => platform === process.platform) : platforms
const snapshotSamples = {
  linux: { pid: 1, ppid: 0, elapsedMs: 46_000, command: '/sbin/init' },
  darwin: { pid: 1, ppid: 0, elapsedMs: 346_000, command: '/sbin/launchd' },
  win32: { pid: 4, ppid: 0, elapsedMs: 46_000, command: 'System' },
} as const
const procStat = (pid: number, command: string, startTicks: number) => `${pid} (${command}) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startTicks} 20\n`

function evidenceHost(platform: typeof platforms[number]) {
  return createHostAdapter({
    platform,
    evidenceRoot: EVIDENCE_ROOT,
    mutate: (evidence: { processTable: { processTable: { raw: string } } }) => {
      if (seedWrongFake && platform !== 'win32') evidence.processTable.processTable.raw = evidence.processTable.processTable.raw.replace(/^(\s*1)\s+0/m, '$1 999')
      return evidence
    },
  })
}

const contractHost = (platform: typeof platforms[number]) => useRealHost ? createHostAdapter({ platform }) : evidenceHost(platform)

describe('host adapter evidence contract', () => {
  const assertions = useRealHost ? 5 : 15
  const contract = (name: string, appliesTo: readonly string[], run: (platform: typeof platforms[number]) => void) => {
    it(`${name} [${appliesTo.join(',')}]`, () => {
      for (const platform of activePlatforms) {
        if (!appliesTo.includes(platform)) continue
        run(platform)
      }
    })
  }

  it('replays only committed host evidence', () => {
    expect(EVIDENCE_ROOT).toBe(COMMITTED_EVIDENCE_ROOT)
  })

  contract('reports evidence provenance for every question', platforms, (platform) => {
    const host = contractHost(platform)
    if (useRealHost) expect(host.platform).toBe(platform)
    else expect(host.evidence()).toMatchObject({ platform, runnerLabel: labels[platform], runId: '35501457364' })
  })

  it.each([
    ['linux', { mib: 14609, source: 'MemAvailable from /proc/meminfo' }],
    ['darwin', { mib: 3099, source: 'free, inactive, and speculative pages from vm_stat' }],
    ['win32', { mib: 13699, source: 'free memory from os.freemem()' }],
  ] as const)('reads recorded available memory on %s', (platform, expected) => {
    expect(evidenceHost(platform).readAvailableMemory()).toEqual(expected)
  })

  it('reads positive available memory from the production host with a named source', () => {
    const memory = createHostAdapter().readAvailableMemory()
    expect(memory.mib).toBeGreaterThan(0)
    expect(memory.source).toBeTruthy()
    process.stdout.write(`production host memory: platform=${process.platform} mib=${memory.mib} source=${memory.source}\n`)
  })

  it('bounds vm_stat and falls back to os.freemem on other supported hosts', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '', stderr: '', error: null }))
    createHostAdapter({ platform: 'darwin', invoke: { run } }).readAvailableMemory()
    expect(run).toHaveBeenCalledWith('vm_stat', [], { timeout: 3_000 })

    expect(createHostAdapter({ platform: 'freebsd', invoke: { freeMemory: () => 2 * 1024 * 1024 * 1024 } }).readAvailableMemory())
      .toEqual({ mib: 2048, source: 'free memory from os.freemem() on freebsd' })
  })

  contract('answers pid to parent-pid from the captured process table', platforms, (platform) => {
    const result = contractHost(platform).readProcessRelationships()
    if (platform === 'win32') {
      expect(result).toEqual({ status: 'unavailable', processes: [], reason: 'process table command exited 1' })
    } else {
      expect(result.status).toBe('known')
      expect(result.processes.length).toBeGreaterThan(1)
      expect(result.processes.every((row: { pid: number, parentPid: number }) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.parentPid))).toBe(true)
      expect(result.processes.find((row: { pid: number }) => row.pid === 1)?.parentPid).toBe(0)
    }
  })

  it.each(platforms)('parses process discovery from an injected %s invocation', (platform) => {
    const outputs = {
      linux: '1 0 46 /sbin/init\n',
      darwin: '1 0 346 /sbin/launchd\n',
      win32: '4 0 46000 System\r\n',
    }
    const run = vi.fn(() => ({ status: 0, stdout: outputs[platform], stderr: '', error: null }))
    const host = createHostAdapter({
      platform,
      invoke: { run },
    })

    expect(host.readProcessSnapshot()).toEqual({ supported: true, processes: [snapshotSamples[platform]] })
    if (platform === 'darwin') {
      expect(run).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,etime=,command='])
    }
  })

  it('reads Linux process discovery from the non-spawning /proc adapter when available', () => {
    const run = vi.fn(() => { throw new Error('ps must not run') })
    const listProcesses = vi.fn(() => [snapshotSamples.linux])
    const host = createHostAdapter({ platform: 'linux', invoke: { run, listProcesses } })

    expect(host.readProcessSnapshot()).toEqual({ supported: true, processes: [snapshotSamples.linux] })
    expect(listProcesses).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it('never combines a Linux PID identity with a reused process command', () => {
    const stats = [
      procStat(42, 'broker-a', 100),
      procStat(42, 'broker-b', 200),
    ]
    const readFile = vi.fn((file: string) => {
      if (file === '/proc/uptime') return '10 1\n'
      if (file.endsWith('/stat')) return stats.shift()!
      return '/plugins/openai-codex/codex/scripts/app-server-broker.mjs\0'
    })

    expect(readLinuxProcProcesses({
      readFile,
      readDirectory: () => [{ name: '42', isDirectory: () => true }],
      observedAt: 20_000,
    })).toEqual({ processes: [], unknownPids: [42] })
  })

  it('reports a live but unreadable Linux PID as unknown', () => {
    const readFile = vi.fn((file: string) => {
      if (file === '/proc/uptime') return '10 1\n'
      if (file.endsWith('/stat')) return procStat(42, 'broker', 100)
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })

    expect(readLinuxProcProcesses({
      readFile,
      readDirectory: () => [{ name: '42', isDirectory: () => true }],
      observedAt: 20_000,
    })).toEqual({ processes: [], unknownPids: [42] })
  })

  it.each(['aix', 'freebsd', 'sunos'] as const)('keeps process discovery supported on %s', (platform) => {
    const run = vi.fn(() => ({ status: 0, stdout: '1 0 12 /sbin/init\n', stderr: '', error: null }))
    const host = createHostAdapter({ platform, invoke: { run } })

    expect(host.readProcessSnapshot()).toEqual({
      supported: true,
      processes: [{ pid: 1, ppid: 0, elapsedMs: 12_000, command: '/sbin/init' }],
    })
    expect(run).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid=,etimes=,args='])
  })

  contract('refuses process snapshot replay when public evidence has no captured operation', platforms, (platform) => {
    const expected = platform === 'win32'
      ? 'captured host evidence has no invocation for powershell.exe -NoProfile -NonInteractive -Command $now = Get-Date'
      : platform === 'darwin'
        ? 'captured host evidence has no invocation for ps -axo pid=,ppid=,etime=,command='
        : 'captured host evidence has no invocation for ps -eo pid=,ppid=,etimes=,args='
    expect(() => evidenceHost(platform).readProcessSnapshot()).toThrow(expected)
  })

  contract('resolves the captured symlinked directory to its canonical target', platforms, (platform) => {
    const host = contractHost(platform)
    if (!useRealHost) {
      const sample = host.evidence().path.symlinkedDirectory
      expect(host.resolveCanonicalPath(sample.input)).toEqual({ status: 'resolved', path: sample.targetRealpath })
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'wt-host-contract-'))
    const target = join(root, 'target'); const link = join(root, 'link')
    try {
      mkdirSync(target)
      symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir')
      expect(host.resolveCanonicalPath(link)).toEqual({ status: 'resolved', path: realpathSync.native(target) })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  contract('ends the captured process family using the native host concept', platforms, (platform) => {
    const host = contractHost(platform)
    if (!useRealHost) {
      const sample = host.evidence().termination
      expect(host.endProcessFamily(sample.childPid)).toEqual({ status: 'ended', kind: platform === 'win32' ? 'process_tree' : 'posix_process_group' })
      return
    }
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
    if (!child.pid) throw new Error('host contract fixture did not start')
    try {
      expect(host.endProcessFamily(child.pid)).toEqual({ status: 'ended', kind: platform === 'win32' ? 'process_tree' : 'posix_process_group' })
    } finally { try { process.kill(child.pid, 'SIGKILL') } catch {} }
  })

  it('prints the declared applicability and skip count', () => {
    const skips = useRealHost ? 10 : 0
    expect(assertions + skips).toBe(15)
    const skippedPlatforms = useRealHost ? platforms.filter((platform) => platform !== process.platform).join(',') : 'none'
    process.stdout.write(`host adapter contract: assertions=${assertions} named_skips=${skips} skipped_platforms=${skippedPlatforms}\n`)
  })
})
