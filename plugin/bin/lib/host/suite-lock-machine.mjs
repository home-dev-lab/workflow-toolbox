import { availableParallelism, loadavg, totalmem, release as kernelRelease } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'

const MIB = 1024 * 1024
const MEMORY_FLOOR_MIB = 1024
const WINDOWS_SAMPLE_MAX_MS = 10_000
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const WINDOWS_LOOP = 'for ($i = 0; $i -lt 150; $i++) { (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory; Start-Sleep -Seconds 2 }'
const warnedFloors = new Set()
const DARWIN_AVAILABLE_PAGES = ['free', 'inactive', 'speculative']
const darwinAvailableMemory = () => darwinMemoryBytes(execFileSync('/usr/bin/vm_stat', [], {
  encoding: 'utf8', timeout: 500, maxBuffer: 16 * 1024, killSignal: 'SIGKILL',
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
}))

export const reservationHostSupported = (platform = process.platform, managed = false) => ['linux', 'darwin'].includes(platform)
  && (!managed || !(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY))

export function readSuiteMachine(input = {}) {
  const { platform, read, free, total, cpus, load } = machineSources(input)
  if (!['linux', 'darwin'].includes(platform)) return { unknown: 'unsupported-platform-memory-and-load' }
  try {
    const { warn = warnFloor } = input
    return sampledMachineValues(machineValues(platform, read, free, total, cpus, load, warn), input, platform)
  } catch { return { unknown: 'machine-source-unavailable' } }
}

function machineSources({ platform = process.platform, read = readFileSync, free = darwinAvailableMemory,
  total = totalmem, cpus = availableParallelism, load = loadavg }) {
  return { platform, read, free, total, cpus, load }
}

function sampledMachineValues(values, input, platform) {
  if (values.unknown) return values
  const { now = Date.now, windowsMemory = null, release = kernelRelease, exists = existsSync } = input
  const wsl = isWsl({ platform, release, exists })
  const sampledAt = now()
  const windows = freshWindowsMemory(windowsMemory, sampledAt)
  const availableMiB = wsl && windows ? Math.min(values.availableMiB, windows.availableMiB) : values.availableMiB
  return { ...values, availableMiB, memMiB: Math.max(0, availableMiB - values.floorMiB),
    wsl, sampledAt, ...(wsl ? { windowsMemory: windows } : {}) }
}

export function isWsl({ platform = process.platform, release = kernelRelease, exists = existsSync } = {}) {
  if (platform !== 'linux') return false
  try { return /microsoft/i.test(release()) || exists('/proc/sys/fs/binfmt_misc/WSLInterop') } catch { return false }
}

function freshWindowsMemory(sample, now) {
  return sample && Number.isFinite(sample.availableMiB) && sample.availableMiB >= 0
    && Number.isFinite(sample.sampledAt) && now >= sample.sampledAt && now - sample.sampledAt <= WINDOWS_SAMPLE_MAX_MS ? sample : null
}

function warnFloor(message) {
  if (warnedFloors.has(message)) return
  warnedFloors.add(message)
  process.stderr.write(`wt-suite-lock: ${message}\n`)
}

function memoryFloor(totalMiB, warn) {
  const computed = Math.max(MEMORY_FLOOR_MIB, totalMiB * 0.1)
  const raw = process.env.WT_SUITE_LOCK_TEST_FLOOR_MIB
  if (raw === undefined) return { floorMiB: computed }
  const override = Number(raw)
  if (!Number.isFinite(override) || override < computed) {
    warn('WT_SUITE_LOCK_TEST_FLOOR_MIB ignored: it must be finite and cannot lower the computed floor')
    return { floorMiB: computed }
  }
  return { floorMiB: override, floorOverrideMiB: override }
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

function machineValues(platform, read, free, total, cpus, load, warn) {
  const availableMiB = platform === 'linux' ? linuxAvailable(read) : free() / MIB
  const totalMiB = total() / MIB
  const floor = memoryFloor(totalMiB, warn)
  const { floorMiB } = floor
  const online = cpus()
  const average = load()[0]
  if (!validMachineValues(availableMiB, floorMiB, online, average)) return { unknown: 'invalid-machine-sample' }
  return { cores: online, onlineCpus: online, totalMiB, memMiB: Math.max(0, availableMiB - floorMiB),
    load: average, loadLimit: online, availableMiB, ...floor }
}

function validMachineValues(availableMiB, floorMiB, online, average) {
  return [availableMiB, floorMiB, online, average].every((value) => Number.isFinite(value) && value >= 0) && online !== 0
}

function linuxAvailable(read) {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(read('/proc/meminfo', 'utf8'))
  if (!match) throw new Error('MemAvailable unavailable')
  return Number(match[1]) / 1024
}

// Only the elected watchdog constructs this reader. Clients consume its state sample.
export function startWindowsMemoryReader({ spawnReader = spawn, now = Date.now } = {}) {
  const state = { child: null, sample: null, buffer: '', closed: false }
  const start = () => startWindowsChild(state, spawnReader, now)
  start()
  return {
    sample() {
      if (!state.child && !state.closed) start()
      return freshWindowsMemory(state.sample, now())
    },
    close() { state.closed = true; state.child?.kill(); state.child = null },
  }
}

function startWindowsChild(state, spawnReader, now) {
  try {
    const child = spawnReader(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LOOP],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    state.child = child
    state.buffer = ''
    child.stdout.on('data', (chunk) => acceptWindowsLines(state, chunk, now))
    const ended = () => { if (state.child === child) state.child = null }
    child.on('exit', ended)
    child.on('error', ended)
  } catch { state.child = null }
}

function acceptWindowsLines(state, chunk, now) {
  state.buffer += chunk.toString()
  const lines = state.buffer.split('\n')
  state.buffer = lines.pop().slice(-1024)
  for (const line of lines) {
    const text = line.trim()
    if (!/^\d+$/.test(text)) continue
    const kib = Number(text)
    if (Number.isSafeInteger(kib) && kib >= 0) state.sample = { availableMiB: kib / 1024, sampledAt: now() }
  }
}
