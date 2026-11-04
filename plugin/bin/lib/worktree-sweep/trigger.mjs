import { existsSync, readFileSync, spawn as spawnChild, statSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { externalState, assertExternal, lockHeld } from './state.mjs'
import { reportMode, summaryLine } from './report.mjs'

const SIX_HOURS = 6 * 3600_000
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url))

function triggerOptions({ project, env = process.env, now = Date.now(), stat = statSync, spawn = spawnChild,
  stateDir = externalState(project, env), claim = () => !lockHeld(stateDir) }) {
  return { project, env, now, stat, spawn, stateDir, claim }
}

export function tick(options = {}) {
  const { project, env, now, stat, spawn, stateDir, claim } = triggerOptions(options)
  reportMode(undefined, env)
  const dir = assertExternal(project, stateDir)
  let previous = null
  try { previous = stat(path.join(dir, 'last.json')) } catch (error) { if (error.code !== 'ENOENT') return false }
  if (previous && now - previous.mtimeMs < SIX_HOURS) return false
  if (!claim()) return false
  const child = spawn(process.execPath, [worker, 'run', '--mode', 'report', '--project', project, '--state', dir], {
    env, detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.once('error', () => {})
  child.unref()
  return true
}

export function sessionSummary(project, env = process.env) {
  let interrupted = ''
  try {
    const dir = assertExternal(project, externalState(project, env))
    if (existsSync(path.join(dir, 'lock'))) interrupted = '; report pending or interrupted (external claim present)'
    const report = JSON.parse(readFileSync(path.join(dir, 'last.json'), 'utf8'))
    return `${summaryLine(report)}${interrupted}`
  } catch { return `worktree sweep (${project}): report only; no completed report (first run or interrupted)${interrupted}` }
}
