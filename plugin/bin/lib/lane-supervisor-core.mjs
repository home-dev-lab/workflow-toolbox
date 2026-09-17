import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const JOURNAL_MAX_BYTES = 10 * 1024 * 1024
const WINDOWS_PROCESS_TABLE_TTL_MS = 500
const windowsProcessTableCache = new WeakMap()

export function sameIdentity(expected, actual) {
  let sameCwd = true
  if (expected.cwd) {
    try { sameCwd = realpathSync(expected.cwd) === realpathSync(actual?.cwd) } catch { sameCwd = expected.cwd === actual?.cwd }
  }
  return Boolean(actual
    && expected.pid === actual.pid
    && Number.isFinite(expected.startTime)
    && expected.startTime === actual.startTime
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv)
    && sameCwd)
}

function evidenceSource(platform) {
  if (platform === 'darwin') return 'ps'
  if (platform === 'win32') return 'powershell'
  return 'proc'
}

function runEvidence(command, args, execFile) {
  try {
    const result = execFile(command, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C' } })
    if (result.error) return { status: 'unavailable' }
    return { status: result.status, stdout: result.stdout ?? '' }
  } catch { return { status: 'unavailable' } }
}

function powershellProcessTable(execFile, now = Date.now()) {
  const cached = windowsProcessTableCache.get(execFile)
  if (cached && now - cached.readAt <= WINDOWS_PROCESS_TABLE_TTL_MS) return cached.result
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate,CommandLine,ParentProcessId | ConvertTo-Json -Compress'
  const evidence = runEvidence('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], execFile)
  let result = evidence
  if (evidence.status === 0) {
    try {
      const parsed = evidence.stdout.trim() ? JSON.parse(evidence.stdout) : []
      result = { status: 0, value: Array.isArray(parsed) ? parsed : [parsed] }
    } catch { result = { status: 'unavailable' } }
  }
  windowsProcessTableCache.set(execFile, { readAt: now, result })
  return result
}

function powershellProcess(pid, execFile) {
  // The pid is interpolated into a PowerShell command string: refuse anything that is not a plain process id.
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return { status: 1, stdout: '' }
  const table = powershellProcessTable(execFile)
  if (table.status === 'unavailable' || table.status !== 0) return table
  const value = table.value.find((row) => Number(row?.ProcessId) === Number(pid))
  return value ? { status: 0, value } : { status: 1, stdout: '' }
}

function processStartSeconds(value) {
  const dotNet = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(String(value))
  const milliseconds = dotNet ? Number(dotNet[1]) : Date.parse(value)
  return Math.floor(milliseconds / 1000)
}

function processExists(pid, { platform = process.platform, procRoot = '/proc', spawnSync: execFile = spawnSync } = {}) {
  if (platform === 'linux') return existsSync(path.join(procRoot, String(pid)))
  if (platform === 'darwin') {
    const result = runEvidence('ps', ['-p', String(pid), '-o', 'pid='], execFile)
    if (result.status === 'unavailable') return null
    return result.status === 0 && result.stdout.trim() === String(pid)
  }
  if (platform === 'win32') {
    const result = powershellProcess(pid, execFile)
    if (result.status === 'unavailable') return null
    return result.status === 0
  }
  return null
}

function processState(pid, { platform = process.platform, procRoot = '/proc', spawnSync: execFile = spawnSync } = {}) {
  if (platform === 'darwin') {
    const result = runEvidence('ps', ['-p', String(pid), '-o', 'state='], execFile)
    return result.status === 0 ? result.stdout.trim().charAt(0) || null : null
  }
  if (platform !== 'linux') return null
  try {
    const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  } catch { return null }
}

function identityStatus(expected, { inspect, platform, procRoot, processExists: exists, processState: state }) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 1 || !Array.isArray(expected.argv) || !Number.isFinite(expected.startTime)) return 'unknown'
  const actual = inspect(expected.pid, { platform, procRoot, captureCwd: false })
  if (actual) {
    if (actual.startTime !== expected.startTime) return 'gone'
    return sameIdentity(expected, actual) ? 'running' : 'unknown'
  }
  const existence = exists(expected.pid, { platform, procRoot })
  if (existence === false) return 'gone'
  if (existence === null) return 'unknown'
  if (state(expected.pid, { platform, procRoot }) === 'Z') return 'gone'
  return 'unknown'
}

