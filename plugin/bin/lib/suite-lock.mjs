import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { artifactStateDir, pidAlive } from './artifact-server.mjs'
import { currentPidNamespace, pidNamespaceHasProcesses, processStartTime } from './host/pid-namespace.mjs'
import { insideChildUserNamespace } from './host/lane-sandbox.mjs'
import { discardDirectory, heartbeatTicket, putLockBack, queuedTickets, readHolderIn, readTicket, removeDirectoryOlderThan, removeTicket, setLockAside, takeTicket } from './host/suite-lock-queue.mjs'

export const DEFAULT_SUITE_LOCK_WAIT_S = 2700
export const DEFAULT_SUITE_LOCK_STALE_S = 10_800

// processStartTime (host perimeter) is recorded beside the PID so a reused PID does not read as the
// same holder: a live process with that PID but a different start time is a DIFFERENT process, and
// the lock is stale (M4 "dead locks kept", LOW 7).

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveSeconds(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number of seconds`)
  return number
}

function suiteLockDir(env = process.env, home = homedir(), platform = process.platform) {
  if (typeof env.WT_SUITE_LOCK_DIR === 'string' && env.WT_SUITE_LOCK_DIR.length > 0) {
    return path.resolve(env.WT_SUITE_LOCK_DIR)
  }
  return path.join(path.dirname(artifactStateDir(env, home, platform)), 'wt-suite-lock')
}

export function readSuiteLock(options = {}) {
  const root = options.root ?? suiteLockDir(options.env, options.home, options.platform)
  const lockDir = path.join(root, 'lock.d')
  let holder = null
  let ageMs
  try { holder = JSON.parse(readFileSync(path.join(lockDir, 'holder.json'), 'utf8')) } catch { /* writer may still be publishing */ }
  try { ageMs = Date.now() - statSync(lockDir).mtimeMs } catch (error) {
    if (error?.code === 'ENOENT') return { held: false, root, lockDir, holder: null, ageMs: null }
    throw error
  }
  return { held: true, root, lockDir, holder, ageMs }
}

// A holder recorded in ANOTHER PID namespace cannot be judged by its PID number, which is
// namespace-local. Whether I am the one inside a sandbox is read MECHANICALLY from the user
// namespace map (insideChildUserNamespace), never from an environment variable a child could lose
// (M4). Returns true (stale), false (live), or null (not a foreign-namespace case → fall through).
function foreignNamespaceStale(lock, options, reclaimMs) {
  const namespace = options.pidNamespace ?? currentPidNamespace()
  const holderNamespace = lock.holder.pidNamespace ?? null
  const iAmSandboxed = options.insideSandbox ?? insideChildUserNamespace()
  const foreign = namespace !== null && holderNamespace !== null && holderNamespace !== namespace
  if (!foreign && !(iAmSandboxed && holderNamespace === null)) return null
  if (iAmSandboxed) {
    // Inside a sandbox the host holder is invisible: it can only be reclaimed at the hard bound.
    return lock.ageMs !== null && lock.ageMs >= reclaimMs
  }
  // On the host, the holder's namespace is visible and empties when its sandbox ends. Reclaim only
  // when that namespace has NO processes; a reused inode that is populated reads as live.
  return (options.namespaceHasProcesses ?? pidNamespaceHasProcesses)(holderNamespace) === false
}

const platformOf = (options) => options.platform ?? process.platform

// Positive proof, from the PID alone, that the recorded process is gone: the PID is dead, or it is a
// DIFFERENT process (PID reuse: the recorded start time no longer matches; only on the host, where
// /proc start times are comparable).
function pidProvesGone(holder, options) {
  if (!pidAlive(holder.pid)) return true
  if (platformOf(options) === 'win32' || !Number.isFinite(holder.startTime)) return false
  const start = (options.processStartTime ?? processStartTime)(holder.pid)
  return start !== null && start !== holder.startTime
}

// A lock.d with no valid holder.json was left by an acquirer that died between `mkdir` and publishing
// its holder (a live one publishes within milliseconds): reclaimable once this old.
const HALF_CREATED_LOCK_MS = 60_000
// Windows refuses for a moment to remove an entry another process holds open (EPERM/EBUSY); `maxRetries`
// retries exactly those codes, and applies only with `recursive: true` (Node fs docs).
const REMOVE_WITH_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }

// Stale = positive proof the holder is gone, or, where its PID proves nothing (a host holder seen from
// inside a sandbox, a signalable PID on Windows), the hard bound --stale-s (3 h by default). Never the
// waiter's own --wait-s: a short-wait waiter reclaiming a live holder ran two suites at once.
function holderIsStale(lock, options = {}) {
  if (!lock.held) return false
  if (!Number.isSafeInteger(lock.holder?.pid) || lock.holder.pid <= 0) return lock.ageMs !== null && lock.ageMs >= HALF_CREATED_LOCK_MS
  const platform = platformOf(options)
  const staleMs = positiveSeconds(options.staleS ?? DEFAULT_SUITE_LOCK_STALE_S, '--stale-s') * 1000
  const foreign = foreignNamespaceStale(lock, options, staleMs)
  if (foreign !== null) return foreign
  if (pidProvesGone(lock.holder, options)) return true
  // Windows signalability does not prove process identity: after this conservative age bound,
  // reclaiming avoids a recycled PID making a crashed holder permanent. POSIX never uses age alone.
  return platform === 'win32' && lock.ageMs !== null && lock.ageMs >= staleMs
}

// A holder record is read from a file any local process can write, then printed on a terminal and
// into logs: control characters (escape sequences, newlines, C1, bidi overrides) are replaced and the
// command is capped, so a crafted argv cannot forge or hide a line.
const ARGV_DISPLAY_MAX = 80
// C0 and C1 controls, DEL, and the bidi marks/overrides/isolates that can reorder a terminal line.
const DISPLAY_UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
const displaySafe = (character) => {
  const code = character.codePointAt(0)
  return DISPLAY_UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high) ? '?' : character
}

function displayArgv(argv) {
  if (!Array.isArray(argv)) return 'unknown command'
  const text = argv.slice(0, 2).map((value) => Array.from(String(value), displaySafe).join('')).join(' ')
  return text.length > ARGV_DISPLAY_MAX ? `${text.slice(0, ARGV_DISPLAY_MAX - 3)}...` : text
}

export function formatSuiteLockHolder(holder) {
  if (!holder || typeof holder !== 'object') return 'holder unknown'
  const pid = Number.isSafeInteger(holder.pid) ? holder.pid : 'unknown'
  const started = new Date(holder.startedAt)
  const since = Number.isNaN(started.valueOf())
    ? 'unknown time'
    : started.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `holder pid ${pid} (${displayArgv(holder.argv)}) since ${since}`
}

// FIFO queue. Without it every waiter polled `mkdir lock.d` and the first poller after a release
// won, so a waiter asleep between polls starved behind arrivals that kept coming. Each waiter now
// takes a numbered ticket in queue.d (file layer: host/suite-lock-queue.mjs) and only the LOWEST live
// ticket may try to take the lock. A ticket is judged by the SAME rule as the holder (holderIsStale:
// pid, start time, pid namespace), its age read as the time since its last heartbeat.
const UNREADABLE_TICKET_GRACE_MS = 10_000
// The head of the queue polls fast: the hand-over after a release takes a tenth of a second, and a
// launcher from an older release, which takes no ticket and polls every two seconds, rarely gets in first.
const HEAD_OF_QUEUE_POLL_MS = 100

// A ticket is stale on SILENCE or on PROOF, never on the caller's own bounds. Silence: a live waiter
// refreshes its record at least every TICKET_HEARTBEAT_MAX_MS, so a record silent for
// TICKET_SILENCE_MS has nobody behind it, in every view (host, sandbox, Windows) and whatever a
// populated namespace suggests; no caller's --wait-s/--stale-s can shorten that. Proof: the holder's
// own namespace and PID evidence (foreignNamespaceStale with no age branch, pidProvesGone). A waiter
// that was merely suspended puts its record back under the same number.
const TICKET_SILENCE_MS = 120_000
const TICKET_HEARTBEAT_MAX_MS = TICKET_SILENCE_MS / 4

function ticketIsStale(ticket, options) {
  if (!Number.isSafeInteger(ticket.holder?.pid) || ticket.holder.pid <= 0) return ticket.ageMs >= UNREADABLE_TICKET_GRACE_MS
  if (ticket.ageMs >= TICKET_SILENCE_MS) return true
  const foreign = foreignNamespaceStale(ticket, options, Infinity)
  return foreign ?? pidProvesGone(ticket.holder, options)
}

// Reclaims dead tickets and returns my place: how many live tickets are ahead, and how many in all.
function queuePlace(queueDir, mine, options) {
  let ahead = 0
  let total = 0
  for (const number of queuedTickets(queueDir)) {
    if (number !== mine) {
      const ticket = readTicket(queueDir, number)
      if (!ticket) continue
      if (ticketIsStale(ticket, options)) {
        removeTicket(queueDir, number)
        continue
      }
      if (number < mine) ahead += 1
    }
    total += 1
  }
  return { ahead, total: Math.max(total, ahead + 1) }
}

function tryTakeLock(lockDir, holder) {
  try {
    mkdirSync(lockDir)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(path.join(lockDir, 'holder.json'), `${JSON.stringify(holder, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // Reclaimed as half-created while this acquirer was suspended: the lock is no longer mine, and the
    // lock.d now there may be someone else's.
    if (error?.code === 'ENOENT') return false
    rmSync(lockDir, { recursive: true, force: true })
    throw error
  }
  return true
}

// A reclaimer holds reclaim.d for a few milliseconds; one older than this was abandoned by a reclaimer
// that died inside the critical section, and is itself removed so the stale holder stays reclaimable.
const RECLAIM_DIR_STALE_MS = 60_000

// Returns true only when it removed the stale holder, so the caller retries at once; otherwise the
// caller's timeout check and sleep run (no spin behind another reclaimer's, or an abandoned, reclaim.d).
const sameInstance = (left, right) => (left === null || right === null)
  ? left === right
  : left?.pid === right?.pid && left?.startedAt === right?.startedAt

// Removes the lock instance judged stale and nothing newer: lock.d is renamed aside, and deleted only
// if the holder that moved is the one judged; a newer instance (a holder that acquired in between) is
// put back. `options.beforeReclaimRemoval` is a test seam that runs between judgment and removal.
function removeJudgedInstance(lockDir, judged, options) {
  options.beforeReclaimRemoval?.()
  const aside = setLockAside(lockDir)
  if (aside === null) return true
  if (sameInstance(readHolderIn(aside), judged)) {
    discardDirectory(aside)
    return true
  }
  putLockBack(aside, lockDir)
  return false
}

function reclaimStaleHolder(root, lockDir, options) {
  const reclaimDir = path.join(root, 'reclaim.d')
  let ownsReclaim = false
  try {
    mkdirSync(reclaimDir)
    ownsReclaim = true
    const confirmed = readSuiteLock({ root })
    if (!holderIsStale(confirmed, options)) return false
    return removeJudgedInstance(lockDir, confirmed.holder, options)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    removeDirectoryOlderThan(reclaimDir, RECLAIM_DIR_STALE_MS)
    return false
  } finally {
    if (ownsReclaim) rmSync(reclaimDir, REMOVE_WITH_RETRY)
  }
}

function waiterRecord(options) {
  return {
    pid: process.pid,
    argv: options.argv ?? process.argv,
    cwd: options.cwd ?? process.cwd(),
    startedAt: new Date().toISOString(),
    platform: options.platform ?? process.platform,
    pidNamespace: options.pidNamespace ?? currentPidNamespace(),
    startTime: options.startTime ?? processStartTime(process.pid),
  }
}

function describeWait(place, current) {
  const holder = current.held ? formatSuiteLockHolder(current.holder) : 'holder none (handing over)'
  return `position ${place.ahead + 1} of ${place.total}, ${holder}`
}

// Windows reports a file or directory that another process is deleting ("delete pending") as EPERM,
// EACCES or EBUSY instead of ENOENT/EEXIST, and the lock's hot path meets exactly that when a holder
// releases while waiters poll: an attempt that meets one is retried. One that persists for
// TRANSIENT_FS_WINDOW_MS is a real permission problem and is thrown.
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRANSIENT_FS_WINDOW_MS = 5000

async function retryTransient(operation, pauseMs) {
  const since = Date.now()
  while (true) {
    try {
      return operation()
    } catch (error) {
      if (!TRANSIENT_FS_CODES.has(error?.code) || Date.now() - since >= TRANSIENT_FS_WINDOW_MS) throw error
      await sleep(pauseMs)
    }
  }
}

// One poll of the queue: `{ lease }` when acquired, `{ again: true }` to poll again at once, or
// `{ place, current }` to wait.
function pollQueue(state, options) {
  const { root, lockDir, queueDir, ticket, record } = state
  heartbeatTicket(queueDir, ticket, record)
  const place = queuePlace(queueDir, ticket, options)
  if (place.ahead === 0) {
    const holder = { ...record, startedAt: new Date().toISOString() }
    if (tryTakeLock(lockDir, holder)) return { lease: { root, lockDir, holder } }
  }
  const current = readSuiteLock({ root })
  // First in line and the holder released between my attempt and this read: try again now.
  if (place.ahead === 0 && !current.held) return { again: true }
  // Only the head of the queue reclaims: it is also the only waiter that acquires next, so no other
  // ticket holder can create a lock.d between this judgment and the removal.
  if (place.ahead === 0 && current.held && holderIsStale(current, options) && reclaimStaleHolder(root, lockDir, options)) return { again: true }
  return { place, current }
}

export async function acquireSuiteLock(options = {}) {
  const env = options.env ?? process.env
  const root = options.root ?? suiteLockDir(env, options.home, options.platform)
  const lockDir = path.join(root, 'lock.d')
  const queueDir = path.join(root, 'queue.d')
  const waitMs = positiveSeconds(options.waitS ?? DEFAULT_SUITE_LOCK_WAIT_S, '--wait-s') * 1000
  const pollMs = options.pollMs ?? 2000
  const noticeMs = options.noticeMs ?? 30_000
  const startedWaiting = Date.now()
  let nextNoticeAt = startedWaiting
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const record = waiterRecord(options)
  const ticket = await retryTransient(() => takeTicket(queueDir, record), HEAD_OF_QUEUE_POLL_MS)
  const state = { root, lockDir, queueDir, ticket, record }

  try {
    while (true) {
      const step = await retryTransient(() => pollQueue(state, options), HEAD_OF_QUEUE_POLL_MS)
      if (step.lease) return step.lease
      if (step.again) continue
      const { place, current } = step
      const now = Date.now()
      if (now - startedWaiting >= waitMs) {
        const timeout = new Error(`timed out waiting for suite lock: ${formatSuiteLockHolder(current.holder)}`)
        timeout.code = 'WT_SUITE_LOCK_TIMEOUT'
        timeout.holder = current.holder
        throw timeout
      }
      if (now >= nextNoticeAt) {
        options.onWait?.(`waiting for suite lock: ${describeWait(place, current)}`)
        nextNoticeAt = now + noticeMs
      }
      const delay = Math.min(place.ahead === 0 ? HEAD_OF_QUEUE_POLL_MS : TICKET_HEARTBEAT_MAX_MS, pollMs)
      await sleep(Math.min(delay, Math.max(1, waitMs - (now - startedWaiting))))
    }
  } finally {
    removeTicket(queueDir, ticket)
  }
}

export function releaseSuiteLock(lease) {
  const current = readSuiteLock({ root: lease.root })
  if (!current.held) return true
  if (current.holder?.pid !== lease.holder.pid || current.holder?.startedAt !== lease.holder.startedAt) return false
  rmSync(lease.lockDir, REMOVE_WITH_RETRY)
  return true
}

export function operatorReleaseSuiteLock(options = {}) {
  const current = readSuiteLock(options)
  if (!current.held) return { released: false, reason: 'free', holder: null }
  if (options.force) {
    rmSync(current.lockDir, { recursive: true, force: true })
    return { released: true, reason: 'forced', holder: current.holder }
  }
  if (!holderIsStale(current, options)) return { released: false, reason: 'live', holder: current.holder }
  const removed = removeJudgedInstance(current.lockDir, current.holder, options)
  return removed ? { released: true, reason: 'stale', holder: current.holder } : { released: false, reason: 'live', holder: readSuiteLock(options).holder }
}

// Windows needs a SHELL only to launch a `.cmd`/`.bat` shim (spawning one directly fails EINVAL).
// Passing `shell: true` for every command instead re-parses the argv through cmd.exe, which mangles
// quotes: measured 2026-09-17 on the 0.182.0 tag run, `node -e 'process.stdout.write("ran")'` exited 1
// on windows-latest while ubuntu and macOS passed. So the shell is decided per EXECUTABLE, never per
// platform alone. A bare name with no extension is resolved against PATH/PATHEXT because that is how
// Windows finds `opencode` -> `opencode.cmd`; an unresolvable name returns false so spawn reports its
// own ENOENT instead of a shell swallowing it.
const WINDOWS_SHELL_EXTENSIONS = new Set(['.cmd', '.bat'])

function resolveWindowsExecutable(executable, options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? ((candidate) => { try { return statSync(candidate).isFile() } catch { return false } })
  const pathExt = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  if (String(executable).includes('/') || String(executable).includes('\\')) {
    for (const extension of pathExt) {
      const candidate = `${executable}${extension}`
      if (exists(candidate)) return candidate
    }
    return null
  }
  const searchPath = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  for (const directory of searchPath) {
    for (const extension of pathExt) {
      const candidate = path.join(directory, `${executable}${extension}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

export function spawnNeedsShell(executable, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return false
  const name = String(executable ?? '')
  if (!name) return false
  const extension = path.extname(name).toLowerCase()
  if (extension) return WINDOWS_SHELL_EXTENSIONS.has(extension)
  const resolved = options.resolve ? options.resolve(name) : resolveWindowsExecutable(name, options)
  return resolved ? WINDOWS_SHELL_EXTENSIONS.has(path.extname(resolved).toLowerCase()) : false
}

export function windowsShimArgumentRefusal(command, options = {}) {
  if (!Array.isArray(command) || !spawnNeedsShell(command[0], options)) return null
  const unsafe = command.slice(1).find((argument) => /[\r\n"%!^&|<>()]/.test(String(argument)))
  return unsafe === undefined ? null : `unsafe Windows shim argument refused because cmd.exe would re-parse it: ${JSON.stringify(String(unsafe))}`
}
