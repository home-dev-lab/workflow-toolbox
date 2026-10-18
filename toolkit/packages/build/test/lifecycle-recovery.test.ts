import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
// @ts-expect-error ESM selftest cases also run directly with Node
import { recoveryChecks } from './lifecycle-recovery.selftest.mjs'

const selftest = fileURLToPath(new URL('./lifecycle-recovery.selftest.mjs', import.meta.url))

it.each(Object.keys(recoveryChecks))('recovery regression %s', (name) => {
  const output = execFileSync(process.execPath, [selftest, name], { encoding: 'utf8' })
  expect(output).toContain(`${name} PASS`)
})
