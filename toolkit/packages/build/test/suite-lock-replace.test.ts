import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { it } from 'vitest'
// @ts-expect-error Executable shared scenarios have no TypeScript declarations.
import { replaceScenarios } from './helpers/suite-lock-replace-scenarios.mjs'

const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url))
const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
if (help.status !== 0 || !help.stdout.includes('--replace <ticket-number>')) throw new Error('CLI help must document queued replacement')
for (const [name, scenario] of Object.entries(replaceScenarios)) {
  it(name, () => (scenario as (cli: string) => Promise<void>)(cli))
}
