import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { artifactStateDir, pidAlive } from './artifact-server.mjs'
import { currentPidNamespace, pidNamespaceHasProcesses, processStartTime } from './host/pid-namespace.mjs'
import { insideChildUserNamespace } from './host/lane-sandbox.mjs'
import { heartbeatTicket, queuedTickets, readTicket, removeDirectoryOlderThan, removeTicket, takeTicket } from './host/suite-lock-queue.mjs'
import { connectSuiteLockBroker, createSuiteLockLeaseId } from './host/suite-lock-host.mjs'

export const DEFAULT_SUITE_LOCK_WAIT_S = 2700
export const DEFAULT_SUITE_LOCK_STALE_S = 10_800

// processStartTime (host perimeter) is recorded beside the PID so a reused PID does not read as the
// same holder: a live process with that PID but a different start time is a DIFFERENT process, and
// the lock is stale (M4 "dead locks kept", LOW 7).

function abortError() {
  const error = new Error('suite lock acquisition aborted')
  error.code = 'ABORT_ERR'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const timer = setTimeout(done, ms)
    function done() { signal?.removeEventListener?.('abort', aborted); resolve() }
    function aborted() { clearTimeout(timer); signal?.removeEventListener?.('abort', aborted); reject(abortError()) }
    signal?.addEventListener?.('abort', aborted, { once: true })
  })
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
    // Inside a sandbox the host holder is invisible: it can only be reclaimed once genuinely stuck,
    // within the SAME window the caller is willing to wait (no 45-min/3-hour mismatch).
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

// A lock.d with no readable holder.json is a writer that died between mkdir and publish: the
// holder is written immediately after mkdir, so after this grace nobody is behind it.
const UNPUBLISHED_HOLDER_GRACE_MS = 30_000

