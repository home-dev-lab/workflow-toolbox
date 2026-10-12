import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkSpawningTestFiles, scanSpawningTestFiles, spawningTestFiles } from '../spawning-test-files.mjs'
import { laneSandboxContext, noteInsideLaneSandbox } from '../../test-support/lane-sandbox-context.js'

const root = resolve(import.meta.dirname, '../..')
function omittedExportEntries(stale: string[], testName: string): string[] {
  const context = laneSandboxContext()
  if (!context.inside) return []
  const committed = spawnSync('git', ['show', 'HEAD:toolkit/scripts/spawning-test-files.mjs'], { cwd: resolve(root, '..'), encoding: 'utf8' })
  if (committed.status !== 0) return []
  return stale.filter((file) => {
    if (!committed.stdout.includes(`'${file}'`)) return false
    if (existsSync(resolve(root, file))) return false
    // Include HEAD as well as the index: deleting a tracked file must still fail this lock.
    const tracked = spawnSync('git', ['ls-files', '--with-tree=HEAD', '--error-unmatch', '--', `toolkit/${file}`], { cwd: resolve(root, '..'), encoding: 'utf8' })
    if (tracked.status !== 1) return false
    noteInsideLaneSandbox(`spawning-test-files.test.ts > ${testName}`, `configured entry present in the committed scheduling list but absent on disk and from git ls-files at HEAD: ${file}`, context)
    return true
  })
}

// A synchronous scan of every test file in the repository: seconds when idle, far longer beside a full
// suite. The default 20 s cap timed out once under that load (certification c4, 2026-09-18).
const WHOLE_TREE_SCAN_TIMEOUT_MS = 120_000

describe('process-spawning test scheduling', () => {
  it('does not exempt a nonexistent entry absent from the committed scheduling list', (ctx) => {
    const file = 'packages/build/test/nonexistent-scheduling-entry.test.ts'
    expect(existsSync(resolve(root, file))).toBe(false)
    expect(omittedExportEntries([file], ctx.task.name)).toEqual([])
  })

  it('keeps every mechanically detected test in the scheduling policy', (ctx) => {
    const result = checkSpawningTestFiles()
    expect(result.missing, `Add these files to spawningTestFiles:\n${result.missing.join('\n')}`).toEqual([])
    const omitted = omittedExportEntries(result.stale, ctx.task.name)
    const stale = result.stale.filter((file) => !omitted.includes(file))
    expect(stale, `Remove these stale files from spawningTestFiles:\n${stale.join('\n')}`).toEqual([])
    expect(scanSpawningTestFiles()).toEqual(spawningTestFiles.filter((file) => !omitted.includes(file)))
  }, WHOLE_TREE_SCAN_TIMEOUT_MS)
})
