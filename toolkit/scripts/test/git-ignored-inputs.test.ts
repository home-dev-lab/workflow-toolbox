import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eslintGitIgnores, listGitIgnoredPaths, pathsRegexSource } from '../git-ignored-inputs.mjs'
import * as knipModule from '../knip-config.mjs'
import { scanHostPrimitives, sourceFiles } from '../host-primitive-census.mjs'

const root = resolve(import.meta.dirname, '../../..')
const toolkit = join(root, 'toolkit')
const directories: string[] = []
const require = createRequire(import.meta.url)
const { knipConfigWithIgnored } = knipModule

function put(dir: string, file: string, text: string) {
  const path = join(dir, file)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

function repo(linkedParent = false) {
  const parent = mkdtempSync(join(tmpdir(), 'git-ignored-inputs-'))
  directories.push(parent)
  let dir = parent
  if (linkedParent) {
    mkdirSync(join(parent, 'real'))
    symlinkSync(join(parent, 'real'), join(parent, 'linked'), 'junction')
    dir = mkdtempSync(join(parent, 'linked', 'repo-'))
  }
  execFileSync('git', ['init', dir], { stdio: 'pipe' })
  put(dir, 'tracked.mjs', 'export {}\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'fixture'], { stdio: 'pipe' })
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function registerGitListingTests() {
  it('lists only ignored inputs including nested host rules, without dependencies', () => {
    const dir = repo()
    put(dir, '.gitignore', 'generated/\nnode_modules/\ntracked.mjs\n')
    put(dir, 'generated/x.mjs', 'export {}')
    put(dir, 'host/.gitignore', '*\n')
    put(dir, 'host/index.d.ts', 'export interface Empty {}')
    put(dir, 'node_modules/x.mjs', 'export {}')
    put(dir, 'nested/node_modules/x.mjs', 'export {}')
    put(dir, 'visible.mjs', 'export {}')
    const listed = listGitIgnoredPaths(dir)
    expect(listed.status).toBe('listed')
    expect(listed.paths).toEqual(expect.arrayContaining(['generated/', 'host/']))
    expect(listed.paths).not.toContain('tracked.mjs')
    expect(listed.paths).not.toContain('visible.mjs')
    expect(listed.paths.some((path) => path.split('/').includes('node_modules'))).toBe(false)
  })

  it('silently accepts a non-repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-ignored-nonrepo-'))
    directories.push(dir)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(listGitIgnoredPaths(dir)).toEqual({ status: 'not-a-repo', paths: [] })
    expect(stderr).not.toHaveBeenCalled()
  })

  it.each(['ENOENT: git missing', 'fatal: permission denied\nsecond line'])('diagnoses git failure once: %s', (message) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const run = () => { throw Object.assign(new Error(message), { stderr: Buffer.alloc(0) }) }
    expect(listGitIgnoredPaths(root, { run })).toEqual({ status: 'git-failed', paths: [] })
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr.mock.calls[0][0]).toContain(root)
    expect(stderr.mock.calls[0][0]).toContain(message.split('\n')[0])
    expect(stderr.mock.calls[0][0]).toContain('ignored files will be read')
    expect(String(stderr.mock.calls[0][0]).split('\n')).toHaveLength(2)
  })

  it('uses execFile arguments and drops every node_modules segment', () => {
    const run = vi.fn(() => 'a/node_modules/\0node_modules/x\0a/keep/\0')
    expect(listGitIgnoredPaths(root, { run }).paths).toEqual(['a/keep/'])
    expect(run).toHaveBeenCalledWith('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], expect.objectContaining({ encoding: 'utf8', env: expect.objectContaining({ LC_ALL: 'C' }) }))
  })
}

