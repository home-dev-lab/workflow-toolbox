import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The host validates a plugin's hooks module statically before it loads it, and refuses the WHOLE module
// on one call shape it does not accept. Measured 2026-09-23 on Claude Code 2.1.280: a `$.env.get(name)` with
// a variable name made wt-secret-guard load nothing in every real session, while its selftest - which
// imports the module under Node with a mocked `$` - stayed green for fifteen commits. So the host's own
// validator runs here, on every plugin this repository ships: `plugin/` and each folder under `plugins/`.
//
// Where the `claude` binary is not available (a clean environment, the cross-os CI matrix, which installs
// only Node and pnpm), every case is SKIPPED WITH ITS REASON, never passed. `WT_CLAUDE_BIN` names another
// binary.

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLAUDE = process.env.WT_CLAUDE_BIN || 'claude'

const pluginDirs = [
  join(REPO_ROOT, 'plugin'),
  ...readdirSync(join(REPO_ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(REPO_ROOT, 'plugins', entry.name)),
].filter((dir) => existsSync(join(dir, '.claude-plugin', 'plugin.json')))

const probe = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 30_000 })
const unavailable = probe.error
  ? `the \`${CLAUDE}\` binary is not available here (${(probe.error as NodeJS.ErrnoException).code ?? probe.error.message}); the host validator cannot run, so no plugin is certified loadable by this run`
  : probe.status !== 0
    ? `\`${CLAUDE} --version\` exited ${probe.status}; the host validator cannot be trusted here`
    : null

describe('every shipped plugin passes the host validator (claude plugin validate --strict)', () => {
  it('finds the plugins it must validate', () => {
    expect(pluginDirs.map((dir) => relative(REPO_ROOT, dir).replaceAll('\\', '/'))).toEqual(expect.arrayContaining(['plugin', 'plugins/wt-secret-guard']))
  })

  for (const dir of pluginDirs) {
    const name = dir.slice(REPO_ROOT.length)
    it(`${name} is accepted by the host validator`, (context) => {
      if (unavailable) context.skip(unavailable)
      const run = spawnSync(CLAUDE, ['plugin', 'validate', dir, '--strict'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      expect(run.error, output).toBeUndefined()
      expect(run.status, output).toBe(0)
      expect(output).toMatch(/Validation passed/)
    }, 180_000)
  }
})
