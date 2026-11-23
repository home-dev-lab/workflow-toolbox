import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { it } from 'vitest'
// @ts-expect-error executable JavaScript fixtures
import { terminalReviewCases, withTerminalRoot } from './suite-lock-terminal-review-cases.mjs'

const spawnFixture = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => spawnSync(command, args, options)

for (const [name, run] of Object.entries(terminalReviewCases)) {
  it(name, () => withTerminalRoot((root: string) => (run as (root: string, spawn: typeof spawnFixture) => Promise<void>)(root, spawnFixture)))
}
