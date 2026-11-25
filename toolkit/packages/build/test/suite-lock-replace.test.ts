import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, it } from 'vitest'
import { suiteAdmissionFixture } from './helpers/suite-lock-admission-fixture.js'
// @ts-expect-error Executable shared scenarios have no TypeScript declarations.
import { replaceScenarios } from './helpers/suite-lock-replace-scenarios.mjs'
// @ts-expect-error Executable shared scenarios have no TypeScript declarations.
import { replacementFailureScenarios } from './helpers/suite-lock-replace-failure-scenarios.mjs'

const admission = suiteAdmissionFixture(fileURLToPath(new URL('../../../../plugin', import.meta.url)))
const cli = join(admission.plugin, 'bin/wt-suite-lock.mjs')
afterAll(() => admission.close())
const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
if (help.status !== 0 || !help.stdout.includes('--replace <ticket-number>')) throw new Error('CLI help must document queued replacement')
for (const [name, scenario] of Object.entries({ ...replaceScenarios, ...replacementFailureScenarios })) {
  it(name, () => (scenario as (cli: string) => Promise<void>)(cli))
}
