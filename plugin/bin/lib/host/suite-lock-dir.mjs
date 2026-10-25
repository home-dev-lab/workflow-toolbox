import { userInfo } from 'node:os'
import path from 'node:path'

const nonEmpty = (value) => typeof value === 'string' && value.length > 0

// Shared with the bypass guard: HOME and USERPROFILE no longer move the machine lock.
export function suiteLockStateRootVariables(platform) {
  return platform === 'win32' ? ['XDG_STATE_HOME', 'LOCALAPPDATA'] : ['XDG_STATE_HOME']
}

function realUserHome(paths) {
  try {
    const home = userInfo().homedir
    if (!nonEmpty(home) || !paths.isAbsolute(home)) throw new Error('OS returned no absolute home directory')
    return home
  } catch (cause) {
    const error = new Error('suite lock OS home is unknown; run WT_SUITE_LOCK_DIR=<shared-directory> wt-suite-lock run -- <command>', { cause })
    error.code = 'WT_SUITE_LOCK_HOME_UNAVAILABLE'
    throw error
  }
}

function usableStateRoot(env, name, paths) {
  if (!nonEmpty(env[name])) return false
  // XDG requires absolute base directories; a relative override is ignored by the sandbox too.
  return name !== 'XDG_STATE_HOME' || paths.isAbsolute(env[name])
}

// Explicit state roots retain their precedence and do not need an account lookup. The optional home
// remains a library test seam; normal callers always use the OS account, never os.homedir()'s env.
// The sandbox supplies path.posix because its plan describes Linux paths even in portable tests.
export function suiteLockDir(env = process.env, home, platform = process.platform, paths = path) {
  if (nonEmpty(env.WT_SUITE_LOCK_DIR)) return paths.resolve(env.WT_SUITE_LOCK_DIR)
  for (const name of suiteLockStateRootVariables(platform)) {
    if (usableStateRoot(env, name, paths)) return paths.join(env[name], 'wt-suite-lock')
  }
  const root = home ?? realUserHome(paths)
  if (platform === 'darwin') return paths.join(root, 'Library', 'Application Support', 'wt-suite-lock')
  if (platform === 'win32') return paths.join(root, 'AppData', 'Local', 'wt-suite-lock')
  return paths.join(root, '.local', 'state', 'wt-suite-lock')
}
