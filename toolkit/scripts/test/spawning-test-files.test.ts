import { describe, expect, it } from 'vitest'
import { checkSpawningTestFiles, scanSpawningTestFiles, spawningTestFiles } from '../spawning-test-files.mjs'

describe('process-spawning test scheduling', () => {
  it('keeps every mechanically detected test in the scheduling policy', () => {
    const result = checkSpawningTestFiles()
    expect(result.missing, `Add these files to spawningTestFiles:\n${result.missing.join('\n')}`).toEqual([])
    expect(result.stale, `Remove these stale files from spawningTestFiles:\n${result.stale.join('\n')}`).toEqual([])
    expect(scanSpawningTestFiles()).toEqual(spawningTestFiles)
  })
})
