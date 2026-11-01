import { closeSync, constants, openSync, renameSync, statSync, writeFileSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { isInvokedDirectly } from '../host/entry-guard.mjs'
import { createProcfs } from '../host/procfs.mjs'
import { scanProject } from './scan.mjs'
import { assertExternal, claimState } from './state.mjs'
import { reportMode } from './report.mjs'

export function reportWorker(project, stateDir, env = process.env) {
  reportMode(undefined, env)
  const dir = assertExternal(project, stateDir)
  const release = claimState(project, dir, createProcfs({ root: env.WT_SWEEP_PROC_ROOT }))
  if (!release) return
  try {
    const out = path.join(dir, 'last.json')
    try { if (Date.now() - statSync(out).mtimeMs < 6 * 3600_000) return } catch (error) { if (error.code !== 'ENOENT') return }
    const report = scanProject({ project, env })
    const staging = path.join(dir, `report-${process.pid}-${Date.now()}.json`)
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { writeFileSync(fd, `${JSON.stringify(report)}\n`) } finally { closeSync(fd) }
    renameSync(staging, out)
  } finally { release() }
}

if (isInvokedDirectly(import.meta.url)) {
  try { reportWorker(process.argv[6], process.argv[8]) } catch { /* A hook must not block a session. */ }
}
