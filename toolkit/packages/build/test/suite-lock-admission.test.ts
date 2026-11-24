import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

for (const file of ['suite-lock-admission', 'suite-lock-admission-process', 'suite-lock-admission-comparison']) {
  it(`${file}: isolated admission regression locks`, () => {
    execFileSync(process.execPath, ['--test', fileURLToPath(new URL(`../../../test-support/${file}.selftest.mjs`, import.meta.url))], {
      encoding: 'utf8', timeout: 60_000,
    })
  }, 65_000)
}
