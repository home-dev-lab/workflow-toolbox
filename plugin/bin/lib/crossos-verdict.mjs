// Pure decision pieces of the cross-OS dispatcher: which paths are host layer, which branch a commit is checked on,
// and the single rule that turns platform evidence into a verdict.

export function matchesHostPath(file, glob) {
  const escaped = glob.split('**').map((part) => part.split('*').map((literal) => literal.replace(new RegExp('[.*+?^${}()|[\\]\\\\]', 'g'), (match) => String.fromCharCode(92) + match)).join('[^/]*')).join('.*')
  return new RegExp(`^${escaped}$`).test(file)
}

function matrixFailure(run) {
  if (run.conclusion !== 'success') return `conclusion ${run.conclusion}`
  if (!run.jobs?.length) return 'no jobs'
  const failed = run.jobs.find((job) => job.conclusion !== 'success')
  if (failed) return `job ${failed.name}: ${failed.conclusion}`
  for (const os of ['ubuntu', 'windows', 'macos']) {
    if (!run.jobs.some((job) => job.name.toLowerCase().includes(os))) return `missing ${os}`
  }
  return null
}

export const ciBranchFor = (sha) => `card/ci-${sha.slice(0, 12)}`
export const EVIDENCE_FIELDS = 'event,headBranch,headSha,status,conclusion,jobs'

// The ONLY producer of a green verdict. Green needs positive evidence about exactly this commit: a dispatched run on
// its own card/ci branch at its sha, completed, with a successful ubuntu, windows and macos job. Absent, foreign or
// partial evidence is unchecked, pending or red, never green. Callers pass evidence read live from GitHub
// (freshEvidence); a stored record is never evidence.
export function verdictFromEvidence(run, sha) {
  if (!run || typeof run !== 'object') return { verdict: 'unchecked', reason: 'no run evidence' }
  if (run.event !== 'workflow_dispatch' || run.headBranch !== ciBranchFor(sha) || run.headSha !== sha) {
    return { verdict: 'unchecked', reason: `evidence is not about ${sha}: event=${run.event} headBranch=${run.headBranch} headSha=${run.headSha}` }
  }
  if (run.status !== 'completed' || !run.conclusion) return { verdict: 'pending', reason: `status ${run.status}` }
  const incomplete = matrixFailure(run)
  return incomplete ? { verdict: 'red', reason: incomplete } : { verdict: 'green', reason: 'ubuntu, windows and macos jobs succeeded' }
}
