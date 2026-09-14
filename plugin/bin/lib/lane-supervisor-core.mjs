import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const JOURNAL_MAX_BYTES = 10 * 1024 * 1024

export function sameIdentity(expected, actual) {
  return Boolean(actual
    && expected.pid === actual.pid
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv)
    && (!expected.cwd || expected.cwd === actual.cwd))
}

export function terminateVerified(expected, { inspect = inspectProcess, kill = process.kill, graceMs = 1000 } = {}) {
  const actual = inspect(expected.pid)
  if (!sameIdentity(expected, actual)) return { killed: false, reason: actual ? 'identity-changed' : 'already-gone' }
  try { kill(expected.pid, 'SIGTERM') } catch (error) {
    return { killed: false, reason: error?.code === 'ESRCH' ? 'already-gone' : `sigterm-${error?.code ?? 'failed'}` }
  }
  if (graceMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs)
  if (!inspect(expected.pid)) return { killed: true, reason: 'terminated' }
  try { kill(expected.pid, 'SIGKILL') } catch (error) {
    if (error?.code === 'ESRCH') return { killed: true, reason: 'terminated' }
    return { killed: false, reason: `sigkill-${error?.code ?? 'failed'}` }
  }
  if (graceMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs)
  return inspect(expected.pid)
    ? { killed: false, reason: 'still-alive-after-sigkill' }
    : { killed: true, reason: 'terminated' }
}

export function classifyLane({ process, record, launcherAlive = false }) {
  if (!record || record.childPid !== process.pid || (process.cwd && record.worktree !== process.cwd) || JSON.stringify(record.childArgv) !== JSON.stringify(process.argv)) {
    return { action: 'warn', reason: 'unknown-owner' }
  }
  if (!['exited', 'abandoned'].includes(record.state)) return { action: 'keep', reason: launcherAlive ? 'live-lane' : 'nonterminal-supervision-record' }
  if (launcherAlive) return { action: 'keep', reason: 'launcher-still-running' }
  if (!launcherAlive) return { action: 'clean', reason: `${record.state}-launcher-gone` }
  return { action: 'keep', reason: 'live-lane' }
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

export function processAlive(pid, { kill = process.kill } = {}) {
  try { kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
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
  if (maxEntries < 0) return { at: null, bounded: true, status: 'unknown' }
  const skipped = new Set(['.git', 'node_modules', '.pnpm', 'dist', 'build', 'coverage', '.next'])
  const stack = [root]
  let latest = 0
  let visited = 0
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++visited > maxEntries) return { at: null, bounded: true, status: 'unknown' }
      if (skipped.has(entry.name) || (dir === path.join(root, '.lane') && entry.name === 'supervision.json')) continue
      const full = path.join(dir, entry.name)
      try {
        const stat = statSync(full)
        latest = Math.max(latest, stat.mtimeMs)
        if (entry.isDirectory()) stack.push(full)
      } catch {}
    }
  }
  return { at: latest || null, bounded: false, status: 'known' }
}

export function appendSupervisorJournal(dataDir, event) {
  mkdirSync(dataDir, { recursive: true })
  const journal = path.join(dataDir, 'lane-supervisor.jsonl')
  try {
    if (statSync(journal).size >= JOURNAL_MAX_BYTES) {
      rmSync(`${journal}.1`, { force: true })
      renameSync(journal, `${journal}.1`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  appendFileSync(journal, `${JSON.stringify({ version: 1, time: new Date().toISOString(), ...event })}\n`)
}

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

export function supervisionUnavailableMessage(platform = process.platform) {
  return `lane supervision unavailable on ${platform}`
}

export function argvSummary(argv) {
  return argv.map((part) => path.basename(part)).slice(0, 8).join(' ').slice(0, 300)
}
