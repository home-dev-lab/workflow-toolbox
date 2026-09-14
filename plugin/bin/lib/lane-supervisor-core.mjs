import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export function sameIdentity(expected, actual) {
  return Boolean(actual
    && expected.pid === actual.pid
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv)
    && (!expected.cwd || expected.cwd === actual.cwd))
}

export function terminateVerified(expected, { inspect = inspectProcess, kill = process.kill } = {}) {
  const actual = inspect(expected.pid)
  if (!sameIdentity(expected, actual)) return { killed: false, reason: actual ? 'identity-changed' : 'already-gone' }
  kill(expected.pid, 'SIGTERM')
  return { killed: true, reason: 'terminated' }
}

export function classifyLane({ process, record, terminalExit = null, launcherAlive = false }) {
  if (!record || record.childPid !== process.pid || (process.cwd && record.worktree !== process.cwd) || JSON.stringify(record.childArgv) !== JSON.stringify(process.argv)) {
    return { action: 'warn', reason: 'unknown-owner' }
  }
  if (terminalExit !== null) return { action: 'clean', reason: 'terminal-lane-log' }
  if (!launcherAlive) return { action: 'clean', reason: 'launcher-gone' }
  return { action: 'keep', reason: 'live-lane' }
}

export function classifyBroker({ idleMs, hasRunningTask }, thresholdMs) {
  if (hasRunningTask) return { action: 'keep', reason: 'broker-has-running-task' }
  return idleMs >= thresholdMs ? { action: 'clean', reason: 'idle-broker' } : { action: 'keep', reason: 'broker-idle-within-threshold' }
}

export function inspectProcess(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null
  try {
    const argv = readFileSync(path.join(procRoot, String(pid), 'cmdline')).toString().split('\0').filter(Boolean)
    const cwd = readlinkSync(path.join(procRoot, String(pid), 'cwd'))
    return { pid: Number(pid), argv, cwd }
  } catch {
    try {
      const argv = readFileSync(path.join(procRoot, String(pid), 'cmdline')).toString().split('\0').filter(Boolean)
      return { pid: Number(pid), argv, cwd: null }
    } catch { return null }
  }
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function readLogTail(file, maxBytes = 2048) {
  try {
    const size = statSync(file).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
    return buffer.toString('utf8')
  } catch { return '' }
}

export function terminalExit(file) {
  return /(?:^|\n)EXIT=([^\s\n]+)\s*$/.exec(readLogTail(file))?.[1] ?? null
}

export function latestWorktreeWrite(root, { maxEntries = 4000 } = {}) {
  const skipped = new Set(['.git', 'node_modules', '.pnpm', 'dist', 'build', 'coverage', '.next'])
  const stack = [root]
  let latest = 0
  let visited = 0
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++visited > maxEntries) return { at: latest || null, bounded: true }
      if (skipped.has(entry.name) || (dir === path.join(root, '.lane') && entry.name === 'supervision.json')) continue
      const full = path.join(dir, entry.name)
      try {
        const stat = statSync(full)
        latest = Math.max(latest, stat.mtimeMs)
        if (entry.isDirectory()) stack.push(full)
      } catch {}
    }
  }
  return { at: latest || null, bounded: false }
}

export function appendSupervisorJournal(dataDir, event) {
  mkdirSync(dataDir, { recursive: true })
  appendFileSync(path.join(dataDir, 'lane-supervisor.jsonl'), `${JSON.stringify({ version: 1, time: new Date().toISOString(), ...event })}\n`)
}

export function argvSummary(argv) {
  return argv.map((part) => path.basename(part)).slice(0, 8).join(' ').slice(0, 300)
}
