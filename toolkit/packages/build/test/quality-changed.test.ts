import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error Node ESM quality module
import { lintText, ownerRules } from '../../../scripts/quality-changed-lint.mjs'
// @ts-expect-error Node ESM quality module
import { git as stageGit } from '../../../scripts/quality-changed-git.mjs'

const toolkit = fileURLToPath(new URL('../../../..', import.meta.url)) + '/toolkit'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixtureEnv(root: string) {
  return { ...process.env, NPM_CONFIG_PREFIX: join(root, 'npm-prefix'), pnpm_config_verify_deps_before_run: 'false',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: fixtureEnv(root) })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text)
}
function commit(root: string) {
  git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  return git(root, 'rev-parse', 'HEAD')
}
// Copies a module and the transitive closure of its relative imports, mirroring the layout under `to`.
// A missing import target throws, so a config that grows a new import fails loudly instead of in the tool.
function copyWithImports(from: string, to: string, seen = new Set<string>()) {
  if (seen.has(from)) return
  seen.add(from); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to)
  for (const [, rel = ''] of readFileSync(from, 'utf8').matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
    copyWithImports(resolve(dirname(from), rel), resolve(dirname(to), rel), seen)
  }
}
function fixture(files: Record<string, string> = {}, prefix = 'wt-changed-quality-') {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root)
  git(root, 'init', '-q', '-b', 'develop')
  mkdirSync(join(root, 'toolkit/scripts'), { recursive: true })
  const source = process.env.WT_CHANGED_SCRIPTS ?? join(toolkit, 'scripts')
  for (const file of ['quality-changed.mjs', 'quality-changed-git.mjs', 'quality-changed-lint.mjs', 'quality-changed-measure.mjs']) {
    copyWithImports(join(source, file), join(root, 'toolkit/scripts', file))
  }
  copyWithImports(join(toolkit, 'eslint.config.mjs'), join(root, 'toolkit/eslint.config.mjs'))
  symlinkSync(join(toolkit, 'node_modules'), join(root, 'toolkit/node_modules'), 'junction')
  write(root, '.gitignore', 'node_modules/\n')
  write(root, 'toolkit/package.json', JSON.stringify({ scripts: { 'quality:changed': 'node scripts/quality-changed.mjs' } }))
  for (const [file, text] of Object.entries(files)) write(root, file, text)
  commit(root)
  return root
}
function run(root: string, args: string[] = [], env: Record<string, string | undefined> = {}, pnpm = false) {
  return spawnSync(pnpm ? 'pnpm' : process.execPath,
    pnpm ? ['run', 'quality:changed', ...args] : [join(root, 'toolkit/scripts/quality-changed.mjs'), ...args],
    { cwd: join(root, 'toolkit'), encoding: 'utf8', timeout: 15000, shell: pnpm && process.platform === 'win32',
      env: { ...fixtureEnv(root),
      WT_QUALITY_BASE: undefined, WT_QUALITY_CHANGED: undefined, ...env } })
}
const violation = (count: number) => `export function legacy(x) {\n${'if (x) x++;\n'.repeat(count)}return x\n}\n`

