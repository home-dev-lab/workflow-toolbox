import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { constants } from 'node:os'
import { createProcfs } from './procfs.mjs'
import { unknownSuiteResources } from '../suite-lock-resources.mjs'

// An asynchronous first census, then at most one per second; never awaited on release.
/** @knipTestSeam Sampling-interval check uses a computed module import. */
export const SUITE_RESOURCE_SAMPLE_MS = 1000
const SUITE_RESOURCE_COMMAND_TIMEOUT_MS = 500
const SUITE_RESOURCE_MAX_PROCESSES = 32768
const READ_BATCH = 64
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const unknown = (reason) => ({ unknown: reason })
const nonnegative = (value) => Number.isFinite(value) && value >= 0
const clockTickReads = new WeakMap()

function runResourceCommand(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: SUITE_RESOURCE_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL', signal, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

function linuxStat(pid, stat, ticks) {
  // comm may contain spaces, parentheses and newlines; the last ')' closes it.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const [ppid, user, system, birth, childUser, childSystem] = [fields[1], fields[11], fields[12], fields[19], fields[13], fields[14]].map(Number)
  if (fields.length < 20 || ![ppid, user, system, birth, childUser, childSystem].every(nonnegative)) throw new Error('invalid stat')
  return { pid: Number(pid), ppid, identity: `${pid}:${birth}`, cpuMs: (user + system + childUser + childSystem) / ticks * 1000,
    childCpuMs: (childUser + childSystem) / ticks * 1000, zombie: fields[0] === 'Z' }
}

async function linuxRows(procfs, ticks, signal) {
  const names = (await procfs.listProcesses()).filter((name) => /^[1-9]\d*$/.test(name))
  if (names.length > SUITE_RESOURCE_MAX_PROCESSES) throw new Error('census bound')
  const rows = []
  const missing = new Set()
  for (let i = 0; i < names.length; i += READ_BATCH) {
    signal?.throwIfAborted()
    const batch = await Promise.all(names.slice(i, i + READ_BATCH).map(async (pid) => {
      try { return linuxStat(pid, await procfs.readProcessStat(pid, { encoding: 'utf8', signal }), ticks) }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) { missing.add(pid); return null }; throw error }
    }))
    rows.push(...batch.filter(Boolean))
  }
  return { rows, missing }
}

function linuxClockTicks(run) {
  // A lease's abort must not poison the process-wide cache. The command has its own timeout.
  if (!clockTickReads.has(run)) clockTickReads.set(run, Promise.resolve()
    .then(() => run('getconf', ['CLK_TCK']))
    .then((text) => Number(text.trim())).catch(() => NaN)
    .then((ticks) => {
      if (!Number.isSafeInteger(ticks) || ticks <= 0) clockTickReads.delete(run)
      return ticks
    }))
  return clockTickReads.get(run)
}

function survivingAncestor(row, previous, current) {
  const visited = new Set([row.pid])
  let parent = previous.get(row.ppid)
  while (parent && !visited.has(parent.pid)) {
    if (parent.ignoresChildCpu || current.get(parent.identity)?.ignoresChildCpu) return undefined
    if (current.has(parent.identity)) return parent.identity
    visited.add(parent.pid)
    parent = previous.get(parent.ppid)
  }
  return undefined
}

function carryExitedCpu(current, retained, credits) {
  const previous = new Map([...retained.values()].map((row) => [row.pid, row]))
  const carried = new Map()
  const add = (identity, cpu) => carried.set(identity, (carried.get(identity) ?? 0) + cpu)
  for (const [identity, cpu] of credits) {
    add(current.has(identity) ? identity : survivingAncestor(retained.get(identity) ?? {}, previous, current), cpu)
  }
  for (const [identity, before] of retained) {
    if (!current.has(identity)) add(survivingAncestor(before, previous, current), before.cpuMs)
  }
  return carried
}

