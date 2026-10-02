import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import coverageModule, { disableChildProcessCoverage, enableChildProcessCoverage, ranWholeSuite, runIsFiltered } from '../child-process-coverage-provider.mjs'
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
    // Outside the repository, so only the edit below can make the tree dirty.
    const reports = mkdtempSync(join(tmpdir(), 'wt-coverage-stamp-reports-'))
    roots.push(reports)

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
    const ctx = (over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({ filenamePattern: undefined, config: { project: [], changed: false, cliExclude: null, ...config }, ...over })
    expect(runIsFiltered(ctx(), {})).toBe(false)
    expect(runIsFiltered(ctx(), { WT_TEST_MODE: 'all' })).toBe(false)
    expect(runIsFiltered(ctx({ filenamePattern: ['quality'] }), {})).toBe(true)
    for (const config of [
      { testNamePattern: /x/ }, { project: ['parallel'] }, { shard: { index: 1, count: 2 } }, { changed: 'HEAD~1' },
      { related: ['a.ts'] }, { cliExclude: ['b.test.ts'] }, { coverage: { changed: 'main' } },
    ]) expect(runIsFiltered(ctx({}, config), {}), JSON.stringify(config)).toBe(true)
    expect(runIsFiltered(ctx(), { WT_TEST_MODE: 'quarantine' })).toBe(true)
    expect(runIsFiltered({ config: { project: [] } }, {})).toBeNull()
  })

  it('removes an older stamp when the new one cannot be written', () => {
    const reports = mkdtempSync(join(tmpdir(), 'wt-coverage-stamp-blocked-'))
    roots.push(reports)
    // A directory where the stamp file belongs makes the write fail.
    mkdirSync(join(reports, 'coverage-stamp.json', 'older'), { recursive: true })
    const identity = { commit: 'c'.repeat(40), tree: 'a'.repeat(40), dirty: false }
    expect(() => writeCoverageStamp(reports, { start: identity, end: identity, filtered: false })).not.toThrow()
    expect(existsSync(join(reports, 'coverage-stamp.json'))).toBe(false)
  })
})

describe('whole-suite check', () => {
  const spec = (project: string, moduleId: string) => ({ project: { name: project }, moduleId })
  const ctxRunning = (ran: Array<[string, string]>, suite: ReturnType<typeof spec>[]) => ({
    state: { getFiles: () => ran.map(([projectName, filepath]) => ({ projectName, filepath })) },
    globTestSpecifications: async () => suite,
  })

  it('is true only when every test file of every project ran', async () => {
    const suite = [spec('unit', '/s/a.test.ts'), spec('unit', '/s/b.test.ts'), spec('spawn', '/s/a.test.ts')]
    expect(await ranWholeSuite(ctxRunning([['unit', '/s/a.test.ts'], ['unit', '/s/b.test.ts'], ['spawn', '/s/a.test.ts']], suite))).toBe(true)
    // A shard, a bail or any selection: one file of one project did not run.
    expect(await ranWholeSuite(ctxRunning([['unit', '/s/a.test.ts'], ['unit', '/s/b.test.ts']], suite))).toBe(false)
    expect(await ranWholeSuite(ctxRunning([], []))).toBe(false)
  })

  it('is unknown when Vitest cannot answer', async () => {
    expect(await ranWholeSuite({})).toBeNull()
    expect(await ranWholeSuite({ state: { getFiles: () => [] }, globTestSpecifications: async () => { throw new Error('no') } })).toBeNull()
  })
})

describe('coverage provider stamping', () => {
  async function providerIn(root: string) {
    const provider = await coverageModule.getProvider() as unknown as Record<string, unknown>
    // Outside the repository, as `.lane/` is ignored in the real one: the reports must not make the tree dirty.
    const scratch = mkdtempSync(join(tmpdir(), 'wt-coverage-provider-reports-'))
    roots.push(scratch)
    const reports = join(scratch, 'reports')
    const coverageFiles = join(scratch, 'coverage-files')
    mkdirSync(coverageFiles)
    mkdirSync(reports)
    writeFileSync(join(reports, 'coverage-summary.json'), '{}')
    Object.assign(provider, {
      options: { reportsDirectory: reports },
      coverageFilesDirectory: coverageFiles,
      ctx: {
        filenamePattern: undefined,
        config: { root, project: [] },
        state: { getFiles: () => [{ projectName: 'unit', filepath: '/suite/a.test.ts' }] },
        globTestSpecifications: async () => [{ project: { name: 'unit' }, moduleId: '/suite/a.test.ts' }],
      },
      treeAtStart: readTreeIdentity(root),
      generateReports: async () => {},
    })
    return { provider: provider as { reportCoverage: (map: unknown, options: unknown) => Promise<void>, mergeReports: (maps: unknown[]) => Promise<void> }, reports }
  }

  it('stamps the reports of an unfiltered run with the tree it measured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-coverage-provider-'))
    roots.push(root)
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'one'], { cwd: root })
    const { provider, reports } = await providerIn(root)
    await provider.reportCoverage(undefined, { allTestsRun: true })
    const stamp = JSON.parse(readFileSync(join(reports, 'coverage-stamp.json'), 'utf8'))
    expect(stamp.tree).toMatch(/^[0-9a-f]{40}$/)
    expect(stamp).toMatchObject({ dirty: false, filtered: false })
  })

  it('stamps a run that left a test file unrun as partial', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-coverage-provider-partial-'))
    roots.push(root)
    const { provider, reports } = await providerIn(root)
    const ctx = (provider as unknown as { ctx: Record<string, unknown> }).ctx
    ctx.globTestSpecifications = async () => [{ project: { name: 'unit' }, moduleId: '/suite/a.test.ts' }, { project: { name: 'unit' }, moduleId: '/suite/b.test.ts' }]
    await provider.reportCoverage(undefined, { allTestsRun: true })
    expect(JSON.parse(readFileSync(join(reports, 'coverage-stamp.json'), 'utf8')).filtered).toBe(true)
  })

  it('removes an older stamp when a coverage run starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-coverage-provider-init-'))
    roots.push(root)
    const reports = join(root, 'reports')
    mkdirSync(reports)
    writeFileSync(join(reports, 'coverage-stamp.json'), '{"tree":"older"}')
    const provider = await coverageModule.getProvider() as unknown as { initialize: (ctx: unknown) => void, childInstrument: unknown }
    const base = Object.getPrototypeOf(Object.getPrototypeOf(provider))
    const spy = vi.spyOn(base, 'initialize').mockImplementation(function (this: { options: unknown }) {
      this.options = { reportsDirectory: reports }
    })
    try {
      provider.initialize({ config: { root } })
    } finally {
      spy.mockRestore()
      disableChildProcessCoverage(provider.childInstrument as never)
    }
    expect(existsSync(join(reports, 'coverage-stamp.json'))).toBe(false)
  })

  it('stamps merged reports as unknown, so quality.mjs refuses them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-coverage-provider-merge-'))
    roots.push(root)
    const { provider, reports } = await providerIn(root)
    await provider.mergeReports([])
    expect(JSON.parse(readFileSync(join(reports, 'coverage-stamp.json'), 'utf8')).filtered).toBeNull()
  })
})
