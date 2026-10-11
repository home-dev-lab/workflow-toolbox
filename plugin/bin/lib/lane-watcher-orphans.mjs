import path from 'node:path'
import { signalProcess } from './host/process-signal-boundary.mjs'
import { createProcfs, DEFAULT_PROC_ROOT } from './host/procfs.mjs'

const WATCHER = 'wt-lane-orphan-watch.mjs'
const DELETED_SUFFIX = ' (deleted)'

function watcherArgv(procfs, pid) {
  try {
    const argv = procfs.readCommandLine(pid).toString().split('\0').filter(Boolean)
    return argv.some((part) => path.basename(part) === WATCHER) ? argv : null
  } catch {
    return null
  }
}

function inspectWatcher(procRoot, pid) {
  const procfs = createProcfs({ root: procRoot, platform: 'linux' })
  const argv = watcherArgv(procfs, pid)
  if (!argv) return null
  let ppid = null
  let startTime = null
  let cwd = null
  try {
    const stat = procfs.readProcessStat(pid, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    ppid = Number(fields[1])
    startTime = Number(fields[19])
    if (!Number.isSafeInteger(ppid) || !Number.isFinite(startTime)) throw new Error('invalid stat')
  } catch {
    return { pid, argv, ppid: null, startTime: null, cwd: null, reason: 'process identity unreadable; no signal sent' }
  }
  try {
    cwd = procfs.readWorkingDirectory(pid)
  } catch {
    return { pid, argv, ppid, startTime, cwd: null, reason: 'cwd unreadable; no signal sent' }
  }
  return { pid, argv, ppid, startTime, cwd }
}

function sameCandidate(expected, actual) {
  return Boolean(actual
    && expected.pid === actual.pid
    && expected.ppid === actual.ppid
    && expected.startTime === actual.startTime
    && expected.cwd === actual.cwd
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv))
}

export function detectOrphanWatchers({ procRoot = DEFAULT_PROC_ROOT, platform = process.platform, selfPid = process.pid } = {}) {
  const procfs = createProcfs({ root: procRoot, platform })
  if (platform !== 'linux' || !procfs.rootExists()) {
    return { status: 'unavailable', reason: 'watcher orphan detection unavailable on this platform: /proc required', orphans: [], reports: [] }
  }
  const orphans = []
  const reports = []
  let entries
  try { entries = procfs.listProcesses({ withFileTypes: true }) } catch {
    return { status: 'unavailable', reason: 'watcher orphan detection unavailable on this platform: /proc required', orphans, reports }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    if (pid === selfPid) continue
    const row = inspectWatcher(procRoot, pid)
    if (!row) continue
    if (row.reason) {
      reports.push(row)
      continue
    }
    if (!row.cwd.endsWith(DELETED_SUFFIX)) continue
    if (row.ppid === 1) orphans.push(row)
    else reports.push({ ...row, reason: `deleted cwd but ppid=${row.ppid}, not init; no signal sent` })
  }
  return { status: 'known', orphans, reports }
}

function signalVerifiedOrphan(candidate, current, kill, killed, detected) {
  if (!sameCandidate(candidate, current) || current.ppid !== 1 || !current.cwd.endsWith(DELETED_SUFFIX)) return
  try {
    kill(candidate.pid, 'SIGTERM')
    killed.push(candidate.pid)
  } catch (error) {
    if (error?.code !== 'ESRCH') detected.reports.push({ ...candidate, reason: `exact-PID SIGTERM failed: ${error?.code ?? String(error)}` })
  }
}

export function terminateOrphanWatchers({ procRoot = DEFAULT_PROC_ROOT, platform = process.platform, selfPid = process.pid, candidates = null, kill = signalProcess } = {}) {
  const detected = detectOrphanWatchers({ procRoot, platform, selfPid })
  if (detected.status !== 'known') return { ...detected, killed: [] }
  const selected = candidates ?? detected.orphans
  const killed = []
  for (const candidate of selected) {
    const current = inspectWatcher(procRoot, candidate.pid)
    signalVerifiedOrphan(candidate, current, kill, killed, detected)
  }
  return { ...detected, orphans: selected, killed }
}
