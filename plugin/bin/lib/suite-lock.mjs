import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { artifactStateDir, pidAlive } from './artifact-server.mjs'
import { currentPidNamespace, pidNamespaceHasProcesses, processStartTime } from './host/pid-namespace.mjs'
import { insideChildUserNamespace } from './host/lane-sandbox.mjs'
import { connectSuiteLockBroker, createSuiteLockLeaseId, removeStaleSuiteLockReclaim } from './host/suite-lock-host.mjs'

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

export function suiteLockDir(env = process.env, home = homedir(), platform = process.platform) {
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

function holderIsStale(lock, options = {}) {
  if (!lock.held) return false
  if (!lock.holder) return lock.ageMs !== null && lock.ageMs >= 30_000
  if (!Number.isSafeInteger(lock.holder.pid) || lock.holder.pid <= 0) return false
  const platform = options.platform ?? process.platform
  const staleMs = positiveSeconds(options.staleS ?? DEFAULT_SUITE_LOCK_STALE_S, '--stale-s') * 1000
  const waitMs = positiveSeconds(options.waitS ?? DEFAULT_SUITE_LOCK_WAIT_S, '--wait-s') * 1000
  // A sandboxed reader that cannot see the host holder reclaims within its own wait window, not
  // after a longer bound it would never reach.
  const foreign = foreignNamespaceStale(lock, options, Math.min(staleMs, waitMs))
  if (foreign !== null) return foreign
  if (!pidAlive(lock.holder.pid)) return true
  // A live PID that is a DIFFERENT process (PID reuse) is stale: the recorded start time no longer
  // matches. Only checked on the host, where /proc start times are comparable.
  if (platform !== 'win32' && Number.isFinite(lock.holder.startTime)) {
    const start = (options.processStartTime ?? processStartTime)(lock.holder.pid)
    if (start !== null && start !== lock.holder.startTime) return true
  }
  // Windows signalability does not prove process identity: after this conservative age bound,
  // reclaiming avoids a recycled PID making a crashed holder permanent. POSIX never uses age alone.
  return platform === 'win32' && lock.ageMs !== null && lock.ageMs >= staleMs
}

export function formatSuiteLockHolder(holder) {
  if (!holder) return 'holder unknown'
  const clean = (value) => {
    const text = String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '')
    return text.length > 80 ? `${text.slice(0, 80)}…` : text
  }
  const argv = Array.isArray(holder.argv) ? holder.argv.slice(0, 2).map(clean).join(' ') : 'unknown command'
  const started = new Date(holder.startedAt)
  const since = Number.isNaN(started.valueOf())
    ? 'unknown time'
    : started.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `holder pid ${Number.isSafeInteger(holder.pid) ? holder.pid : 'unknown'} (${argv}) since ${since}`
}

export async function acquireSuiteLock(options = {}) {
  const env = options.env ?? process.env
  const broker = typeof env.WT_SUITE_LOCK_BROKER === 'string' ? env.WT_SUITE_LOCK_BROKER.trim() : ''
  if (broker) return acquireBrokerSuiteLock(broker, options)
  const root = options.root ?? suiteLockDir(env, options.home, options.platform)
  const lockDir = path.join(root, 'lock.d')
  const reclaimDir = path.join(root, 'reclaim.d')
  const waitMs = positiveSeconds(options.waitS ?? DEFAULT_SUITE_LOCK_WAIT_S, '--wait-s') * 1000
  const pollMs = options.pollMs ?? 2000
  const noticeMs = options.noticeMs ?? 30_000
  const startedWaiting = Date.now()
  let nextNoticeAt = startedWaiting
  mkdirSync(root, { recursive: true, mode: 0o700 })

  while (true) {
    options.onLoop?.()
    throwIfAborted(options.signal)
    try {
      mkdirSync(lockDir)
      const holder = {
        leaseId: createSuiteLockLeaseId(),
        pid: process.pid,
        argv: options.argv ?? process.argv,
        cwd: options.cwd ?? process.cwd(),
        startedAt: options.startedAt ?? new Date().toISOString(),
        platform: options.platform ?? process.platform,
        pidNamespace: options.pidNamespace ?? currentPidNamespace(),
        startTime: options.startTime ?? processStartTime(process.pid),
      }
      try {
        writeFileSync(path.join(lockDir, 'holder.json'), `${JSON.stringify(holder, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        throwIfAborted(options.signal)
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true })
        throw error
      }
      return { root, lockDir, holder }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    let current = readSuiteLock({ root })
    removeStaleSuiteLockReclaim(reclaimDir)
    if (!current.held) { await retryWait(); continue }
    if (holderIsStale(current, options)) {
      let ownsReclaim = false
      try {
        mkdirSync(reclaimDir)
        ownsReclaim = true
        const confirmed = readSuiteLock({ root })
        if (holderIsStale(confirmed, options)) rmSync(lockDir, { recursive: true, force: true })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      } finally {
        if (ownsReclaim) rmSync(reclaimDir, { recursive: true, force: true })
      }
      await retryWait()
      continue
    }
    await retryWait(current)

    async function retryWait(observed = current) {
      throwIfAborted(options.signal)
      const now = Date.now()
      if (now - startedWaiting >= waitMs) {
        const timeout = new Error(`timed out waiting for suite lock: ${formatSuiteLockHolder(observed?.holder)}`)
        timeout.code = 'WT_SUITE_LOCK_TIMEOUT'
        timeout.holder = observed?.holder ?? null
        throw timeout
      }
      if (observed?.held && now >= nextNoticeAt) {
        options.onWait?.(`waiting for suite lock: ${formatSuiteLockHolder(observed.holder)}`)
        nextNoticeAt = now + noticeMs
      }
      await sleep(Math.min(pollMs, Math.max(1, waitMs - (now - startedWaiting))), options.signal)
    }
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
      if (settled) { if (!released) resolveLost(); return }
      settled = true; clearTimeout(timer); reject(error)
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
