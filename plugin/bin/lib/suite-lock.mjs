import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { artifactStateDir, pidAlive } from './artifact-server.mjs'

export const DEFAULT_SUITE_LOCK_WAIT_S = 2700
export const DEFAULT_SUITE_LOCK_STALE_S = 10_800

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

function holderIsStale(lock, options = {}) {
  if (!lock.held || !Number.isSafeInteger(lock.holder?.pid) || lock.holder.pid <= 0) return false
  if (!pidAlive(lock.holder.pid)) return true
  const platform = options.platform ?? process.platform
  const staleMs = positiveSeconds(options.staleS ?? DEFAULT_SUITE_LOCK_STALE_S, '--stale-s') * 1000
  // Windows signalability does not prove process identity: after this conservative age bound,
  // reclaiming avoids a recycled PID making a crashed holder permanent. POSIX never uses age alone.
  return platform === 'win32' && lock.ageMs !== null && lock.ageMs >= staleMs
}

export function formatSuiteLockHolder(holder) {
  if (!holder) return 'holder unknown'
  const argv = Array.isArray(holder.argv) ? holder.argv.slice(0, 2).join(' ') : 'unknown command'
  const started = new Date(holder.startedAt)
  const since = Number.isNaN(started.valueOf())
    ? 'unknown time'
    : started.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `holder pid ${holder.pid} (${argv}) since ${since}`
}

export async function acquireSuiteLock(options = {}) {
  const env = options.env ?? process.env
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
    try {
      mkdirSync(lockDir)
      const holder = {
        pid: process.pid,
        argv: options.argv ?? process.argv,
        cwd: options.cwd ?? process.cwd(),
        startedAt: new Date().toISOString(),
        platform: options.platform ?? process.platform,
      }
      try {
        writeFileSync(path.join(lockDir, 'holder.json'), `${JSON.stringify(holder, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true })
        throw error
      }
      return { root, lockDir, holder }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    const current = readSuiteLock({ root })
    if (!current.held) continue
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
      continue
    }
    const now = Date.now()
    if (now - startedWaiting >= waitMs) {
      const timeout = new Error(`timed out waiting for suite lock: ${formatSuiteLockHolder(current.holder)}`)
      timeout.code = 'WT_SUITE_LOCK_TIMEOUT'
      timeout.holder = current.holder
      throw timeout
    }
    if (now >= nextNoticeAt) {
      options.onWait?.(`waiting for suite lock: ${formatSuiteLockHolder(current.holder)}`)
      nextNoticeAt = now + noticeMs
    }
    await sleep(Math.min(pollMs, Math.max(1, waitMs - (now - startedWaiting))))
  }
}

export function releaseSuiteLock(lease) {
  const current = readSuiteLock({ root: lease.root })
  if (!current.held) return true
  if (current.holder?.pid !== lease.holder.pid || current.holder?.startedAt !== lease.holder.startedAt) return false
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
