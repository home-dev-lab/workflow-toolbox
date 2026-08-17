// opencode-plugin-root-resolution.test.ts — TEST-LOCK for the Workflow-tool (Path A) plugin-root
// defect measured on run wf_7d40d5d6-086.
//
// Defect: opencode-envelope.md and opencode-verifier.md located their wrapper script via
// `${CLAUDE_PLUGIN_ROOT:-$WT_PLUGIN_ROOT}`. An interactive session has CLAUDE_PLUGIN_ROOT; a
// Path B delegated session gets WT_PLUGIN_ROOT from the server. Under the Workflow tool
// (Path A), NEITHER is set — the path collapsed to "/bin/wt-opencode-envelope.mjs" and the
// agent died MODULE_NOT_FOUND, burning its whole maxTurns:3 budget on a `find` before it could
// even report the failure.
//
// A previous fix (card #1843083021113099568) introduced the two-variable fallback and was
// locked with a TEXT-CONTENT assertion (opencode-verifier-taskfile.test.ts). That lock passes
// today and says nothing about the Workflow tool, which is exactly how the regression shipped
// as Done — a string match on "the expansion looks right" is not evidence the expansion
// RESOLVES with both variables unset.
//
// This lock instead EXTRACTS the live shell expression from both agent definitions and RUNS it
// in bash with CLAUDE_PLUGIN_ROOT and WT_PLUGIN_ROOT deliberately unset, asserting it still
// resolves to the plugin's real content root — via the harness's own installed_plugins.json
// registry — and that the resolved path actually contains the wrapper script.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

const DEFS = [
  {
    label: 'plugin/agents/opencode-envelope.md',
    path: join(REPO_ROOT, 'plugin/agents/opencode-envelope.md'),
    // Extract the ${CLAUDE_PLUGIN_ROOT:-...} expression up to the wrapper script name.
    anchor: '/bin/wt-opencode-envelope.mjs"',
  },
  {
    label: 'plugin/launch-agents/agents/opencode-envelope.md',
    path: join(REPO_ROOT, 'plugin/launch-agents/agents/opencode-envelope.md'),
    anchor: '/bin/wt-opencode-envelope.mjs"',
  },
]

const VERIFIER_DEFS = [
  join(REPO_ROOT, 'plugin/agents/opencode-verifier.md'),
  join(REPO_ROOT, 'plugin/launch-agents/agents/opencode-verifier.md'),
]

/** Extract every `${CLAUDE_PLUGIN_ROOT:- ... }` expression that resolves the given wrapper
 * script name, as it literally appears inside a `node "<expr>/bin/<script>"` invocation. */
function extractPluginRootExprs(source: string, scriptName: string): string[] {
  const re = new RegExp(`node "(\\$\\{CLAUDE_PLUGIN_ROOT:-[^]*?)\\/bin\\/${scriptName}"`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) out.push(m[1]!)
  return out
}

/** Run `echo "<expr>"` in bash under a controlled env and return trimmed stdout. */
function resolveInBash(expr: string, env: NodeJS.ProcessEnv): { stdout: string; status: number | null } {
  const script = `RESOLVED="${expr}"\nprintf '%s' "$RESOLVED"`
  const res = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
  return { stdout: (res.stdout ?? '').trim(), status: res.status }
}

