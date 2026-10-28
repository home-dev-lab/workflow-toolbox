import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { linuxTsCpuTree, selectTsCpuTree } from './ts-cpu-tree.mjs'

// Cumulative child CPU accounting; unavailable is deliberately distinct from idle.

const text = (file) => readFileSync(file, 'utf8')
const isServer = (command) => /(?:^|[/\\])_?tsserver\.js(?:\s|$)/.test(command)
const unavailable = (reason) => ({ status: 'unavailable', reason })
/** @knipTestSeam Computed file-URL import in ts-language-server-cpu-r2.test.ts. */
export function runTsCpuCommand(command, args, { exec = execFile, timeout = 1000 } = {}) {
  return new Promise((resolve) => {
    exec(command, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      resolve({ status: error ? null : 0, error, stdout: stdout ?? '' })
    })
  })
}

function linuxProcess(pid, read, ticks) {
  const stat = read(`/proc/${pid}/stat`)
  // comm can contain parentheses and newlines; fields after its LAST ')' are stable.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const numbers = [fields[1], fields[11], fields[12], fields[19], fields[2]].map(Number)
  if (fields.length < 20 || numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('invalid proc stat')
  return { pid: Number(pid), ppid: numbers[0], pgid: numbers[4], state: fields[0], identity: `${pid}:${fields[19]}`, cpuMs: (numbers[1] + numbers[2]) / ticks * 1000 }
}

function linuxFamily(pid, read, ticks) {
  const parent = linuxProcess(pid, read, ticks)
  const children = read(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/).filter(Boolean)
  const servers = []
  for (const id of children) {
    try {
      const child = linuxProcess(id, read, ticks)
      const args = read(`/proc/${id}/cmdline`).split('\0')
      if (child.ppid === Number(pid) && args.some(isServer)) servers.push(child)
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
  }
  return { status: 'measured', parent, servers }
}

function cpuTime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) throw new Error('invalid ps CPU time')
  const total = ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000
  if (!Number.isFinite(total)) throw new Error('invalid ps CPU time')
  return total
}

function psCommand(value) {
  const command = value.trimStart() || value.slice(-1)
  if (/[\r\n\u2028\u2029]/.test(command)) throw new Error('invalid ps process row')
  return command
}

async function darwinProcesses(run, withState = false) {
  const columns = 'pid=,ppid=,pgid=,lstart=,time=,command='
  const result = await run('/bin/ps', ['-wwaxo', withState ? `state=,${columns}` : columns])
  if (result.status !== 0 || result.error) throw new Error('ps failed')
  return result.stdout.trim().split('\n').map((line) => {
    const state = withState ? /^(\S+)\s+/.exec(line.trimStart())?.[1] : undefined
    if (withState && !/^[A-Z]/.test(state ?? '')) throw new Error('invalid ps state')
    if (withState) line = line.trimStart().slice(state.length).trimStart()
    // Capture the delimiter once; command whitespace is handled without
    // overlapping repetitions in the host-wide process-row expression.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)(\s[\s\S]+)$/.exec(line)
    if (!match) throw new Error('invalid ps process row')
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), identity: `${match[1]}:${match[4]}`, cpuMs: cpuTime(match[5]), command: psCommand(match[6]) }
    return withState ? { ...row, state: state[0] } : row
  })
}

async function darwinFamily(pid, run) {
  const rows = await darwinProcesses(run)
  const parent = rows.find((row) => row.pid === Number(pid))
  if (!parent) throw new Error('backend not found')
  return { status: 'measured', parent, servers: rows.filter((row) => row.ppid === Number(pid) && isServer(row.command)) }
}

// Child CPU is OS cumulative user+system time, never the launcher's process.cpuUsage().
export function createTsCpuReader({ platform = process.platform, read = text, list = readdirSync, run = runTsCpuCommand } = {}) {
  let ticks
  const reader = async (pid) => {
    if (platform !== 'linux' && platform !== 'darwin') return unavailable(`unsupported platform ${platform}`)
    try {
      if (platform === 'darwin') return await darwinFamily(pid, run)
      if (ticks === undefined) {
        const result = await run('/usr/bin/getconf', ['CLK_TCK'])
        const value = result.status === 0 && !result.error ? Number(result.stdout.trim()) : NaN
        if (!Number.isSafeInteger(value) || value <= 0) return unavailable('CLK_TCK unavailable')
        ticks = value
      }
      return linuxFamily(pid, read, ticks)
    } catch { return unavailable('process CPU sample failed') }
  }
  // Birth capture needs no clock helper. On Linux this stat is read synchronously
  // at spawn, before the first asynchronous cumulative-CPU sample starts.
  reader.identity = (pid) => processIdentity(pid, { platform, read, run })
  reader.census = (pids) => processCensus(pids, { platform, read, run })
  reader.tree = async (pid) => {
    try {
      if (platform === 'linux') return linuxTsCpuTree(pid, { read, list, process: linuxProcess })
      if (platform === 'darwin') return selectTsCpuTree(await darwinProcesses(run, true), pid)
      return unavailable(`unsupported platform ${platform}`)
    } catch { return unavailable('backend process tree unavailable') }
  }
  return reader
}

async function processIdentity(pid, { platform, read, run }) {
  try {
    if (platform === 'linux') return { status: 'measured', process: linuxProcess(pid, read, 1) }
    if (platform !== 'darwin') return unavailable(`unsupported platform ${platform}`)
    const process = (await darwinProcesses(run)).find((row) => row.pid === pid)
    return process ? { status: 'measured', process } : unavailable('backend not found')
  } catch { return unavailable('process birth identity unavailable') }
}

function linuxCensus(pids, read) {
  return pids.flatMap((pid) => {
    try {
      const process = linuxProcess(pid, read, 1)
      return ['Z', 'X'].includes(process.state) ? [] : [process]
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return []
      throw error
    }
  })
}

async function processCensus(pids, { platform, read, run }) {
  try {
    if (platform === 'linux') return { status: 'measured', processes: linuxCensus(pids, read) }
    if (platform === 'darwin') return { status: 'measured', processes: (await darwinProcesses(run, true)).filter((row) => pids.includes(row.pid) && !['Z', 'X'].includes(row.state)) }
    return unavailable(`unsupported platform ${platform}`)
  } catch { return unavailable('post-signal process census failed') }
}
