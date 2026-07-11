// Locks the RESOLUTION side of the portable spawn (cross-OS I3, review finding):
// spawnServer runs `node + require.resolve('tsx/cli')` — the exec path is not
// exercised by unit tests (it drives a real child process), so THIS test at least
// pins that the resolved entry exists in the current checkout. A tsx major bump
// changing its exports map fails HERE instead of as a live `wt-observe start` hang.
// (The vite-watcher half of this lock lives with the server, in the Workflow
// Observatory repo — the app is no longer part of this workspace.)
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
})
