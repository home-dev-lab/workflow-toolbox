// owned-lane-process.ts — a long-lived process this test owns whose kernel process name is
// exactly the lane executable name (`opencode`), for the real `pgrep -x` and /proc paths.
//
// A copy of /bin/sleep under a new name works where sleep ignores its own file name (GNU
// coreutils, BSD). Where coreutils is the uutils multicall binary (Ubuntu 26.04 and later), the
// binary dispatches on its executable name: a copy named `opencode` prints "unknown program
// 'opencode'" and exits at once, even with argv[0] set to `sleep`. Each candidate is therefore
// proven to run under the new name before it is used, and the next one is a copy of the system
// POSIX shell running a loop that never replaces itself.
//
// On macOS a copy of /bin/sleep or /bin/sh is killed by a signal at once (the Mac certification
// reported both with no exit code). The last candidate is a copy of the Node binary running this
// test: it is not a system binary and it runs on every host that runs the suite. A refusal names
// the signal that killed a candidate.

import { spawnSync } from 'node:child_process'
import { chmodSync, constants, copyFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface FakeLaneCandidate { source: string, args: string[], probeArgs: string[] }
export interface FakeLane { executable: string, args: string[], source: string }

// The loop keeps the shell process itself alive: a simple `-c 'sleep 30'` may be exec'd in place,
// which would rename the process to `sleep`. It ends on its own after about 30 s, like `sleep 30`,
// so a test that never kills it cannot leave it running.
const SHELL_LOOP = 'i=0; while [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done'
// The Node candidate ends on its own after 30 s too, and exits on SIGTERM like the others. Node
// names its main thread `MainThread`, which on Linux is the kernel process name `pgrep -x` reads;
// setting the title to the copy's own file name restores it (Linux: prctl PR_SET_NAME). On macOS
// `pgrep -x` is expected to read the executable's file name whatever the title; the
// owned-lane-process test asserts it through the real pgrep.
const NODE_IDLE = "process.title = require('node:path').basename(process.execPath); setTimeout(() => {}, 30_000)"

export function defaultFakeLaneCandidates(): FakeLaneCandidate[] {
  const shell = (() => { try { return realpathSync('/bin/sh') } catch { return '/bin/sh' } })()
  return [
    { source: '/bin/sleep', args: ['30'], probeArgs: ['0'] },
    { source: shell, args: ['-c', SHELL_LOOP], probeArgs: ['-c', 'exit 0'] },
    { source: process.execPath, args: ['-e', NODE_IDLE], probeArgs: ['-e', ''] },
  ]
}

function probeOutcome(probe: ReturnType<typeof spawnSync>): string {
  if (probe.error) return probe.error.message
  if (probe.signal) return `killed by signal ${probe.signal}`
  return `exit ${String(probe.status)}`
}

function runsUnderName(executable: string, probeArgs: string[]): string | null {
  const probe = spawnSync(executable, probeArgs, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (probe.status === 0 && !probe.error) return null
  return `${probeOutcome(probe)} ${String(probe.stderr ?? '').trim()}`.trim()
}

/** Copy (a clone where the file system offers one: the Node binary is large) and make it executable. */
function copyExecutable(source: string, executable: string) {
  copyFileSync(source, executable, constants.COPYFILE_FICLONE)
  chmodSync(executable, 0o755)
}

/** Copy the first candidate that runs under `name` into `root`; refuse, naming every candidate, when none does. */
export function prepareFakeLane(root: string, name = 'opencode', candidates = defaultFakeLaneCandidates()): FakeLane {
  const executable = join(root, name)
  const refusals: string[] = []
  for (const candidate of candidates) {
    try {
      copyExecutable(candidate.source, executable)
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
