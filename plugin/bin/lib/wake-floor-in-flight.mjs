import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyLane } from './lane-supervisor-core.mjs'
import { laneHostDir } from './host/lane-host-dir.mjs'
import { createProcfs } from './host/procfs.mjs'

const RECORD_NAME = /^\d+-\d+\.json$/
const LIVE_STATUSES = new Set(['running', 'decision-needed', 'launching'])
const INACTIVE_STATUSES = new Set(['gone', 'terminal', 'worker-gone-child-alive'])
const TASK_OUTPUT_NAME = /^[A-Za-z0-9_-]+\.output$/
const BACKGROUND_TASK_UNSUPPORTED = 'background task inspection requires Linux procfs'
const MONITOR_SCRIPTS = [
  'wt-arc-watch.mjs',
  'wt-service-watch.mjs',
  'wt-quota-watch.mjs',
  'wt-autonomy-watch.mjs',
  'wt-wake-floor.mjs',
  'wt-cache-keepalive.mjs',
  'wt-artifact-server-ensure.mjs',
  'wt-lane-orphan-watch.mjs',
]

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function processStartTime(value) {
  const close = value.lastIndexOf(')')
  if (close < 0) return null
  const fields = value.slice(close + 1).trim().split(/\s+/)
  return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null
}

function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function writableFd(value) {
  const match = /^flags:\s*([0-7]+)$/m.exec(value)
  if (!match) return null
  const accessMode = Number.parseInt(match[1], 8) & 3
  return accessMode === 1 || accessMode === 2
}

function pluginMonitorArgv(argv) {
  return MONITOR_SCRIPTS.some((name) => argv.includes(`/${name}`) || argv.split('\0').some((argument) => path.basename(argument) === name))
}

// Explicit `undefined` takes the default, as destructuring defaults would.
function taskOptions(options) {
  const defaults = {
    platform: process.platform, tmpdirImpl: tmpdir, getuidImpl: process.getuid,
    readdirImpl: readdirSync, readFileImpl: readFileSync, readlinkImpl: readlinkSync, statImpl: statSync,
    maxProcesses: 10_000, maxFds: 1_024, maxTaskOutputs: 1_000,
  }
  // Each option is read exactly once: an accessor-backed option must not change between reads.
  const resolved = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = options[key]
    return [key, value === undefined ? fallback : value]
  }))
  return { projectDir: options.projectDir, sessionId: options.sessionId, ...resolved }
}

// Returns { result } when the answer is already known, else { uid, outputs }.
function taskOutputs(o, uid) {
  const tasksDir = path.join(o.tmpdirImpl(), `claude-${uid}`, projectSlug(o.projectDir), o.sessionId, 'tasks')
  let taskEntries
  try {
    taskEntries = o.readdirImpl(tasksDir, { withFileTypes: true })
  } catch (error) {
    return { result: missing(error) ? { status: 'none' } : { status: 'unknown', reason: 'task directory unreadable' } }
  }
  const names = taskEntries.map((entry) => entry.name).filter((name) => TASK_OUTPUT_NAME.test(name))
  if (names.length === 0) return { result: { status: 'none' } }
  if (names.length > o.maxTaskOutputs) return { result: { status: 'unknown', reason: `task output scan capped at ${o.maxTaskOutputs}` } }
  return { uid, outputs: new Set(names.map((name) => path.join(tasksDir, name))) }
}

function taskScope(o) {
  if (o.platform !== 'linux') return { result: { status: 'unknown', reason: BACKGROUND_TASK_UNSUPPORTED } }
  if (typeof o.sessionId !== 'string' || o.sessionId === '') return { result: { status: 'unknown', reason: 'session id unavailable' } }
  if (!/^[A-Za-z0-9._-]+$/.test(o.sessionId)) return { result: { status: 'unknown', reason: 'session id invalid' } }
  const uid = o.getuidImpl?.()
  if (!Number.isInteger(uid)) return { result: { status: 'unknown', reason: 'user id unavailable' } }
  return taskOutputs(o, uid)
}

