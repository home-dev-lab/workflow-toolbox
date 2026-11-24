// Three complete observations avoid relabelling a class from a single atypical run.
/** @knipTestSeam Threshold-edge checks use a computed module import. */
export const SUITE_RESOURCE_MIN_RUNS = 3
// One core and 512 MiB bound small static checks; either larger peak is heavy.
// These are reporting thresholds only, never inputs to admission.
/** @knipTestSeam Threshold-edge checks use a computed module import. */
export const SUITE_LIGHT_MAX_CORES = 1
/** @knipTestSeam Threshold-edge checks use a computed module import. */
export const SUITE_LIGHT_MAX_MEM_MIB = 512

const measured = (value) => Number.isFinite(value) && value >= 0
const resourceValue = (value) => value === 'unknown' || measured(value)

export const unknownSuiteResources = (wallMs, reason) => ({ peakCores: 'unknown', peakMemMiB: 'unknown', wallMs, unknownReasons: [reason] })

export const suiteResourceReleaseOutcome = (outcome) => ({ ...outcome, exit: outcome.exit ?? 'unknown',
  resources: outcome.resources ?? unknownSuiteResources(outcome.heldMs, 'client-telemetry-unavailable') })

export function validSuiteResources(value) {
  return value && resourceValue(value.peakCores) && resourceValue(value.peakMemMiB)
    && measured(value.wallMs) && Array.isArray(value.unknownReasons)
    && value.unknownReasons.every((reason) => typeof reason === 'string' && /^[a-z-]{1,64}$/.test(reason))
}

/** Pure: runs are release-row resources, not rounded status text.
 * @knipTestSeam Computed import in suite-lock-resources.selftest.mjs.
 */
export function classifySuiteJob(runs, declared = 'heavy') {
  const complete = runs.filter((run) => validSuiteResources(run) && measured(run.peakCores) && measured(run.peakMemMiB))
  const cores = complete.length ? Math.max(...complete.map((run) => run.peakCores)) : 'unknown'
  const memMiB = complete.length ? Math.max(...complete.map((run) => run.peakMemMiB)) : 'unknown'
  if (complete.length < SUITE_RESOURCE_MIN_RUNS) return { class: declared, cores, memMiB, basis: 'declared' }
  const light = cores <= SUITE_LIGHT_MAX_CORES && memMiB <= SUITE_LIGHT_MAX_MEM_MIB
  return { class: light ? 'light' : 'heavy', cores, memMiB, basis: 'measured' }
}

/** Reuse the journal's existing cmd identity; old or incomplete rows are not observations. */
export function suiteResourceClasses(tickets) {
  const groups = new Map()
  for (const ticket of tickets) {
    if (typeof ticket.cmd !== 'string') continue
    if (!groups.has(ticket.cmd)) groups.set(ticket.cmd, { runs: [], declared: 'heavy' })
    const group = groups.get(ticket.cmd)
    group.declared = ticket.light === true || ticket.kind === 'light' || ticket.kind === 'static' ? 'light' : 'heavy'
    if (ticket.release?.resources) group.runs.push(ticket.release.resources)
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, classifySuiteJob(group.runs, group.declared)]))
}
