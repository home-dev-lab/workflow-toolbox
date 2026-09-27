// Every Vitest worker requests private host-owned lane state. In a child user namespace the
// override is deliberately ignored; fixtures must clean their own directories at the real root.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect } from 'vitest'
// @ts-expect-error ESM runtime module
import { laneHostStateRoot } from '../../plugin/bin/lib/host/lane-host-dir.mjs'
// @ts-expect-error ESM runtime module
import { insideChildUserNamespace } from '../../plugin/bin/lib/host/lane-sandbox.mjs'

const root = mkdtempSync(join(tmpdir(), 'wt-lane-host-suite-'))
process.env.WT_LANE_HOST_STATE = root
const overrideTookEffect = laneHostStateRoot() === root
expect(overrideTookEffect, 'WT_LANE_HOST_STATE override is effective exactly outside child user namespaces')
  .toBe(process.platform !== 'linux' || insideChildUserNamespace() === false)

afterAll(() => {
  // Detached fixture workers can still be finishing; do not race their writes
  // or fail a successful test while removing the worker's private state.
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  }
})
