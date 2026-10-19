// The Git Bash spelling of a host directory. Pure: no host read.

/**
 * The hook's cwd and home come from the host: on win32 they read `C:\Users\x`. The Bash commands
 * it judges run in Git Bash, which spells the same directory `/c/Users/x`. Comparing the two
 * forms would miss every home or working-directory target, so a drive-letter path is rewritten
 * to the Git Bash form. A POSIX path is returned unchanged.
 */
export function toGitBashPath(path) {
  if (typeof path !== 'string') return path
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(path)
  if (!drive) return path
  return `/${drive[1].toLowerCase()}/${path.slice(2).replace(/\\/g, '/').replace(/^\/+/, '')}`
}