it.each(['plugin/new.mjs', 'toolkit/scripts/new.js', 'probes/new.mts'])('rejects new tracked violating code in %s', (file) => {
  const root = fixture(); write(root, file, violation(11)); git(root, 'add', file)
  expect(run(root).status).toBe(1)
})
it('rejects untracked violating code', () => {
  const root = fixture(); write(root, 'plugin/new.mjs', violation(11))
  expect(run(root).status).toBe(1)
})
it.each([['unchanged', 11, 0], ['shrinking', 10, 0], ['growing', 12, 1]] as const)('legacy %s violation', (_name, count, status) => {
  const root = fixture({ 'plugin/old.mjs': violation(11) })
  write(root, 'plugin/old.mjs', violation(count) + '\nexport const addition = 1\n')
  expect(run(root).status).toBe(status)
})
it.each(['// eslint-disable', '/* eslint-disable */'])('rejects a new violation hidden by %s', (directive) => {
  const root = fixture(); write(root, 'plugin/new.mjs', directive + '\n' + violation(11))
  expect(run(root).status).toBe(1)
})
it('rejects new explicit any in TypeScript', () => {
  const root = fixture(); write(root, 'toolkit/packages/build/test/new.ts', 'export const value: any = 1\n')
  expect(run(root).status).toBe(1)
})
it('rejects new oversized functions', () => {
  const root = fixture(); write(root, 'plugin/new.mjs', 'export function long() {\n' + 'console.log(1)\n'.repeat(41) + '}\n')
  expect(run(root).status).toBe(1)
})
it('fails closed without a base', () => {
  const root = fixture(); git(root, 'branch', '-m', 'other')
  const result = run(root); expect(result.status).toBe(2); expect(result.stderr).toContain('--base <ref>')
})
it('fails closed outside Git with one actionable line', () => {
  const root = fixture(); rmSync(join(root, '.git'), { recursive: true, force: true })
  const result = run(root)
  expect(result.status).toBe(2); expect(result.stderr).toContain('--base <ref>')
  expect(result.stderr.trim().split('\n')).toHaveLength(1)
})
it('supports explicit and environment bases', () => {
  const root = fixture(); git(root, 'branch', '-m', 'other')
  expect(run(root, ['--base', 'HEAD']).status).toBe(0)
  expect(run(root, [], { WT_QUALITY_BASE: 'HEAD' }).status).toBe(0)
})
it('explicit skip succeeds without a base', () => {
  const root = fixture(); git(root, 'branch', '-m', 'other')
  const result = run(root, [], { WT_QUALITY_CHANGED: 'skip' })
  expect(result.status).toBe(0); expect(result.stdout).toContain('quality:changed SKIPPED (WT_QUALITY_CHANGED=skip)')
})
it.each([false, true])('rename inherits scoped base (staged=%s)', (staged) => {
  const root = fixture({ 'plugin/old.mjs': violation(11) })
  renameSync(join(root, 'plugin/old.mjs'), join(root, 'plugin/new.mjs'))
  if (staged) git(root, 'add', '-A')
  expect(run(root).status).toBe(0)
})
it('rename from excluded source is added code', () => {
  const root = fixture({ 'plugin/fixtures/old.mjs': violation(11) })
  renameSync(join(root, 'plugin/fixtures/old.mjs'), join(root, 'plugin/new.mjs'))
  expect(run(root).status).toBe(1)
})
it('similar unstaged rename inherits the scoped base', () => {
  const root = fixture({ 'plugin/old.mjs': violation(11) })
  renameSync(join(root, 'plugin/old.mjs'), join(root, 'plugin/new.mjs'))
  write(root, 'plugin/new.mjs', violation(11) + 'export const addition = 1\n')
  expect(run(root).status).toBe(0)
})
it('rename to excluded destination is skipped', () => {
  const root = fixture({ 'plugin/old.mjs': violation(11) })
  mkdirSync(join(root, 'plugin/fixtures')); renameSync(join(root, 'plugin/old.mjs'), join(root, 'plugin/fixtures/new.mjs'))
  expect(run(root).status).toBe(0)
})
it('non-merge develop HEAD checks zero files', () => {
  const result = run(fixture({ 'plugin/old.mjs': violation(11) }))
  expect(result.status).toBe(0); expect(result.stdout).toContain('0 files checked')
})
it('merge develop HEAD checks its first parent', () => {
  const root = fixture(); git(root, 'checkout', '-qb', 'feature')
  write(root, 'plugin/new.mjs', violation(11)); commit(root); git(root, 'checkout', '-q', 'develop')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '-qm', 'merge', 'feature')
  expect(run(root).status).toBe(1)
})
it('subject-ref reads the selected tree rather than working files', () => {
  const root = fixture(), base = git(root, 'rev-parse', 'HEAD')
  write(root, 'plugin/new.mjs', violation(11)); const subject = commit(root)
  write(root, 'plugin/new.mjs', 'export const repaired = true\n')
  expect(run(root, ['--base', base, '--subject-ref', subject]).status).toBe(1)
  expect(run(root, ['--base', base]).status).toBe(0)
})
it('runs through pnpm from toolkit cwd', () => {
  const root = fixture(); write(root, 'plugin/new.js', violation(11))
  expect(run(root, [], {}, true).status).toBe(1)
})
it('symlink invocation still judges code in the script repository', () => {
  const root = fixture(); write(root, 'plugin/new.mjs', violation(11))
  symlinkSync(join(root, 'toolkit/scripts'), join(root, 'alias'), 'junction')
  const result = spawnSync(process.execPath, [join(root, 'alias/quality-changed.mjs')], { encoding: 'utf8', env: { ...fixtureEnv(root), WT_QUALITY_BASE: undefined, WT_QUALITY_CHANGED: undefined } })
  expect(result.status).toBe(1)
})
it('subject parse errors are regressions', () => {
  const root = fixture(); write(root, 'plugin/new.mjs', 'export function (')
  expect(run(root).status).toBe(1)
})
it('coverage invariant fails closed if effective owner config is missing', () => {
  const root = fixture(); write(root, 'plugin/new.mjs', violation(11))
  write(root, 'toolkit/eslint.config.mjs', 'export default []\n')
  expect(run(root).status).toBe(2)
})
it.each(['absent result', 'ignored result', 'wrong path', 'wrong config'])('coverage invariant rejects %s', async (mode) => {
  const rules = Object.fromEntries(Object.entries(ownerRules).map(([rule, setting]) => {
    const value = setting as string | [string, ...unknown[]]
    return [rule, Array.isArray(value) ? [2, ...value.slice(1)] : [2]]
  }))
  const eslint = {
    calculateConfigForFile: async () => ({ rules: mode === 'wrong config' ? {} : rules }),
    lintText: async () => mode === 'absent result' ? [] : [{ filePath: mode === 'wrong path' ? '/fixture/other.mjs' : '/fixture/code.mjs',
      messages: mode === 'ignored result' ? [{ message: 'File ignored because of a matching ignore pattern.' }] : [] }],
  }
  await expect(lintText(eslint, '/fixture', 'code.mjs', '')).rejects.toThrow()
})

