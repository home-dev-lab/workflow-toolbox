import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Cumulative child CPU accounting; unavailable is deliberately distinct from idle.

const text = (file) => readFileSync(file, 'utf8')
const isServer = (command) => /(?:^|[/\\])_?tsserver\.js(?:\s|$)/.test(command)
const unavailable = (reason) => ({ status: 'unavailable', reason })
const execute = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } })

function linuxProcess(pid, read, ticks) {
  const stat = read(`/proc/${pid}/stat`)
  // comm can contain parentheses and newlines; fields after its LAST ')' are stable.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const numbers = [fields[1], fields[11], fields[12], fields[19], fields[2]].map(Number)
  if (fields.length < 20 || numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('invalid proc stat')
  return { pid: Number(pid), ppid: numbers[0], pgid: numbers[4], identity: `${pid}:${fields[19]}`, cpuMs: (numbers[1] + numbers[2]) / ticks * 1000 }
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

function darwinFamily(pid, run) {
  const result = run('/bin/ps', ['-wwaxo', 'pid=,ppid=,pgid=,lstart=,time=,command='])
  if (result.status !== 0 || result.error) throw new Error('ps failed')
  const rows = result.stdout.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(.+)$/.exec(line)
    if (!match) throw new Error('invalid ps process row')
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), identity: `${match[1]}:${match[4]}`, cpuMs: cpuTime(match[5]), command: match[6] }
  })
  const parent = rows.find((row) => row.pid === Number(pid))
  if (!parent) throw new Error('backend not found')
  return { status: 'measured', parent, servers: rows.filter((row) => row.ppid === Number(pid) && isServer(row.command)) }
}

// Child CPU is OS cumulative user+system time, never the launcher's process.cpuUsage().
export function createTsCpuReader({ platform = process.platform, read = text, run = execute } = {}) {
  let ticks
  return (pid) => {
    if (platform !== 'linux' && platform !== 'darwin') return unavailable(`unsupported platform ${platform}`)
    try {
      if (platform === 'darwin') return darwinFamily(pid, run)
      if (ticks === undefined) {
        const result = run('/usr/bin/getconf', ['CLK_TCK'])
        const value = result.status === 0 && !result.error ? Number(result.stdout.trim()) : NaN
        if (!Number.isSafeInteger(value) || value <= 0) return unavailable('CLK_TCK unavailable')
        ticks = value
      }
      return linuxFamily(pid, read, ticks)
    } catch { return unavailable('process CPU sample failed') }
  }
}
