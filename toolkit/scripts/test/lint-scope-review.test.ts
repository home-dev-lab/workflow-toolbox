import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
type GateResult = { status: number | null; signal?: string; error?: { message: string } }

function runDiagnosticGate(script: string, kind: string[], result: GateResult, failedAt = 0, areaErrors = 0) {
  const target = join(ROOT, 'toolkit/scripts', script)
  const setup = script === 'quality-root-gate.mjs' ? `
    await import(${JSON.stringify(pathToFileURL(join(ROOT, 'toolkit/scripts/lint-scope.mjs')).href)});
    const {ESLint} = await import('eslint');
    ESLint.prototype.lintFiles = async () => [{warningCount:30,errorCount:${areaErrors}}];
    ESLint.prototype.loadFormatter = async () => ({format:()=>''});
  ` : ''
  const bootstrap = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    ${setup}
    let count=0;
    cp.spawnSync=(command,args)=>{
      process.stdout.write('STAGE='+JSON.stringify([command,...args])+'\\n');
      return count++ === ${failedAt} ? ${JSON.stringify(result)} : {status:0};
    };
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(target)},...${JSON.stringify(kind)}];
    await import(${JSON.stringify(pathToFileURL(target).href)});
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: join(ROOT, 'toolkit'), encoding: 'utf8', timeout: 20_000,
  })
}

const QUALITY_STAGES = ['scripts/skill-size-check.mjs', 'quality:lint', 'quality:changed', 'quality:host', 'quality:dup', 'quality:dead', 'quality:deps']

describe('quality failure diagnostics', () => {
  it.each(QUALITY_STAGES)('names the failing quality stage %s and stops there', (stage) => {
    const index = QUALITY_STAGES.indexOf(stage)
    const result = runDiagnosticGate('script-gates.mjs', ['quality'], { status: 7 }, index)
    expect(result.status, result.stderr).toBe(7)
    expect(result.stderr.trim().split('\n').at(-1)).toContain(`${stage} (exit code 7)`)
    expect(result.stdout.trim().split('\n')).toHaveLength(index + 1)
  })

  it.each([
    { result: { status: null, error: { message: 'fixture command unavailable' } }, code: 2, reason: 'spawn error: fixture command unavailable' },
    { result: { status: null, signal: 'SIGTERM' }, code: 1, reason: 'signal SIGTERM' },
    { result: { status: null }, code: 1, reason: 'no exit status' },
  ])('names the stage and reason for abnormal termination: $reason', ({ result: outcome, code, reason }) => {
    const result = runDiagnosticGate('script-gates.mjs', ['quality'], outcome, 1)
    expect(result.status, result.stderr).toBe(code)
    expect(result.stderr.trim().split('\n').at(-1)).toContain(`quality:lint (${reason})`)
    expect(result.stdout.trim().split('\n')).toHaveLength(2)
  })

  it('keeps all seven successful stages green without a failure message', () => {
    const result = runDiagnosticGate('script-gates.mjs', ['quality'], { status: 0 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(7)
  })
})

describe('lint ratchet failure diagnostics', () => {
  it('summarizes the failed ratchet after printing the warning-only areas', () => {
    const result = runDiagnosticGate('quality-root-gate.mjs', ['lint'], { status: 1 })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout).toContain('warn-only; a follow-up sets its ratchet')
    expect(result.stderr.trim().split('\n').at(-1)).toBe('quality:lint failed: ratchet (exit code 1; max-warnings 685)')
  })

  it('names correctness errors in every warn-first area', () => {
    const result = runDiagnosticGate('quality-root-gate.mjs', ['lint'], { status: 0 }, 0, 1)
    expect(result.status, result.stderr).toBe(1)
    for (const pass of scope.GATE_PASSES.filter((pass: Pass & { warnOnly?: boolean }) => pass.warnOnly)) {
      expect(result.stderr).toContain(`${pass.name} (1 errors)`)
    }
  })

  it('keeps area warnings advisory when the ratchet passes', () => {
    const result = runDiagnosticGate('quality-root-gate.mjs', ['lint'], { status: 0 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('30 warnings, 0 errors')
    expect(result.stderr).toBe('')
  })

  it('keeps run-ID validation within the warning ratchet', async () => {
    const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, 'toolkit/eslint.config.mjs') })
    const results = await eslint.lintFiles(['plugin/bin/lib/crossos-dispatch.mjs'])
    const warnings = results.flatMap((result) => result.messages).filter((message) => message.ruleId === 'sonarjs/concise-regex')
    expect(warnings, 'run-ID digit class must not consume a ratcheted warning').toEqual([])
  })
})

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

})

describe('review locks for effective gate scope', () => {
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

})

describe('review locks for effective gate scope', () => {
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

})

describe('review locks for effective gate scope', () => {
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

})

describe('review locks for effective gate scope', () => {
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
