// Per-OS-user wt-lane launch admission across projects. Other scripts may acquire the same exported
// laneLaunchAdmissionLockPath() with acquireLaneAdmissionLock(), and must hold it from
// counting until their own opencode/codex PID is retained by countLaneProcessesReal, or apply the
// same explicit uncountable-child release policy described below.
// Linux: ~/.local/state/wt-lane-host/launch-admission.lock; macOS: ~/Library/Application
// Support/wt-lane-host/launch-admission.lock; Windows: %LOCALAPPDATA%/wt-lane-host/launch-admission.lock.
// No flock dependency: the create-exclusive file claim carries PID plus birth identity.
// Visibility: the recorded REAL lane spawn (childPid), or the same descendant behind its sandbox
// wrapper, must be retained on two consecutive polls. Counted worker preflight probes beside the
// recorded spawn never prove visibility. After 30s continuously without any named family process,
// a recorded child releases admission with a named warning, leaving the worker
// running. Named but lock-excluded family processes keep waiting. A grace shorter than the caller's
// visibility window extends a late child's deadline; an explicit window no longer than grace wins.
// Completed workers also release admission. Each launch released this way may run one lane above
// the cap for that lane's lifetime if it becomes named later; a never-named lane is never counted.
// Unknown-count policy: warn-and-admit under the mutex, with one NOT MEASURED line. A broken or
// missing counter must not block every lane (the saturation hook's policy). Windows has no counter
// here: every launch there prints `lane count NOT MEASURED` and the cap is NOT enforced.
// Residual: a launcher killed with SIGKILL after spawning its detached worker and before that lane
// is counted cannot release or record its reservation; the next launcher reclaims the dead claim and
// may admit one lane above the cap (at most one extra lane per launcher killed in that window).
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { countLaneProcessesReal, DEFAULT_MAX, LANE_PROCESS_NAMES } from '../wt-lane-saturation-core.mjs'
import { laneHostStateRoot } from './lane-host-dir.mjs'
import { hostAdapter } from './adapter.mjs'
import { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } from './lane-admission-lock.mjs'

export { acquireLaneAdmissionLock, releaseLaneLaunchAdmission }
export const LANE_LAUNCH_CAP = DEFAULT_MAX
// Worker preflight includes three 30s probes, the 30s cache wait, sandbox socket scans
// (10+30+90s per scan), process capture and a 60s spawn receipt. Allow startup under load.
const VISIBILITY_MS = 900_000
const UNCOUNTED_GRACE_MS = 30_000

export function laneLaunchAdmissionLockPath({ env = process.env, home, ...options } = {}) {
  // The helper's OS user-profile home, not a project-isolated HOME, owns this mutex.
  // Per-worktree WT_LANE_HOST_STATE overrides must never split it either.
  const root = laneHostStateRoot({ ...options, home, env: { ...env, WT_LANE_HOST_STATE: undefined }, insideSandbox: false })
  return join(root, 'launch-admission.lock')
}

