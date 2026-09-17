import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const JOURNAL_MAX_BYTES = 10 * 1024 * 1024
const DARWIN_PROCESS_TABLE_TTL_MS = 100
const WINDOWS_PROCESS_READ_TTL_MS = 500
const WINDOWS_PROCESS_READ_TIMEOUT_MS = 10_000
const WINDOWS_APPROXIMATE_START_SKEW_MS = 2_000
const darwinProcessTableCache = new WeakMap()
const darwinCwdCache = new WeakMap()
const windowsProcessCache = new WeakMap()

export function sameIdentity(expected, actual) {
  let sameCwd = true
  if (expected.cwd) {
    try { sameCwd = realpathSync(expected.cwd) === realpathSync(actual?.cwd) } catch { sameCwd = expected.cwd === actual?.cwd }
  }
  const sameStartTime = startTimesMatch(expected, actual)
  const sameImage = !expected?.image
    || Boolean(actual?.image
      && expected.image.name === actual.image.name
      && (!expected.image.path || (actual.image.path && expected.image.path.toLowerCase() === actual.image.path.toLowerCase())))
  return Boolean(actual
    && expected.pid === actual.pid
    && Number.isFinite(expected.startTime)
    && Number.isFinite(actual.startTime)
    && sameStartTime
    && sameImage
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv)
    && sameCwd)
}

function startTimesMatch(expected, actual) {
  return expected?.startTimeApproximate
    ? Math.abs(expected.startTime - actual?.startTime) <= WINDOWS_APPROXIMATE_START_SKEW_MS
    : expected?.startTime === actual?.startTime
}

function evidenceSource(platform) {
  if (platform === 'darwin') return 'ps'
  if (platform === 'win32') return 'powershell'
  return 'proc'
}

function runEvidence(command, args, execFile, timeoutMs) {
  try {
    const result = execFile(command, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, ...(Number.isFinite(timeoutMs) ? { timeout: Math.max(1, timeoutMs) } : {}) })
    if (result.error) return { status: 'unavailable' }
    return { status: result.status, stdout: result.stdout ?? '' }
  } catch { return { status: 'unavailable' } }
}

function darwinProcessTable(execFile, pid, now = Date.now()) {
  const cached = darwinProcessTableCache.get(execFile)
  if (cached && now - cached.readAt <= DARWIN_PROCESS_TABLE_TTL_MS) {
    const missReadAt = cached.missReadAt.get(pid)
    if (cached.result.status !== 0 || cached.result.value.has(pid) || (missReadAt !== undefined && now - missReadAt <= DARWIN_PROCESS_TABLE_TTL_MS)) return cached.result
  }
  const evidence = runEvidence('ps', ['-ww', '-axo', 'pid=,lstart=,pgid=,state=,command='], execFile)
  let result = evidence
  if (evidence.status === 0) {
    const value = new Map()
    for (const line of evidence.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.{24})\s+(\d+)\s+(\S+)\s+([\s\S]+?)\s*$/.exec(line)
      if (!match) continue
      const startTime = processStartSeconds(match[2])
      if (!Number.isFinite(startTime)) continue
      value.set(Number(match[1]), { pid: Number(match[1]), argv: [match[5]], startTime, groupId: Number(match[3]), state: match[4] })
    }
    result = { status: 0, value }
  }
  const missReadAt = new Map([...cached?.missReadAt ?? []].filter(([, readAt]) => now - readAt <= DARWIN_PROCESS_TABLE_TTL_MS))
  if (result.status === 0) {
    for (const presentPid of result.value.keys()) missReadAt.delete(presentPid)
    if (!result.value.has(pid)) missReadAt.set(pid, now)
  }
  darwinProcessTableCache.set(execFile, { readAt: now, result, missReadAt })
  return result
}

function darwinCwd(pid, execFile, now = Date.now()) {
  const cached = darwinCwdCache.get(execFile)
  if (cached && now - cached.readAt <= DARWIN_PROCESS_TABLE_TTL_MS) {
    const missReadAt = cached.missReadAt.get(pid)
    if (cached.value.has(pid) || (missReadAt !== undefined && now - missReadAt <= DARWIN_PROCESS_TABLE_TTL_MS)) return cached.value.get(pid) ?? null
  }
  const result = runEvidence('lsof', ['-d', 'cwd', '-F', 'pn'], execFile)
  const value = new Map()
  let currentPid = null
  if (result.status === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith('p')) currentPid = Number(line.slice(1))
      else if (line.startsWith('n') && Number.isSafeInteger(currentPid)) value.set(currentPid, line.slice(1))
    }
  }
  const missReadAt = new Map([...cached?.missReadAt ?? []].filter(([, readAt]) => now - readAt <= DARWIN_PROCESS_TABLE_TTL_MS))
  for (const presentPid of value.keys()) missReadAt.delete(presentPid)
  if (!value.has(pid)) missReadAt.set(pid, now)
  darwinCwdCache.set(execFile, { readAt: now, value, missReadAt })
  return value.get(pid) ?? null
}

