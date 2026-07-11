// Locks the RESOLUTION side of the portable spawns (cross-OS I3, review finding):
// spawnServer runs `node + require.resolve('tsx/cli')` and dev-api's watcher runs
// `node + <vite pkg root>/bin/vite.js` — neither exec path is exercised by unit tests
// (they drive real child processes), so THIS test at least pins that the resolved
// entries exist in the current checkout. A tsx major bump changing its exports map,
// or vite moving its bin, fails HERE instead of as a live `wt-observe start` hang.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
// test → debugger → packages → toolkit
const TOOLKIT = join(HERE, '..', '..', '..')

describe('portable spawn targets resolve in this checkout', () => {
  it("tsx/cli (spawnServer's target) resolves to an existing .mjs", () => {
    const tsxCli = createRequire(join(TOOLKIT, 'package.json')).resolve('tsx/cli')
    expect(existsSync(tsxCli)).toBe(true)
    expect(tsxCli.endsWith('.mjs')).toBe(true)
  })

  it("vite's own JS bin (the watcher's target) resolves from apps/observe-ui", () => {
    const appDir = join(TOOLKIT, 'apps', 'observe-ui')
    const vitePkg = createRequire(join(appDir, 'package.json')).resolve('vite/package.json')
    const viteBin = join(dirname(vitePkg), 'bin', 'vite.js')
    expect(existsSync(viteBin)).toBe(true)
  })
})