function admissionLease(options, initial) {
  let workerPid = null
  let verifyWorker = () => false
  let visible = false
  let warned = false
  const warnUnknown = (live) => {
    if (!warned) options.warn(`wt-lane: lane count NOT MEASURED: ${live.reason}`)
    warned = true
  }
  if (initial.state === 'unknown') warnUnknown(initial)
  // One cleanup per launch: once it ran, tracking the same launch's worker again (the launcher's
  // finally does after a timeout throw) arms nothing, so no second stop and no second outcome.
  let cleaned = false
  const cleanup = () => {
    if (cleaned || !workerPid || visible) return 'no uncounted worker tracked by this launch; nothing stopped'
    cleaned = true
    return stopUncountedWorker(workerPid, verifyWorker, options)
  }
  return {
    trackWorker(pid, verify = () => false) { if (!cleaned) { workerPid = pid; verifyWorker = verify } },
    abort() {
      const outcome = cleanup()
      if (outcome.startsWith('NOT CONFIRMED')) options.warn(`wt-lane: admission worker cleanup ${outcome}`)
    },
    async waitUntilVisible(readPid, readTerminal = () => false) {
      if (visible || initial.state === 'unknown') { visible = true; return }
      const waiting = visibilityWait(options)
      for (;;) {
        const live = visibilityObservation(options, readPid)
        if (live.state === 'unknown') { warnUnknown(live); visible = true; return }
        const status = waiting.observe(live)
        if (status.visible) { visible = true; return }
        // A completed worker cannot later launch an uncounted lane. Very short commands
        // may finish between polls; retaining their reservation would serve no purpose.
        if (visibilityTerminal(readTerminal, workerPid, options)) { visible = true; return }
        if (status.uncounted) { visible = true; options.warn(uncountedWarning(status.childPid, options.uncountedGraceMs)); return }
        if (status.expired) throw new Error(`wt-lane: new lane was not visible to the counter within ${options.visibilityMs}ms; worker cleanup: ${cleanup()}; retry the same wt-lane command after checking its launch log`)
        await delay(options.pollMs)
      }
    },
  }
}

function visibilityTerminal(readTerminal, workerPid, options) {
  return readTerminal() || (workerPid && options.workerFinished(workerPid))
}

function visibilityWait(options) {
  let deadline = options.clock() + options.visibilityMs
  const graceEnabled = options.uncountedGraceMs < options.visibilityMs
  const child = { pid: null, childSeenAt: null, unnamedSince: null, previous: new Set() }
  let confirmationAllowed = true
  return {
    observe(live) {
      const now = options.clock()
      const replaced = observeChild(child, live, now)
      if (replaced && graceEnabled) deadline = Math.max(deadline, child.childSeenAt + options.uncountedGraceMs)
      const visible = live.namedPids.some((pid) => child.previous.has(pid))
      child.previous = new Set(live.namedPids)
      let expired = now >= deadline
      if (expired && !visible && live.namedPids.length > 0 && confirmationAllowed) {
        confirmationAllowed = false
        expired = false
      }
      return { visible, childPid: child.pid, expired,
        uncounted: graceEnabled && child.unnamedSince !== null && now - child.unnamedSince >= options.uncountedGraceMs }
    },
  }
}

function observeChild(child, live, now) {
  const replaced = Boolean(live.childPid && live.childPid !== child.pid)
  if (replaced) {
    child.pid = live.childPid
    child.childSeenAt = now
    child.unnamedSince = null
    child.previous = new Set()
  }
  if (!live.childPid) child.previous = new Set()
  if (!live.childPid || live.familyNamed) child.unnamedSince = null
  else if (child.unnamedSince === null) child.unnamedSince = now
  return replaced
}

function uncountedWarning(childPid, graceMs) {
  return `wt-lane: lane child pid ${childPid} is not countable: no ${LANE_PROCESS_NAMES.join('/')} process in its family for ${Math.round(graceMs / 1000)}s; admission released; this lane is NOT counted against the cap of ${LANE_LAUNCH_CAP}`
}

// Returns the cleanup outcome actually observed. `ended` means the platform accepted the
// force-stop (a group SIGKILL or taskkill /F); the worker's exit itself is not observed here.
function stopUncountedWorker(pid, verifyWorker, options) {
  if (!verifyWorker()) return 'NOT CONFIRMED: identity changed or not measured'
  const result = options.stopWorker(pid)
  if (result.status !== 'ended') return `NOT CONFIRMED: ${result.reason ?? result.status}`
  return `ended (force-stop of worker pid ${pid} accepted; its exit was not observed)`
}

function workerFinished(pid) {
  if (hostAdapter.readProcessExecutionState(pid).status !== 'gone') return false
  return hostAdapter.platform === 'win32' || hostAdapter.readProcessGroupLiveness(pid).status === 'gone'
}

