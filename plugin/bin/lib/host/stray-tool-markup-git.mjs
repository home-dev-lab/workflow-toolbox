import { spawnSync } from 'node:child_process'

// The hook is registered with a 5 s timeout: the git read keeps a margin below it.
/** @knipTestSeam Imported by stray-tool-markup-guard-hook.test.ts to pin the margin below the hook timeout. */
export const GIT_TIMEOUT_MS = 3000

// Host boundary: inspect only the stored message, never execute the tool's shell text.
export function recentCommitMessage(dir) {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is the repository interface being inspected.
    const result = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%ct%x00%B'], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
    })
    if (result.error || result.status !== 0) return null
    const separator = result.stdout.indexOf('\0')
    if (separator < 0) return null
    const time = Number(result.stdout.slice(0, separator))
    if (!Number.isFinite(time) || Math.abs(Date.now() / 1000 - time) > 120) return null
    return result.stdout.slice(separator + 1)
  } catch { return null }
}
