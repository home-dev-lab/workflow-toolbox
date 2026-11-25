import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

// Expose new locks individually in the suite count while retaining the original
// aggregate cases. Each standalone case executes once, not again in its aggregate.
const addedCases = [
  ['suite-lock-admission-recovery', 'R5 machine reader preserves legacy source getter ordering'],
  ['suite-lock-admission-recovery', 'R8 release retries a temporarily unreadable reservation state'],
  ['suite-lock-admission-recovery', 'R5 an invalid Windows sample cannot authorize sharing'],
  ['suite-lock-admission-recovery', 'R8 a launcher killed after grant before spawn is reconciled'],
  ['suite-lock-admission-recovery', 'R6 a killed victim launcher cannot block the next victim past its deadline'],
  ['suite-lock-admission-recovery', 'R5 publication rechecks heartbeat freshness inside the writer'],
  ['suite-lock-admission-recovery', 'R5 publication rechecks windows freshness inside the writer'],
  ['suite-lock-admission-recovery', 'R6 unknown supervision never becomes an automatic stop'],
  ['suite-lock-admission-recovery', 'R6 real watchdog pause never stops its healthy child'],
  ['suite-lock-admission-recovery', 'R6 real watchdog kill never stops its healthy child'],
  ['suite-lock-admission-recovery', 'R5 unknown falls through to exclusive without a holder'],
  ['suite-lock-admission-recovery', 'R5 heartbeat falls through to exclusive without a holder'],
  ['suite-lock-admission-recovery', 'R5 windows falls through to exclusive without a holder'],
  ['suite-lock-admission-recovery', 'R5 stale sensors never share with an existing holder'],
  ['suite-lock-admission-recovery', 'R8 dead writer in reservation-write.d is reclaimed'],
  ['suite-lock-admission-recovery', 'R8 dead writer in reclaim.d is reclaimed'],
  ['suite-lock-admission-recovery', 'R8 ownerless writer older than ten seconds is reclaimed'],
  ['suite-lock-admission-recovery', 'R8 live writer is never reclaimed merely by age'],
  ['suite-lock-admission-recovery', 'R8 two concurrent reclaimers cannot both enter the writer section'],
  ['suite-lock-admission-recovery', 'R8 reconciliation removes a dead launcher and journals unknown release'],
  ['suite-lock-admission-recovery', 'R8 release retries a live writer beyond the old three-second cutoff'],
  ['suite-lock-admission-recovery', 'R6 victim order is total for absent sequence and timestamps'],
  ['suite-lock-admission-recovery', 'R6 expired stops are abandoned and the next victim can be chosen'],
  ['suite-lock-admission-recovery', 'R6 confirmed release settles five seconds before a new fresh low reading'],
  ['suite-lock-admission-recovery', 'R5 publication rechecks the sensors after beforePublish'],
  ['suite-lock-admission-recovery', 'R5 Windows reader parses integer lines, ages samples and respawns one child'],
  ['suite-lock-admission-recovery', 'R4 CPU booking capacity is exactly the online logical CPU count'],
  ['suite-lock-admission-recovery', 'R5 WSL uses the minimum of Linux and fresh Windows memory'],
  ['suite-lock-admission-recovery', 'R5 WSL interop marker detects WSL without a Microsoft kernel string'],
  ['suite-lock-admission-recovery', 'R6 test floor can only rise and its memory stops retain the override'],
  ['suite-lock-admission', 'admission has no count ceiling for a large fitting family'],
  ['suite-lock-admission', 'memory pressure still selects a victim when every holder has release priority'],
  ['suite-lock-admission-process', 'a released memory victim keeps its place ahead of an already polling peer'],
  ['suite-lock-admission-process', 'thirty-three measured heavy leases fit without a holder-count cap'],
  ['suite-lock-admission-process', 'same-name light jobs use history, not their name: sensitive=false'],
  ['suite-lock-admission-process', 'same-name light jobs use history, not their name: sensitive=true'],
  ['suite-lock-admission-process', 'queue status exposes the same full-precision reservation used by admission'],
  ['suite-lock-admission-process', 'a job that repeatedly exceeds memory alone ends after three requeues'],
  ['suite-lock-admission-process', 'CPU overload leaves real running jobs unsignalled and only pauses new admission'],
  ['suite-lock-admission-process', 'a foreign PID namespace cannot replace a live watchdog (Linux bwrap required)'],
] as const
const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const run = (file: string, pattern?: string) => execFileSync(process.execPath, [
  '--test', ...(pattern ? ['--test-name-pattern', pattern] : []),
  fileURLToPath(new URL(`../../../test-support/${file}.selftest.mjs`, import.meta.url)),
], { encoding: 'utf8', timeout: 60_000 })

for (const file of ['suite-lock-admission', 'suite-lock-admission-process', 'suite-lock-admission-comparison']) {
  it(`${file}: isolated admission regression locks`, () => {
    const names = addedCases.filter(([source]) => source === file).map(([, name]) => escaped(name))
    run(file, names.length ? `^(?!(?:${names.join('|')})$)` : undefined)
  }, 65_000)
}

for (const [file, name] of addedCases) it(name, () => { run(file, `^${escaped(name)}$`) }, 65_000)
