import { acquireSuiteLock, hasSuiteLeaseAsync, releaseSuiteLock, suiteLeaseMarker } from '../../plugin/bin/lib/suite-lock.mjs'

export default async function setup(project) {
  if (process.env.WT_SUITE_LOCK === '0' || project?.config?.watch === true) return
  let lease
  try {
    if (await hasSuiteLeaseAsync()) return
    lease = await acquireSuiteLock({ argv: ['vitest', 'run'], onWait: (message) => process.stderr.write(`${message}\n`) })
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