// A listing failure stays unknown; a pid that vanished mid-scan is simply absent from the plain listing.
function listTaskProcesses(procfs, maxProcesses) {
  let processes
  try {
    processes = procfs.listProcessIds()
  } catch {
    return { result: { status: 'unknown', reason: 'process table unreadable' } }
  }
  if (processes.length > maxProcesses) return { result: { status: 'unknown', reason: `process scan capped at ${maxProcesses}` } }
  return { processes }
}

function ownedByUid(procfs, pid, uid, unknowns) {
  try {
    return procfs.processDirectoryStat(pid).uid === uid
  } catch (error) {
    if (!missing(error)) unknowns.push('process identity unreadable')
    return false
  }
}

function readStartAndDescriptors(procfs, pid) {
  try {
    const before = processStartTime(String(procfs.readProcessStat(pid, 'utf8')))
    return { before, fds: procfs.listDescriptors(pid, { withFileTypes: true }) }
  } catch {
    return null
  }
}

function writableOutputFd(procfs, pid, name, unknowns) {
  try {
    const writable = writableFd(String(procfs.readDescriptorInfo(pid, name, 'utf8')))
    if (writable === null) unknowns.push('process fd mode unreadable')
    return Boolean(writable)
  } catch (error) {
    if (!missing(error)) unknowns.push('process fd unreadable')
    return false
  }
}

function descriptorTarget(procfs, pid, name) {
  try {
    return procfs.readDescriptorTarget(pid, name)
  } catch {
    // An unreadable unrelated descriptor is not evidence about a task output.
    return undefined
  }
}

function findHeldOutput(procfs, pid, fds, outputs, unknowns) {
  for (const fd of fds) {
    const target = descriptorTarget(procfs, pid, fd.name)
    if (outputs.has(target) && writableOutputFd(procfs, pid, fd.name, unknowns)) return { output: target, fd: fd.name }
  }
  return null
}

function rejectHolder(unknowns, reason) {
  unknowns.push(reason)
  return null
}

function heldFdChanged(procfs, pid, held) {
  const finalTarget = procfs.readDescriptorTarget(pid, held.fd)
  const finalWritable = writableFd(String(procfs.readDescriptorInfo(pid, held.fd, 'utf8')))
  return finalTarget !== held.output || finalWritable !== true
}

function attestHolder(procfs, pid, held, before, sessionId, unknowns) {
  const environment = String(procfs.readEnvironment(pid)).split('\0')
  const argv = String(procfs.readCommandLine(pid))
  const after = processStartTime(String(procfs.readProcessStat(pid, 'utf8')))
  if (!after || after !== before) return rejectHolder(unknowns, 'background task process identity changed')
  if (!environment.includes(`CLAUDE_CODE_SESSION_ID=${sessionId}`)) return null
  if (argv === '') return rejectHolder(unknowns, 'background task argv unreadable')
  if (pluginMonitorArgv(argv)) return null
  if (heldFdChanged(procfs, pid, held)) return rejectHolder(unknowns, 'background task fd identity changed')
  const finalStart = processStartTime(String(procfs.readProcessStat(pid, 'utf8')))
  if (!finalStart || finalStart !== before) return rejectHolder(unknowns, 'background task process identity changed')
  return { status: 'in-flight', reason: `session background task ${path.basename(held.output, '.output')} held by pid ${pid}` }
}

function attributeHolder(procfs, pid, held, before, sessionId, unknowns) {
  try {
    return attestHolder(procfs, pid, held, before, sessionId, unknowns)
  } catch (error) {
    if (!missing(error)) unknowns.push('background task attribution unreadable')
    return null
  }
}

function scanTaskProcess(procfs, pid, scope, unknowns) {
  if (!ownedByUid(procfs, pid, scope.uid, unknowns)) return null
  const head = readStartAndDescriptors(procfs, pid)
  if (!head?.before) return null
  if (head.fds.length > scope.maxFds) return rejectHolder(unknowns, `process fd scan capped at ${scope.maxFds}`)
  const held = findHeldOutput(procfs, pid, head.fds, scope.outputs, unknowns)
  return held ? attributeHolder(procfs, pid, held, head.before, scope.sessionId, unknowns) : null
}

