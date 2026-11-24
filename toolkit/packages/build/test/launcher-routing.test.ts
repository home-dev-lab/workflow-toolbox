import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// Keep the seconds-long, fake-host locks runnable with node --test in external lanes,
// and also include them in the ordinary toolkit suite and cross-platform certification.
it.each(['launcher-routing', 'launcher-wait', 'launcher-emitters', 'launcher-delivery', 'launcher-maildir', 'launcher-review', 'launcher-journal'])('%s standalone regression locks', (name) => {
  const file = fileURLToPath(new URL(`./${name}.node.test.mjs`, import.meta.url))
  const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 30_000 })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
})