function powershellProcess(pid, execFile, timeoutMs = WINDOWS_PROCESS_READ_TIMEOUT_MS, now = Date.now()) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return { status: 1, stdout: '' }
  let cache = windowsProcessCache.get(execFile)
  if (!cache) { cache = new Map(); windowsProcessCache.set(execFile, cache) }
  const cached = cache.get(Number(pid))
  if (cached && now - cached.readAt <= WINDOWS_PROCESS_READ_TTL_MS) return cached.result
  const script = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ Id = $p.Id; ProcessName = $p.ProcessName; Path = $p.Path; StartTime = [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`
  const evidence = runEvidence('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], execFile, timeoutMs)
  let result = evidence
  if (evidence.status === 0) {
    try {
      const value = evidence.stdout.trim() ? JSON.parse(evidence.stdout) : null
      result = value ? { status: 0, value } : { status: 1, stdout: '' }
    } catch { result = { status: 'unavailable' } }
  }
  cache.set(Number(pid), { readAt: now, result })
  return result
}

function processStartSeconds(value) {
  const dotNet = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(String(value))
  const milliseconds = dotNet ? Number(dotNet[1]) : Date.parse(value)
  return Math.floor(milliseconds / 1000)
}

function processExists(pid, { platform = process.platform, procRoot = '/proc', spawnSync: execFile = spawnSync, timeoutMs } = {}) {
  if (platform === 'linux') return existsSync(path.join(procRoot, String(pid)))
  if (platform === 'darwin') {
    const result = darwinProcessTable(execFile, Number(pid))
    if (result.status === 'unavailable') return null
    return result.status === 0 && result.value.has(Number(pid))
  }
  if (platform === 'win32') {
    const result = powershellProcess(pid, execFile, timeoutMs)
    if (result.status === 'unavailable') return null
    return result.status === 0
  }
  return null
}

function processState(pid, { platform = process.platform, procRoot = '/proc', spawnSync: execFile = spawnSync } = {}) {
  if (platform === 'darwin') {
    const result = darwinProcessTable(execFile, Number(pid))
    return result.status === 0 ? result.value.get(Number(pid))?.state?.charAt(0) ?? null : null
  }
  if (platform !== 'linux') return null
  try {
    const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  } catch { return null }
}

function identityStatus(expected, { inspect, platform, procRoot, processExists: exists, processState: state }) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 1 || !Array.isArray(expected.argv) || !Number.isFinite(expected.startTime)) return 'unknown'
  const actual = inspect(expected.pid, { platform, procRoot, captureCwd: false, recordedArgv: expected.argv })
  if (actual) {
    if (sameIdentity(expected, actual)) return 'running'
    return startTimesMatch(expected, actual) ? 'unknown' : 'gone'
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
  const worker = identityStatus({ pid: record.workerPid, argv: record.workerArgv, startTime: record.workerStartTime, startTimeApproximate: record.workerStartTimeApproximate, image: record.workerImage }, { inspect, platform, procRoot, processExists: exists, processState: state })
  const child = record.childPid === null && record.childArgv === null
    ? 'not-spawned'
    : identityStatus({ pid: record.childPid, argv: record.childArgv, startTime: record.childStartTime, startTimeApproximate: record.childStartTimeApproximate, image: record.childImage }, { inspect, platform, procRoot, processExists: exists, processState: state })
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
  const result = darwinProcessTable(execFile, pid)
  if (result.status !== 0) return null
  const row = result.value.get(pid)
  if (!row || row.state.startsWith('Z')) return null
  return { pid: row.pid, argv: row.argv, startTime: row.startTime, groupId: row.groupId, cwd: captureCwd ? darwinCwd(pid, execFile) : null }
}

function inspectWindowsProcess(pid, execFile, timeoutMs, recordedArgv) {
  const result = powershellProcess(pid, execFile, timeoutMs)
  if (result.status !== 0 || !result.value) return null
  const startTime = Number(result.value.StartTime)
  const name = String(result.value.ProcessName || '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '')
  if (!Number.isFinite(startTime) || !name) return null
  return { pid, argv: Array.isArray(recordedArgv) ? recordedArgv : [], startTime, image: { name, path: typeof result.value.Path === 'string' && result.value.Path ? result.value.Path : null }, groupId: null, cwd: null }
}

export function inspectProcess(pid, { procRoot = '/proc', platform = process.platform, spawnSync: execFile = spawnSync, captureCwd = true, timeoutMs = platform === 'win32' ? WINDOWS_PROCESS_READ_TIMEOUT_MS : undefined, recordedArgv = null } = {}) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null
  if (platform === 'darwin') return inspectDarwinProcess(Number(pid), execFile, captureCwd)
  if (platform === 'win32') return inspectWindowsProcess(Number(pid), execFile, timeoutMs, recordedArgv)
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
  const windowsOptions = platform === 'win32' ? { singlePid: true, timeoutMs: WINDOWS_PROCESS_READ_TIMEOUT_MS } : {}
  if (inspect(pid, { platform, ...windowsOptions })) return 'running'
  const existence = exists(pid, { platform, ...windowsOptions })
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