export function sessionBackgroundTaskInFlight(options) {
  const o = taskOptions(options)
  const scope = taskScope(o)
  if (scope.result) return scope.result
  const procfs = createProcfs({ platform: o.platform, readdir: o.readdirImpl, readFile: o.readFileImpl, readlink: o.readlinkImpl, stat: o.statImpl })
  const listed = listTaskProcesses(procfs, o.maxProcesses)
  if (listed.result) return listed.result
  const unknowns = []
  for (const pid of listed.processes) {
    const found = scanTaskProcess(procfs, pid, { ...scope, maxFds: o.maxFds, sessionId: o.sessionId }, unknowns)
    if (found) return found
  }
  return unknowns.length ? { status: 'unknown', reason: unknowns[0] } : { status: 'none' }
}

function readRecord(file, readFileImpl) {
  try {
    const value = JSON.parse(readFileImpl(file, 'utf8'))
    return plainObject(value) ? { value } : { reason: 'record unreadable' }
  } catch {
    return { reason: 'record unreadable' }
  }
}

function ownership(record, sessionId) {
  if (record.owner === 'pilot') return 'pilot'
  if (record.owner !== 'session') return 'unattributable'
  if (typeof record.ownerSessionId !== 'string' || record.ownerSessionId === '') return 'unattributable'
  if (typeof sessionId !== 'string' || sessionId === '') return 'unattributable'
  return record.ownerSessionId === sessionId ? 'owned' : 'foreign'
}

function classifyRecord(record, sessionId, classify) {
  if (record.state === 'launch-failed') return { status: 'none' }
  const owner = ownership(record, sessionId)
  if (owner === 'pilot' || owner === 'foreign') return { status: 'none' }
  let verdict
  try {
    verdict = classify(record)
  } catch {
    return { status: 'unknown', reason: 'lane classification threw' }
  }
  if (LIVE_STATUSES.has(verdict?.status)) {
    return owner === 'owned'
      ? { status: 'in-flight', reason: verdict.reason ?? verdict.status }
      : { status: 'unknown', reason: 'lane ownership unattributable' }
  }
  if (INACTIVE_STATUSES.has(verdict?.status)) return { status: 'none' }
  return {
    status: 'unknown',
    reason: owner === 'unattributable' ? 'lane ownership unattributable' : verdict?.reason ?? 'lane classification unknown',
  }
}

function gitWorktrees(projectDir, spawnSyncImpl) {
  let result
  try {
    result = spawnSyncImpl('git', ['-C', projectDir, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 5_000,
    })
  } catch {
    return { paths: [], reason: 'git worktree list unavailable' }
  }
  if (result?.error) return { paths: [], reason: 'git worktree list unavailable' }
  if (result?.status !== 0) {
    return /not a git repository/i.test(String(result?.stderr))
      ? { paths: [] }
      : { paths: [], reason: 'git worktree list unavailable' }
  }
  const paths = String(result.stdout ?? '').split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
  return paths.length ? { paths } : { paths: [], reason: 'git worktree list unavailable' }
}

function umbrellaWorktrees(projectDir, readdirImpl, maxUmbrellaEntries) {
  const root = path.join(projectDir, '.claude', 'worktrees')
  let entries
  try {
    entries = readdirImpl(root, { withFileTypes: true })
  } catch (error) {
    return missing(error) ? { paths: [] } : { paths: [], reason: 'worktree directory unreadable' }
  }
  const candidates = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
  return {
    paths: candidates.slice(0, maxUmbrellaEntries).map((entry) => path.join(root, entry.name)),
    ...(candidates.length > maxUmbrellaEntries ? { reason: `umbrella scan capped at ${maxUmbrellaEntries}` } : {}),
  }
}

function currentRecord(dir, entries, readFileImpl) {
  if (!entries.some((entry) => entry.name === 'current.json')) return {}
  const pointer = readRecord(path.join(dir, 'current.json'), readFileImpl)
  if (!pointer.value || typeof pointer.value.runId !== 'string' || !/^\d+-\d+$/.test(pointer.value.runId)) {
    return { reason: 'record unreadable' }
  }
  return { name: `${pointer.value.runId}.json` }
}

