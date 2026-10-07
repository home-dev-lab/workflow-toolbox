import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eslintIgnorePatterns, listGitIgnoredPaths, pathsRegexSource } from '../git-ignored-inputs.mjs'
import { scanHostPrimitives, sourceFiles } from '../host-primitive-census.mjs'

const root = resolve(import.meta.dirname, '../../..')
const toolkit = join(root, 'toolkit')
const directories: string[] = []
const require = createRequire(import.meta.url)

function put(dir: string, file: string, text: string) {
  const path = join(dir, file)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-ignored-inputs-'))
  directories.push(dir)
  execFileSync('git', ['init', dir], { stdio: 'pipe' })
  put(dir, 'tracked.mjs', 'export {}\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'fixture'], { stdio: 'pipe' })
  return dir
}

function hostFixture() {
  const dir = mkdtempSync(join(root, 'plugin/.claude-plugin/types-fixture-'))
  directories.push(dir)
  put(dir, '.gitignore', '*\n')
  return { dir, file: put(dir, 'index.d.ts', 'export interface Empty {}\n') }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('git-ignored quality inputs', () => {
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

  it('deduplicates base forms and escapes glob metacharacters', () => {
    expect(eslintIgnorePatterns(['plugin/[x]*?{a}/'], root, [toolkit, root, root])).toEqual([
      '../plugin/\\[x\\]\\*\\?\\{a\\}/', 'plugin/\\[x\\]\\*\\?\\{a\\}/',
    ])
  })

  it('ESLint excludes the host shape with the real config from the repository root', async () => {
    const fixture = hostFixture()
    try {
      const eslint = new ESLint({ cwd: root, overrideConfigFile: join(toolkit, 'eslint.config.mjs') })
      expect(await eslint.isPathIgnored(fixture.file)).toBe(true)
      expect(await eslint.isPathIgnored(join(root, 'plugin/bin/wt-suite-lock.mjs'))).toBe(false)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('census skips ignored directories and individual files but counts the control', () => {
    const dir = repo()
    put(dir, 'hidden/.gitignore', '*\n')
    put(dir, 'hidden/x.mjs', "import fs from 'node:fs'\n")
    put(dir, '.gitignore', 'ignored.mjs\n')
    put(dir, 'ignored.mjs', "import fs from 'node:fs'\n")
    const control = put(dir, 'visible/x.mjs', "import fs from 'node:fs'\n")
    expect(sourceFiles(dir).sort()).toEqual([join(dir, 'tracked.mjs'), control].sort())
    expect(scanHostPrimitives(dir).findings).toEqual([{ file: 'visible/x.mjs', line: 1, primitive: 'fs import' }])
  })

  it('knip merges ignored paths while preserving JSONC workspace data', async () => {
    const fixture = hostFixture()
    const { default: config } = await import('../knip-config.mjs')
    const file = join(root, 'knip.json')
    const original = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8')).config
    expect(config.ignore).toContain(`${relative(root, fixture.dir).replaceAll('\\', '/')}/**`)
    expect(config.workspaces).toEqual(original.workspaces)
  })

  it('dependency-cruiser excludes ignored modules and keeps the control', () => {
    const fixture = hostFixture()
    const file = join(toolkit, '.dependency-cruiser.cjs')
    delete require.cache[require.resolve(file)]
    const config = require(file)
    const regex = new RegExp(config.options.exclude?.path ?? '(?!)')
    expect(regex.test(relative(toolkit, fixture.file).replaceAll('\\', '/'))).toBe(true)
    expect(regex.test('../plugin/bin/wt-suite-lock.mjs')).toBe(false)
  })
})
