import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ESLint, type Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain .mjs script without type declarations
import { classifyTrackedFiles, GATE_PASSES, globToRegExp, listTrackedFiles, makeIsLinted, makeTargetSelector } from '../lint-scope.mjs'
// @ts-expect-error -- plain .mjs config without type declarations
import { LINT_SCOPE_EXCLUSIONS } from '../../eslint.config.mjs'
// @ts-expect-error -- plain .mjs script without type declarations
import { runAreaPass } from '../quality-root-gate.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(import.meta.url)
const { minimatch } = createRequire(require.resolve('eslint'))('minimatch') as {
  minimatch: (path: string, glob: string, options: { dot: boolean }) => boolean
}
type Pass = { gate: string; name: string; cwd: string; targets: string[]; maxWarnings?: number; warnOnly?: boolean }
type Exclusion = { glob: string; reason: string }
const passes = GATE_PASSES as Pass[]
const exclusions = LINT_SCOPE_EXCLUSIONS as Exclusion[]

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr)
  return result.stdout.split('\0').filter(Boolean)
}

function linkToolkit(root: string): void {
  symlinkSync(join(ROOT, 'toolkit'), join(root, 'toolkit'), process.platform === 'win32' ? 'junction' : 'dir')
}

function areaPass(areaName: string): Pass {
  return passes.find((pass) => pass.name === `area:${areaName}`)!
}

const WITNESSES = ['__witness__.mjs', '__witness__.js', '__parse__.mjs', '__parse__.js']

function plantWitnesses(root: string, directory: string): void {
  for (const file of WITNESSES) {
    writeFileSync(join(root, directory, file), file.startsWith('__parse__') ? 'return 1\n' : 'const planted = 1\nundefinedName()\n')
  }
}

function expectWitnessFault(result: { results: ESLint.LintResult[] }, where: { root: string; directory: string; areaName: string }, file: string): void {
  const { root, directory, areaName } = where
  const found = result.results.find((entry: ESLint.LintResult) => entry.filePath === join(root, directory, file))
  expect(found, `${areaName}/${file}: widened pass did not read this file`).toBeDefined()
  expect(found!.errorCount, `${areaName}/${file}: planted fault went green`).toBeGreaterThan(0)
  if (file.startsWith('__parse__')) expect(found!.fatalErrorCount).toBeGreaterThan(0)
  else {
    for (const rule of ['no-unused-vars', 'no-undef']) {
      expect(found!.messages.some((message: Linter.LintMessage) => message.ruleId === rule && message.severity === 2), `${areaName}/${file}: missing ${rule} error`).toBe(true)
    }
  }
}

async function expectWarnFirstConfig(root: string, directory: string, areaName: string): Promise<void> {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'toolkit/eslint.config.mjs') })
  for (const extension of ['mjs', 'js']) {
    const config = await eslint.calculateConfigForFile(join(root, directory, `__witness__.${extension}`))
    expect(config?.rules['sonarjs/cognitive-complexity'], `${areaName}: sonar block missing`).toEqual([1, 282])
    for (const rule of ['complexity', 'max-lines', 'max-lines-per-function', 'max-depth', 'max-params']) {
      expect(config?.rules[rule]?.[0], `${areaName}: ${rule} must warn`).toBe(1)
    }
    expect(config?.rules['no-undef']?.[0]).toBe(2)
    expect(config?.rules['workflow-toolbox/no-dynamic-replace']?.[0]).toBe(2)
  }
}