function holderIsStale(lock, options = {}) {
  if (!lock.held) return false
  if (!lock.holder) return lock.ageMs !== null && lock.ageMs >= UNPUBLISHED_HOLDER_GRACE_MS
  if (!Number.isSafeInteger(lock.holder.pid) || lock.holder.pid <= 0) return false
  const platform = platformOf(options)
  const staleMs = positiveSeconds(options.staleS ?? DEFAULT_SUITE_LOCK_STALE_S, '--stale-s') * 1000
  const waitMs = positiveSeconds(options.waitS ?? DEFAULT_SUITE_LOCK_WAIT_S, '--wait-s') * 1000
  // A sandboxed reader that cannot see the host holder reclaims within its own wait window, not
  // after a longer bound it would never reach.
  const foreign = foreignNamespaceStale(lock, options, Math.min(staleMs, waitMs))
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
function reclaimStaleHolder(root, lockDir, options) {
  const reclaimDir = path.join(root, 'reclaim.d')
  let ownsReclaim = false
  try {
    mkdirSync(reclaimDir)
    ownsReclaim = true
    const confirmed = readSuiteLock({ root })
    if (!holderIsStale(confirmed, options)) return false
    rmSync(lockDir, { recursive: true, force: true })
    return true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    removeDirectoryOlderThan(reclaimDir, RECLAIM_DIR_STALE_MS)
    return false
  } finally {
    if (ownsReclaim) rmSync(reclaimDir, { recursive: true, force: true })
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

export async function acquireSuiteLock(options = {}) {
  const env = options.env ?? process.env
  // Inside a lane sandbox the host lock directory is not writable: the host-side broker takes the
  // lock for this process and holds it while the connection stays open (host/lane-suite-lock-broker.mjs).
  const broker = typeof env.WT_SUITE_LOCK_BROKER === 'string' ? env.WT_SUITE_LOCK_BROKER.trim() : ''
  if (broker) return acquireBrokerSuiteLock(broker, options)
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
  const ticket = takeTicket(queueDir, record)

  try {
    while (true) {
      throwIfAborted(options.signal)
      heartbeatTicket(queueDir, ticket, record)
      const place = queuePlace(queueDir, ticket, options)
      if (place.ahead === 0) {
        const holder = { ...record, leaseId: createSuiteLockLeaseId(), startedAt: options.startedAt ?? new Date().toISOString() }
        if (tryTakeLock(lockDir, holder)) {
          const lease = { root, lockDir, holder }
          // An abort that lands during the publish never leaves a lock behind.
          if (options.signal?.aborted) { releaseSuiteLock(lease); throw abortError() }
          return lease
        }
      }

      const current = readSuiteLock({ root })
      // First in line and the holder released between my attempt and this read: try again now.
      if (place.ahead === 0 && !current.held) continue
      if (current.held && holderIsStale(current, options) && reclaimStaleHolder(root, lockDir, options)) continue
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
      await sleep(Math.min(delay, Math.max(1, waitMs - (now - startedWaiting))), options.signal)
    }
  } finally {
    removeTicket(queueDir, ticket)
  }
}

function acquireBrokerSuiteLock(socketPath, options) {
  const waitS = positiveSeconds(options.waitS ?? DEFAULT_SUITE_LOCK_WAIT_S, '--wait-s')
  return new Promise((resolve, reject) => {
    const socket = connectSuiteLockBroker(socketPath)
    let buffer = ''
    let settled = false
    let released = false
    let resolveLost
    const lost = new Promise((done) => { resolveLost = done })
    const fail = (error) => {
      if (settled) {
        if (!released) resolveLost()
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      const timeout = new Error(`timed out waiting for suite lock broker ${socketPath}`)
      timeout.code = 'WT_SUITE_LOCK_TIMEOUT'
      socket.destroy(); fail(timeout)
    }, waitS * 1000)
    const abort = () => { socket.destroy(); fail(abortError()) }
    options.signal?.addEventListener?.('abort', abort, { once: true })
    socket.once('connect', () => socket.write(`${JSON.stringify({ argv: options.argv ?? process.argv, waitS })}\n`))
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (line.startsWith('wait ')) options.onWait?.(line.slice(5))
        else if (line.startsWith('error ')) { socket.destroy(); fail(new Error(`suite lock broker ${socketPath}: ${line.slice(6)}`)) }
        else if (line.startsWith('granted ') && !settled) {
          settled = true; clearTimeout(timer); options.signal?.removeEventListener?.('abort', abort)
          resolve({ broker: socketPath, socket, holder: { leaseId: line.slice(8) }, lost, markReleased: () => { released = true } })
        }
      }
    })
    socket.once('error', (error) => fail(new Error(`suite lock broker ${socketPath}: ${error.message}`)))
    socket.once('close', () => { if (!settled) fail(new Error(`suite lock broker ${socketPath} closed before granting`)); else if (!released) resolveLost() })
    throwIfAborted(options.signal)
  })
}

export function releaseSuiteLock(lease) {
  if (lease?.broker) {
    lease.markReleased?.()
    if (!lease.socket.destroyed) lease.socket.end()
    return true
  }
  const current = readSuiteLock({ root: lease.root })
  if (!current.held) return true
  // leaseId identifies ONE acquisition; pid + startedAt is the rule for holders written by older copies.
  const same = current.holder?.leaseId && lease.holder?.leaseId
    ? current.holder.leaseId === lease.holder.leaseId
    : current.holder?.pid === lease.holder.pid && current.holder?.startedAt === lease.holder.startedAt
  if (!same) return false
  rmSync(lease.lockDir, { recursive: true, force: true })
  return true
}

export function operatorReleaseSuiteLock(options = {}) {
  const current = readSuiteLock(options)
  if (!current.held) return { released: false, reason: 'free', holder: null }
  if (!options.force && !holderIsStale(current, options)) return { released: false, reason: 'live', holder: current.holder }
  rmSync(current.lockDir, { recursive: true, force: true })
  return { released: true, reason: options.force ? 'forced' : 'stale', holder: current.holder }
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
