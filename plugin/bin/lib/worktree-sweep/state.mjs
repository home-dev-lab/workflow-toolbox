// Trigger state is external to the project. CLI report runs never use this module.
import { createHash } from 'node:crypto'
import { closeSync, homedir, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { canonicalDirectory } from '../host/canonical-path.mjs'
import { pathContains } from '../host/sweep-evidence.mjs'
import { createProcfs } from '../host/procfs.mjs'

export function externalState(project, env = process.env) {
  const key = createHash('sha256').update(path.resolve(project)).digest('hex')
  const root = env.XDG_STATE_HOME || path.join(env.HOME || homedir(), '.local', 'state')
  return path.join(root, 'workflow-toolbox', 'worktree-sweep', key)
}

export function assertExternal(project, dir) {
  const actual = canonicalDirectory(dir)
  const projectPath = canonicalDirectory(project)
  if (!actual || !projectPath || pathContains(projectPath, actual)) throw new Error('worktree sweep: state must be outside the project')
  return actual
}

export function lockHeld(dir) {
  try {
    readFileSync(path.join(dir, 'lock'), 'utf8')
    return true
  } catch (error) { return error.code !== 'ENOENT' }
}

function claimIdentity(procfs) {
  try {
    const stat = procfs.readProcessStat('self', 'utf8')
    return { namespace: procfs.readPidNamespace(), startIdentity: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }
  } catch { return { namespace: null, startIdentity: null } }
}

export function claimState(project, stateDir, procfs = createProcfs()) {
  const dir = assertExternal(project, stateDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = path.join(dir, 'lock')
  try {
    const fd = openSync(lock, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, ...claimIdentity(procfs) })) } finally { closeSync(fd) }
    return () => { assertExternal(project, dir); unlinkSync(lock) }
  } catch (error) {
    // A pathname recheck followed by unlink could remove a concurrent successor's
    // claim. Keep crashed claims rather than pretending that check is atomic.
    if (error.code !== 'EEXIST') throw error
    return null
  }
}
