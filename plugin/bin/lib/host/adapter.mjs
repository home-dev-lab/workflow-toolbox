import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexBrokerOwnership } from './codex-broker-ownership.mjs'
import { freemem } from 'node:os'
import * as darwin from './darwin.mjs'
import * as linux from './linux.mjs'
import * as posix from './posix.mjs'
import * as win32 from './win32.mjs'

const implementations = { aix: posix, darwin, freebsd: posix, linux, sunos: posix, win32 }
const evidenceLabels = { linux: 'ubuntu-latest', darwin: 'macos-latest', win32: 'windows-latest' }

export function createHostAdapter({ platform = process.platform, invoke, evidenceRoot, mutate = (value) => value, unavailableFallback = false } = {}) {
  const implementation = implementations[platform]
  if (!implementation && unavailableFallback) return unavailableAdapter(platform, `host adapter unavailable on ${platform}`)
  if (!implementation) throw new Error(`host adapter unavailable on ${platform}`)
  const captured = evidenceRoot ? readEvidence(platform, evidenceRoot, mutate) : null
  const invocation = captured ? evidenceInvocation(implementation, captured) : invoke ?? realInvocation()
  const adapter = {
    platform,
    readProcessRelationships: () => implementation.readProcessRelationships(invocation),
    readProcessSnapshot: () => implementation.readProcessSnapshot(invocation),
    readAvailableMemory: () => readAvailableMemory(platform, invocation),
    resolveCanonicalPath: (input) => implementation.resolveCanonicalPath(invocation, input),
    endProcessFamily: (pid) => implementation.endProcessFamily(invocation, pid),
    forceEndProcessFamily: (pid) => implementation.forceEndProcessFamily(invocation, pid),
    createCodexBrokerOwnership: (env) => createCodexBrokerOwnership(adapter, env),
  }
  if (!captured) return adapter
  return { ...adapter, evidence: () => evidenceSummary(platform, captured) }
}

