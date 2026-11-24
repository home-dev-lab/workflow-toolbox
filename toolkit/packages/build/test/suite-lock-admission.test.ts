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
