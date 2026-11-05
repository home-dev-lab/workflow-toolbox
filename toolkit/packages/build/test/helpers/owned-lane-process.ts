// owned-lane-process.ts — a long-lived process this test owns whose kernel process name is
// exactly the lane executable name (`opencode`), for the real `pgrep -x` and /proc paths.
//
// A copy of /bin/sleep under a new name works where sleep ignores its own file name (GNU
// coreutils, BSD, macOS). Where coreutils is the uutils multicall binary (Ubuntu 26.04 and
// later), the binary dispatches on its executable name: a copy named `opencode` prints
// "unknown program 'opencode'" and exits at once, even with argv[0] set to `sleep`. Each
// candidate is therefore proven to run under the new name before it is used, and the next
// one is a copy of the system POSIX shell running a loop that never replaces itself.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface FakeLaneCandidate { source: string, args: string[], probeArgs: string[] }
export interface FakeLane { executable: string, args: string[], source: string }

// The loop keeps the shell process itself alive: a simple `-c 'sleep 30'` may be exec'd in place,
// which would rename the process to `sleep`.
const SHELL_LOOP = 'while :; do sleep 1; done'

export function defaultFakeLaneCandidates(): FakeLaneCandidate[] {
  const shell = (() => { try { return realpathSync('/bin/sh') } catch { return '/bin/sh' } })()
  return [
    { source: '/bin/sleep', args: ['30'], probeArgs: ['0'] },
    { source: shell, args: ['-c', SHELL_LOOP], probeArgs: ['-c', 'exit 0'] },
  ]
}

function runsUnderName(executable: string, probeArgs: string[]): string | null {
  const probe = spawnSync(executable, probeArgs, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (probe.status === 0) return null
  return `${probe.error?.message ?? `exit ${String(probe.status)}`} ${String(probe.stderr ?? '').trim()}`.trim()
}

/** Copy the first candidate that runs under `name` into `root`; refuse, naming every candidate, when none does. */
export function prepareFakeLane(root: string, name = 'opencode', candidates = defaultFakeLaneCandidates()): FakeLane {
  const executable = join(root, name)
  const refusals: string[] = []
  for (const candidate of candidates) {
    try {
      copyFileSync(candidate.source, executable)
      chmodSync(executable, 0o755)
    } catch (error) {
      refusals.push(`${candidate.source}: ${(error as Error).message}`)
      continue
    }
    const refusal = runsUnderName(executable, candidate.probeArgs)
    if (refusal === null) return { executable, args: candidate.args, source: candidate.source }
    refusals.push(`${candidate.source}: ${refusal}`)
    rmSync(executable, { force: true })
  }
  throw new Error(`no candidate runs under the name ${name}: ${refusals.join('; ')}`)
}
