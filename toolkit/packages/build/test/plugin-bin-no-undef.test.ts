import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain .mjs script without type declarations
import { lintPasses, PLUGIN_LINT_TARGETS } from '../../../scripts/lint-gate.mjs'
// @ts-expect-error -- plain .js plugin module without type declarations
import { SNAPSHOT_PROGRAM } from '../../../../plugin/hooks/snapshot-program.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/[\\/]$/, '')
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
// These tests lock what must stay true for that to hold: the gate runs the root pass; every
// plugin script found on disk is selected by the gate's globs AND linted with both rules at
// error; the collector program embedded as text in snapshot-program.js is checked too; and the
// real config turns an undefined reference in plugin/bin/lib into an error.

// Paths the config deliberately leaves out, each for a stated reason in eslint.config.mjs:
// test fixtures, and a vendored byte-identity-checked artifact whose generator is linted.
const DELIBERATE_EXCLUSIONS = [
  (path: string) => path.split('/').includes('fixtures'),
  (path: string) => path === 'plugin/bin/lib/vendor/yaml.mjs',
]

// The inventory is built from the disk, independently of the gate's own target list, so that
// dropping a glob from the gate leaves files unselected instead of shrinking the expectation.
function pluginScriptsOnDisk(): string[] {
  const found: string[] = []
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const child = posix.join(relative, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (/\.(?:m?js|cjs)$/.test(entry.name)) found.push(child)
    }
  }
  walk('plugin')
  walk('plugins')
  return found.sort()
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
    const plugin = passes.find((pass) => pass.cwd.replace(/[\\/]$/, '') === REPO_ROOT)
    expect(plugin, JSON.stringify(passes.map((pass) => pass.cwd))).toBeDefined()
    expect(plugin!.args).toContain('toolkit/eslint.config.mjs')
    for (const target of PLUGIN_LINT_TARGETS as string[]) expect(plugin!.args).toContain(target)

    const pkg = JSON.parse(readFileSync(join(TOOLKIT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.lint).toContain('scripts/lint-gate.mjs')
  })

  it('selects and lints every plugin script on disk with no-undef and no-unused-vars at error', async () => {
    const scripts = pluginScriptsOnDisk()
    const targets = PLUGIN_LINT_TARGETS as string[]
    const eslint = rootLinter()
    const unselected: string[] = []
    const ignored: string[] = []
    const weak: string[] = []
    const perDirectory: Record<string, number> = {}
    for (const path of scripts) {
      if (DELIBERATE_EXCLUSIONS.some((excluded) => excluded(path))) continue
      if (!targets.some((target) => posix.matchesGlob(path, target))) {
        unselected.push(path)
        continue
      }
      const absolute = join(REPO_ROOT, path)
      if (await eslint.isPathIgnored(absolute)) {
        ignored.push(path)
        continue
      }
      const config = await eslint.calculateConfigForFile(absolute)
      for (const rule of ['no-undef', 'no-unused-vars']) {
        if (severity(config.rules?.[rule]) !== 2) weak.push(`${path} ${rule}=${JSON.stringify(config.rules?.[rule])}`)
      }
      const key = path.split('/').slice(0, 2).join('/')
      perDirectory[key] = (perDirectory[key] ?? 0) + 1
    }
    expect(unselected).toEqual([])
    expect(ignored).toEqual([])
    expect(weak).toEqual([])
    // Every directory adopters run scripts from is represented; a walk or glob that silently
    // stopped reaching one of them would drop its count to zero.
    for (const directory of ['plugin/bin', 'plugin/hooks', 'plugin/hooks-modules', 'plugin/skills', 'plugin/workflows', 'plugins/wt-deep-search', 'plugins/wt-rules-on-demand', 'plugins/wt-secret-guard']) {
      expect(perDirectory[directory] ?? 0, JSON.stringify(perDirectory)).toBeGreaterThan(0)
    }
  })

  // The collector in snapshot-program.js is source TEXT: hooks.js runs it through
  // `Function('require', 'laneHostDir', 'ensureLaneHostDir', SNAPSHOT_PROGRAM)`, so no lint of
  // the file reads inside it. Lint it here as the function body it becomes.
  //
  // Only the two correctness rules run, with the settings and globals the REAL config resolves
  // for a plugin script at that path: the full rule set (sonarjs, complexity) on a 1600-line
  // body took ~5 s per lint on an idle machine and timed out under full-suite load.
  it('finds no undefined reference or unused binding in the embedded snapshot collector', async () => {
    const filePath = join(REPO_ROOT, 'plugin/hooks/snapshot-collector.virtual.js')
    const real = await rootLinter().calculateConfigForFile(filePath)
    expect(severity(real.rules?.['no-undef'])).toBe(2)
    expect(severity(real.rules?.['no-unused-vars'])).toBe(2)
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: [{
        files: ['**/*.js'],
        languageOptions: {
          ecmaVersion: real.languageOptions.ecmaVersion,
          sourceType: real.languageOptions.sourceType,
          globals: real.languageOptions.globals,
        },
        rules: { 'no-undef': real.rules['no-undef'], 'no-unused-vars': real.rules['no-unused-vars'] },
      }],
    })
    const lint = async (parameters: string) => {
      const [result] = await eslint.lintText(`(function (${parameters}) {\n${SNAPSHOT_PROGRAM as string}\n});\n`, { filePath })
      return result!.messages.filter((message) => message.ruleId === 'no-undef' || message.ruleId === 'no-unused-vars')
    }
    expect(await lint('require, laneHostDir, ensureLaneHostDir')).toEqual([])
    // Control: without the injected names the same lint must report them, so a green result
    // above comes from the rules running on the program, not from the text being skipped.
    const withoutInjection = await lint('require')
    expect(withoutInjection.some((message) => message.severity === 2 && message.message.includes("'laneHostDir'"))).toBe(true)
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
