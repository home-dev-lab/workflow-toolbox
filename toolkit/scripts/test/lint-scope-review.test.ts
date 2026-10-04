import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain .mjs script without declarations
import * as scope from '../lint-scope.mjs'
// @ts-expect-error -- plain .mjs gate without declarations
import * as lint from '../lint-gate.mjs'
// @ts-expect-error -- plain .mjs gate without declarations
import * as quality from '../quality-root-gate.mjs'
// @ts-expect-error -- plain .mjs config without declarations
import * as config from '../../eslint.config.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(import.meta.url)
// ESLint's own glob implementation, with the same dot-inclusive matching options.
const { minimatch } = createRequire(require.resolve('eslint'))('minimatch') as {
  minimatch: (path: string, glob: string, options: { dot: boolean }) => boolean
}
type Pass = { name: string; gate: string; cwd: string; targets: string[] }

describe('review locks for effective gate scope', () => {
  it('requires both target selection and ESLint configuration on the real tree', async () => {
    const isLinted = scope.makeIsLinted(ROOT)
    for (const file of ['plugin/bin/lib/vendor/yaml.mjs', 'plugin/bin/git-hooks/pre-push', 'plugins/x/foo.ts', 'probes/new.ts', 'plugin/hooks/other-cli']) {
      expect(await isLinted(file), `${file}: excluded or unselected source must not be linted`).toBe(false)
    }
    for (const file of ['plugin/hooks/snapshot-cli', 'probes/host-platform/probe-lib.mjs', 'toolkit/.dependency-cruiser.cjs']) {
      expect(await isLinted(file), file).toBe(true)
    }
    const result = await scope.classifyTrackedFiles(scope.listTrackedFiles(ROOT), isLinted, config.LINT_SCOPE_EXCLUSIONS)
    for (const file of ['plugin/bin/lib/vendor/yaml.mjs', 'plugin/bin/git-hooks/pre-push']) {
      expect(result.excluded.map((entry: { file: string }) => entry.file)).toContain(file)
    }
  }, 120_000)

  it.each(['lint-scope.mjs', 'lint-gate.mjs', 'quality-root-gate.mjs'])('runs %s through a linked entrypoint', (script) => {
    const root = mkdtempSync(join(tmpdir(), 'wt-linked-gate-'))
    // A directory junction needs no Windows symlink privilege; argv still differs from the canonical file.
    const link = join(root, 'scripts')
    try {
      symlinkSync(join(ROOT, 'toolkit/scripts'), link, process.platform === 'win32' ? 'junction' : 'dir')
      const result = spawnSync(process.execPath, [join(link, script), '--help'], { encoding: 'utf8', timeout: 120_000 })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout, `${script}: linked entrypoint silently did nothing`).toContain(`usage: ${script}`)
    } finally {
      unlinkSync(link)
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('fails the lint exit decision for escaped sources and preserves pass failures', () => {
    expect(lint.lintExitCode, 'lint gate must centralize its exit decision').toBeTypeOf('function')
    expect(lint.lintExitCode(0, { escaped: ['probes/escaped.ts'] })).toBe(1)
    expect(lint.lintExitCode(0, { escaped: [] })).toBe(0)
    expect(lint.lintExitCode(2, { escaped: [] })).toBe(2)
  })

  it('fails the quality exit decision on area errors but permits warnings', () => {
    expect(quality.qualityExitCode, 'quality gate must centralize its exit decision').toBeTypeOf('function')
    expect(quality.qualityExitCode(0, [{ errors: 1, warnings: 0 }])).toBe(1)
    expect(quality.qualityExitCode(0, [{ errors: 0, warnings: 5000 }])).toBe(0)
    expect(quality.qualityExitCode(2, [{ errors: 0, warnings: 0 }])).toBe(2)
  })

  it('refuses an escaped tracked source from the scope CLI in an isolated git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-scope-cli-'))
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    try {
      mkdirSync(join(root, 'toolkit/scripts'), { recursive: true })
      writeFileSync(join(root, 'toolkit/scripts/lint-scope.mjs'), '// inventory witness\n')
      writeFileSync(join(root, 'toolkit/eslint.config.mjs'), "export default [{ files: ['**/*.mjs'], rules: {} }]\n")
      writeFileSync(join(root, 'escaped.zig'), 'const source = 1;\n')
      for (const args of [['init', '--quiet'], ['add', '--', 'toolkit/scripts/lint-scope.mjs', 'escaped.zig']]) {
        const git = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
        expect(git.status, git.stderr).toBe(0)
      }
      const result = spawnSync(process.execPath, [join(ROOT, 'toolkit/scripts/lint-scope.mjs'), '--root', root], { env, encoding: 'utf8', timeout: 120_000 })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
      expect(result.stderr).toContain('escaped: escaped.zig')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('gives all real-area and on-disk witness locks a generous timeout', () => {
    const text = readFileSync(join(ROOT, 'toolkit/scripts/test/lint-scope.test.ts'), 'utf8')
    const section = text.slice(text.indexOf("describe('widened quality passes"))
    expect(section.match(/}, 120_000\)/g), 'each of the three area/witness groups needs an explicit 120s timeout').toHaveLength(3)
  })

  it('unlinks every toolkit fixture before recursive root cleanup', () => {
    const text = readFileSync(join(ROOT, 'toolkit/scripts/test/lint-scope.test.ts'), 'utf8')
    const cleanups = [...text.matchAll(/finally \{([^}]+)\}/g)]
    expect(cleanups).toHaveLength(2)
    for (const [, cleanup] of cleanups) {
      expect(cleanup, 'remove the junction itself before recursively deleting its parent').toMatch(/unlinkSync\(join\(root, 'toolkit'\)\)[\s\S]*rmSync\(root/)
    }
  })

  it('applies the shipped warning policy and CommonJS correctness floor to snapshot-cli', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-snapshot-policy-'))
    const link = join(root, 'toolkit')
    try {
      symlinkSync(join(ROOT, 'toolkit'), link, process.platform === 'win32' ? 'junction' : 'dir')
      mkdirSync(join(root, 'plugin/hooks'), { recursive: true })
      const file = join(root, 'plugin/hooks/snapshot-cli')
      writeFileSync(file, 'const planted = 1\nundefinedName()\nif (module.exports) {}\n')
      const eslint = new ESLint({ cwd: root, overrideConfigFile: join(link, 'eslint.config.mjs') })
      const [result] = await eslint.lintFiles([file])
      for (const rule of ['no-unused-vars', 'no-undef']) expect(result!.messages.find((entry) => entry.ruleId === rule)?.severity, rule).toBe(2)
      expect(result!.messages.find((entry) => entry.ruleId === 'no-empty')?.severity, 'empty block must warn, not fail correctness').toBe(1)
      expect(result!.fatalErrorCount).toBe(0)
      expect((await eslint.calculateConfigForFile(file))?.languageOptions.sourceType).toBe('commonjs')
    } finally {
      unlinkSync(link)
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('matches dotfiles and dot-directories using ESLint dot-inclusive glob semantics', () => {
    for (const file of ['probes/.hidden.mjs', 'probes/.private/a.js', 'probes/a/.hidden.js']) {
      expect(scope.globToRegExp('probes/**/*.{mjs,js}').test(file), file).toBe(true)
    }
    const files = [...scope.listTrackedFiles(ROOT), 'plugins/.new/.hidden.mjs', 'toolkit/.private/.check.ts']
    for (const pass of scope.GATE_PASSES as Pass[]) for (const target of pass.targets) {
      const glob = pass.cwd === 'toolkit' ? 'toolkit/**' : target
      const selects = scope.makeTargetSelector(pass, target)
      expect(files.filter((file) => selects(file) !== minimatch(file, glob, { dot: true })), glob).toEqual([])
    }
  })

  it('declares data exclusions with reasons in the ESLint config, including source-looking text fixtures', async () => {
    expect(config.LINT_SCOPE_DATA, 'data policy belongs in the reason-bearing ESLint config').toBeDefined()
    for (const group of config.LINT_SCOPE_DATA) expect(group.reason.trim()).not.toBe('')
    const textGroup = config.LINT_SCOPE_DATA.find((group: { extensions?: string[] }) => group.extensions?.includes('txt'))
    expect(textGroup.reason).toMatch(/\.mjs\.txt.*\.js\.txt/)
    expect(await scope.classifyTrackedFiles(['fixture.mjs.txt', 'fixture.js.txt'], () => false, [])).toEqual({ covered: [], excluded: [], escaped: [] })
  })

  it('requires the lint-scope inventory witness even after a successful git command', () => {
    for (const stdout of ['', 'probes/only.mjs\0']) {
      expect(() => scope.listTrackedFiles(ROOT, () => ({ status: 0, stdout })), 'a partial or empty inventory must fail closed').toThrow('toolkit/scripts/lint-scope.mjs')
    }
  })

  it('counts every tracked marketplace/probe source directory and discovers a newly added area', async () => {
    const files = scope.listTrackedFiles(ROOT)
    const directories = new Set(files.filter((file: string) => /^(plugins|probes)\/[^/]+\/.*\.(mjs|js)$/.test(file)).map((file: string) => file.split('/').slice(0, 2).join('/')))
    const coveredByQuality = (file: string, passes: Pass[]) => passes.filter((pass) => pass.gate === 'quality').some((pass) => pass.targets.some((target) => scope.globToRegExp(target).test(file)))
    for (const directory of directories) for (const file of files.filter((file: string) => file.startsWith(`${directory}/`) && /\.(mjs|js)$/.test(file))) {
      expect(coveredByQuality(file, scope.GATE_PASSES), file).toBe(true)
    }
    expect(scope.qualityAreaPasses, 'area counts must be discovered from the tracked inventory').toBeTypeOf('function')
    const next = 'plugins/new-marketplace/hooks/check.mjs'
    const areaPasses = scope.qualityAreaPasses([...files, next])
    expect(areaPasses.some((pass: Pass) => pass.name === 'area:plugins/new-marketplace' && pass.targets.some((target) => scope.globToRegExp(target).test(next)))).toBe(true)
    const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, 'toolkit/eslint.config.mjs') })
    const nextConfig = await eslint.calculateConfigForFile(join(ROOT, next))
    expect(nextConfig?.rules['sonarjs/cognitive-complexity']?.[0]).toBe(1)
    expect(nextConfig?.rules['complexity']?.[0]).toBe(1)
    expect(nextConfig?.rules['no-undef']?.[0]).toBe(2)
  }, 120_000)
})