function retainedCpuTotal(processes, retained, credits) {
  const current = new Map(processes.map((row) => [row.identity, row]))
  const carried = carryExitedCpu(current, retained, credits)
  for (const row of processes) {
    const before = retained.get(row.identity)
    const transferred = before ? row.childCpuMs - before.childCpuMs : 0
    carried.set(row.identity, Math.max(0, (carried.get(row.identity) ?? 0) - transferred))
  }
  credits.clear()
  for (const [identity, cpu] of carried) if (cpu > 0) credits.set(identity, cpu)
  // Difference whole-family own + reaped-child CPU, carrying already observed time
  // until its ancestor's child counters absorb it. Unreconcilable exits (reparenting
  // outside the tracked tree or SIGCHLD ignored) lose at most CPU consumed between
  // their last sample and exit; their already sampled CPU is never discarded.
  return processes.reduce((sum, row) => sum + row.cpuMs, 0) + [...credits.values()].reduce((sum, cpu) => sum + cpu, 0)
}

// The kernel prints the Vm block only while the task owns an address space. An exiting
// process drops it before its zombie state is set, so status and stat can both still say
// running. A status with a State line and no Vm field at all is that process, not a broken source.
function withoutAddressSpace(status) {
  return /^State:\s+\S/m.test(status) && !/^Vm[A-Za-z]+:/m.test(status)
}

function linuxMemory(status) {
  const rss = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(status)
  const hwm = /^VmHWM:\s+(\d+)\s+kB\s*$/m.exec(status)
  if (!rss && withoutAddressSpace(status)) return 0 // Nothing resident once the address space is released.
  if (!rss || (/^VmHWM:/m.test(status) && !hwm)) throw new Error('resident memory unavailable')
  const sizes = [rss[1], hwm?.[1] ?? rss[1]].map(Number)
  if (!sizes.every(nonnegative)) throw new Error('invalid resident memory')
  return Math.max(...sizes) / 1024
}

function ignoresChildCpu(status) {
  const ignored = /^SigIgn:\s+([\da-f]+)\s*$/im.exec(status)
  if (!ignored) {
    if (/^SigIgn:/m.test(status)) throw new Error('invalid ignored signals')
    return false
  }
  return (BigInt(`0x${ignored[1]}`) & (1n << BigInt(constants.signals.SIGCHLD - 1))) !== 0n
}

async function linuxFamilyRow(procfs, ticks, before, signal) {
  try {
    const options = { encoding: 'utf8', signal }
    const status = await procfs.readProcessStatus(before.pid, options)
    const current = linuxStat(before.pid, await procfs.readProcessStat(before.pid, options), ticks)
    if (current.identity !== before.identity) return unknown('pid-reused')
    if (current.cpuMs < before.cpuMs || current.childCpuMs < before.childCpuMs) return unknown('census-incoherent')
    return { ...current, memMiB: linuxMemory(status), ignoresChildCpu: ignoresChildCpu(status) }
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null // Exit races are not unavailable sources.
    throw error
  }
}

function parentFirstFamily(family) {
  const pids = new Set(family.map((row) => row.pid))
  const children = new Map()
  for (const row of family) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid).push(row)
  }
  const ordered = family.filter((row) => !pids.has(row.ppid))
  for (let i = 0; i < ordered.length; i++) ordered.push(...children.get(ordered[i].pid) ?? [])
  if (ordered.length !== family.length) throw new Error('cyclic process family')
  return ordered
}

