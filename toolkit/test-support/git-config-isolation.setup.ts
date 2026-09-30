// git-config-isolation.setup.ts — no git process started during `pnpm test` reads the machine's
// global or system git configuration, or reaches the machine's SSH agent (card 1838017282).
//
// Why: a fixture commit that inherits a developer's global `commit.gpgsign=true` signs through the
// machine's real signer (for example a password-manager SSH agent), which sometimes does not answer. The test then
// fails with `No private key found for public key "<machine key>.pub"` under load and passes alone —
// a failure about the machine, never about the code. Two unrelated tests hit it
// (signatures-workflow-step, citation-marker-check); the dependency, not either test, is the defect.
//
// How: once per worker (a `setupFiles` module, like guard-journal-isolation.setup.ts), point
// GIT_CONFIG_GLOBAL at a suite-owned file and set GIT_CONFIG_NOSYSTEM. Per git(1), with
// GIT_CONFIG_GLOBAL set "neither $HOME/.gitconfig nor $XDG_CONFIG_HOME/git/config will be read", and
// GIT_CONFIG_NOSYSTEM skips $(prefix)/etc/gitconfig. Every child that inherits `process.env` — the
// test's own `spawnSync('git', …)` and any git the code under test starts — inherits the redirect.
// The file is a real path on every OS (no `/dev/null`, which is POSIX-only), and it carries the
// neutral author identity a fixture commit used to borrow from the global config.
// Command-line-level injections from the outer shell (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/KEY/VALUE)
// are removed for the same reason, and SSH_AUTH_SOCK is removed so that even a test that opts into
// SSH signing with a fixture `.pub` path cannot make ssh-keygen consult the machine agent.
//
// Opting back in: a test that must see other git configuration passes its own GIT_CONFIG_GLOBAL /
// HOME in the child env (signatures-workflow-step.test.ts does, with a fixture key) and says why.
// Repository-local config (`git config user.email …` inside a fixture repo) still applies unchanged.
// Locked by packages/build/test/git-config-isolation.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'wt-git-config-suite-'))
const globalConfig = join(dir, 'gitconfig')
writeFileSync(globalConfig, [
  '[user]',
  '\tname = Workflow Toolbox Test',
  '\temail = test@workflow-toolbox.invalid',
  '[commit]',
  '\tgpgsign = false',
  '[tag]',
  '\tgpgsign = false',
  '',
].join('\n'))

process.env.GIT_CONFIG_GLOBAL = globalConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'
delete process.env.GIT_CONFIG_PARAMETERS
for (const key of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete process.env[key]
}
delete process.env.SSH_AUTH_SOCK

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
