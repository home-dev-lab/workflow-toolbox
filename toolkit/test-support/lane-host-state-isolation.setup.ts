// Every Vitest worker and its launcher children use private host-owned lane state.
// Never point test launches at the operator's live state directory.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'wt-lane-host-suite-'))
process.env.WT_LANE_HOST_STATE = root

afterAll(() => {
  // Detached fixture workers can still be finishing; do not race their writes
  // or fail a successful test while removing the worker's private state.
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  }
})
