import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function homeDirectory() {
  try { return os.userInfo().homedir } catch {
    if (process.env.HOME && path.isAbsolute(process.env.HOME)) return process.env.HOME
    throw new Error('lane host state: no home directory')
  }
}

function sandboxed() {
  if (process.platform !== 'linux') return false
  try { return !/^\s*0\s+0\s+4294967295\s*$/.test(readFileSync('/proc/self/uid_map', 'utf8').trim()) } catch { return true }
}

export function laneHostStateRoot({ base, env = process.env, platform = process.platform, home = homeDirectory(), insideSandbox = sandboxed() } = {}) {
  const override = !insideSandbox && env.WT_LANE_HOST_STATE
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('WT_LANE_HOST_STATE must be absolute')
    return path.resolve(override)
  }
  let stateBase = base
  if (!stateBase && platform === 'win32') stateBase = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'))
  else if (!stateBase && platform === 'darwin') stateBase = path.join(home, 'Library', 'Application Support')
  else if (!stateBase) stateBase = path.join(home, '.local', 'state')
  const root = path.join(stateBase, 'wt-lane-host')
  // A root this host cannot read as absolute (a win32 spelling computed on a POSIX host, e.g. a
  // simulated platform) would be created relative to the working directory, inside a worktree.
  if (!path.isAbsolute(root)) throw new Error(`lane host state root is not an absolute path on this host: ${root}`)
  return root
}

export function laneHostDir(worktree, options = {}) {
  const platform = options.platform ?? process.platform
  const realpath = options.realpath ?? realpathSync.native
  let ancestor = path.resolve(worktree)
  const remainder = []
  let canonical = ancestor
  while (true) {
    try { canonical = path.resolve(realpath(ancestor), ...remainder); break } catch {
      // A removed worktree retains the identity of its nearest existing, canonical ancestor.
      // Lexically resolving the whole path here splits /var from /private/var (or a Windows
      // short-name parent from its long spelling) after removal.
      const parent = path.dirname(ancestor)
      if (parent === ancestor) break
      remainder.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
  const key = ['win32', 'darwin'].includes(platform) ? canonical.toLowerCase() : canonical
  return path.join(laneHostStateRoot(options), createHash('sha256').update(key).digest('hex').slice(0, 32))
}

export function ensureLaneHostDir(worktree, options = {}) {
  realpathSync.native(worktree)
  const stateRoot = laneHostStateRoot(options)
  if (laneWritablePath(worktree, stateRoot)) throw new Error('lane host state root is inside a lane worktree')
  const dir = laneHostDir(worktree, options)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const candidate of [stateRoot, dir]) {
    const stat = statSync(candidate)
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new Error(`lane host state directory is not privately owned: ${candidate}`)
    }
  }
  const marker = path.join(dir, 'worktree')
  try { writeFileSync(marker, `${realpathSync.native(worktree)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return dir
}

export function laneWritablePath(worktree, candidate) {
  let root
  try { root = realpathSync.native(worktree) } catch { root = path.resolve(worktree) }
  let probe = path.resolve(candidate)
  const lexical = probe === root || probe.startsWith(`${root}${path.sep}`)
  const remainder = []
  while (true) {
    try { probe = path.resolve(realpathSync.native(probe), ...remainder); break } catch {
      const parent = path.dirname(probe)
      if (parent === probe) break
      remainder.unshift(path.basename(probe))
      probe = parent
    }
  }
  if (lexical || probe === root || probe.startsWith(`${root}${path.sep}`)) return true
  let entries
  try { entries = readdirSync(laneHostStateRoot()) } catch { return false }
  for (const entry of entries) {
    if (!/^[0-9a-f]{32}$/.test(entry)) continue
    const marker = path.join(laneHostStateRoot(), entry, 'worktree')
    try {
      if (!statSync(marker).isFile()) continue
      const other = readFileSync(marker, 'utf8').replace(/\n$/, '')
      if (candidate === other || candidate.startsWith(`${other}${path.sep}`) || probe === other || probe.startsWith(`${other}${path.sep}`)) return true
    } catch { continue }
  }
  return false
}

// Anchor the walk at a trusted realpath and refuse *every* redirected component, not just the leaf.
// Without O_NOFOLLOW, keep the containment and component checks; only the open-time race
// protection is unavailable for unsandboxed lanes.
export function readWorktreeRegular(file, encoding = 'utf8', root = null, { unsandboxed = process.platform !== 'linux' || process.env.WT_LANE_SANDBOX === 'off' } = {}) {
  const protectedOpen = process.platform !== 'win32' && !!constants.O_NOFOLLOW && !!constants.O_NONBLOCK
  if (!protectedOpen && !unsandboxed) return null
  let fd
  try {
    const laneMarker = `${path.sep}.lane${path.sep}`
    const inferredRoot = path.resolve(file).indexOf(laneMarker)
    const requestedRoot = path.resolve(root ?? (inferredRoot < 0 ? path.dirname(file) : path.resolve(file).slice(0, inferredRoot)))
    const relative = path.relative(requestedRoot, path.resolve(file))
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    const anchor = realpathSync.native(requestedRoot)
    const protectedFile = path.join(anchor, relative)
    let current = anchor
    const components = relative.split(path.sep)
    for (const part of components.slice(0, -1)) {
      current = path.join(current, part)
      const info = lstatSync(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return null
    }
    const leaf = lstatSync(protectedFile)
    if (!leaf.isFile() || leaf.isSymbolicLink()) return null
    if (!protectedOpen) return readFileSync(protectedFile, encoding === null ? undefined : encoding)
    fd = openSync(protectedFile, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino) return null
    return encoding === null ? readFileSync(fd) : readFileSync(fd, encoding)
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

export function makeReadableLaneBrief(snapshot, worktree, { temporaryParent = os.tmpdir() } = {}) {
  if (laneWritablePath(worktree, temporaryParent)) throw new Error('temporary directory must be outside the lane worktree')
  const directory = mkdtempSync(path.join(temporaryParent, 'wt-lane-brief-'))
  try {
    chmodSync(directory, 0o700)
    const file = path.join(directory, 'brief.md')
    writeFileSync(file, readFileSync(snapshot), { flag: 'wx', mode: 0o400 })
    return { directory, file }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function removeReadableLaneBrief(directory) {
  rmSync(directory, { recursive: true, force: true })
}

export function readLifecycleRegular(file, root = null, options = {}) {
  // Lifecycle lanes on non-Linux hosts have kind 'none' and already hold the owner's access.
  return readWorktreeRegular(file, 'utf8', root, { unsandboxed: process.platform !== 'linux', ...options })
}