function registerIgnorePatternTests() {
  it('never returns an empty regex alternation', () => {
    expect(pathsRegexSource([], root, toolkit)).toBeNull()
  })

  it('anchors directories, exact files and literal regex metacharacters', () => {
    const regex = new RegExp(pathsRegexSource(['a/types/', 'a/[x]+.mjs'], root, root)!)
    expect(regex.test('a/types/x.d.ts')).toBe(true)
    expect(regex.test('a/types-extra/x.d.ts')).toBe(false)
    expect(regex.test('a/[x]+.mjs')).toBe(true)
    expect(regex.test('a/[x]+.mjs-extra')).toBe(false)
    expect(regex.test('a/x.mjs')).toBe(false)
    expect(regex.test('prefix/a/types/x.d.ts')).toBe(false)
  })

  it('makes regex paths relative to a different base', () => {
    const regex = new RegExp(pathsRegexSource(['plugin/types/'], root, toolkit)!)
    expect(regex.test('../plugin/types/x.d.ts')).toBe(true)
    expect(regex.test('plugin/types/x.d.ts')).toBe(false)
  })

  it('anchors ESLint glob patterns to one repository base and escapes metacharacters', () => {
    const list = () => ({ paths: ['plugin/[x]*?{a}/'] })
    expect(eslintGitIgnores(root, { list })).toEqual({
      basePath: root, ignores: ['plugin/\\[x\\]\\*\\?\\{a\\}/'],
    })
    expect(eslintGitIgnores(root, { list: () => ({ paths: [] }) })).toEqual({ basePath: root, ignores: [] })
  })
}

function registerEslintInputTests() {
  it.each(['.', 'toolkit'])('ESLint keeps the tracked same-spelling control from cwd %s', async (cwd) => {
    const dir = repo()
    const control = put(dir, 'toolkit/plugin/generated.mjs', 'export {}')
    execFileSync('git', ['-C', dir, 'add', 'toolkit/plugin/generated.mjs'])
    put(dir, '.gitignore', '/plugin/generated.mjs\n')
    const ignored = put(dir, 'plugin/generated.mjs', 'export {}')
    const eslint = new ESLint({ cwd: resolve(dir, cwd), overrideConfigFile: true,
      overrideConfig: [{ files: ['**/*.mjs'] }, eslintGitIgnores(dir)] })
    expect(await eslint.isPathIgnored(ignored)).toBe(true)
    expect(await eslint.isPathIgnored(control)).toBe(false)
  })

  it('wires the real ESLint config to the repository base', async () => {
    const { default: config } = await import('../../eslint.config.mjs')
    expect(config.some((item) => item.basePath === root)).toBe(true)
  })

  it('keeps generated test fixtures outside the real repository', () => {
    const source = readFileSync(join(import.meta.dirname, 'git-ignored-inputs.test.ts'), 'utf8')
    expect(source.includes('function ' + 'hostFixture(')).toBe(false)
    expect(source.includes('mkdtempSync(' + 'join(root,')).toBe(false)
  })
}

function registerCensusInputTests() {
  it.each([false, true])('census skips ignored directories and individual files but counts the control (linked parent: %s)', (linkedParent) => {
    const dir = repo(linkedParent)
    put(dir, 'hidden/.gitignore', '*\n')
    put(dir, 'hidden/x.mjs', "import fs from 'node:fs'\n")
    put(dir, '.gitignore', 'ignored.mjs\n')
    put(dir, 'ignored.mjs', "import fs from 'node:fs'\n")
    const control = put(dir, 'visible/x.mjs', "import fs from 'node:fs'\n")
    expect(sourceFiles(dir).sort()).toEqual([join(dir, 'tracked.mjs'), control].map((path) => realpathSync(path)).sort())
    expect(scanHostPrimitives(dir).findings).toEqual([{ file: 'visible/x.mjs', line: 1, primitive: 'fs import' }])
  })

  it.skipIf(process.platform === 'win32').each([false, true])('census preserves literal POSIX backslashes in ignored names (linked parent: %s)', (linkedParent) => {
    const dir = repo(linkedParent)
    put(dir, '.gitignore', 'literal\\\\name.mjs\n')
    put(dir, 'literal\\name.mjs', "import fs from 'node:fs'\n")
    const control = put(dir, 'control.mjs', "import fs from 'node:fs'\n")
    expect(listGitIgnoredPaths(dir).paths).toContain('literal\\name.mjs')
    expect(sourceFiles(dir).sort()).toEqual([join(dir, 'tracked.mjs'), control].map((path) => realpathSync(path)).sort())
    expect(scanHostPrimitives(dir).findings).toEqual([{ file: 'control.mjs', line: 1, primitive: 'fs import' }])
  })
}

