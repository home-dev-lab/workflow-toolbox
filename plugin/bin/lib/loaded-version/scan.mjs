// Which version of a plugin each live Claude session's servers load, read off the processes.
// Exit codes: 0 every session current (or listing only), 1 at least one stale, 2 could not judge.
import path from 'node:path'
import { hostProcfs } from '../host/procfs.mjs'
import { hostLoadedVersionFiles } from '../host/loaded-version-files.mjs'
import { UnjudgeableError, ancestors, assertInspectable, errorCode, readCensus, realUid } from './census.mjs'
import { inspectSession } from './session.mjs'

const PLUGIN_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/
export const NO_SESSION_REASON = 'no live Claude session found; pass --allow-none when none is expected'

export function sessionStatus(session, expect) {
  const versions = [...new Set(session.modules.map(module => module.version))].sort()
  const mismatch = expect !== null && versions.some(version => version !== expect)
  if (mismatch) return { status: 'stale', versions }
  if (session.reason) return { status: 'unknown', versions }
  if (!versions.length) return { status: 'absent', versions }
  return { status: expect === null ? 'loaded' : 'current', versions }
}

export function exitCodeFor(sessions, reason) {
  if (sessions.some(session => session.status === 'stale')) return 1
  if (reason) return 2
  return sessions.some(session => session.status === 'unknown') ? 2 : 0
}

function canonical(dir, files) {
  try { return files.realpath(path.resolve(dir)) ?? path.resolve(dir) } catch (error) {
    throw new UnjudgeableError(`realpath of profile ${dir} failed: ${errorCode(error)}`)
  }
}

// A session is in scope when its own config dir, or the profile its servers load from, was asked for.
function inProfiles(session, options) {
  if (!options.profiles.length || session.profile === null) return true
  const own = [session.profile, ...session.moduleProfiles].map(dir => canonical(dir, options.files))
  return own.some(dir => options.profiles.includes(dir))
}

// A reader started from inside a Claude session must find that session in its own ancestry.
function assertSeesOwnSession(census, options, sessionPids) {
  if (options.env.CLAUDECODE !== '1') return
  if (ancestors(census, options.selfPid).some(pid => sessionPids.includes(pid))) return
  throw new UnjudgeableError('the reader runs inside a Claude session (CLAUDECODE=1) that the /proc census cannot see')
}

function scanOnce(options) {
  const census = readCensus(options)
  const pids = [...census.rows.values()]
    .filter(row => row.comm === 'claude' && realUid(options.procfs, row.pid) === options.uid).map(row => row.pid)
  assertSeesOwnSession(census, options, pids)
  return pids
    .map(pid => inspectSession(options.procfs, census, pid, options.plugin, options.files))
    .filter(session => inProfiles(session, options))
    .map(session => ({ ...session, ...sessionStatus(session, options.expect) }))
}

// A server restarting between the census and its read leaves an absent session: rescan once.
function liveSessions(options) {
  const first = scanOnce(options)
  return first.some(session => session.status === 'absent' && session.vanished > 0) ? scanOnce(options) : first
}

function normalise(input) {
  if (typeof input.plugin !== 'string' || !PLUGIN_NAME.test(input.plugin)) {
    throw new TypeError(`loaded-version: plugin name must match ${PLUGIN_NAME} (got ${JSON.stringify(input.plugin)})`)
  }
  return {
    procfs: hostProcfs, platform: process.platform, selfPid: process.pid, uid: process.getuid?.(),
    files: hostLoadedVersionFiles, env: process.env, allowNone: false, ...input,
    expect: input.expect ?? null, profiles: input.profiles ?? [],
  }
}

function resolveProfiles(options) {
  return options.profiles.map(dir => {
    if (!options.files.realpath(path.resolve(dir))) throw new UnjudgeableError(`--profile ${dir} does not exist`)
    return canonical(dir, options.files)
  })
}

function verdict(options, sessions) {
  if (sessions.length || options.expect === null || options.allowNone) return null
  return NO_SESSION_REASON
}

export function checkLoadedVersions(input) {
  const options = normalise(input)
  const base = { plugin: options.plugin, expect: options.expect, profiles: options.profiles }
  try {
    assertInspectable(options)
    options.profiles = resolveProfiles(options)
    base.profiles = options.profiles
    const sessions = liveSessions(options)
    const reason = verdict(options, sessions)
    return { ...base, inspected: true, reason, sessions, exitCode: exitCodeFor(sessions, reason) }
  } catch (error) {
    if (!(error instanceof UnjudgeableError)) throw error
    return { ...base, inspected: false, reason: error.message, sessions: [], exitCode: 2 }
  }
}
