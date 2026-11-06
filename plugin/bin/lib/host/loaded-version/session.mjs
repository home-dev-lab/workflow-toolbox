// One live session: its id and profile from its own descriptors, and the plugin versions its
// server processes load, read from each process's own command line and working directory.
// A command line is only searched for path-shaped elements; it is never returned or printed, and a
// match counts only when it lands in a real profile's plugins/cache tree.
import path from 'node:path'
import { UnjudgeableError, errorCode, parseStat, readLive, readOrGone } from './census.mjs'

const SESSION_ID = /^\/.*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/tasks$/
const NOT_A_PROFILE = /^\/(proc|dev|sys)\//
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])
const DELETED = ' (deleted)'
const VERSION = /^[A-Za-z0-9._+-]+$/
const PATH_SHAPED = /^\.{0,2}\/[^'"`;&|$<>\n\r\t]*$/

// Host metadata lookups: a missing path is an answer, any other failure makes the session unknown.
function lookup(read, what) {
  try { return read() } catch (error) {
    throw new UnjudgeableError(`${what}: ${errorCode(error)}`)
  }
}

function descriptorTargets(procfs, pid) {
  const names = readLive(procfs, pid, () => procfs.listDescriptors(pid), `descriptors of pid ${pid} unreadable`) ?? []
  return names
    // ENOENT on one descriptor is that descriptor closing between the listing and the read.
    .map(fd => readOrGone(() => procfs.readDescriptorTarget(pid, fd), `descriptor ${fd} of pid ${pid} unreadable`))
    .filter(target => typeof target === 'string' && target.startsWith('/'))
}

const isProfile = (dir, files) => lookup(() => files.isDirectory(path.join(dir, 'plugins', 'cache')), `stat of ${dir}/plugins/cache failed`)

function attribution(procfs, pid, files) {
  const targets = descriptorTargets(procfs, pid)
  const ids = [...new Set(targets.map(target => SESSION_ID.exec(target)?.[1]).filter(Boolean))]
  const profiles = [...new Set(targets)]
    .filter(target => !NOT_A_PROFILE.test(target) && !SESSION_ID.test(target))
    .filter(target => isProfile(target, files))
  return { sessionId: ids.length ? ids.join(',') : null, profile: profiles.length === 1 ? profiles[0] : null }
}

// `<profile>/plugins/cache/<marketplace>/<plugin>/<version>[/...]` -> the version root, never the rest.
function matchModule(file, plugin) {
  const parts = file.split('/')
  for (let i = 1; i + 4 < parts.length; i += 1) {
    if (parts[i] !== 'plugins' || parts[i + 1] !== 'cache' || parts[i + 3] !== plugin) continue
    if (!parts[i + 2] || !VERSION.test(parts[i + 4])) continue
    return { profile: parts.slice(0, i).join('/') || '/', version: parts[i + 4], module: parts.slice(0, i + 5).join('/') }
  }
  return null
}

const stripDeleted = link => (link?.endsWith(DELETED) ? link.slice(0, -DELETED.length) : link)

// The resolved path decides when it is still in a plugins/cache tree; the path as given decides when
// the file is gone (an update deleted the old version) or resolves outside the cache (a linked checkout).
function matchElement(file, plugin, files) {
  const given = matchModule(file, plugin)
  const resolve = target => lookup(() => files.realpath(target), 'realpath of a module path failed')
  // A file the process named can be gone while its version directory still resolves.
  const real = resolve(file) ?? (given ? resolve(given.module) : null)
  const match = (real && matchModule(real, plugin)) || given
  return match && isProfile(match.profile, files) ? match : null
}

// An empty command line is a process that just exited (zombie) or one that hides it: only the first is gone.
function exitedOrEmpty(procfs, pid) {
  const text = readLive(procfs, pid, () => procfs.readProcessStat(pid, 'utf8'), `stat of pid ${pid} unreadable`)
  const state = text === null ? 'X' : parseStat(text)?.state
  if (state === 'Z' || state === 'X') return null
  throw new UnjudgeableError(`command line of pid ${pid} is empty`)
}

// The plugin modules one process loads; null when the process exited mid-scan.
function processModules(procfs, pid, plugin, files) {
  const raw = readLive(procfs, pid, () => procfs.readCommandLine(pid, 'utf8'), `command line of pid ${pid} unreadable`)
  if (raw === null) return null
  if (raw === '') return exitedOrEmpty(procfs, pid)
  const cwd = stripDeleted(readLive(procfs, pid, () => procfs.readWorkingDirectory(pid), `working directory of pid ${pid} unreadable`))
  if (cwd === null) return null
  const candidates = raw.split('\0').filter(arg => PATH_SHAPED.test(arg)).map(arg => path.resolve(cwd, arg))
  return [...candidates, cwd].map(file => matchElement(file, plugin, files)).filter(Boolean)
}

function descendants(census, pid) {
  const found = []
  const queue = [...(census.children.get(pid) ?? [])]
  while (queue.length) {
    const next = queue.shift()
    found.push(next)
    queue.push(...(census.children.get(next) ?? []))
  }
  return found
}

// Run one read; a named failure becomes a reason on the session instead of aborting the others.
function guarded(reasons, read, fallback) {
  try { return read() } catch (error) {
    if (!(error instanceof UnjudgeableError)) throw error
    reasons.push(error.message)
    return fallback
  }
}

// Every non-shell child subtree is a server tree (a launcher may wrap the real server); a shell child
// is the Bash tool or a hook, whose commands are not the session's servers.
function sessionModules(procfs, census, sessionPid, context) {
  const servers = (census.children.get(sessionPid) ?? []).filter(pid => !SHELLS.has(census.rows.get(pid)?.comm))
  const modules = []
  for (const pid of servers.flatMap(child => [child, ...descendants(census, child)])) {
    const own = guarded(context.reasons, () => processModules(procfs, pid, context.plugin, context.files), [])
    if (own === null) context.vanished += 1
    modules.push(...(own ?? []))
  }
  return modules
}

export function inspectSession(procfs, census, pid, plugin, files) {
  const context = { plugin, files, reasons: [], vanished: 0 }
  const { sessionId, profile } = guarded(context.reasons, () => attribution(procfs, pid, files), { sessionId: null, profile: null })
  const modules = sessionModules(procfs, census, pid, context)
  return {
    pid: Number(pid), sessionId, profile: profile ?? modules[0]?.profile ?? null,
    moduleProfiles: [...new Set(modules.map(module => module.profile))], modules, vanished: context.vanished,
    reason: context.reasons.length ? context.reasons.join('; ') : null,
  }
}
