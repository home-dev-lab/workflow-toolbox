import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const JOURNAL_MAX_BYTES = 10 * 1024 * 1024

export function sameIdentity(expected, actual) {
  return Boolean(actual
    && expected.pid === actual.pid
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv)
    && (!expected.cwd || expected.cwd === actual.cwd))
}

function identityStatus(expected, { inspect, platform, procRoot }) {
  if (platform !== 'linux') return 'unknown'
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 1 || !Array.isArray(expected.argv)) return 'unknown'
  const actual = inspect(expected.pid, { platform, procRoot })
  if (actual) return sameIdentity(expected, actual) ? 'running' : 'gone'
  if (inspect !== inspectProcess) return 'gone'
  const processDir = path.join(procRoot, String(expected.pid))
  if (!existsSync(processDir)) return 'gone'
  try {
    const stat = readFileSync(path.join(processDir, 'stat'), 'utf8')
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') return 'gone'
  } catch {}
  return 'unknown'
}

export function classifyLane(record, { inspect = inspectProcess, platform = process.platform, procRoot = '/proc' } = {}) {
  if (!record || typeof record !== 'object' || typeof record.runId !== 'string') {
    return { status: 'unknown', reason: 'invalid-record', worker: 'unknown', child: 'unknown' }
  }
  if (platform !== 'linux') return { status: 'unknown', reason: `identity-unavailable-${platform}`, worker: 'unknown', child: 'unknown' }
  if (record.state === 'launch-failed') return { status: 'terminal', reason: 'launch-failed', worker: 'gone', child: 'gone' }
  const worker = identityStatus({ pid: record.workerPid, argv: record.workerArgv }, { inspect, platform, procRoot })
  const child = identityStatus({ pid: record.childPid, argv: record.childArgv }, { inspect, platform, procRoot })
  if (worker === 'gone' && child === 'gone') return { status: 'gone', reason: 'worker-and-child-gone', worker, child }
  if (worker === 'gone' && child === 'running') return { status: 'worker-gone-child-alive', reason: 'worker-gone-child-alive', worker, child }
  if (worker === 'unknown' || child === 'unknown') return { status: 'unknown', reason: 'identity-unreadable', worker, child }
  if (['exited', 'abandoned'].includes(record.state) && child === 'gone') return { status: 'terminal', reason: record.state, worker, child }
  if (worker === 'running' && child === 'running' && ['running', 'decision-needed'].includes(record.state)) {
    return { status: record.state, reason: record.state, worker, child }
  }
  return { status: 'unknown', reason: 'inconsistent-record', worker, child }
}

export function terminateLane(record, { inspect = inspectProcess, kill = process.kill, graceMs = 1000, platform = process.platform, journal = () => {}, source = 'unknown', markTerminal = null } = {}) {
  const verdict = classifyLane(record, { inspect, platform })
  if (verdict.status === 'gone') return { killed: false, reason: 'already-gone', verdict }
  if (!['running', 'decision-needed', 'terminal', 'worker-gone-child-alive'].includes(verdict.status)) {
    return { killed: false, reason: verdict.reason, verdict }
  }
  const worker = inspect(record.workerPid, { platform })
  const child = inspect(record.childPid, { platform })
  if ((worker && !sameIdentity({ pid: record.workerPid, argv: record.workerArgv }, worker))
    || (child && !sameIdentity({ pid: record.childPid, argv: record.childArgv }, child))) {
    return { killed: false, reason: 'identity-changed', verdict }
  }
  if ((worker?.groupId && worker.groupId !== record.workerPid) || (child?.groupId && child.groupId !== record.workerPid)) {
    return { killed: false, reason: 'process-group-changed', verdict }
  }
  const event = { event: 'termination-signaled', runId: record.runId, source, workerPid: record.workerPid, childPid: record.childPid, pid: record.childPid, argv: argvSummary(record.childArgv ?? []), worktree: record.worktree, owner: record.owner ?? null, reason: 'verified lane process group' }
  journal(event)
  if (markTerminal) markTerminal('terminating')
  const signal = (name) => {
    try { kill(-record.workerPid, name); return true } catch (error) {
      if (error?.code === 'ESRCH') return false
      throw error
    }
  }
  try {
    if (!signal('SIGTERM')) {
      if (markTerminal) markTerminal('terminal')
      return { killed: false, reason: 'already-gone', verdict }
    }
    if (markTerminal) markTerminal('terminal')
    if (graceMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs)
    const afterTerm = classifyLane(record, { inspect, platform })
    if (afterTerm.status === 'gone') {
      journal({ ...event, event: 'terminated', reason: 'terminated' })
      return { killed: true, reason: 'terminated', verdict: afterTerm }
    }
    if (afterTerm.status === 'unknown' && afterTerm.reason === 'identity-unreadable') return { killed: false, reason: 'identity-unreadable-after-sigterm', verdict: afterTerm }
    if (!signal('SIGKILL')) return { killed: true, reason: 'terminated', verdict: afterTerm }
    if (graceMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs)
    const afterKill = classifyLane(record, { inspect, platform })
    if (afterKill.status === 'gone') {
      journal({ ...event, event: 'terminated', reason: 'terminated' })
      return { killed: true, reason: 'terminated', verdict: afterKill }
    }
    return { killed: false, reason: 'still-alive-after-sigkill', verdict: afterKill }
  } catch (error) {
    return { killed: false, reason: `signal-${error?.code ?? 'failed'}`, verdict }
  }
}

