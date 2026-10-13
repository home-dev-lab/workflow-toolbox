// claude-config-isolation.ts — no `claude` process started by a test ever runs on the developer's real
// Claude Code config dir.
//
// Why: `claude` started with an inherited CLAUDE_CONFIG_DIR reads and REWRITES that dir's login file.
// A suite run from a developer's session inherited ~/.claude, ran `claude plugin validate`, and the
// login file of that config dir lost its tokens in the same second (2026-10-13). A test never needs a
// developer's login: the validator works offline, and a test that needs a model is not a unit test.
//
// Two layers, like git-config-isolation.setup.ts:
//   - claude-config-isolation.setup.ts points CLAUDE_CONFIG_DIR at a per-worker temporary dir and drops
//     the credential variables, so every child that inherits `process.env` is sealed by default;
//   - sealedClaudeEnv() builds an explicit env for a test that starts the real binary, so the seal holds
//     even if something upstream unset or replaced CLAUDE_CONFIG_DIR, and HOME points away from the
//     developer's home too (Claude Code falls back to ~/.claude and ~/.claude.json without the variable).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Variables that would let a child authenticate as the developer. None is needed to validate a plugin.
export const CREDENTIAL_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'] as const

export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of CREDENTIAL_ENV_KEYS) delete out[key]
  return out
}

export interface SealedClaudeEnv {
  env: NodeJS.ProcessEnv
  dir: string
  cleanup: () => void
}

// A fresh config dir and home for one or more spawns of the real `claude` binary.
export function sealedClaudeEnv(base: NodeJS.ProcessEnv = process.env): SealedClaudeEnv {
  const dir = mkdtempSync(join(tmpdir(), 'wt-claude-sealed-'))
  const config = join(dir, 'config')
  const home = join(dir, 'home')
  const env = { ...withoutCredentials(base), CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home }
  return { env, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
