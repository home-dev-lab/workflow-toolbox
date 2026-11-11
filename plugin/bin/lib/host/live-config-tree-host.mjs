// Host facts the live-config-tree guard needs: whether the commands it reads spell Windows paths.
// Kept behind the host adapter so the guard itself reads no platform directly.
import { hostPlatform } from './platform.mjs'

const KNOWN_PLATFORMS = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32'])

// Test seam: WT_LIVE_CONFIG_TREE_GUARD_PLATFORM names the platform whose path spelling the guard
// reads. The hook reads the HOOK process's environment, which the harness sets; a command under
// inspection cannot change it.
export function liveConfigTreeGuardPlatform(env = process.env) {
  const forced = env.WT_LIVE_CONFIG_TREE_GUARD_PLATFORM
  return typeof forced === 'string' && KNOWN_PLATFORMS.has(forced) ? forced : hostPlatform
}

// Git Bash spells drive C: as `/c/...` (or `/cygdrive/c/...`). Node on Windows reads that as a path
// on the CURRENT drive (`C:\c\...`), so the guard maps it to the drive first.
const GIT_BASH_DRIVE = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/

/** `value` with a Git Bash drive prefix mapped to its Windows drive, on Windows only. */
export function nativeDrivePath(value, platform) {
  if (platform !== 'win32') return value
  const match = GIT_BASH_DRIVE.exec(value)
  if (!match) return value
  return `${match[1].toUpperCase()}:${value.slice(match[0].length) || '/'}`
}
