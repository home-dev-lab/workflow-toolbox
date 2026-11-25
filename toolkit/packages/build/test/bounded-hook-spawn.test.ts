import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('bounds synchronous hook children at the OS boundary', () => {
  const script = fileURLToPath(new URL('./bounded-hook-spawn.selftest.mjs', import.meta.url))
  const result = spawnSync(process.execPath, ['--test', script], { encoding: 'utf8', timeout: 70_000, killSignal: 'SIGKILL' })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
}, 75_000)
