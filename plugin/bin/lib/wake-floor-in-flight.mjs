import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyLane } from './lane-supervisor-core.mjs'

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

export function sessionBackgroundTaskInFlight({
  projectDir,
  sessionId,
  platform = process.platform,
  tmpdirImpl = tmpdir,
  getuidImpl = process.getuid,
  readdirImpl = readdirSync,
  readFileImpl = readFileSync,
  readlinkImpl = readlinkSync,
  statImpl = statSync,
  maxProcesses = 10_000,
  maxFds = 1_024,
  maxTaskOutputs = 1_000,
}) {
  if (platform !== 'linux') return { status: 'unknown', reason: BACKGROUND_TASK_UNSUPPORTED }
  if (typeof sessionId !== 'string' || sessionId === '') return { status: 'unknown', reason: 'session id unavailable' }
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return { status: 'unknown', reason: 'session id invalid' }
  const uid = getuidImpl?.()
  if (!Number.isInteger(uid)) return { status: 'unknown', reason: 'user id unavailable' }
  const tasksDir = path.join(tmpdirImpl(), `claude-${uid}`, projectSlug(projectDir), sessionId, 'tasks')
  let taskEntries
  try {
    taskEntries = readdirImpl(tasksDir, { withFileTypes: true })
  } catch (error) {
    return missing(error) ? { status: 'none' } : { status: 'unknown', reason: 'task directory unreadable' }
  }
  const names = taskEntries.map((entry) => entry.name).filter((name) => TASK_OUTPUT_NAME.test(name))
  if (names.length === 0) return { status: 'none' }
  if (names.length > maxTaskOutputs) return { status: 'unknown', reason: `task output scan capped at ${maxTaskOutputs}` }
  const outputs = new Set(names.map((name) => path.join(tasksDir, name)))
  let processes
  try {
    processes = readdirImpl('/proc', { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => /^\d+$/.test(name))
  } catch {
    return { status: 'unknown', reason: 'process table unreadable' }
  }
  if (processes.length > maxProcesses) return { status: 'unknown', reason: `process scan capped at ${maxProcesses}` }
  const unknowns = []
  for (const pid of processes) {
    const procDir = path.join('/proc', pid)
    try {
      if (statImpl(procDir).uid !== uid) continue
    } catch (error) {
      if (!missing(error)) unknowns.push('process identity unreadable')
      continue
    }
    let before
    let fds
    try {
      before = processStartTime(String(readFileImpl(path.join(procDir, 'stat'), 'utf8')))
      fds = readdirImpl(path.join(procDir, 'fd'), { withFileTypes: true })
    } catch {
      continue
    }
    if (!before) continue
    if (fds.length > maxFds) {
      unknowns.push(`process fd scan capped at ${maxFds}`)
      continue
    }
    let heldOutput = null
    let heldFd = null
    for (const fd of fds) {
      let target
      try {
        target = readlinkImpl(path.join(procDir, 'fd', fd.name))
      } catch {
        // An unreadable unrelated descriptor is not evidence about a task output.
        continue
      }
      if (outputs.has(target)) {
        try {
          const writable = writableFd(String(readFileImpl(path.join(procDir, 'fdinfo', fd.name), 'utf8')))
          if (writable === null) unknowns.push('process fd mode unreadable')
          if (writable) {
            heldOutput = target
            heldFd = fd.name
            break
          }
        } catch (error) {
          if (!missing(error)) unknowns.push('process fd unreadable')
        }
      }
    }
    if (!heldOutput) continue
    try {
      const environment = String(readFileImpl(path.join(procDir, 'environ'))).split('\0')
      const argv = String(readFileImpl(path.join(procDir, 'cmdline')))
      const after = processStartTime(String(readFileImpl(path.join(procDir, 'stat'), 'utf8')))
      if (!after || after !== before) {
        unknowns.push('background task process identity changed')
        continue
      }
      if (!environment.includes(`CLAUDE_CODE_SESSION_ID=${sessionId}`)) continue
      if (argv === '') {
        unknowns.push('background task argv unreadable')
        continue
      }
      if (pluginMonitorArgv(argv)) continue
      const finalTarget = readlinkImpl(path.join(procDir, 'fd', heldFd))
      const finalWritable = writableFd(String(readFileImpl(path.join(procDir, 'fdinfo', heldFd), 'utf8')))
      if (finalTarget !== heldOutput || finalWritable !== true) {
        unknowns.push('background task fd identity changed')
        continue
      }
      const finalStart = processStartTime(String(readFileImpl(path.join(procDir, 'stat'), 'utf8')))
      if (!finalStart || finalStart !== before) {
        unknowns.push('background task process identity changed')
        continue
      }
      return { status: 'in-flight', reason: `session background task ${path.basename(heldOutput, '.output')} held by pid ${pid}` }
    } catch (error) {
      if (!missing(error)) unknowns.push('background task attribution unreadable')
    }
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
    const dir = path.join(worktree, '.lane', 'supervision')
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
  return unknowns.length
    ? { status: 'unknown', reason: backgroundTaskUnsupported ? `${unknowns[0]}; ${BACKGROUND_TASK_UNSUPPORTED}` : unknowns[0] }
    : { status: 'none', reason: 'no live owned lane' }
}
