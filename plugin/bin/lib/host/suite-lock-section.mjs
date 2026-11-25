import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { removeDirectoryOlderThan } from './suite-lock-queue.mjs'

export const RECLAIM_BUSY = Symbol('reclaim busy')
export const RECLAIM_DIR_STALE_MS = 60_000
// Recursive removal retries Windows delete-pending errors for a short interval.
const REMOVE_WITH_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }

// Holder removals and proven-dead ticket endings share this section. Acquirers
// withdraw while it exists; an abandoned section retains the existing age bound.
export function claimSuiteSection(root, critical) {
  const directory = path.join(root, 'reclaim.d')
  try { mkdirSync(directory) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    removeDirectoryOlderThan(directory, RECLAIM_DIR_STALE_MS)
    return RECLAIM_BUSY
  }
  try { return critical() } finally { rmSync(directory, REMOVE_WITH_RETRY) }
}

// Synchronous callers retry briefly. At the bound nothing is removed: the
// caller gets false and can retry; a dead client's holder remains recoverable.
export function retrySuiteSection(root, critical) {
  const deadline = performance.now() + 3000
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    const result = claimSuiteSection(root, critical)
    if (result !== RECLAIM_BUSY) return result
    if (performance.now() >= deadline) {
      process.stderr.write('wt-suite-lock: release section busy after 3 s; holder retained, retry release\n')
      return false
    }
    Atomics.wait(pause, 0, 0, 20)
  }
}