function registerKnipInputTests() {
  it('knip excludes ignored inputs at entry and project selection in each workspace', () => {
    const config = { workspaces: {
      '.': { entry: ['plugin/bin/*.mjs'], project: ['plugin/**/*.mjs'] },
      'toolkit/packages/runtime': { entry: ['src/index.ts'], project: ['src/**/*.ts'] },
      'toolkit/packages/build': { entry: ['src/index.ts'], project: ['src/**/*.ts'] },
    } }
    const merged = knipConfigWithIgnored(config, ['plugin/types/', 'toolkit/packages/runtime/src/generated.ts'])
    expect(merged.workspaces['.'].entry).toEqual(['plugin/bin/*.mjs', '!plugin/types/**', '!toolkit/packages/runtime/src/generated.ts'])
    expect(merged.workspaces['.'].project).toEqual(['plugin/**/*.mjs', '!plugin/types/**', '!toolkit/packages/runtime/src/generated.ts'])
    expect(merged.workspaces['toolkit/packages/runtime'].entry).toEqual(['src/index.ts', '!src/generated.ts'])
    expect(merged.workspaces['toolkit/packages/runtime'].project).toEqual(['src/**/*.ts', '!src/generated.ts'])
    expect(merged.workspaces['toolkit/packages/build']).toEqual(config.workspaces['toolkit/packages/build'])
    expect(merged).not.toHaveProperty('ignore')
    expect(config.workspaces['.'].entry).toEqual(['plugin/bin/*.mjs'])
    expect(knipConfigWithIgnored(config, [])).toEqual(config)
  })

  it.each(['quality-root-gate.mjs', 'quality.mjs'])('wires %s to the knip selection config', (caller) => {
    const source = readFileSync(join(toolkit, 'scripts', caller), 'utf8')
    expect(source).toContain("'--config', 'toolkit/scripts/knip-config.mjs'")
    expect(source).not.toContain("'--config', 'knip.json'")
  })

  it('wires the default knip config to Git exclusions without a report filter', () => {
    const file = join(root, 'knip.json')
    const original = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8')).config
    expect(knipModule.default).toEqual(knipConfigWithIgnored(original, listGitIgnoredPaths(root).paths))
    expect(knipModule.default).not.toHaveProperty('ignore')
  })
}

function registerDependencyCruiserInputTests() {
  it('dependency-cruiser regex skips ignored temporary inputs and keeps the control', () => {
    const dir = repo()
    put(dir, '.gitignore', 'plugin/generated/\n')
    const ignored = put(dir, 'plugin/generated/index.mjs', 'export {}')
    const control = put(dir, 'plugin/generated-control/index.mjs', 'export {}')
    mkdirSync(join(dir, 'toolkit'))
    const regex = new RegExp(pathsRegexSource(listGitIgnoredPaths(dir).paths, dir, join(dir, 'toolkit'))!)
    expect(regex.test(relative(join(dir, 'toolkit'), ignored).split(sep).join('/'))).toBe(true)
    expect(regex.test(relative(join(dir, 'toolkit'), control).split(sep).join('/'))).toBe(false)
  })

  it('wires dependency-cruiser exclusion to the real Git listing and regex helper', () => {
    const file = join(toolkit, '.dependency-cruiser.cjs')
    delete require.cache[require.resolve(file)]
    const config = require(file)
    const paths = listGitIgnoredPaths(root).paths
    if (paths.length) {
      expect(typeof config.options.exclude?.path).toBe('string')
      expect(config.options.exclude.path).toMatch(/^\^\(\?:/)
      expect(config.options.exclude.path).toBe(pathsRegexSource(paths, root, toolkit))
    } else {
      expect(config.options).not.toHaveProperty('exclude')
    }
  })
}

describe('git-ignored quality inputs', () => {
  registerGitListingTests()
  registerIgnorePatternTests()
  registerEslintInputTests()
  registerCensusInputTests()
  registerKnipInputTests()
  registerDependencyCruiserInputTests()
})
