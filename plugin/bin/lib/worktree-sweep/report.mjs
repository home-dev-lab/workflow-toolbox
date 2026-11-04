import { closeSync, constants, openSync, writeFileSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { resolveWorkflowToolboxOption } from '../plugin-options.mjs'

export const APPLY_UNAVAILABLE = 'worktree sweep: apply is not available in this version (deletion design open)'

export function reportMode(mode, env = process.env) {
  const value = mode ?? resolveWorkflowToolboxOption('worktree_sweep_mode', { env }).value
  if (value === 'apply') throw new Error(APPLY_UNAVAILABLE)
  if (!['report', 'auto'].includes(value)) throw new Error('worktree sweep: mode must be report, auto or apply')
  return 'report'
}

export function summaryLine(report) {
  if (report.reason) return `worktree sweep (${report.project}): report only; KEEP all (${report.reason})`
  const summary = report.summary
  const reasons = Object.entries(summary.counts).map(([reason, count]) => `${count} ${reason}`).join(', ')
  return `worktree sweep (${report.project}): report only; ${summary.entries} entries; ${reasons}; moved 0; purged 0; ${report.outsideSweep.count} outside the sweep; excluded ${summary.nonDumpable} non-dumpable, ${summary.foreignUnreadable} foreign-unreadable, ${summary.mismatchExcluded} other-device references`
}

// The caller explicitly designates this one output. Exclusive creation prevents
// clobbering an entry, following an existing symlink or truncating a hard-link alias.
export function writeReport(out, report) {
  const fd = openSync(path.resolve(out), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`) } finally { closeSync(fd) }
}
