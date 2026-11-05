// Per-OS-user wt-lane launch admission across projects. Other scripts may acquire the same exported
// laneLaunchAdmissionLockPath() with acquireLaneAdmissionLock(), and must hold it from
// counting until their own opencode/codex PID is retained by countLaneProcessesReal.
// Linux: ~/.local/state/wt-lane-host/launch-admission.lock; macOS: ~/Library/Application
// Support/wt-lane-host/launch-admission.lock; Windows: %LOCALAPPDATA%/wt-lane-host/launch-admission.lock.
// No flock dependency: the create-exclusive file claim carries PID plus birth identity.
// Visibility: the reservation is released only once the worker has recorded its REAL lane spawn
// (childPid) and the counter sees that pid or a descendant of it (a sandbox wrapper). The worker's
// own preflight probes (`opencode --version`, `opencode debug skill`) are counted names too, so a
// counted descendant of the worker alone never proves the lane is running.
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
      if (initial.state === 'unknown') { visible = true; return }
      const deadline = options.clock() + options.visibilityMs
      for (;;) {
        const live = visibilityObservation(options, readPid)
        if (live.state === 'unknown') { warnUnknown(live); visible = true; return }
        if (live.visible) { visible = true; return }
        // A completed worker cannot later launch an uncounted lane. Very short commands
        // may finish between polls; retaining their reservation would serve no purpose.
        if (readTerminal() || (workerPid && options.workerFinished(workerPid))) { visible = true; return }
        if (options.clock() >= deadline) throw new Error(`wt-lane: new lane was not visible to the counter within ${options.visibilityMs}ms; worker cleanup: ${cleanup()}; retry the same wt-lane command after checking its launch log`)
        await delay(options.pollMs)
      }
    },
  }
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

function countedLaunch(pids, childPid, readProcesses) {
  if (!childPid) return { visible: false }
  if (pids.includes(childPid)) return { visible: true }
  const family = new Set([childPid])
  const snapshot = readAncestry(readProcesses)
  if (snapshot.state === 'unknown') return snapshot
  const rows = snapshot.processes
  let previousSize
  do {
    previousSize = family.size
    for (const row of rows) if (family.has(row.ppid)) family.add(row.pid)
  } while (family.size !== previousSize)
  return { visible: pids.some((pid) => family.has(pid)) }
}

function visibilityObservation(options, readPid) {
  const live = options.counter(LANE_PROCESS_NAMES)
  return live.state === 'unknown' ? { state: 'unknown', reason: live.reason } : countedLaunch(live.pids, readPid(), options.readProcesses)
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
  return { counter, clock: () => performance.now(), visibilityMs: VISIBILITY_MS, pollMs: 25,
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
