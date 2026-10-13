// claude-config-isolation.setup.ts — every test file runs with a suite-owned CLAUDE_CONFIG_DIR and no
// credential variable, so any `claude` a test or the code under test starts never reaches the developer's
// real config dir or login (see claude-config-isolation.ts for the incident and the second layer).
//
// Opting back in: a test that must exercise a real config dir builds its own fixture dir and passes it in
// the child env, never the developer's. A test that only READS host declarations shipped under the real config
// dir (no credential) finds that dir in WT_HOST_CLAUDE_CONFIG_DIR; never hand it to a child.
// Not covered (card 1885017225669117366): a test that rebuilds the env without CLAUDE_CONFIG_DIR (home fallback), the
// vitest parent and globalSetup, and anything that runs before this file.
// Locked by packages/build/test/claude-config-isolation.test.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { isCredentialKey } from './claude-config-isolation'

const dir = mkdtempSync(join(tmpdir(), 'wt-claude-suite-'))

process.env.WT_HOST_CLAUDE_CONFIG_DIR ??= process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
process.env.CLAUDE_CONFIG_DIR = dir
for (const key of Object.keys(process.env)) if (isCredentialKey(key)) delete process.env[key]

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
