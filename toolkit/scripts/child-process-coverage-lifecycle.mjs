import { execFileSync } from 'node:child_process'
import { constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OWNER_FILE = '.owner' // Not .json: readIncludedResults must never parse this as V8 output.
const OWNERLESS_MAX_AGE_MS = 60 * 60 * 1000
const instruments = new Set()
const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']
const handlers = new Map(signals.map((signal) => [signal, () => onSignal(signal)]))

function linuxIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (['Z', 'X'].includes(fields[0])) return { dead: true, identity: null }
  if (!/^\d+$/.test(fields[19] ?? '')) return { dead: false, identity: null }
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  return { dead: false, identity: `linux:${boot}:${fields[19]}` }
}

function processIdentity(pid) {
  try {
    if (process.platform === 'linux') return linuxIdentity(pid)
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      const start = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim()
      return { dead: false, identity: /^\d+$/.test(start) ? `win32:${start}` : null }
    }
  } catch {
    // Permission failures, missing utilities and unsupported hosts are unknown,
    // never evidence that a potentially live owner can safely be removed.
  }
  // In particular, macOS ps exposes only whole-second start times: it cannot
  // prove a PID incarnation. Keep a live PID as unknown rather than guessing.
  return { dead: false, identity: null }
}

function validOwner(owner) {
  if (!owner || owner.version !== 1) return false
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2 ** 31 - 1) return false
  return owner.identity === null || typeof owner.identity === 'string'
}

function readOwner(directory) {
  try {
    const path = resolve(directory, OWNER_FILE)
    if (!lstatSync(path).isFile()) return undefined
    const flag = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    const owner = JSON.parse(readFileSync(path, { encoding: 'utf8', flag }))
    return validOwner(owner) ? owner : undefined
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined
  }
}

function ownerIsDead(owner) {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return true
    // EPERM: the pid exists under another user, possibly a reuse; its identity still decides.
    if (error.code !== 'EPERM') return false
  }
  const current = processIdentity(owner.pid)
  if (current.dead) return true
  if (owner.identity === null || current.identity === null) return false
  return owner.identity !== current.identity
}

function removeStaleDirectory(directory, now) {
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    const owner = readOwner(directory)
    if (owner === undefined) return // Unreadable/malformed metadata is unknown, not ownerless.
    const stale = owner ? ownerIsDead(owner) : now - stat.mtimeMs > OWNERLESS_MAX_AGE_MS
    if (stale) rmSync(directory, { recursive: true, force: true })
  } catch {
    // Another initializer can have collected this same orphan already.
    // Unreadable directories remain untouched; sweeping must not break a run.
  }
}

function prepareParent(root) {
  const parent = resolve(root, '.lane')
  mkdirSync(parent, { recursive: true })
  const stat = lstatSync(parent)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Child coverage .lane must be a directory, not a symlink')
  const now = Date.now()
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('child-coverage-')) removeStaleDirectory(resolve(parent, entry.name), now)
  }
  return parent
}

// The signal handler is installed only while no other listener exists for that signal, so it
// emulates the default action and never competes with an application or a library that itself
// re-raises only as the sole listener (signal-exit): two such listeners would each defer to the
// other and the signal would be swallowed.
function installIfAlone(signal) {
  if (instruments.size > 0 && process.listenerCount(signal) === 0) process.on(signal, handlers.get(signal))
}

function yieldToNewListener(event, listener) {
  if (!handlers.has(event) || listener === handlers.get(event)) return
  // Removing now would drop the count to zero before the new listener is added, and Node would
  // stop watching the signal; remove once the newcomer is in place.
  queueMicrotask(() => {
    if (process.listenerCount(event) > 1) process.removeListener(event, handlers.get(event))
  })
}

function reclaimAfterRemoval(event, listener) {
  if (handlers.has(event) && listener !== handlers.get(event)) installIfAlone(event)
}

function attachHooks() {
  if (instruments.size !== 1) return
  process.prependListener('exit', cleanupAll)
  for (const signal of handlers.keys()) installIfAlone(signal)
  process.on('newListener', yieldToNewListener)
  process.on('removeListener', reclaimAfterRemoval)
}

function detachHooks() {
  if (instruments.size !== 0) return
  process.removeListener('newListener', yieldToNewListener)
  process.removeListener('removeListener', reclaimAfterRemoval)
  process.removeListener('exit', cleanupAll)
  for (const [signal, handler] of handlers) process.removeListener(signal, handler)
}

function cleanupAll() {
  // Nested instruments restore their environment in reverse registration order.
  for (const instrument of [...instruments].reverse()) {
    try {
      disableChildProcessCoverage(instrument)
    } catch {
      // Cleanup failures must not replace an exit code or a signal's outcome.
    }
  }
}

function onSignal(signal) {
  // Backstop for the instant between a newcomer's registration and the microtask that withdraws
  // this handler: an application-owned handler keeps its semantics, including continuing to run.
  const handled = process.rawListeners(signal).some((listener) => listener !== handlers.get(signal))
  if (handled) return // Graceful handlers may still need to generate/report coverage before exit.
  cleanupAll()
  process.kill(process.pid, signal)
}

export function enableChildProcessCoverage(root, env = process.env) {
  const parent = prepareParent(root)
  const directory = mkdtempSync(resolve(parent, 'child-coverage-'))
  try {
    const owner = { version: 1, pid: process.pid, identity: processIdentity(process.pid).identity }
    const temporary = resolve(directory, `${OWNER_FILE}.tmp`)
    writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, resolve(directory, OWNER_FILE))
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  const instrument = { directory, env, previous: env.NODE_V8_COVERAGE }
  env.NODE_V8_COVERAGE = directory
  instruments.add(instrument)
  attachHooks()
  return instrument
}

const lateWriteDirectories = new Set()

function removeLateWrites() {
  for (const directory of lateWriteDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Cleanup failures must not replace an exit code.
    }
  }
}

// A process that inherited NODE_V8_COVERAGE (a Vitest fork worker among them) writes its own coverage
// when it stops, and Node recreates the directory to do so: a worker stopped after generateCoverage
// brings the directory back without an owner record. Remove it once more when this process exits.
export function removeLateWritesAtExit(directory) {
  if (lateWriteDirectories.size === 0) process.once('exit', removeLateWrites)
  lateWriteDirectories.add(directory)
}

export function disableChildProcessCoverage(instrument) {
  if (instrument.env.NODE_V8_COVERAGE === instrument.directory) {
    if (instrument.previous === undefined) delete instrument.env.NODE_V8_COVERAGE
    else instrument.env.NODE_V8_COVERAGE = instrument.previous
  }
  instruments.delete(instrument)
  detachHooks()
  rmSync(instrument.directory, { recursive: true, force: true })
}
