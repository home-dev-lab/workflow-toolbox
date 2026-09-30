import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain .mjs script without type declarations
import { lintPasses, PLUGIN_LINT_TARGETS } from '../../../scripts/lint-gate.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const TOOLKIT_ROOT = join(REPO_ROOT, 'toolkit')
const CONFIG_FILE = join(TOOLKIT_ROOT, 'eslint.config.mjs')

// The plugin scripts are `.mjs`/`.js` files that live OUTSIDE the toolkit, and adopters run
// them as they are: no type checker reads them, and `node --check` sees syntax only, so an
// undefined reference or a dangling binding reaches an adopter as a runtime ReferenceError.
//
// ESLint refuses to lint a file outside its base path, and `eslint .` run from toolkit/ has
// toolkit/ as base path — so for a long time the toolkit's lint gate read none of them. The
// gate now runs a second pass from the repository root (scripts/lint-gate.mjs) with the same
// config file, where `no-undef` and `no-unused-vars` are ERRORS for every shipped plugin script.
//
// These tests lock the three things that must stay true for that to hold: the gate still runs
// the root pass, every tracked plugin script is inside what that pass lints with both rules at
// error, and the real config still turns an undefined reference in plugin/bin/lib into an error.

// Paths the config deliberately leaves out, each for a stated reason in eslint.config.mjs:
// test fixtures, a vendored byte-identity-checked artifact, and a generated program.
const DELIBERATE_EXCLUSIONS = [
  (path: string) => path.includes('/fixtures/'),
  (path: string) => path === 'plugin/bin/lib/vendor/yaml.mjs',
  (path: string) => path === 'plugin/hooks/snapshot-program.js',
]

function trackedPluginScripts(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'plugin', 'plugins'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\0').filter((path) => /\.(?:m?js|cjs)$/.test(path))
}

function rootLinter() {
  return new ESLint({ cwd: REPO_ROOT, overrideConfigFile: CONFIG_FILE })
}

function severity(setting: unknown): number {
  const level = Array.isArray(setting) ? setting[0] : setting
  return level === 'error' || level === 2 ? 2 : level === 'warn' || level === 1 ? 1 : 0
}

describe('the lint gate covers every shipped plugin script', () => {
  it('runs a second pass from the repository root with the toolkit config', () => {
    const passes = lintPasses() as Array<{ name: string; cwd: string; args: string[] }>
    const plugin = passes.find((pass) => pass.cwd === REPO_ROOT.replace(/[\\/]$/, '') || pass.cwd === REPO_ROOT)
    expect(plugin, JSON.stringify(passes.map((pass) => pass.cwd))).toBeDefined()
    expect(plugin!.args).toContain('toolkit/eslint.config.mjs')
    for (const target of PLUGIN_LINT_TARGETS as string[]) expect(plugin!.args).toContain(target)

    const pkg = JSON.parse(readFileSync(join(TOOLKIT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.lint).toContain('scripts/lint-gate.mjs')
  })

  it('lints every tracked plugin script with no-undef and no-unused-vars at error', async () => {
    const scripts = trackedPluginScripts()
    // The gate's globs name .mjs and .js only; a .cjs script would fall outside them silently.
    expect(scripts.filter((path) => path.endsWith('.cjs'))).toEqual([])

    const eslint = rootLinter()
    const uncovered: string[] = []
    const weak: string[] = []
    const perDirectory: Record<string, number> = {}
    for (const path of scripts) {
      if (DELIBERATE_EXCLUSIONS.some((excluded) => excluded(path))) continue
      const absolute = join(REPO_ROOT, path)
      if (await eslint.isPathIgnored(absolute)) {
        uncovered.push(path)
        continue
      }
      const config = await eslint.calculateConfigForFile(absolute)
      for (const rule of ['no-undef', 'no-unused-vars']) {
        if (severity(config.rules?.[rule]) !== 2) weak.push(`${path} ${rule}=${JSON.stringify(config.rules?.[rule])}`)
      }
      const key = path.split('/').slice(0, 2).join('/')
      perDirectory[key] = (perDirectory[key] ?? 0) + 1
    }
    expect(uncovered).toEqual([])
    expect(weak).toEqual([])
    // Every directory adopters run scripts from is represented; a glob that silently stopped
    // matching one of them would drop its count to zero.
    for (const directory of ['plugin/bin', 'plugin/hooks', 'plugin/skills', 'plugins/wt-deep-search', 'plugins/wt-rules-on-demand', 'plugins/wt-secret-guard']) {
      expect(perDirectory[directory] ?? 0, JSON.stringify(perDirectory)).toBeGreaterThan(0)
    }
  })

  // The red proof, run on every suite: a check whose ability to fail is never exercised is
  // decoration. It lints mutated TEXT under a real plugin/bin/lib path, so the real config's
  // file matching decides the outcome, and no file on disk is ever rewritten (a suite that
  // mutates a real file leaves it mutated when interrupted, and tests that spawn these
  // scripts would read the broken version under a parallel run).
  it('reports an undefined reference in plugin/bin/lib as an error', async () => {
    // Reproduce the real defect shape: one side of a merge renames a function's DEFINITION and
    // the other side keeps calling the old name. Pick the first function defined in the file
    // and also called in it, rename only its definition, and expect its callers to dangle.
    const relative = 'plugin/bin/lib/suite-lock.mjs'
    const original = readFileSync(join(REPO_ROOT, relative), 'utf8')
    const victim = [...original.matchAll(/^(?:export )?function (\w+)\(/gm)]
      .map((match) => match[1]!)
      .find((name) => original.split(`${name}(`).length > 2)
    expect(victim, 'no function in the file is both defined and called').toBeDefined()
    const mutated = original.replace(new RegExp(`function ${victim}\\(`), `function ${victim}Renamed(`)
    expect(mutated).not.toBe(original)

    const eslint = rootLinter()
    const [clean] = await eslint.lintText(original, { filePath: join(REPO_ROOT, relative) })
    expect(clean!.messages.filter((message) => message.ruleId === 'no-undef')).toEqual([])

    const [result] = await eslint.lintText(mutated, { filePath: join(REPO_ROOT, relative) })
    const undefinedReferences = result!.messages.filter((message) => message.ruleId === 'no-undef')
    expect(undefinedReferences.length).toBeGreaterThan(0)
    expect(undefinedReferences.every((message) => message.severity === 2)).toBe(true)
    expect(undefinedReferences.map((message) => message.message).join('\n')).toContain(`'${victim}'`)
  })
})
