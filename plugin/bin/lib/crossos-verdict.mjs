// Pure decision pieces of the cross-OS dispatcher: which paths are host layer, which branch a commit is checked on,
// and the single rule that turns platform evidence into a verdict.

export function matchesHostPath(file, glob) {
  const escaped = glob.split('**').map((part) => part.split('*').map((literal) => literal.replace(new RegExp('[.*+?^${}()|[\\]\\\\]', 'g'), (match) => String.fromCharCode(92) + match)).join('[^/]*')).join('.*')
  return new RegExp(`^${escaped}$`).test(file)
}

// A job that never actually ran to a real conclusion — the matrix itself is short a data point,
// distinct from a job that ran and failed.
const NOT_RUN = new Set(['skipped', null, undefined, ''])

// Splits "the matrix is missing information" (a job absent, or present but not run) from
// "the matrix is complete and at least one job failed" — the two are different facts and must
// never share one reason string (a complete, failed matrix is not an incomplete one).
function matrixState(run) {
  if (!run.jobs?.length) return { incomplete: 'no jobs' }
  for (const os of ['ubuntu', 'windows', 'macos']) {
    if (!run.jobs.some((job) => job.name.toLowerCase().includes(os))) return { incomplete: `missing ${os}` }
  }
  const notRun = run.jobs.find((job) => NOT_RUN.has(job.conclusion))
  if (notRun) return { incomplete: `job ${notRun.name}: ${notRun.conclusion ?? 'no conclusion'}` }
  const failed = run.jobs.filter((job) => job.conclusion !== 'success')
  if (!failed.length && run.conclusion !== 'success') return { incomplete: `conclusion ${run.conclusion}` }
  return { failed }
}

export const ciBranchFor = (sha) => `card/ci-${sha.slice(0, 12)}`
export const EVIDENCE_FIELDS = 'event,headBranch,headSha,status,conclusion,jobs'

// The ONLY producer of a green verdict. Green needs positive evidence about exactly this commit: a dispatched run on
// its own card/ci branch at its sha, completed, with a successful ubuntu, windows and macos job (Windows runs as
// several shard jobs, `matrix (windows-latest, 1)` and so on; green needs EVERY job of the run to have succeeded,
// so one failed shard is red). Absent, foreign or
// partial evidence is unchecked, pending or red, never green. Callers pass evidence read live from GitHub
// (freshEvidence); a stored record is never evidence.
export function verdictFromEvidence(run, sha) {
  if (!run || typeof run !== 'object') return { verdict: 'unchecked', reason: 'no run evidence' }
  if (run.event !== 'workflow_dispatch' || run.headBranch !== ciBranchFor(sha) || run.headSha !== sha) {
    return { verdict: 'unchecked', reason: `evidence is not about ${sha}: event=${run.event} headBranch=${run.headBranch} headSha=${run.headSha}` }
  }
  if (run.status !== 'completed' || !run.conclusion) return { verdict: 'pending', reason: `status ${run.status}` }
  const state = matrixState(run)
  if (state.incomplete) return { verdict: 'red', reason: state.incomplete, incomplete: true }
  if (!state.failed.length) return { verdict: 'green', reason: 'ubuntu, windows and macos jobs succeeded', incomplete: false }
  const names = state.failed.map((job) => job.name).join(', ')
  return { verdict: 'red', reason: `${state.failed.length} of ${run.jobs.length} jobs failed (${names})`, incomplete: false }
}
