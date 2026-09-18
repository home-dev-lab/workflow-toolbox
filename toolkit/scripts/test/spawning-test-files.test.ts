import { describe, expect, it } from 'vitest'
import { checkSpawningTestFiles, scanSpawningTestFiles, spawningTestFiles } from '../spawning-test-files.mjs'

// A synchronous scan of every test file in the repository: seconds when idle, far longer beside a full
// suite. The default 20 s cap timed out once under that load (certification c4, 2026-09-18).
const WHOLE_TREE_SCAN_TIMEOUT_MS = 120_000

describe('process-spawning test scheduling', () => {
  it('keeps every mechanically detected test in the scheduling policy', () => {
    const result = checkSpawningTestFiles()
    expect(result.missing, `Add these files to spawningTestFiles:\n${result.missing.join('\n')}`).toEqual([])
    expect(result.stale, `Remove these stale files from spawningTestFiles:\n${result.stale.join('\n')}`).toEqual([])
    expect(scanSpawningTestFiles()).toEqual(spawningTestFiles)
  }, WHOLE_TREE_SCAN_TIMEOUT_MS)
})