describe('fail-closed tracked lint scope', () => {
  it.each(['missing.mjs', 'missing.py', 'missing.zig', 'hooks/new-hook'])('refuses an uncovered source: %s', async (file) => {
    expect((await classifyTrackedFiles([file], () => false, [])).escaped).toEqual([file])
  })

  it('recognizes only declared data extensions and exact extensionless basenames', async () => {
    const files = ['guide.md', 'rows.jsonl', '.gitignore', '.gitattributes', 'LICENSE', '.github/allowed_signers']
    expect(await classifyTrackedFiles(files, () => false, [])).toEqual({ covered: [], excluded: [], escaped: [] })
    expect((await classifyTrackedFiles(['LICENSE-extra', 'new-dotfile', '.new-dotfile'], () => false, [])).escaped)
      .toEqual(['LICENSE-extra', 'new-dotfile', '.new-dotfile'])
  })

  it('carries the first justified exclusion and gives real coverage precedence', async () => {
    const rules = [{ glob: '**/*.py', reason: 'language-server fixture' }, { glob: '**/*', reason: 'second' }]
    expect(await classifyTrackedFiles(['probe.py'], () => false, rules)).toEqual({
      covered: [], excluded: [{ file: 'probe.py', reason: 'language-server fixture' }], escaped: [],
    })
    expect(await classifyTrackedFiles(['probe.py'], () => true, rules)).toEqual({ covered: ['probe.py'], excluded: [], escaped: [] })
    await expect(classifyTrackedFiles(['probe.py'], () => false, [{ glob: '**/*.py', reason: ' ' }])).rejects.toThrow('reason')
  })

  it('has no escaped source on the git-tracked real tree', async () => {
    const result = await classifyTrackedFiles(trackedFiles(), makeIsLinted(ROOT), exclusions)
    expect(result.escaped, `Tracked sources escaped all gates:\n${result.escaped.join('\n')}`).toEqual([])
    expect(result.covered).toContain('plugin/hooks/snapshot-cli')
    expect(result.covered).toContain('toolkit/.dependency-cruiser.cjs')
  })

  it('has no dead or unjustified exclusion', () => {
    const files = trackedFiles()
    for (const entry of exclusions) {
      expect(entry.reason.trim(), entry.glob).not.toBe('')
      expect(files.some((file) => globToRegExp(entry.glob).test(file)), entry.glob).toBe(true)
    }
  })

  it('does not turn an inventory failure into an empty green scope', () => {
    expect(() => listTrackedFiles(ROOT, () => ({ error: new Error('git unavailable') }))).toThrow('git unavailable')
    expect(() => listTrackedFiles(ROOT, () => ({ status: 1, stderr: 'not a repository' }))).toThrow('not a repository')
    expect(listTrackedFiles(ROOT, (_command: string, args: string[]) => {
      expect(args).toEqual(['ls-files', '-z'])
      return { status: 0, stdout: 'toolkit/scripts/lint-scope.mjs\0probe/with\nnewline.mjs\0probe/with space.mjs\0' }
    })).toEqual(['toolkit/scripts/lint-scope.mjs', 'probe/with\nnewline.mjs', 'probe/with space.mjs'])
  })
})

describe('gate glob compiler', () => {
  it('handles zero or multiple directories, braces, and literal punctuation', () => {
    const regex = globToRegExp('probes/**/*.{mjs,js}')
    for (const file of ['probes/x.mjs', 'probes/a/b/x.js']) expect(regex.test(file)).toBe(true)
    for (const file of ['other/x.mjs', 'probes/x.ts', 'probes/xXmjs']) expect(regex.test(file)).toBe(false)
    expect(globToRegExp('toolkit/.dependency-cruiser.cjs').test('toolkit/Xdependency-cruiser.cjs')).toBe(false)
    expect(regex.test('probes/x.mjs\n')).toBe(false)
  })

  it.each(['a/?.js', 'a/[xy].js', 'a/!(x).js', 'a/**x.js', 'a/{x}.js', 'a/{x,{y,z}}.js', 'a/\\*.js'])
    ('refuses unsupported syntax rather than silently losing scope: %s', (glob) => {
      expect(() => globToRegExp(glob)).toThrow('Unsupported glob')
    })

  it('agrees with ESLint dot-inclusive glob selection on every tracked path and real gate target', () => {
    const files = [...trackedFiles(), 'probes/.hidden.mjs', 'plugins/.private/.script.js', 'toolkit/.private/.check.ts']
    for (const pass of passes) {
      for (const target of pass.targets) {
        const glob = pass.cwd === 'toolkit' ? 'toolkit/**' : target
        const selects = makeTargetSelector(pass, target)
        const disagreements = files.filter((file) => selects(file) !== minimatch(file, glob, { dot: true }))
        expect(disagreements, glob).toEqual([])
      }
    }
  })
})

