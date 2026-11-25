import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

// Expose new locks individually in the suite count while retaining the original
// aggregate cases. Each standalone case executes once, not again in its aggregate.
const addedCases = [
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
  ['suite-lock-admission-identity', 'switch defaults off and uses legacy acquisition and release without a watchdog'],
  ['suite-lock-admission-identity', 'explicit reservation switch creates managed state and a live watchdog'],
  ['suite-lock-admission-identity', 'marker enables reservations and exclusive overrides the marker'],
  ['suite-lock-admission-identity', 'invalid switch warns once and is treated as unset including marker fallback'],
  ['suite-lock-admission-identity', 'flag job class wins and request and release journal the explicit identity'],
  ['suite-lock-admission-identity', 'environment supplies job class and nested CLI cannot inherit it'],
  ['suite-lock-admission-identity', 'job class format accepts boundaries and rejects invalid input with one warning'],
  ['suite-lock-admission-identity', 'history is keyed only by job class even for identical wrapper argv categories'],
  ['suite-lock-admission-identity', 'timing sensitivity is confined to the explicit workload class'],
  ['suite-lock-admission-identity', 'classless wrapper remains exclusive despite other history for heavy and light'],
  ['suite-lock-admission-identity', 'unmeasured heavy and light both reserve exclusive declared slots'],
  ['suite-lock-admission-identity', 'failed and memory-stopped runs cannot train reservations'],
  ['suite-lock-admission-identity', 'newer successful incomplete resources revoke old measurements until three complete successes'],
  ['suite-lock-admission-identity', 'failed rows between three greens are ignored but still occupy the ten-release window'],
  ['suite-lock-admission-identity', 'resource window includes disqualifying rows and excludes rows with no resources record'],
  ['suite-lock-admission-identity', 'complete peaks with a null wall time qualify without inventing a duration requirement'],
  ['suite-lock-admission-identity', 'measured peaks use all trainable rows in the window at full precision'],
  ['suite-lock-admission-identity', 'oversize measurements become exclusive and remain runnable alone under any load'],
  ['suite-lock-admission-identity', 'nominal total memory distinguishes temporarily unavailable from oversize'],
  ['suite-lock-admission-identity', 'load plus candidate and sum of holders each stay within online CPUs'],
  ['suite-lock-admission-identity', 'CPU overload blocks shared admissions without a job count cap or memory stop'],
  ['suite-lock-admission-identity', 'exclusive candidate needs no machine-reading or load precondition'],
  ['suite-lock-admission-identity', 'reservation environment emits positive ceilings only for managed shared leases'],
  ['suite-lock-admission-identity', 'child environment removes managed keys using native platform case rules'],
  ['suite-lock-admission-identity', 'status shows switch and waiting and running identity mode reservation and basis'],
  ['suite-lock-admission-identity', 'status retains legacy running identity after a reservation epoch has emptied'],
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