function realInvocation() {
  return {
    run(command, args, options = {}) {
      try {
        const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
        return { status: result.status ?? 'unavailable', stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null }
      } catch (error) {
        return { status: 'unavailable', stdout: '', stderr: '', error }
      }
    },
    read(file) {
      try { return { status: 'read', value: readFileSync(file, 'utf8') } } catch (error) { return { status: 'unavailable', value: '', reason: error?.code ?? String(error) } }
    },
    listProcesses() {
      let uptime
      try { uptime = Number(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]) } catch { return null }
      const observedAt = Date.now()
      return readdirSync('/proc', { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return []
        try {
          const stat = readFileSync(join('/proc', entry.name, 'stat'), 'utf8')
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
          const command = readFileSync(join('/proc', entry.name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ') || stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
          const startedAt = observedAt - Math.max(0, uptime - Number(fields[19]) / 100) * 1000
          return [{ pid: Number(entry.name), ppid: Number(fields[1]), elapsedMs: Math.max(0, observedAt - startedAt), command }]
        } catch { return [] }
      })
    },
    freeMemory: () => freemem(),
    realpath(input) {
      try { return { status: 'resolved', path: realpathSync.native(input) } } catch (error) { return { status: 'unavailable', path: null, reason: error?.code ?? String(error) } }
    },
    killGroup(pid, signal = 'SIGTERM') {
      try { process.kill(-Number(pid), signal); return { status: 'ended', kind: 'posix_process_group' } } catch (error) { return { status: 'unavailable', kind: 'posix_process_group', reason: error?.code ?? String(error) } }
    },
    killTree(pid, force = false) {
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
      const result = spawnSync('taskkill', args, { encoding: 'utf8', windowsHide: true })
      return result.status === 0 ? { status: 'ended', kind: 'process_tree' } : { status: 'unavailable', kind: 'process_tree', reason: `taskkill exited ${String(result.status)}` }
    },
  }
}

// A platform with no implementation degrades to a named "unavailable" adapter instead of throwing at import:
// every consumer already turns a throwing read into a legible "unavailable on this platform".
function unavailableAdapter(platform, reason) {
  const unavailable = () => { throw new Error(reason) }
  const adapter = { available: false, platform, reason, readAvailableMemory: () => ({ mib: null, source: `available memory on ${platform}`, reason: 'unsupported platform' }), readProcessRelationships: unavailable, readProcessSnapshot: unavailable, endProcessFamily: () => ({ status: 'unavailable', reason }), forceEndProcessFamily: () => ({ status: 'unavailable', reason }) }
  return { ...adapter, createCodexBrokerOwnership: (env) => createCodexBrokerOwnership(adapter, env) }
}

export const hostAdapter = createHostAdapter({ unavailableFallback: true })

function readEvidence(platform, evidenceRoot, mutate) {
  const label = evidenceLabels[platform]
  const plainDirectory = join(evidenceRoot, label)
  const directory = existsSync(plainDirectory) ? plainDirectory : join(evidenceRoot, `host-platform-evidence-${label}`)
  return mutate({
    processTable: JSON.parse(readFileSync(join(directory, 'process-table.json'), 'utf8')),
    termination: JSON.parse(readFileSync(join(directory, 'process-group-terminate.json'), 'utf8')),
    path: JSON.parse(readFileSync(join(directory, 'path-resolve.json'), 'utf8')),
    memory: JSON.parse(readFileSync(join(directory, 'memory-available.json'), 'utf8')),
  })
}

const evidenceSummary = (platform, captured) => ({
  platform,
  runnerLabel: captured.processTable.provenance.runnerImage.label,
  runId: captured.processTable.provenance.runId,
  path: captured.path,
  termination: { childPid: captured.termination.pids.childPid, ...captured.termination.operation },
})

const operationKey = ({ command, args }) => JSON.stringify([command, args])

function evidenceInvocation(implementation, captured) {
  const operations = new Map([
    [operationKey(implementation.processRelationshipOperation), captured.processTable.processTable],
    [operationKey(implementation.processSnapshotOperation), captured.processTable.processSnapshot],
    [operationKey({ command: 'vm_stat', args: [] }), captured.memory.macos.vmStat],
  ].filter(([, result]) => result))
  return {
    run(command, args) {
      const key = operationKey({ command, args })
      const result = operations.get(key)
      if (!result) throw new Error(`captured host evidence has no invocation for ${command} ${args.join(' ')}`)
      const stdout = result.raw ?? result.stdout ?? ''
      return { status: result.exitCode, stdout, stderr: result.stderr ?? (result.exitCode === 0 ? '' : stdout) }
    },
    read(file) {
      if (file !== '/proc/meminfo' || captured.memory.linux.status !== 'measured') return { status: 'unavailable', value: '', reason: 'file absent from captured evidence' }
      return { status: 'read', value: `${captured.memory.linux.raw}\n` }
    },
    freeMemory() {
      if (captured.memory.osMemory.status !== 'measured') throw new Error('free memory absent from captured evidence')
      return captured.memory.osMemory.freeBytes
    },
    realpath(input) {
      const samples = [captured.path.tempDirectory.machineEvidence, captured.path.symlinkedDirectory, captured.path.windowsUnc?.machineEvidence].filter(Boolean)
      const sample = samples.find((item) => item.input === input)
      return sample?.realpath ? { status: 'resolved', path: sample.realpath } : { status: 'unavailable', path: null, reason: 'path absent from captured evidence' }
    },
    killGroup(pid) {
      return pid === captured.termination.pids.childPid && captured.termination.termination.exitCode === 0
        ? { status: 'ended', kind: 'posix_process_group' }
        : { status: 'unavailable', kind: 'posix_process_group', reason: 'termination absent from captured evidence' }
    },
    killTree(pid) {
      return pid === captured.termination.pids.childPid && captured.termination.termination.exitCode === 0
        ? { status: 'ended', kind: 'process_tree' }
        : { status: 'unavailable', kind: 'process_tree', reason: 'termination absent from captured evidence' }
    },
  }
}

function readAvailableMemory(platform, invoke) {
  if (platform === 'linux') {
    const result = invoke.read('/proc/meminfo')
    const match = result.status === 'read' ? /^MemAvailable:\s+(\d+)\s+kB$/m.exec(result.value) : null
    return match
      ? { mib: Math.floor(Number(match[1]) / 1024), source: 'MemAvailable from /proc/meminfo' }
      : { mib: null, source: 'MemAvailable from /proc/meminfo', reason: result.status === 'read' ? 'field missing' : 'unreadable' }
  }
  if (platform === 'darwin') {
    const result = invoke.run('vm_stat', [], { timeout: 3_000 })
    const pageSize = /page size of (\d+) bytes/.exec(result.stdout)
    const pages = [...String(result.stdout).matchAll(/^Pages (?:free|inactive|speculative):\s+(\d+)\./gm)].reduce((sum, match) => sum + Number(match[1]), 0)
    return result.status === 0 && pageSize && pages > 0
      ? { mib: Math.floor(pages * Number(pageSize[1]) / 1024 / 1024), source: 'free, inactive, and speculative pages from vm_stat' }
      : { mib: null, source: 'free, inactive, and speculative pages from vm_stat', reason: result.status === 0 ? 'fields missing' : 'unreadable' }
  }
  if (platform === 'win32') {
    try {
      const bytes = invoke.freeMemory()
      return Number.isFinite(bytes) && bytes > 0
        ? { mib: Math.floor(bytes / 1024 / 1024), source: 'free memory from os.freemem()' }
        : { mib: null, source: 'free memory from os.freemem()', reason: 'invalid value' }
    } catch { return { mib: null, source: 'free memory from os.freemem()', reason: 'unreadable' } }
  }
  try {
    const bytes = invoke.freeMemory()
    return Number.isFinite(bytes) && bytes > 0
      ? { mib: Math.floor(bytes / 1024 / 1024), source: `free memory from os.freemem() on ${platform}` }
      : { mib: null, source: `free memory from os.freemem() on ${platform}`, reason: 'invalid value' }
  } catch { return { mib: null, source: `free memory from os.freemem() on ${platform}`, reason: 'unreadable' } }
}
