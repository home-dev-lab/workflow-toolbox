import { availableParallelism, loadavg, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MIB = 1024 * 1024
// CPU booking units include the observation's 25% margin, plus 20% sampling
// headroom. A fully CPU-bound historical run must still fit its own host.
// Actual overload closes admission at the online CPU count, without killing.
const CPU_FACTOR = 1.5
const MEMORY_FLOOR_MIB = 1024
const DARWIN_AVAILABLE_PAGES = ['free', 'inactive', 'speculative']
const darwinAvailableMemory = () => darwinMemoryBytes(execFileSync('/usr/bin/vm_stat', [], {
  encoding: 'utf8', timeout: 500, maxBuffer: 16 * 1024, killSignal: 'SIGKILL',
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
}))

export const reservationHostSupported = (platform = process.platform, managed = false) => ['linux', 'darwin'].includes(platform)
  && (!managed || !(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY))

export function readSuiteMachine({ platform = process.platform, read = readFileSync,
  free = darwinAvailableMemory, total = totalmem, cpus = availableParallelism, load = loadavg } = {}) {
  if (!['linux', 'darwin'].includes(platform)) return { unknown: 'unsupported-platform-memory-and-load' }
  try {
    return machineValues(platform, read, free, total, cpus, load)
  } catch { return { unknown: 'machine-source-unavailable' } }
}

function darwinMemoryBytes(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error('vm_stat page size unavailable')
  const pages = DARWIN_AVAILABLE_PAGES.reduce((sum, name) => sum + darwinPageCount(text, name), 0)
  const bytes = pages * pageSize
  if (!Number.isSafeInteger(bytes)) throw new Error('vm_stat memory out of range')
  return bytes
}

function darwinPageCount(text, name) {
  const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'm').exec(text)
  const pages = Number(match?.[1])
  if (!Number.isSafeInteger(pages) || pages < 0) throw new Error('vm_stat page count unavailable')
  return pages
}

function machineValues(platform, read, free, total, cpus, load) {
  const availableMiB = platform === 'linux' ? linuxAvailable(read) : free() / MIB
  const floorMiB = Math.max(MEMORY_FLOOR_MIB, total() / MIB * 0.1)
  const online = cpus()
  const average = load()[0]
  if (!validMachineValues(availableMiB, floorMiB, online, average)) return { unknown: 'invalid-machine-sample' }
  return { cores: online * CPU_FACTOR, memMiB: Math.max(0, availableMiB - floorMiB),
    load: average, loadLimit: online, availableMiB, floorMiB }
}

function validMachineValues(availableMiB, floorMiB, online, average) {
  return [availableMiB, floorMiB, online, average].every((value) => Number.isFinite(value) && value >= 0) && online !== 0
}

function linuxAvailable(read) {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(read('/proc/meminfo', 'utf8'))
  if (!match) throw new Error('MemAvailable unavailable')
  return Number(match[1]) / 1024
}
