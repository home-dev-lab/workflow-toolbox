import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
function invoke(command: string) {
  const module = pathToFileURL(join(ROOT, 'plugin/hooks-modules/pilot-guard/hooks/hooks.js')).href
  const code = `import(${JSON.stringify(module)}).then(async (guard) => { let handler; guard.register((event, filter, registered) => { if (event === 'tool.call') handler = registered }); console.log(JSON.stringify(await handler({ ui: { log: async () => {} } }, { command: ${JSON.stringify(command)} }, (event) => ({ allowed: event })))); })`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}

describe('SDK pilot Function Hook guard', () => {
  it('proves the loaded module can rewrite the measured harmless fixture', () => {
    expect(invoke('echo FH_ORIGINAL')).toEqual({ allowed: { command: 'echo FH_LOADED' } })
  })
  it('denies push, publish, merge, force, deletion, and recursive forced removal without retrying', () => {
    for (const command of ['git push origin card', 'pnpm publish', 'git merge develop', 'git push --force', 'git branch -D old', 'rm -rf tmp']) {
      expect(invoke(command)).toMatchObject({ deny: expect.stringContaining('wt-sdk-pilot-guard:') })
    }
  })
})