export function classifyLane(record, { inspect = inspectProcess, platform = process.platform, procRoot = '/proc', processExists: exists = processExists, processState: state = processState } = {}) {
  if (!record || typeof record !== 'object' || typeof record.runId !== 'string') {
    return { status: 'unknown', reason: 'invalid-record', worker: 'unknown', child: 'unknown' }
  }
  if (record.state === 'launch-failed') return { status: 'terminal', reason: 'launch-failed', worker: 'gone', child: 'gone' }
  const worker = identityStatus({ pid: record.workerPid, argv: record.workerArgv, startTime: record.workerStartTime }, { inspect, platform, procRoot, processExists: exists, processState: state })
  const child = record.childPid === null && record.childArgv === null
    ? 'not-spawned'
    : identityStatus({ pid: record.childPid, argv: record.childArgv, startTime: record.childStartTime }, { inspect, platform, procRoot, processExists: exists, processState: state })
  if (worker === 'gone' && child === 'not-spawned') return { status: 'gone', reason: 'worker-gone-no-child', worker, child: 'gone' }
  if (worker === 'running' && child === 'not-spawned' && record.state === 'launching') return { status: 'launching', reason: 'worker-launching-child', worker, child: 'not-spawned' }
  if (worker === 'gone' && child === 'gone') return { status: 'gone', reason: 'worker-and-child-gone', worker, child }
  if (worker === 'gone' && child === 'running') return { status: 'worker-gone-child-alive', reason: 'worker-gone-child-alive', worker, child }
  if (worker === 'unknown' || child === 'unknown') {
    const unavailable = worker === 'unknown' && typeof record.workerIdentity === 'string'
      ? `worker identity ${record.workerIdentity}`
      : child === 'unknown' && typeof record.childIdentity === 'string'
        ? `child identity ${record.childIdentity}`
        : null
    return { status: 'unknown', reason: unavailable ?? (platform === 'linux' ? 'identity-unreadable' : `identity-unreadable-${evidenceSource(platform)}`), worker, child }
  }
  if (['exited', 'abandoned'].includes(record.state) && child === 'gone') return { status: 'terminal', reason: record.state, worker, child }
  if (worker === 'running' && child === 'running' && ['running', 'decision-needed'].includes(record.state)) {
    return { status: record.state, reason: record.state, worker, child }
  }
  return { status: 'unknown', reason: 'inconsistent-record', worker, child }
}

