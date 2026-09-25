import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_USER_CONFIG_TYPES } from './fixtures/what-is-running/host-user-config-types.mjs'

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

// The offline selftest (fixtures/what-is-running/hooks.selftest.mjs) checks every plugin.json userConfig type against
// HOST_USER_CONFIG_TYPES, because the cross-os CI has no `claude` binary. That list is a copy of a host fact, so it
// is pinned here to the host itself: on 2026-09-25 it still read string/number/boolean while the host accepted
// `file` and `directory` too, and the selftest refused a manifest the host validator passed.
// Candidates probed besides the list itself: the documented five and plausible types a manifest author might try.
// Types OUTSIDE the list are what make this able to see a list that is too short, and the ones the host rejects are
// the control that shows the probe can say no.
const PROBED_USER_CONFIG_TYPES = ['string', 'number', 'boolean', 'directory', 'file', 'array', 'object', 'integer', 'path', 'url', 'select', 'enum']

describe('the userConfig type list the offline selftest uses matches the installed host validator', () => {
  it('accepts exactly HOST_USER_CONFIG_TYPES among the probed candidates, and rejects at least one', (context) => {
    if (unavailable) context.skip(unavailable)
    const root = mkdtempSync(join(tmpdir(), 'wt-usercfg-types-'))
    try {
      const verdicts: Record<string, string> = {}
      for (const type of [...new Set([...HOST_USER_CONFIG_TYPES, ...PROBED_USER_CONFIG_TYPES])]) {
        const dir = join(root, type, '.claude-plugin')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
          name: 'usercfg-type-probe',
          version: '0.0.0',
          description: 'probe',
          author: { name: 'probe' },
          userConfig: { probe_option: { type, title: 'Probe', description: 'Probe option' } },
        }))
        const run = spawnSync(CLAUDE, ['plugin', 'validate', join(root, type), '--strict'], { encoding: 'utf8', timeout: 120_000 })
        const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
        verdicts[type] = run.status === 0 && /Validation passed/.test(output)
          ? 'accepted'
          : /userConfig\.probe_option\.type/.test(output) ? 'rejected' : `unclassified (exit ${run.status}): ${output.trim()}`
      }
      const unclassified = Object.entries(verdicts).filter(([, verdict]) => verdict.startsWith('unclassified'))
      expect(unclassified).toEqual([])
      const accepted = Object.keys(verdicts).filter((type) => verdicts[type] === 'accepted').sort()
      expect(accepted, JSON.stringify(verdicts)).toEqual([...HOST_USER_CONFIG_TYPES].sort())
      expect(Object.values(verdicts)).toContain('rejected')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 300_000)
})