async function linuxResourceTree(procfs, ticks, pid, retained, credits, signal) {
  const { rows } = await linuxRows(procfs, ticks, signal)
  const previous = new Map(retained)
  const previousPids = new Map([...previous.values()].map((row) => [row.pid, row.identity]))
  if (rows.some((row) => previousPids.has(row.pid) && previousPids.get(row.pid) !== row.identity)) return unknown('pid-reused')
  const family = parentFirstFamily(selectFamily(rows, pid, new Map(retained)))
  const processes = []
  // Parent-before-child reads cannot include both a reaped child's CPU and its
  // transfer to the parent. A reap after the parent read is reconciled next time.
  for (const before of family) {
    const row = await linuxFamilyRow(procfs, ticks, before, signal)
    if (row?.unknown) return row
    if (!row) continue
    const old = previous.get(row.identity)
    if (retainedCountersRegressed(row, old)) return unknown('census-incoherent')
    processes.push(row)
  }
  if (!processes.some((row) => row.pid === pid)) throw new Error('root missing')
  const totalCpuMs = retainedCpuTotal(processes, previous, credits)
  retained.clear()
  for (const row of processes) retained.set(row.identity, row)
  return { processes, totalCpuMs }
}

function retainedCountersRegressed(row, old) {
  return old && (row.cpuMs < old.cpuMs || row.childCpuMs < old.childCpuMs)
}

function selectFamily(rows, pid, retained) {
  if (!rows.some((row) => row.pid === pid)) throw new Error('root missing')
  const byParent = new Map()
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const selected = new Set(rows.filter((row) => row.pid === pid || retained.has(row.identity)).map((row) => row.pid))
  const pending = [...selected]
  for (let i = 0; i < pending.length; i++) {
    for (const child of byParent.get(pending[i]) ?? []) {
      if (selected.has(child.pid)) continue
      selected.add(child.pid); pending.push(child.pid)
    }
  }
  const family = rows.filter((row) => selected.has(row.pid))
  retained.clear()
  for (const row of family) retained.set(row.identity, row)
  return family
}

function psCpuMs(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text)
  if (!match) throw new Error('invalid ps CPU')
  return ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000
}

function darwinRows(text) {
  const lines = text.trim().split('\n')
  if (lines.length > SUITE_RESOURCE_MAX_PROCESSES) throw new Error('census bound')
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 9) throw new Error('invalid ps row')
    const [pid, ppid, rss] = fields.slice(0, 3).map(Number)
    if (![pid, ppid, rss].every(nonnegative)) throw new Error('invalid ps numbers')
    return { pid, ppid, identity: `${pid}:${fields.slice(4).join(' ')}`, cpuMs: psCpuMs(fields[3]), memMiB: rss / 1024 }
  })
}

function darwinResourceTree(rows, pid, retained) {
  const current = new Map(rows.map((row) => [row.identity, row]))
  // ps -S exposes no separate child counters with which to prove a reap transfer.
  if ([...retained].some(([identity, before]) => !current.has(identity) || current.get(identity).cpuMs < before.cpuMs)) {
    return unknown('census-incoherent')
  }
  return { processes: selectFamily(rows, pid, retained) }
}

/** Linux/WSL: procfs CPU ticks + max(VmRSS, VmHWM); macOS: ps instantaneous RSS
 * (no per-process resident high-water mark); Windows: named unknown.
 * A missing/denied/malformed source is never replaced by a plausible zero.
 * @knipTestSeam Computed import in suite-lock-resources.selftest.mjs.
 */
export function createSuiteResourceReader({ platform = process.platform, read = readFile, list = readdir, run = runResourceCommand } = {}) {
  const procfs = createProcfs({ platform, readFile: read, readdir: list })
  const retained = new Map()
  const credits = new Map()
  return async (pid, { signal } = {}) => {
    if (!['linux', 'darwin'].includes(platform)) return unknown('unsupported-platform')
    try {
      if (platform === 'darwin') return darwinResourceTree(darwinRows(await run('/bin/ps', ['-S', '-axo', 'pid=,ppid=,rss=,time=,lstart='], { signal })), pid, retained)
      const ticks = await linuxClockTicks(run)
      if (!Number.isSafeInteger(ticks) || ticks <= 0) return unknown('clock-ticks-unavailable')
      return await linuxResourceTree(procfs, ticks, pid, retained, credits, signal)
    } catch { return unknown('source-unavailable') }
  }
}

