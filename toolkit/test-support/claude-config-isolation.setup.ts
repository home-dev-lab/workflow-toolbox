// claude-config-isolation.setup.ts — every test worker runs with a suite-owned CLAUDE_CONFIG_DIR and no
// credential variable, so any `claude` a test or the code under test starts never reaches the developer's
// real config dir or login (see claude-config-isolation.ts for the incident and the second layer).
//
// Opting back in: a test that must exercise a real config dir builds its own fixture dir and passes it in
// the child env, never the developer's. Locked by packages/build/test/claude-config-isolation.test.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { CREDENTIAL_ENV_KEYS } from './claude-config-isolation'

const dir = mkdtempSync(join(tmpdir(), 'wt-claude-suite-'))

process.env.CLAUDE_CONFIG_DIR = dir
for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key]

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