// Only the worker's recorded lane spawn (childPid) proves visibility: the counted pid itself, or a
// counted process descending from it (the bwrap wrapper case). Never a descendant of the worker alone.
function readAncestry(readProcesses) {
  try {
    const snapshot = readProcesses()
    const processes = snapshot?.processes
    if (snapshot?.supported === false || !Array.isArray(processes)) return { state: 'unknown', reason: snapshot?.reason ?? 'process ancestry snapshot unavailable' }
    return { processes }
  } catch (error) { return { state: 'unknown', reason: error?.message ?? String(error) } }
}

function countedLaunch(pids, childPid, readProcesses, excluded) {
  if (!childPid) return { namedPids: [], familyNamed: false }
  const family = new Set([childPid])
  const snapshot = readAncestry(readProcesses)
  if (snapshot.state === 'unknown') return snapshot
  const rows = snapshot.processes
  let previousSize
  do {
    previousSize = family.size
    for (const row of rows) if (family.has(row.ppid)) family.add(row.pid)
  } while (family.size !== previousSize)
  const namedPids = pids.filter((pid) => family.has(pid))
  return { namedPids, familyNamed: namedPids.length > 0 || excluded.some(({ pid }) => family.has(pid)) }
}

function visibilityObservation(options, readPid) {
  const live = options.counter(LANE_PROCESS_NAMES)
  if (live.state === 'unknown') return { state: 'unknown', reason: live.reason }
  const pids = live.pids
  const childPid = readPid()
  return { childPid, ...countedLaunch(pids, childPid, options.readProcesses, live.excluded ?? []) }
}

function releaseOnExit(claim, abort) {
  const exit = () => { try { abort() } finally { releaseLaneLaunchAdmission(claim) } }
  const signals = new Map([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129], ['SIGQUIT', 131]])
  if (process.platform === 'win32') signals.delete('SIGQUIT')
  const handlers = [...signals].map(([signal, code]) => [signal, () => { try { exit() } finally { process.exit(code) } }])
  const detach = () => {
    process.removeListener('exit', exit)
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  try {
    process.once('exit', exit)
    for (const [signal, handler] of handlers) process.once(signal, handler)
  } catch (error) { detach(); throw error }
  return detach
}

function admissionOptions(options) {
  const platform = options.platform ?? process.platform
  const counter = platform === 'win32'
    ? () => ({ state: 'unknown', reason: 'pgrep is unavailable on win32' }) : countLaneProcessesReal
  return { counter, clock: () => performance.now(), visibilityMs: VISIBILITY_MS, uncountedGraceMs: UNCOUNTED_GRACE_MS, pollMs: 25,
    readProcesses: () => hostAdapter.readProcessSnapshot(),
    stopWorker: (pid) => hostAdapter.forceEndProcessFamily(pid),
    workerFinished,
    lockPath: options.lockPath ?? laneLaunchAdmissionLockPath({ platform }), warn: (line) => process.stderr.write(`${line}\n`), ...options }
}

export async function withLaneLaunchAdmission(launch, options = {}) {
  const resolved = admissionOptions(options)
  const claim = await acquireLaneAdmissionLock(resolved.lockPath, resolved)
  let lease
  let detach = () => {}
  try {
    detach = releaseOnExit(claim, () => lease?.abort())
    const live = resolved.counter(LANE_PROCESS_NAMES)
    if (live.state === 'ok' && live.count >= LANE_LAUNCH_CAP) {
      resolved.warn(`wt-lane: Refused: ${live.count} lanes live, cap ${LANE_LAUNCH_CAP}; wait for a lane to exit, then retry the same wt-lane command`)
      return 1
    }
    lease = admissionLease(resolved, live)
    return await launch(lease)
  } finally {
    try { lease?.abort() } finally {
      try { detach() } finally { releaseLaneLaunchAdmission(claim) }
    }
  }
}