const validSampleRows = (rows) => Array.isArray(rows) && rows.length > 0 && rows.every((row) => nonnegative(row.cpuMs) && nonnegative(row.memMiB))

function sampleValues(state, snapshot, at) {
  if (snapshot?.unknown) { state.reasons.add(snapshot.unknown); return }
  const rows = snapshot?.processes
  if (!validSampleRows(rows)) {
    state.reasons.add('source-unavailable'); return
  }
  const memory = rows.reduce((sum, row) => sum + row.memMiB, 0)
  state.peakMemMiB = Math.max(state.peakMemMiB ?? memory, memory)
  const total = snapshot.totalCpuMs ?? rows.reduce((sum, row) => sum + row.cpuMs, 0)
  sampleCorePeak(state, rows, at, total)
  state.previous = { at, total, cpu: new Map(rows.map((row) => [row.identity, row.cpuMs])) }
}

function sampleCorePeak(state, rows, at, total) {
  if (!state.previous || at <= state.previous.at) return
  // Reaped CPU transfers from a child into its parent. Difference whole-tree totals
  // so already-observed child time is not counted again after that transfer.
  const cpu = total - state.previous.total
  if (cpu < 0 || rows.some((row) => row.cpuMs < (state.previous.cpu.get(row.identity) ?? 0))) {
    state.reasons.add('cpu-counter-regressed'); return
  }
  const cores = cpu / (at - state.previous.at)
  state.peakCores = Math.max(state.peakCores ?? cores, cores)
}

function sampleResult(state, wallMs) {
  const reasons = new Set(state.reasons)
  if (state.peakCores === undefined) reasons.add('insufficient-samples')
  if (state.peakMemMiB === undefined) reasons.add('insufficient-samples')
  // A broken census invalidates both peaks: partial evidence cannot establish a tree maximum.
  const failed = state.reasons.size > 0
  return { peakCores: failed ? 'unknown' : state.peakCores ?? 'unknown',
    peakMemMiB: failed ? 'unknown' : state.peakMemMiB ?? 'unknown', wallMs, unknownReasons: [...reasons] }
}

/** @knipTestSeam Computed import in suite-lock-resources.selftest.mjs. */
export function createSuiteResourceSampler({ pid = process.pid, readTree = createSuiteResourceReader(), now = () => performance.now(),
  intervalMs = SUITE_RESOURCE_SAMPLE_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const started = now()
  const controller = new AbortController()
  const state = { reasons: new Set() }
  let stopped = false
  let timer
  let running
  let result
  const sample = () => {
    if (stopped) return Promise.resolve()
    if (running) return running
    if (timer !== undefined) { cancel(timer); timer = undefined }
    running = takeResourceSample(readTree, pid, controller.signal, state, now, () => stopped).finally(() => {
      running = undefined
      if (!stopped) { timer = schedule(sample, intervalMs); timer?.unref?.() }
    })
    return running
  }
  const stop = () => {
    if (stopped) return result
    stopped = true
    if (timer !== undefined) cancel(timer)
    controller.abort()
    result = sampleResult(state, Math.max(0, now() - started))
    return result
  }
  timer = schedule(sample, 0)
  timer?.unref?.()
  return { sample, stop, ready: Promise.resolve() }
}

async function takeResourceSample(read, pid, signal, state, now, stopped) {
  try {
    const snapshot = await read(pid, { signal })
    if (!stopped()) sampleValues(state, snapshot, now())
  } catch { if (!stopped()) state.reasons.add('source-unavailable') }
}

export function startSuiteResourceSampler(options) {
  // The host broker is not the client's tree. Its release gets client-side telemetry.
  if (options.route === 'broker') return undefined
  try { return (options.resourceSampler ?? createSuiteResourceSampler)() }
  catch {
    const started = performance.now()
    return { stop: () => unknownSuiteResources(performance.now() - started, 'sampler-unavailable') }
  }
}
