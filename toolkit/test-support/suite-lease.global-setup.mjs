import { acquireSuiteLock, hasSuiteLeaseAsync, releaseSuiteLock, suiteLeaseMarker } from '../../plugin/bin/lib/suite-lock.mjs'

// A focused run (one to eight selected files, coverage known to be off) is light: it goes before full
// suites queued earlier in the lock queue. Anything else, and anything unknown or unreadable, is exclusive
// (fail closed): an unknown coverage state or a missing path list never earns priority.
const LIGHT_MAX_FILES = 8

export function suiteLeaseClassFor({ paths, coverageEnabled }) {
  if (coverageEnabled !== false || !Array.isArray(paths)) return 'exclusive'
  return paths.length >= 1 && paths.length <= LIGHT_MAX_FILES ? 'light' : 'exclusive'
}

export function suiteLeaseClassForProject(project) {
  try {
    const state = project?.vitest?.state
    const paths = typeof state?.getPaths === 'function' ? state.getPaths() : undefined
    return suiteLeaseClassFor({ paths, coverageEnabled: project?.vitest?.config?.coverage?.enabled })
  } catch {
    return 'exclusive'
  }
}

// The holder label a waiter reads in the lock. It names the files Vitest actually resolved (relative
// to the project root) for a focused run, and their count otherwise, so a bare `vitest run` never
// hides whether the holder is one file or the whole suite. Unreadable state falls back to the bare label.
export function suiteLeaseArgvForProject(project) {
  try {
    const state = project?.vitest?.state
    const paths = typeof state?.getPaths === 'function' ? state.getPaths() : undefined
    if (!Array.isArray(paths) || paths.length === 0) return ['vitest', 'run']
    if (paths.length > LIGHT_MAX_FILES) return ['vitest', 'run', `(${paths.length} files)`]
    const root = String(project?.vitest?.config?.root ?? '')
    const prefix = root && !root.endsWith('/') ? `${root}/` : root
    return ['vitest', 'run', ...paths.map((path) => (prefix && String(path).startsWith(prefix) ? String(path).slice(prefix.length) : String(path)))]
  } catch {
    return ['vitest', 'run']
  }
}

export default async function setup(project) {
  if (process.env.WT_SUITE_LOCK === '0' || project?.config?.watch === true) return
  let lease
  try {
    if (await hasSuiteLeaseAsync()) return
    lease = await acquireSuiteLock({ argv: suiteLeaseArgvForProject(project), ...(suiteLeaseClassForProject(project) === 'light' ? { light: true } : {}), onWait: (message) => process.stderr.write(`${message}\n`) })
  } catch (error) {
    if (error?.code !== 'WT_SUITE_LOCK_TIMEOUT' && error?.code !== 'WT_SUITE_LOCK_UNAVAILABLE') throw error
    process.stderr.write(`vitest: ${error.message}\n`)
    process.exit(75)
  }
  const previous = process.env.WT_SUITE_LEASE
  process.env.WT_SUITE_LEASE = suiteLeaseMarker(lease)
  // Vitest tears down global setup before closing its pool. Keep the lease until
  // the Vitest process itself exits, after its workers have been stopped.
  // The broker socket must not itself keep an otherwise finished Vitest process alive.
  lease.socket?.unref?.()
  process.once('exit', () => releaseSuiteLock(lease))
  lease.lost?.then(() => {
    process.stderr.write('vitest: suite lease lost (broker gone); stopping run\n')
    process.exitCode = 75
    process.kill(process.pid, 'SIGTERM')
  })
  return () => {
    if (previous === undefined) delete process.env.WT_SUITE_LEASE
    else process.env.WT_SUITE_LEASE = previous
  }
}