describe('shared gate pass definitions', () => {
  it('keeps the existing ratchet file set and 685-warning ceiling exactly', () => {
    expect(passes.find((pass) => pass.gate === 'quality' && pass.name === 'ratchet')).toEqual({
      gate: 'quality', name: 'ratchet', cwd: '.', maxWarnings: 685,
      targets: ['toolkit/packages/*/src/**/*.ts', 'plugin/**/*.mjs', 'plugin/**/*.js', 'plugin/**/*.{ts,mts,cts}',
        'plugins/wt-rules-on-demand/**/*.mjs', 'plugins/wt-rules-on-demand/**/*.js'],
    })
  })

  it('widens shipped scripts and measures each new area separately without a warning ceiling', () => {
    expect(passes.find((pass) => pass.name === 'shipped-scripts')?.targets).toContain('probes/**/*.{mjs,js}')
    expect(passes.find((pass) => pass.name === 'shipped-scripts')?.targets).toContain('plugin/hooks/snapshot-cli')
    expect(passes.filter((pass) => pass.warnOnly).map((pass) => pass.name))
      .toEqual(['area:plugins/wt-deep-search', 'area:plugins/wt-secret-guard', 'area:probes'])
    for (const pass of passes.filter((pass) => pass.warnOnly)) {
      expect(pass.gate).toBe('quality')
      expect(pass.maxWarnings).toBeUndefined()
    }
  })
})

describe('widened quality passes planted-fault witnesses', () => {
  it.each(['plugins/wt-deep-search', 'plugins/wt-secret-guard', 'probes'])
    ('keeps the shipped warn-first area free of correctness errors: %s', async (areaName) => {
      const result = await runAreaPass(areaPass(areaName), { root: ROOT })
      expect(result.errors, result.output).toBe(0)
    }, 120_000)
})

describe('widened quality passes planted-fault witnesses', () => {
  it.each(['plugins/wt-deep-search', 'plugins/wt-secret-guard', 'probes'])
    ('counts a crossed complexity ceiling as a warning without failing correctness: %s', async (areaName) => {
      const root = mkdtempSync(join(tmpdir(), 'wt-lint-ceiling-'))
      try {
        linkToolkit(root)
        mkdirSync(join(root, areaName), { recursive: true })
        const branches = Array.from({ length: 128 }, (_, index) => `if (value === ${index}) return ${index}`).join('\n')
        writeFileSync(join(root, areaName, '__ceiling__.mjs'), `export function check(value) {\n${branches}\nreturn -1\n}\n`)
        const result = await runAreaPass(areaPass(areaName), { root })
        expect(result.errors, result.output).toBe(0)
        expect(result.warnings, `${areaName}: crossed ceiling went green-for-wrong-reason`).toBeGreaterThan(0)
        expect(result.results[0].messages.some((message: Linter.LintMessage) => message.ruleId === 'complexity' && message.severity === 1)).toBe(true)
      } finally {
        unlinkSync(join(root, 'toolkit'))
        rmSync(root, { recursive: true, force: true })
      }
    }, 120_000)
})

describe('widened quality passes planted-fault witnesses', () => {
  it.each(['plugins/wt-deep-search', 'plugins/wt-secret-guard', 'probes'])
    ('reads both extensions, reports correctness errors, and applies warning-only ceilings: %s', async (areaName) => {
      const root = mkdtempSync(join(tmpdir(), 'wt-lint-scope-'))
      try {
        linkToolkit(root)
        const directory = areaName === 'probes' ? 'probes/host-platform' : areaName
        mkdirSync(join(root, directory), { recursive: true })
        plantWitnesses(root, directory)
        const result = await runAreaPass(areaPass(areaName), { root })
        expect(result.line).toBe(`quality:lint area ${areaName}: ${result.warnings} warnings, ${result.errors} errors (warn-only; a follow-up sets its ratchet)`)
        for (const file of WITNESSES) expectWitnessFault(result, { root, directory, areaName }, file)
        await expectWarnFirstConfig(root, directory, areaName)
      } finally {
        unlinkSync(join(root, 'toolkit'))
        rmSync(root, { recursive: true, force: true })
      }
    }, 120_000)
})
