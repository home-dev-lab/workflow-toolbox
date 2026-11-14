import { acquireSuiteLock, hasSuiteLeaseAsync, releaseSuiteLock, suiteLeaseDomain, suiteLeaseMarker } from '../../plugin/bin/lib/suite-lock.mjs'
import { guardLightRun, lightScopeMode } from '../../plugin/bin/lib/suite-lock-light-scope.mjs'
import { lightScopeLog } from '../../plugin/bin/lib/host/suite-lock-light-scope-log.mjs'

// A focused run (coverage known to be off) is light: it goes before full suites queued earlier in the lock
// queue. Anything else, and anything unknown or unreadable, is exclusive (fail closed): an unknown coverage
// state or a missing path list never earns priority. A light ticket is for ONE test file: during the
// light-scope probation (WT_SUITE_LOCK_LIGHT_SCOPE=warn, the default) a selection of 2 to 8 files stays light
// and is warned and recorded; in refuse mode the bound is one file and a larger selection queues exclusive.
const PROBATION_LIGHT_MAX_FILES = 8

export function lightMaxFiles(env = process.env) {
  return lightScopeMode(env) === 'refuse' ? 1 : PROBATION_LIGHT_MAX_FILES
}

export function suiteLeaseClassFor({ paths, coverageEnabled, env = process.env }) {
  if (coverageEnabled !== false || !Array.isArray(paths)) return 'exclusive'
  return paths.length >= 1 && paths.length <= lightMaxFiles(env) ? 'light' : 'exclusive'
}

// Throws when Vitest's state reader throws; callers fail closed.
function selectedPaths(project) {
  const state = project?.vitest?.state
  return typeof state?.getPaths === 'function' ? state.getPaths() : undefined
}

export function suiteLeaseClassForProject(project, env = process.env) {
  try {
    return suiteLeaseClassFor({ paths: selectedPaths(project), coverageEnabled: project?.vitest?.config?.coverage?.enabled, env })
  } catch {
    return 'exclusive'
  }
}

function rootPrefix(project) {
  const root = String(project?.vitest?.config?.root ?? '')
  return root && !root.endsWith('/') ? `${root}/` : root
}

const relativePath = (path, prefix) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path)

// The holder label a waiter reads in the lock. It names the files Vitest actually resolved (relative
// to the project root) for a focused run, and their count otherwise, so a bare `vitest run` never
// hides whether the holder is one file or the whole suite. Unreadable state falls back to the bare label.
export function suiteLeaseArgvForProject(project) {
  try {
    const paths = selectedPaths(project)
    if (!Array.isArray(paths) || paths.length === 0) return ['vitest', 'run']
    if (paths.length > PROBATION_LIGHT_MAX_FILES) return ['vitest', 'run', `(${paths.length} files)`]
    const prefix = rootPrefix(project)
    return ['vitest', 'run', ...paths.map((path) => relativePath(String(path), prefix))]
  } catch {
    return ['vitest', 'run']
  }
}

function skipSuiteLeaseSetup(project) {
  return process.env.WT_SUITE_LOCK === '0' || project?.config?.watch === true
}

// A closed stderr reports EPIPE asynchronously as an 'error' event; unhandled, it would end the Vitest run.
function writeStderr(text) {
  if (process.stderr.listenerCount('error') === 0) process.stderr.on('error', () => { /* a diagnostic failure never ends the run */ })
  process.stderr.write(text)
}

// A light selection over several files is warned (probation) and recorded on the host, like `run --light`.
export function vitestLightScopeGuard(argv, { env = process.env, write = writeStderr, domain = suiteLeaseDomain } = {}) {
  let log = null
  try {
    const root = domain()
    if (!root.startsWith('broker:')) log = lightScopeLog(root)
  } catch { /* an unknown lock root only loses the record, never the warning */ }
  return guardLightRun({ command: ['pnpm', 'exec', ...argv], route: 'vitest', env, write, log })
}

function listenForSuiteLeaseEnd(lease, scopeGuard) {
  // Keep the lease until Vitest exits after stopping its workers. A broker socket
  // must not itself keep an otherwise finished Vitest process alive.
  lease.socket?.unref?.()
  let lost = false
  const granted = performance.now()
  process.once('exit', (exit) => {
    scopeGuard?.end(performance.now() - granted) // before release: a release failure never loses the hold
    releaseSuiteLock(lease, { exit, served: !lost })
  })
  lease.lost?.then((reason) => {
    lost = true
    process.stderr.write(`vitest: suite lease lost (${reason || 'broker gone'}); stopping run\n`)
    process.exitCode = 75
    process.kill(process.pid, 'SIGTERM')
  })
}

export default async function setup(project) {
  if (skipSuiteLeaseSetup(project)) return
  let lease
  let scopeGuard = null
  try {
    if (await hasSuiteLeaseAsync()) return
    const argv = suiteLeaseArgvForProject(project)
    const light = suiteLeaseClassForProject(project) === 'light'
    if (light) scopeGuard = vitestLightScopeGuard(argv)
    lease = await acquireSuiteLock({ argv, ...(light ? { light: true } : {}), onWait: (message) => process.stderr.write(`${message}\n`) })
  } catch (error) {
    if (error?.code !== 'WT_SUITE_LOCK_TIMEOUT' && error?.code !== 'WT_SUITE_LOCK_UNAVAILABLE') throw error
    process.stderr.write(`vitest: ${error.message}\n`)
    process.exit(75)
  }
  const previous = process.env.WT_SUITE_LEASE
  process.env.WT_SUITE_LEASE = suiteLeaseMarker(lease)
  listenForSuiteLeaseEnd(lease, scopeGuard)
  return () => {
    if (previous === undefined) delete process.env.WT_SUITE_LEASE
    else process.env.WT_SUITE_LEASE = previous
  }
}