export function inspectProcess(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null
  try {
    const argv = readFileSync(path.join(procRoot, String(pid), 'cmdline')).toString().split('\0').filter(Boolean)
    const cwd = readlinkSync(path.join(procRoot, String(pid), 'cwd'))
    const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (rest[0] === 'Z') return null
    return { pid: Number(pid), argv, cwd, groupId: Number(rest[2]) }
  } catch {
    try {
      const argv = readFileSync(path.join(procRoot, String(pid), 'cmdline')).toString().split('\0').filter(Boolean)
      const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (rest[0] === 'Z') return null
      return { pid: Number(pid), argv, cwd: null, groupId: Number(rest[2]) }
    } catch { return null }
  }
}

export function processEvidenceStatus(pid, { platform = process.platform, inspect = inspectProcess } = {}) {
  if (platform !== 'linux') return 'unknown'
  return inspect(pid, { platform }) ? 'running' : 'gone'
}

export function laneHardBoundAt(record) {
  const timeoutAt = Date.parse(record?.timeoutAt)
  const timeoutMs = Number(record?.timeoutSeconds) * 1000
  const graceMs = Number(record?.decisionGraceSeconds) * 1000
  const remaining = Math.max(0, Number(record?.maxExtensions) - Number(record?.extensionCount))
  if (![timeoutAt, timeoutMs, graceMs, remaining].every(Number.isFinite)) return null
  return timeoutAt + remaining * (timeoutMs + graceMs) + graceMs + Math.max(0, Number(record?.decisionTransitionBoundMs) || 0)
}

export const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

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
      if (skipped.has(entry.name) || (dir === path.join(root, '.lane') && entry.name === 'supervision')) continue
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
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

export function supervisionPaths(root, runId = null) {
  const dir = path.join(root, '.lane', 'supervision')
  return {
    dir,
    pointer: path.join(dir, 'current.json'),
    record: runId ? path.join(dir, `${runId}.json`) : null,
    decision: runId ? path.join(dir, `${runId}.decision.json`) : null,
  }
}

export function readCurrentSupervision(root) {
  try {
    const paths = supervisionPaths(root)
    const pointer = JSON.parse(readFileSync(paths.pointer, 'utf8'))
    if (typeof pointer.runId !== 'string' || !/^\d+-\d+$/.test(pointer.runId)) return null
    return JSON.parse(readFileSync(supervisionPaths(root, pointer.runId).record, 'utf8'))
  } catch { return null }
}

export function supervisionUnavailableMessage(platform = process.platform) {
  return `lane supervision unavailable on ${platform}`
}

export function argvSummary(argv) {
  return argv.map((part) => path.basename(part)).slice(0, 8).join(' ').slice(0, 300)
}
