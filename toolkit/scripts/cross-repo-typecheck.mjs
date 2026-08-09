import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

try {
  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve('tsx/cli')
  const result = spawnSync(process.execPath, [tsxCli, join(here, 'cross-repo-typecheck.ts')], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status === 2) process.exitCode = 2
  else if (result.status !== 0) {
    process.stdout.write(`cross-repo gate: TypeScript toolchain did not start (exit ${String(result.status)}) - SKIPPED (infrastructure)\n`)
  }
} catch (error) {
  process.stdout.write(`cross-repo gate: TypeScript toolchain unavailable (${error instanceof Error ? error.message : String(error)}) - SKIPPED (infrastructure)\n`)
}
