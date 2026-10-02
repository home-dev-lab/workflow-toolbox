import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disableChildProcessCoverage, enableChildProcessCoverage, runIsFiltered } from '../child-process-coverage-provider.mjs'
import { readTreeIdentity, writeCoverageStamp } from '../coverage-stamp.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('child-process coverage instrument', () => {
  it('captures code executed only by a spawned Node process and cleans its run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-child-coverage-'))
    roots.push(root)
    const executable = join(root, 'spawn-only.mjs')
    writeFileSync(executable, 'const coveredOnlyInChild = 21 * 2\nprocess.stdout.write(String(coveredOnlyInChild))\n')

    const instrument = enableChildProcessCoverage(root)
    const result = spawnSync(process.execPath, [executable], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('42')
    const entries = readdirSync(instrument.directory).map((file) => JSON.parse(readFileSync(join(instrument.directory, file), 'utf8')))
    const childScript = entries.flatMap((entry) => entry.result).find((script) => script.url.endsWith('/spawn-only.mjs'))
    expect(childScript?.functions.some((fn) => fn.ranges.some((range) => range.count > 0))).toBe(true)

    disableChildProcessCoverage(instrument)
    expect(() => readdirSync(instrument.directory)).toThrow()
  })
})

describe('coverage provenance stamp', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  const readStamp = (directory: string) => JSON.parse(readFileSync(join(directory, 'coverage-stamp.json'), 'utf8'))

  function repoWithOneCommit() {
    const repo = mkdtempSync(join(tmpdir(), 'wt-coverage-stamp-'))
    roots.push(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    expect(git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one').status).toBe(0)
    return repo
  }

  it('records the commit and tree the coverage measured, and whether the tree was uncommitted', () => {
    const repo = repoWithOneCommit()
    const commit = git(repo, 'rev-parse', 'HEAD').stdout.trim()
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').stdout.trim()
    const reports = join(repo, 'reports')

    const clean = readTreeIdentity(repo)
    expect(clean).toEqual({ commit, tree, dirty: false })
    writeCoverageStamp(reports, { start: clean, end: readTreeIdentity(repo), filtered: false })
    expect(readStamp(reports)).toMatchObject({ commit, tree, dirty: false, filtered: false })

    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    writeCoverageStamp(reports, { start: clean, end: readTreeIdentity(repo), filtered: false })
    expect(readStamp(reports)).toMatchObject({ commit, tree, dirty: true })
  })

  it('records no tree when HEAD moved while the suite ran', () => {
    const repo = repoWithOneCommit()
    const start = readTreeIdentity(repo)
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', 'b.txt')
    expect(git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'two').status).toBe(0)
    const reports = join(repo, 'reports')
    writeCoverageStamp(reports, { start, end: readTreeIdentity(repo), filtered: false })
    expect(readStamp(reports)).toMatchObject({ commit: null, tree: null })
  })

  it('writes an unreadable tree as null instead of failing the coverage run', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wt-coverage-stamp-norepo-'))
    roots.push(outside)
    const identity = readTreeIdentity(outside)
    expect(identity).toEqual({ commit: null, tree: null, dirty: null })
    expect(() => writeCoverageStamp(outside, { start: identity, end: identity, filtered: false })).not.toThrow()
    expect(readStamp(outside).tree).toBeNull()
  })

  it('classifies a filtered run from the Vitest context and the test mode', () => {
    const ctx = (over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({ filenamePattern: undefined, config: { project: [], ...config }, ...over })
    expect(runIsFiltered(ctx(), {})).toBe(false)
    expect(runIsFiltered(ctx(), { WT_TEST_MODE: 'all' })).toBe(false)
    expect(runIsFiltered(ctx({ filenamePattern: ['quality'] }), {})).toBe(true)
    expect(runIsFiltered(ctx({}, { testNamePattern: /x/ }), {})).toBe(true)
    expect(runIsFiltered(ctx({}, { project: ['parallel'] }), {})).toBe(true)
    expect(runIsFiltered(ctx(), { WT_TEST_MODE: 'quarantine' })).toBe(true)
    expect(runIsFiltered({ config: { project: [] } }, {})).toBeNull()
  })
})
