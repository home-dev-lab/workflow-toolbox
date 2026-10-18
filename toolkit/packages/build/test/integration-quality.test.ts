import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error Node ESM host module
import { certifiedIndexDifference, cleanupCertification } from '../../../../plugin/bin/lib/host/integration-quality.mjs'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}))
const execute = vi.mocked(execFileSync)
const roots: string[] = []
afterEach(() => {
  execute.mockReset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('uses the same absolute Git executable for every certified index operation', () => {
  execute.mockReturnValueOnce('tree\n').mockReturnValueOnce('').mockReturnValueOnce('changed.mjs\0')
  const result = certifiedIndexDifference({ into: tmpdir(), certification: { temp: tmpdir() } })
  expect(result).toBe('changed.mjs\0')
  const calls = execute.mock.calls
  expect(calls).toHaveLength(3)
  expect(calls.every(([program]) => isAbsolute(String(program)))).toBe(true)
  expect(new Set(calls.map(([program]) => program)).size).toBe(1)
  expect(calls.map(([, args]) => args?.at(-1))).toEqual(['write-tree', 'tree', '-z'])
  expect(calls[1]?.[2]).toMatchObject({ env: { GIT_INDEX_FILE: join(tmpdir(), 'index'), GIT_NO_LAZY_FETCH: '1' } })
})

it('uses the resolved absolute Git executable for worktree cleanup including retries', () => {
  const temp = mkdtempSync(join(tmpdir(), 'wt-quality-cleanup-')); roots.push(temp)
  const checkout = join(temp, 'target'); mkdirSync(checkout)
  execute.mockImplementationOnce(() => { throw new Error('temporary lock') }).mockReturnValueOnce('')
  cleanupCertification({ certification: { root: temp, checkout, temp, registered: true } })
  expect(execute.mock.calls).toHaveLength(2)
  const [first, second] = execute.mock.calls
  expect(isAbsolute(String(first?.[0]))).toBe(true)
  expect(second).toEqual(first)
  expect(first?.[1]?.slice(-4)).toEqual(['worktree', 'remove', '--force', checkout])
  expect(first?.[2]).toMatchObject({ encoding: 'utf8', stdio: 'pipe', timeout: 120000 })
})