export function terminateLane(record, { inspect = inspectProcess, kill = process.kill, graceMs = 1000, platform = process.platform, procRoot = '/proc', processExists: exists = processExists, processState: state = processState, journal = () => {}, source = 'unknown', markTerminal = null, ownedChild = null, recordWorktree = null } = {}) {
  const event = { event: 'termination-signaled', runId: record.runId, source, workerPid: record.workerPid, childPid: record.childPid, pid: record.childPid, argv: argvSummary(record.childArgv ?? []), worktree: record.worktree, owner: record.owner ?? null, reason: 'verified lane process group' }
  // The worker owns this ChildProcess handle and its detached group. This path deliberately does
  // not consult /proc and never sends SIGKILL to the group leader (itself).
  if (source === 'worker' && ownedChild?.pid === record.childPid) {
    journal(event)
    if (markTerminal) markTerminal('terminating')
    try {
      if (platform === 'win32') ownedChild.kill('SIGTERM')
      else kill(-record.workerPid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') return { killed: false, reason: `signal-${error?.code ?? 'failed'}`, verdict: { status: 'unknown' } }
    }
    if (graceMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs)
    try { kill(record.childPid, 0); ownedChild.kill('SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') return { killed: false, reason: `signal-${error?.code ?? 'failed'}`, verdict: { status: 'unknown' } } }
    if (markTerminal) markTerminal('terminal')
    journal({ ...event, event: 'terminated', reason: 'terminated' })
    return { killed: true, reason: 'terminated', verdict: { status: 'gone', reason: 'worker-owned-child-ended' } }
  }
  const verdict = classifyLane(record, { inspect, platform, procRoot, processExists: exists, processState: state })
  if (verdict.status === 'gone') return { killed: false, reason: 'already-gone', verdict }
  if (!['running', 'decision-needed', 'terminal', 'worker-gone-child-alive'].includes(verdict.status)) {
    return { killed: false, reason: verdict.reason, verdict }
  }
  const worker = inspect(record.workerPid, { platform, captureCwd: true })
  const child = inspect(record.childPid, { platform, captureCwd: true })
  const refuse = (reason) => {
    journal({ ...event, event: 'termination-refused', reason })
    return { killed: false, reason, verdict }
  }
  if (platform === 'win32') return refuse('external-tree-termination-unavailable-win32')
  if (['control', 'watcher'].includes(source)) {
    if (child && !child.cwd) return refuse('child-cwd-unreadable')
    let recordRoot
    let sourceRoot
    let childCwd
    try { recordRoot = realpathSync(record.worktree); sourceRoot = realpathSync(recordWorktree) } catch { return refuse('record-worktree-mismatch') }
    if (recordRoot !== sourceRoot) return refuse('record-worktree-mismatch')
    try { childCwd = child ? realpathSync(child.cwd) : null } catch { return refuse('child-cwd-unreadable') }
    const relative = child ? path.relative(recordRoot, childCwd) : null
    if (child && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return refuse('child-cwd-outside-worktree')
  }
  if ((worker && !sameIdentity({ pid: record.workerPid, argv: record.workerArgv, startTime: record.workerStartTime, cwd: record.workerCwd }, worker))
    || (child && !sameIdentity({ pid: record.childPid, argv: record.childArgv, startTime: record.childStartTime, cwd: record.childCwd }, child))) {
    return { killed: false, reason: 'identity-changed', verdict }
  }
  if ((worker?.groupId && worker.groupId !== record.workerPid) || (child?.groupId && child.groupId !== record.workerPid)) {
    return { killed: false, reason: 'process-group-changed', verdict }
  }
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
    const afterTerm = classifyLane(record, { inspect, platform, procRoot, processExists: exists, processState: state })
    if (afterTerm.status === 'gone') {
      journal({ ...event, event: 'terminated', reason: 'terminated' })
      return { killed: true, reason: 'terminated', verdict: afterTerm }
    }
    if (afterTerm.status === 'unknown' && afterTerm.reason === 'identity-unreadable') return { killed: false, reason: 'identity-unreadable-after-sigterm', verdict: afterTerm }
    if (!signal('SIGKILL')) return { killed: true, reason: 'terminated', verdict: afterTerm }
    if (graceMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs)
    const afterKill = classifyLane(record, { inspect, platform, procRoot, processExists: exists, processState: state })
    if (afterKill.status === 'gone') {
      journal({ ...event, event: 'terminated', reason: 'terminated' })
      return { killed: true, reason: 'terminated', verdict: afterKill }
    }
    return { killed: false, reason: 'still-alive-after-sigkill', verdict: afterKill }
  } catch (error) {
    return { killed: false, reason: `signal-${error?.code ?? 'failed'}`, verdict }
  }
}

function inspectDarwinProcess(pid, execFile, captureCwd) {
  const result = runEvidence('ps', ['-ww', '-p', String(pid), '-o', 'lstart=,pgid=,command='], execFile)
  if (result.status !== 0) return null
  const match = /^(.{24})\s+(\d+)\s+([\s\S]+?)\s*$/.exec(result.stdout)
  if (!match) return null
  const startTime = processStartSeconds(match[1])
  if (!Number.isFinite(startTime)) return null
  const state = runEvidence('ps', ['-p', String(pid), '-o', 'state='], execFile)
  if (state.status === 0 && state.stdout.trim().startsWith('Z')) return null
  const cwdResult = captureCwd ? runEvidence('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], execFile) : null
  const cwd = cwdResult?.status === 0 ? cwdResult.stdout.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) ?? null : null
  return { pid, argv: [match[3]], startTime, groupId: Number(match[2]), cwd }
}

function inspectWindowsProcess(pid, execFile) {
  const result = powershellProcess(pid, execFile)
  if (result.status !== 0 || !result.value) return null
  const startTime = processStartSeconds(result.value.CreationDate)
  if (!Number.isFinite(startTime) || typeof result.value.CommandLine !== 'string') return null
  return { pid, argv: [result.value.CommandLine], startTime, groupId: Number(result.value.ParentProcessId), cwd: null }
}

export function inspectProcess(pid, { procRoot = '/proc', platform = process.platform, spawnSync: execFile = spawnSync, captureCwd = true } = {}) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null
  if (platform === 'darwin') return inspectDarwinProcess(Number(pid), execFile, captureCwd)
  if (platform === 'win32') return inspectWindowsProcess(Number(pid), execFile)
  if (platform !== 'linux') return null
  try {
    const argv = readFileSync(path.join(procRoot, String(pid), 'cmdline')).toString().split('\0').filter(Boolean)
    const cwd = readlinkSync(path.join(procRoot, String(pid), 'cwd'))
    const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (rest[0] === 'Z') return null
    return { pid: Number(pid), argv, cwd, groupId: Number(rest[2]), startTime: Number(rest[19]) }
  } catch {
    try {
      const argv = readFileSync(path.join(procRoot, String(pid), 'cmdline')).toString().split('\0').filter(Boolean)
      const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (rest[0] === 'Z') return null
      return { pid: Number(pid), argv, cwd: null, groupId: Number(rest[2]), startTime: Number(rest[19]) }
    } catch { return null }
  }
}

export function processEvidenceStatus(pid, { platform = process.platform, inspect = inspectProcess, processExists: exists = processExists } = {}) {
  if (inspect(pid, { platform })) return 'running'
  const existence = exists(pid, { platform })
  return existence === false ? 'gone' : 'unknown'
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

export function claimCurrentSupervision(paths, runId, { writePointer = writeJsonAtomic } = {}) {
  writePointer(paths.pointer, { version: 1, runId })
  let currentRunId = null
  try { currentRunId = JSON.parse(readFileSync(paths.pointer, 'utf8')).runId } catch {}
  if (currentRunId === runId) return true
  rmSync(paths.record, { force: true })
  return false
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
