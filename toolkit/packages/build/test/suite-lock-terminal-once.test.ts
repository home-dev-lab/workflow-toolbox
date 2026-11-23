import { spawn, type SpawnOptions } from 'node:child_process'
import { it } from 'vitest'
// @ts-expect-error executable JavaScript fixtures
import { setTerminalOnceSpawn, terminalOnceCases, withTerminalOnceRoot } from './suite-lock-terminal-once-cases.mjs'

// Keep process creation visible to the suite's process-spawning scheduler census.
setTerminalOnceSpawn((command: string, args: string[], options: SpawnOptions) => spawn(command, args, options))

for (const [name, run] of Object.entries(terminalOnceCases)) {
  it(name, () => withTerminalOnceRoot(run), 30_000)
}