describe('opencode-envelope / opencode-verifier — plugin-root resolution under the Workflow tool', () => {
  if (process.platform === 'win32') {
    it.skip('bash-execution lock skipped on win32 (POSIX-only Bash-tool shell)', () => {})
    return
  }

  let fixtureRoot: string
  let configDir: string
  let legacyConfigDir: string
  let pluginContentRoot: string

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'wt-opencode-plugin-root-'))
    configDir = join(fixtureRoot, 'home', '.claude')
    pluginContentRoot = join(
      fixtureRoot,
      'cache',
      'workflow-toolbox',
      'workflow-toolbox',
      '9.9.9',
    )
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    mkdirSync(join(pluginContentRoot, 'bin'), { recursive: true })
    // The one file the resolved root must actually contain.
    writeFileSync(join(pluginContentRoot, 'bin', 'wt-opencode-envelope.mjs'), '// fixture\n')
    writeFileSync(join(pluginContentRoot, 'bin', 'wt-opencode-json-extractor.mjs'), '// fixture\n')
    // The REAL registry shape on this harness is v2: a `{version, plugins}` envelope, NOT a
    // flat map. An earlier fixture here wrote the flat shape — written from the same
    // understanding as the resolver it was checking, so the two agreed perfectly and were
    // both wrong about the machine. The resolver then threw on every real config dir while
    // this lock stayed green. Keep the envelope; a fixture that cannot exhibit the real
    // shape cannot reveal a defect in handling it.
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'workflow-toolbox@workflow-toolbox': [
            { scope: 'user', installPath: pluginContentRoot, version: '9.9.9' },
          ],
        },
      }),
    )

    // A second config dir carrying the LEGACY flat shape, so both branches of the
    // `j.plugins || j` fallback are exercised rather than one being assumed.
    legacyConfigDir = join(fixtureRoot, 'home-legacy', '.claude')
    mkdirSync(join(legacyConfigDir, 'plugins'), { recursive: true })
    writeFileSync(
      join(legacyConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        'workflow-toolbox@workflow-toolbox': [
          { scope: 'user', installPath: pluginContentRoot, version: '9.9.9' },
        ],
      }),
    )
  })

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  const noPluginRootEnv = () => {
    const env = { ...process.env }
    delete env.CLAUDE_PLUGIN_ROOT
    delete env.WT_PLUGIN_ROOT
    env.CLAUDE_CONFIG_DIR = configDir
    delete env.HOME // must not fall back to the real machine's ~/.claude
    return env
  }

  for (const def of DEFS) {
    describe(def.label, () => {
      const source = readFileSync(def.path, 'utf8')
      const exprs = extractPluginRootExprs(source, 'wt-opencode-envelope\\.mjs')

      it('the definition carries at least one CLAUDE_PLUGIN_ROOT-fallback expression', () => {
        expect(exprs.length).toBeGreaterThanOrEqual(1)
      })

      it('resolves to the real plugin content root with BOTH CLAUDE_PLUGIN_ROOT and WT_PLUGIN_ROOT unset (the Workflow-tool case)', () => {
        const expr = exprs[0]!
        const { stdout, status } = resolveInBash(expr, noPluginRootEnv())
        expect(status).toBe(0)
        expect(stdout).toBe(pluginContentRoot)
      })

      it('resolves against the LEGACY flat registry shape too (both branches of j.plugins||j)', () => {
        const expr = exprs[0]!
        const env = noPluginRootEnv()
        env.CLAUDE_CONFIG_DIR = legacyConfigDir
        const { stdout, status } = resolveInBash(expr, env)
        expect(status).toBe(0)
        expect(stdout).toBe(pluginContentRoot)
      })

      it('the resolved root actually contains the wrapper script (not just a plausible-looking path)', () => {
        const expr = exprs[0]!
        const { stdout } = resolveInBash(expr, noPluginRootEnv())
        const res = spawnSync('node', ['-e', `require('node:fs').accessSync(process.argv[1])`, `${stdout}/bin/wt-opencode-envelope.mjs`])
        expect(res.status).toBe(0)
      })

      it('still prefers CLAUDE_PLUGIN_ROOT when set (fast path unaffected, never touches installed_plugins.json)', () => {
        const expr = exprs[0]!
        const env = noPluginRootEnv()
        env.CLAUDE_PLUGIN_ROOT = '/interactive/session/plugin/root'
        // Point CLAUDE_CONFIG_DIR at a directory with NO installed_plugins.json — if the fast
        // path touched the registry at all this would fail loudly instead of resolving.
        env.CLAUDE_CONFIG_DIR = join(fixtureRoot, 'no-such-config-dir')
        const { stdout, status } = resolveInBash(expr, env)
        expect(status).toBe(0)
        expect(stdout).toBe('/interactive/session/plugin/root')
      })

      it('still prefers WT_PLUGIN_ROOT when set and CLAUDE_PLUGIN_ROOT is not (Path B, unaffected)', () => {
        const expr = exprs[0]!
        const env = noPluginRootEnv()
        env.WT_PLUGIN_ROOT = '/path-b/server/plugin/root'
        env.CLAUDE_CONFIG_DIR = join(fixtureRoot, 'no-such-config-dir')
        const { stdout, status } = resolveInBash(expr, env)
        expect(status).toBe(0)
        expect(stdout).toBe('/path-b/server/plugin/root')
      })
    })
  }

  for (const path of VERIFIER_DEFS) {
    const rel = path.slice(REPO_ROOT.length)
    describe(rel, () => {
      const source = readFileSync(path, 'utf8')
      const exprs = extractPluginRootExprs(source, 'wt-opencode-json-extractor\\.mjs')

      it('carries the extractor-resolving expression at least twice (happy path + 429-retry path)', () => {
        expect(exprs.length).toBeGreaterThanOrEqual(2)
      })

      it('EVERY occurrence resolves under the Workflow-tool case (both variables unset)', () => {
        for (const expr of exprs) {
          const { stdout, status } = resolveInBash(expr, noPluginRootEnv())
          expect(status).toBe(0)
          expect(stdout).toBe(pluginContentRoot)
        }
      })
    })
  }
})
