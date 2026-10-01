// Host facts the suite-lock bypass guard needs: which platform's lock semantics apply, and whether a
// lock directory written in a command lands under the machine's temporary root. Kept behind the host
// adapter so the guard itself reads no platform, temp directory or path separator directly.
import os from 'node:os'
import path from 'node:path'
import { hostPlatform } from './platform.mjs'
import { pathWithin } from './path-within.mjs'

const KNOWN_PLATFORMS = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32'])

// Test seam: WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM names the platform whose lock semantics the guard
// applies (the Windows-only age reclaim). The hook reads the HOOK process's environment, which the
// harness sets; a command under inspection cannot change it.
export function suiteLockBypassGuardPlatform(env = process.env) {
  const forced = env.WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM
  return typeof forced === 'string' && KNOWN_PLATFORMS.has(forced) ? forced : hostPlatform
}

const POSIX_TEMP_EXPANSION = /^(?:\$TMPDIR|\$\{TMPDIR)(?!\w)/
const WINDOWS_TEMP_EXPANSION = /^(?:%TEMP%|%TMP%|\$env:TEMP(?!\w)|\$env:TMP(?!\w))/i
const MKTEMP = /^(?:\$\(|`)\s*mktemp(?!\w|-)/
// The home directory is never the temporary root: `$HOME/…`, `${HOME}/…`, `%USERPROFILE%…`, `$env:USERPROFILE…`.
const HOME_EXPANSION = /^(?:\$HOME(?!\w)|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE(?!\w))/i
const OTHER_EXPANSION = /[$`]|%[A-Za-z_]\w*%/
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/

function tempRoots(api) {
  const roots = api === path.win32 ? [] : ['/tmp']
  const native = os.tmpdir()
  if (api.isAbsolute(native)) roots.push(native)
  return roots
}

function underTempRoot(api, normalised) {
  const fold = api === path.win32 ? (value) => value.toLowerCase() : (value) => value
  return tempRoots(api).some((root) => pathWithin(fold(api.normalize(root)), fold(normalised), api))
}

/**
 * Where a WT_SUITE_LOCK_DIR value written in a command points.
 * - `temp`: under the temporary root (`/tmp`, `os.tmpdir()`), or a TMPDIR/TEMP/TMP or mktemp expansion.
 * - `unresolved`: any other shell or Windows expansion, or a relative path with no absolute cwd.
 * - `elsewhere`: a literal path outside the temporary root, or one under the home directory
 *   (`~`, `$HOME`, `${HOME}`, `%USERPROFILE%`, `$env:USERPROFILE`).
 */
export function suiteLockDirLocation(value, cwd = '') {
  const text = String(value)
  if (POSIX_TEMP_EXPANSION.test(text) || WINDOWS_TEMP_EXPANSION.test(text) || MKTEMP.test(text)) return 'temp'
  if (text.startsWith('~') || HOME_EXPANSION.test(text)) return 'elsewhere'
  if (OTHER_EXPANSION.test(text)) return 'unresolved'
  if (WINDOWS_ABSOLUTE.test(text)) return underTempRoot(path.win32, path.win32.normalize(text)) ? 'temp' : 'elsewhere'
  if (path.posix.isAbsolute(text)) return underTempRoot(path.posix, path.posix.normalize(text)) ? 'temp' : 'elsewhere'
  if (typeof cwd === 'string' && path.posix.isAbsolute(cwd)) {
    return underTempRoot(path.posix, path.posix.resolve(cwd, text)) ? 'temp' : 'elsewhere'
  }
  if (typeof cwd === 'string' && WINDOWS_ABSOLUTE.test(cwd)) {
    return underTempRoot(path.win32, path.win32.resolve(cwd, text)) ? 'temp' : 'elsewhere'
  }
  return 'unresolved'
}