it.each(['--assume-unchanged', '--skip-worktree'])('checks working code hidden by %s without changing the real index', (flag) => {
  const root = fixture({ 'plugin/old.mjs': 'export const value = 1\n' })
  git(root, 'update-index', flag, 'plugin/old.mjs')
  const before = readFileSync(join(root, '.git/index'))
  write(root, 'plugin/old.mjs', violation(11))
  const result = run(root)
  expect(result.status, result.stderr).toBe(1)
  expect(readFileSync(join(root, '.git/index'))).toEqual(before)
})
it.skipIf(process.platform === 'win32')('every Git invocation disables lazy fetch (offline fake git)', () => {
  const root = fixture({ 'plugin/new.mjs': 'export const value = 1\n' }), bin = join(root, 'fake-bin'), log = join(root, 'git-calls.jsonl')
  mkdirSync(bin)
  write(root, 'fake-bin/git', `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, noFetch: process.env.GIT_NO_LAZY_FETCH }) + '\\n');
const cmd = args[2];
if (cmd === 'rev-parse') console.log(args.includes('--show-toplevel') ? ${JSON.stringify(root)} : 'a'.repeat(40));
if (cmd === 'diff') process.stdout.write('M\\0plugin/new.mjs\\0');
if (cmd === 'ls-tree') process.stdout.write('100644 blob ' + 'b'.repeat(40) + '\\tplugin/new.mjs\\0');
if (cmd === 'show') console.log('export const value = 1');
`)
  chmodSync(join(bin, 'git'), 0o755)
  const result = run(root, ['--base', 'HEAD', '--subject-ref', 'HEAD'], { PATH: bin + delimiter + process.env.PATH })
  expect(result.status, result.stderr).toBe(0)
  const working = run(root, ['--base', 'HEAD'], { PATH: bin + delimiter + process.env.PATH })
  expect(working.status, working.stderr).toBe(0)
  // eslint.config.mjs lists git-ignored paths through `git ls-files --others --ignored` (reads no objects, so it cannot
  // lazy-fetch); that call belongs to the config, not to the tool whose Git wrapper this test pins.
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((call) => !call.args.includes('--ignored'))
  expect(calls.length).toBeGreaterThan(3)
  expect(calls.every((call) => call.noFetch === '1')).toBe(true)
})
it('Git wrapper bounds every subprocess and forces no lazy fetch over caller environment', () => {
  const calls: { timeout?: number; env: Record<string, string> }[] = []
  stageGit('/fixture', ['show', 'HEAD:file'], { GIT_NO_LAZY_FETCH: '0' },
    (_command: string, _args: string[], options: { timeout?: number; env: Record<string, string> }) => {
      calls.push(options); return ''
    })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.env.GIT_NO_LAZY_FETCH).toBe('1')
  expect(calls[0]!.timeout).toBe(120000)
})
it('feature branch at a merge contained in develop checks zero files', () => {
  const root = fixture(); git(root, 'checkout', '-qb', 'feature')
  write(root, 'plugin/new.mjs', violation(11)); commit(root); git(root, 'checkout', '-q', 'develop')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '-qm', 'merge', 'feature')
  git(root, 'checkout', '-qb', 'review')
  const result = run(root)
  expect(result.status, result.stdout).toBe(0); expect(result.stdout).toContain('0 files checked')
})
it('rejects an option-like subject revision', () => {
  const result = run(fixture(), ['--base', 'HEAD', '--subject-ref', '-s'])
  expect(result.status, result.stdout).toBe(2)
})
it.skipIf(process.platform === 'win32')('skips a code symlink pointing to an unwritten FIFO without hanging', () => {
  const root = fixture()
  expect(spawnSync('mkfifo', [join(root, 'pipe')]).status).toBe(0)
  mkdirSync(join(root, 'plugin')); symlinkSync('../pipe', join(root, 'plugin/new.mjs'))
  const result = run(root)
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('0 files checked')
}, 20000)
it.skipIf(process.platform === 'win32')('skips code symlinks in subject trees (POSIX symlink fixture)', () => {
  const root = fixture(), base = git(root, 'rev-parse', 'HEAD')
  mkdirSync(join(root, 'plugin')); symlinkSync('missing', join(root, 'plugin/new.mjs'))
  const subject = commit(root), result = run(root, ['--base', base, '--subject-ref', subject])
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('0 files checked')
})
it.skipIf(process.platform === 'win32')('alternate object path containing colon works (POSIX only; skipped on Windows)', () => {
  const result = run(fixture({}, 'wt:changed-quality-'))
  expect(result.status, result.stderr).toBe(0)
})
it('ignores unrelated untracked unborn nested repositories', () => {
  const root = fixture(); mkdirSync(join(root, 'scratch'))
  git(join(root, 'scratch'), 'init', '-q')
  const result = run(root)
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('0 files checked')
})
