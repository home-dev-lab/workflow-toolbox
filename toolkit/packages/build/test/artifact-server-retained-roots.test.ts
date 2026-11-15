import { spawn, type SpawnOptions } from 'node:child_process'
import { afterEach, it } from 'vitest'
// @ts-expect-error the standalone Node regression cases also run under Vitest
import { registerRetainedRootIntegrationTests } from './artifact-server-retained-roots.selftest.mjs'

registerRetainedRootIntegrationTests({ test: it, afterEach,
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => spawn(command, args, options),
})
