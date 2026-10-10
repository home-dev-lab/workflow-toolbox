import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
  publishWorktreeMarker(path.join(dir, 'worktree'), realpathSync.native(worktree), { ...MARKER_FS, ...options.markerFs })
  return dir
}

// A marker is the worktree's absolute path followed by one newline. Anything else (an empty file,
// a write cut short before its newline, a relative path) names no worktree and is ignored.
function readWorktreeMarker(marker) {
  if (!statSync(marker).isFile()) return null
  const content = readFileSync(marker, 'utf8')
  if (!content.endsWith('\n')) return null
  const recorded = content.slice(0, -1)
  return recorded && path.isAbsolute(recorded) ? recorded : null
}

function currentMarker(marker) {
  try { return readWorktreeMarker(marker) } catch { return null }
}

// `fs` is a seam for the write, link and exclusive-open steps of marker publication.
const MARKER_FS = { writeFileSync, linkSync, openSync, closeSync, unlinkSync }

// Readers must never observe a marker that exists before its bytes, and an existing marker is never
// replaced (the first writer wins, as the former exclusive create did): the path is written to a
// private staging file and published without clobbering. An invalid marker already in place is left
// alone; readers ignore it.
function publishWorktreeMarker(marker, worktree, fs) {
  if (existsSync(marker)) return
  const staging = `${marker}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(staging, `${worktree}\n`, { flag: 'wx', mode: 0o600 })
    publishNoClobber(staging, marker, fs)
  } catch (error) {
    if (currentMarker(marker) === null) throw error
  } finally {
    try { rmSync(staging, { force: true }) } catch { /* a leftover staging file is never read as a marker */ }
  }
}

// A hard link publishes the complete file or fails with EEXIST. Where the file system refuses hard
// links (whatever error it reports), an exclusive create of the same bytes keeps the no-clobber
// guarantee; a write that fails after that create removes the file it created.
function publishNoClobber(source, marker, fs) {
  try { fs.linkSync(source, marker); return } catch (error) {
    if (error?.code === 'EEXIST') return
  }
  let fd
  try { fd = fs.openSync(marker, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') return
    throw error
  }
  try { fs.writeFileSync(fd, readFileSync(source)) } catch (error) {
    try { fs.unlinkSync(marker) } catch { /* readers ignore an unterminated marker */ }
    throw error
  } finally { fs.closeSync(fd) }
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
    const other = currentMarker(marker)
    if (other === null) continue
    if (candidate === other || candidate.startsWith(`${other}${path.sep}`) || probe === other || probe.startsWith(`${other}${path.sep}`)) return true
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

// Starts a detached process whose stderr appends to the host-owned lane log, so a process that
// fails before writing its own stages still leaves its error where the operator reads the lane.
export function spawnWithLaneLogStderr(log, start) {
  const fd = openSync(log, 'a', 0o600)
  try { return start(['ignore', 'ignore', fd]) } finally { closeSync(fd) }
}

export function appendLaunchFailure(log, reason) {
  if (!log) return
  try {
    let tail = ''
    try { tail = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).at(-1) ?? '' } catch {}
    if (/^EXIT=\d+$/.test(tail)) return
    appendFileSync(log, `wt-lane: launch-failed: ${reason}\nEXIT=1\n`)
  } catch { /* best effort diagnostic */ }
}

export function awaitChildSpawn(child, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const settle = (complete, value) => {
      clearTimeout(timer)
      child.removeListener('spawn', onSpawn)
      child.removeListener('error', onError)
      complete(value)
    }
    const onSpawn = () => settle(resolve)
    const onError = (error) => settle(reject, error)
    // Ref'd deliberately: even a child with no live handle must reach the failure reporter.
    const timer = setTimeout(() => {
      const error = new Error(`opencode reported neither spawn nor error within ${timeoutMs / 1000} s`)
      error.code = 'OPENCODE_SPAWN_TIMEOUT'
      settle(reject, error)
    }, timeoutMs)
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

export function removeReadableLaneBrief(directory) {
  rmSync(directory, { recursive: true, force: true })
}

export function readLifecycleRegular(file, root = null, options = {}) {
  // Lifecycle lanes on non-Linux hosts have kind 'none' and already hold the owner's access.
  return readWorktreeRegular(file, 'utf8', root, { unsandboxed: process.platform !== 'linux', ...options })
}
