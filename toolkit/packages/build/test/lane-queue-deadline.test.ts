import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

function requirePasses(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined()
  expect(result.status, String(result.stdout) + result.stderr).toBe(0)
  expect(String(result.stdout)).toMatch(/(?:^|\n)[^\n]*\bpass [1-9]\d*(?:\r?\n|$)/)
  expect(String(result.stdout)).toMatch(/(?:^|\n)[^\n]*\bskipped 0(?:\r?\n|$)/)
}

it.each(['idle', 'preemptive', 'budget', 'replay', 'publish', 'total', 'authority', 'late', 'claim', 'pause', 'aggregate', 'renewal', 'evidence', 'transport', 'termination', 'verdict'])('locks %s lane deadlines through the real worker', (family) => {
  const selected = family === 'termination' ? './lane-termination-deadline.selftest.mjs' : ['authority', 'late', 'claim', 'pause', 'aggregate', 'renewal', 'evidence', 'transport', 'verdict'].includes(family) ? './lane-broker-deadline.selftest.mjs' : './lane-queue-deadline.selftest.mjs'
  const scripts = (family === 'total' ? [selected, './lane-broker-deadline.selftest.mjs'] : [selected]).map((name) => fileURLToPath(new URL(name, import.meta.url)))
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${family}:`, ...scripts], { encoding: 'utf8', timeout: 15_000 })
  requirePasses(result)
})

it('rejects an all-skipped or partially skipped successful Node run', () => {
  for (const source of ["test('fixture', {skip: true}, () => {})", "test('pass', () => {}); test('skip', {skip: true}, () => {})"]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {test} from 'node:test'; ${source}`], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(() => requirePasses(result)).toThrow()
  }
})

// Unix-socket integration is separate so portable families never accept skips.
it.skipIf(process.platform === 'win32')('locks native broker socket integration with positive passes and zero skips', () => {
  const script = fileURLToPath(new URL('./lane-broker-deadline.selftest.mjs', import.meta.url))
  requirePasses(spawnSync(process.execPath, ['--test', '--test-name-pattern=^native-', script], { encoding: 'utf8', timeout: 15_000 }))
})