function supervisionDirs(worktree, readdirImpl) {
  const hostDir = laneHostDir(worktree)
  const defaultDir = path.join(hostDir, 'supervision')
  let entries
  try { entries = readdirImpl(hostDir, { withFileTypes: true }) } catch { entries = [] }
  const slots = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && /^supervision-[A-Za-z0-9._-]+$/.test(entry.name))
    .map((entry) => path.join(hostDir, entry.name))
    .sort()
  return [defaultDir, ...slots]
}

export function sessionLaneInFlight({
  projectDir,
  sessionId,
  readdirImpl = readdirSync,
  readFileImpl = readFileSync,
  spawnSyncImpl = spawnSync,
  classify = classifyLane,
  backgroundTaskProbe = sessionBackgroundTaskInFlight,
  maxWorktrees = 500,
  maxUmbrellaEntries = 200,
  maxRecords = 1000,
}) {
  const unknowns = []
  let backgroundTask
  try {
    backgroundTask = backgroundTaskProbe({ projectDir, sessionId })
  } catch {
    backgroundTask = { status: 'unknown', reason: 'background task inspection threw' }
  }
  if (backgroundTask?.status === 'in-flight') return backgroundTask
  const backgroundTaskUnsupported = backgroundTask?.status === 'unknown' && backgroundTask.reason === BACKGROUND_TASK_UNSUPPORTED
  if (backgroundTask?.status === 'unknown' && !backgroundTaskUnsupported) unknowns.push(backgroundTask.reason ?? 'background task inspection unknown')
  const git = gitWorktrees(projectDir, spawnSyncImpl)
  const umbrella = umbrellaWorktrees(projectDir, readdirImpl, maxUmbrellaEntries)
  if (git.reason) unknowns.push(git.reason)
  if (umbrella.reason) unknowns.push(umbrella.reason)
  const discovered = [...new Set([path.resolve(projectDir), ...git.paths.map((item) => path.resolve(item)), ...umbrella.paths.map((item) => path.resolve(item))])]
  if (discovered.length > maxWorktrees) unknowns.push(`worktree scan capped at ${maxWorktrees}`)
  const worktrees = discovered.slice(0, maxWorktrees)
  let recordsSeen = 0

  for (const worktree of worktrees) {
    for (const dir of supervisionDirs(worktree, readdirImpl)) {
      let entries
      try {
        entries = readdirImpl(dir, { withFileTypes: true })
      } catch (error) {
        if (!missing(error)) unknowns.push('supervision dir unreadable')
        continue
      }
      const current = currentRecord(dir, entries, readFileImpl)
      if (current.reason) unknowns.push(current.reason)
      const names = entries.map((entry) => entry.name).filter((name) => RECORD_NAME.test(name)).sort()
      if (current.name && !names.includes(current.name)) unknowns.push('record unreadable')
      const ordered = current.name && names.includes(current.name)
        ? [current.name, ...names.filter((name) => name !== current.name)]
        : names
      if (recordsSeen + names.length > maxRecords) unknowns.push(`record scan capped at ${maxRecords}`)
      const available = Math.max(0, maxRecords - recordsSeen)
      const selected = current.name && ordered[0] === current.name && available === 0 ? [current.name] : ordered.slice(0, available)
      recordsSeen += names.length
      for (const name of selected) {
        const loaded = readRecord(path.join(dir, name), readFileImpl)
        if (!loaded.value) {
          unknowns.push(loaded.reason)
          continue
        }
        const verdict = classifyRecord(loaded.value, sessionId, classify)
        if (verdict.status === 'in-flight') return verdict
        if (verdict.status === 'unknown') unknowns.push(verdict.reason)
      }
    }
  }
  return unknowns.length
    ? { status: 'unknown', reason: backgroundTaskUnsupported ? `${unknowns[0]}; ${BACKGROUND_TASK_UNSUPPORTED}` : unknowns[0] }
    : { status: 'none', reason: 'no live owned lane' }
}
