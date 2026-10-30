import { execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error runtime module
import { fixture, fingerprint, git, repository, sweepModule } from '../../../test-support/worktree-sweep-fixture.mjs'
const moduleUrl = sweepModule('bin/lib/worktree-sweep/scan.mjs')
const sweep = await import(/* @vite-ignore */ moduleUrl).catch(() => null)
const cli = fileURLToPath(sweepModule('bin/wt-worktree-sweep.mjs'))
const roots: string[] = []
function setup() { const f = fixture(); roots.push(f.root); return f }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function entry(f: ReturnType<typeof fixture>) { return sweep!.scanProject(f.options).entries[0] }

  it('ships a report-only scanner', () => { expect(sweep, 'report-only scanner must ship').not.toBeNull() })
  it('G1 tracked edits are KEEP uncommitted with path, branch, bytes, age and count', () => {
    const f = setup(); const dir = repository(f)
    writeFileSync(join(dir, 'tracked'), 'local change\n')
    expect(entry(f)).toMatchObject({ path: dir, verdict: 'KEEP', reason: 'uncommitted', changedFiles: 1 })
    expect(entry(f).branch).toBeTruthy(); expect(entry(f).bytes).toBeGreaterThan(0)
    expect(entry(f).ageHours).toBeGreaterThan(72)
  })
  it('G2 untracked non-ignored files are KEEP uncommitted', () => {
    const f = setup(); const dir = repository(f); writeFileSync(join(dir, 'untracked'), 'new')
    git(dir, f.env, 'config', 'status.showUntrackedFiles', 'no')
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'uncommitted', changedFiles: 1 })
  })
  it('G3 staged-only edits are KEEP uncommitted', () => {
    const f = setup(); const dir = repository(f); writeFileSync(join(dir, 'tracked'), 'staged')
    git(dir, f.env, 'add', 'tracked')
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'uncommitted' })
  })
  it('G4 ordinary directories without git are KEEP no-git with size', () => {
    const f = setup(); mkdirSync(join(f.source, 'plain')); writeFileSync(join(f.source, 'plain', 'x'), 'abc')
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'no-git', bytes: 3 })
  })
  it.skipIf(process.platform === 'win32')('G5 a failing git on the pinned PATH is KEEP git-status-failed', () => {
    const f = setup(); repository(f)
    const fake = join(f.root, 'bin', 'git')
    f.env.WT_FIXTURE_REAL_GIT = readlinkSync(fake)
    rmSync(fake)
    writeFileSync(fake, '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = status ]; then exit 37; fi\ndone\nexec "$WT_FIXTURE_REAL_GIT" "$@"\n')
    chmodSync(fake, 0o755)
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'git-status-failed' })
  })
  it('G5 a timed-out git status is KEEP git-status-failed', () => {
    const f = setup(); repository(f)
    f.options.gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => args.includes('status')
      ? { status: null, stdout: '', error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) }
      : spawnSync(cmd, args, options)
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'git-status-failed' })
  })
  it.each(['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'])('G6 %s is KEEP operation-in-progress', marker => {
    const f = setup(); const dir = repository(f)
    if (marker.startsWith('rebase-')) mkdirSync(join(dir, '.git', marker))
    else writeFileSync(join(dir, '.git', marker), git(dir, f.env, 'rev-parse', 'HEAD'))
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'operation-in-progress' })
  })
  it('G7 base snapshots remain base-unproven without reachability evidence', () => {
    const f = setup(); const repo = repository(f); mkdirSync(join(f.source, 'copy.base'))
    const file = join(f.source, 'copy.base', 'x'); writeFileSync(file, 'foreign')
    const oid = git(repo, f.env, 'hash-object', '-w', '--no-filters', file).trim()
    expect(() => git(repo, f.env, 'cat-file', '-e', oid)).not.toThrow()
    expect(sweep!.scanProject(f.options).entries.find((e: { name: string }) => e.name === 'copy.base')).toMatchObject({ verdict: 'KEEP', reason: 'base-unproven' })
  })
  it('G7 a base containing only reachable raw blobs is eligible in fixture report mode', () => {
    const f = setup(); repository(f)
    mkdirSync(join(f.source, 'copy.base'))
    writeFileSync(join(f.source, 'copy.base', 'tracked'), 'committed\n')
    expect(sweep!.scanProject(f.options).entries.find((e: { name: string }) => e.name === 'copy.base')).toMatchObject({ verdict: 'ELIGIBLE (report only)' })
  })
   it('clean standalone entries without another preserving ref are KEEP', () => {
     const f = setup(); const dir = repository(f)
     git(dir, f.env, 'update-ref', '-d', 'refs/remotes/origin/main')
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'commits not preserved elsewhere' })
   })
   it('clean, old entries preserved by a remote-tracking ref are ELIGIBLE (report only)', () => {
     const f = setup(); repository(f)
     expect(entry(f)).toMatchObject({ verdict: 'ELIGIBLE (report only)', reason: 'eligible' })
   })
   it.each(['branch', 'detached'])('local-only %s commits are KEEP even with an older remote ref', kind => {
     const f = setup(); const dir = repository(f)
     if (kind === 'detached') git(dir, f.env, 'checkout', '--detach', '-q')
     writeFileSync(join(dir, 'tracked'), 'local-only commit\n')
     git(dir, f.env, 'add', 'tracked')
     git(dir, f.env, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local only')
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'commits not preserved elsewhere' })
   })
   it('a detached HEAD reachable from a base branch is preserved', () => {
     const f = setup(); const dir = repository(f)
     git(dir, f.env, 'branch', 'develop')
     git(dir, f.env, 'checkout', '--detach', '-q')
     git(dir, f.env, 'update-ref', '-d', 'refs/remotes/origin/main')
     expect(entry(f)).toMatchObject({ verdict: 'ELIGIBLE (report only)' })
   })
   it('a preserving ref may contain HEAD as an ancestor rather than its tip', () => {
     const f = setup(); const dir = repository(f); const head = git(dir, f.env, 'rev-parse', 'HEAD').trim()
     writeFileSync(join(dir, 'tracked'), 'descendant\n'); git(dir, f.env, 'add', 'tracked')
     git(dir, f.env, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'descendant')
     git(dir, f.env, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
     git(dir, f.env, 'reset', '--hard', head)
     expect(entry(f)).toMatchObject({ verdict: 'ELIGIBLE (report only)' })
   })
   it('failed preserving-ref enumeration is KEEP', () => {
     const f = setup(); repository(f)
     f.options.gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => args.includes('for-each-ref')
       ? { status: 1, stdout: '' } : spawnSync(cmd, args, options)
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'commits not preserved elsewhere' })
   })
   it('an index.lock directory in a base snapshot cannot hide unpreserved bytes', () => {
     const f = setup(); repository(f); const base = join(f.source, 'copy.base')
     mkdirSync(join(base, 'index.lock'), { recursive: true })
     writeFileSync(join(base, 'tracked'), 'committed\n')
     writeFileSync(join(base, 'index.lock', 'unique-work'), 'not preserved\n')
     const before = fingerprint(base)
     expect(sweep!.scanProject(f.options).entries.find((e: { name: string }) => e.name === 'copy.base'))
       .toMatchObject({ verdict: 'KEEP', reason: 'base-unproven' })
     expect(fingerprint(base)).toEqual(before)
   })
   it.each(['index.lock', 'ignored/index.lock', '.git/index.lock'])('a directory named %s is included in recency inspection', suffix => {
     const f = setup(); const dir = repository(f)
     mkdirSync(join(dir, suffix), { recursive: true })
     const file = join(dir, suffix, 'unique-work'); writeFileSync(file, 'keep\n')
     utimesSync(file, f.now / 1000, f.now / 1000)
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: suffix === 'index.lock' ? 'uncommitted' : 'recent' })
   })
   it('only the regular Git index lock is ignored, not an ignored namesake file', () => {
     const f = setup(); const dir = repository(f)
     const lock = join(dir, '.git', 'index.lock'); writeFileSync(lock, 'git lock')
     utimesSync(lock, f.now / 1000, f.now / 1000)
     expect(entry(f)).toMatchObject({ verdict: 'ELIGIBLE (report only)' })
     mkdirSync(join(dir, 'ignored')); const namesake = join(dir, 'ignored', 'index.lock')
     writeFileSync(namesake, 'owner bytes'); utimesSync(namesake, f.now / 1000, f.now / 1000)
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'recent' })
   })
   it('the second idle observation includes index.lock directories changed after inventory', () => {
     const f = setup(); const dir = repository(f)
     mkdirSync(join(dir, 'ignored', 'index.lock'), { recursive: true })
     const file = join(dir, 'ignored', 'index.lock', 'work'); writeFileSync(file, 'owner bytes')
     f.options.gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
       if (args.includes('status')) utimesSync(file, f.now / 1000, f.now / 1000)
       return spawnSync(cmd, args, options)
     }
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'recent' })
   })
   it('locked registered worktrees are KEEP and registration does not alter project bytes', () => {
     const f = setup(); const main = repository(f, 'main'); const dir = join(f.source, 'locked linked')
     git(main, f.env, 'worktree', 'add', '-qb', 'linked', dir)
     git(main, f.env, 'worktree', 'lock', '--reason', 'owner lease', dir)
     const before = fingerprint(f.project)
     expect(sweep!.scanProject(f.options).entries.find((e: { path: string }) => e.path === dir))
       .toMatchObject({ verdict: 'KEEP', reason: 'locked' })
     expect(fingerprint(f.project)).toEqual(before)
   })
   it.skipIf(process.platform === 'win32').each([false, true])('missing registered worktrees remain visible (locked=%s)', locked => {
     const f = setup(); const main = repository(f, 'main'); const dir = join(f.source, 'missing\nlinked')
     git(main, f.env, 'worktree', 'add', '-qb', 'missing', dir)
     if (locked) git(main, f.env, 'worktree', 'lock', dir)
     rmSync(dir, { recursive: true })
     expect(sweep!.scanProject(f.options).entries.find((e: { path: string }) => e.path === dir))
       .toMatchObject({ verdict: 'KEEP', reason: locked ? 'registered-missing' : 'registered-prunable' })
   })
   it('an unreadable worktree registry cannot produce eligibility', () => {
     const f = setup(); repository(f)
     f.options.gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => args.includes('worktree')
       ? { status: 1, stdout: '' } : spawnSync(cmd, args, options)
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'worktree-registry-unavailable' })
   })
   it('a prunable registration is KEEP even if a directory still occupies its path', () => {
     const f = setup(); const dir = repository(f)
     const registered = git(dir, f.env, 'rev-parse', '--show-toplevel').trim()
     f.options.gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
       const result = spawnSync(cmd, args, options)
       if (args.includes('worktree')) result.stdout = result.stdout.replace(`worktree ${registered}\0`, `worktree ${registered}\0prunable stale registration\0`)
       return result
     }
     expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'registered-prunable' })
   })
   it('registry paths outside the direct-child scope are counted outside the sweep, never made entries', () => {
     const f = setup(); const main = repository(f, 'main')
     git(main, f.env, 'worktree', 'add', '-qb', 'outside', join(f.root, 'outside'))
     git(main, f.env, 'worktree', 'add', '-qb', 'nested', join(main, 'nested'))
     const before = fingerprint(f.root)
     const report = sweep!.scanProject(f.options)
     expect(report.entries.map((row: { name: string }) => row.name)).toEqual(['main'])
     const normalized = (file: string) => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file)
     expect(report.outsideSweep.count).toBe(2)
     expect(report.outsideSweep.paths.map(normalized).sort()).toEqual([join(main, 'nested'), join(f.root, 'outside')].map(normalized).sort())
     expect(fingerprint(f.root)).toEqual(before)
   })
   it.skipIf(process.platform === 'win32').each(['win32', 'darwin'])('registry path spelling preserves locked and missing records (%s)', platform => {
     const f = setup(); const main = repository(f, 'main'); const locked = join(f.source, 'locked'); const missing = join(f.source, 'missing')
     git(main, f.env, 'worktree', 'add', '-qb', 'locked', locked); git(main, f.env, 'worktree', 'lock', locked)
     git(main, f.env, 'worktree', 'add', '-qb', 'missing', missing); rmSync(missing, { recursive: true })
     const prefix = platform === 'win32' ? f.source.replaceAll('/', '\\') : f.source.toUpperCase()
     f.options.platform = platform; f.options.pid = 42; f.options.cwd = f.project
     f.options.lsofRun = () => ({ status: 0, stdout: `p42\nfcwd\nn${f.project}\n` })
     f.options.gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
       const result = spawnSync(cmd, args, options)
       if (args.includes('worktree')) {
         result.stdout = result.stdout.replaceAll(f.source, prefix)
         if (platform === 'win32') result.stdout = result.stdout.replaceAll(`${prefix}/`, `${prefix}\\`)
       }
       return result
     }
     const before = fingerprint(f.project); const report = sweep!.scanProject(f.options)
     expect(report.entries.find((row: { name: string }) => row.name === 'locked')).toMatchObject({ verdict: 'KEEP', reason: 'locked' })
     expect(report.entries.find((row: { name: string }) => row.name === 'missing')).toMatchObject({ verdict: 'KEEP', reason: 'registered-prunable' })
     expect(fingerprint(f.project)).toEqual(before)
   })
  it('G13 direct symlinks and mounted children are not entries; ancestor mounts refuse the source', () => {
    const f = setup(); repository(f); symlinkSync(f.root, join(f.source, 'link'))
    f.options.mounts = [join(f.source, 'clean')]
    expect(sweep!.scanProject(f.options).entries.map((e: { reason: string }) => e.reason)).toEqual(['not-an-entry', 'not-an-entry'])
    f.options.mounts = [join(f.project, '.claude')]
    expect(sweep!.scanProject(f.options).reason).toBe('source-mount-boundary')
  })
  it('D3 a symlink source and empty mountinfo are named refusals', () => {
    const f = setup()
    writeFileSync(join(f.procRoot, 'self', 'mountinfo'), '')
    expect(sweep!.scanProject(f.options).reason).toContain('mountinfo root witness unavailable')
    rmSync(f.source, { recursive: true }); symlinkSync(f.root, f.source)
    expect(sweep!.scanProject(f.options).reason).toBe('source-not-canonical')
  })
  it('D3 the real CLI uses injected mountinfo before planning any entry', () => {
    const f = setup(); repository(f); const before = fingerprint(f.project)
    writeFileSync(join(f.procRoot, 'self', 'mountinfo'), '')
    const out = join(f.root, 'boundary.json')
    execFileSync(process.execPath, [cli, 'run', '--mode', 'report', '--out', out], { env: f.env })
    expect(JSON.parse(readFileSync(out, 'utf8')).reason).toContain('mountinfo root witness unavailable')
    expect(fingerprint(f.project)).toEqual(before)
  })
  it('G16 namespace uncertainty never produces eligibility', () => {
    const f = setup(); repository(f); f.options.hostNamespace = { status: 'unknown' }
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'liveness unknown: not in the host PID namespace' })
  })
  it.skipIf(process.platform === 'win32')('recent ctime, including git internals with old mtimes, prevents eligibility', () => {
    const f = setup(); const dir = repository(f)
    for (const row of fingerprint(dir)) utimesSync(`${dir}${row[0]}`, 0, 0)
    const times = fingerprint(dir).map((row: readonly [string, string, string, string, unknown]) => BigInt(row[3]))
    const latest = times.reduce((a: bigint, b: bigint) => a > b ? a : b, 0n)
    f.options.now = Number(latest / 1_000_000n) + 1
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'recent' })
  })
  it('the 72-hour quiet threshold uses raw nanoseconds rather than rounded display age', () => {
    const f = setup(); const dir = repository(f)
    const times = fingerprint(dir).flatMap((row: readonly [string, string, string, string, unknown]) => [BigInt(row[2]), BigInt(row[3])])
    const latest = times.reduce((a: bigint, b: bigint) => a > b ? a : b, 0n)
    f.options.now = Number(latest / 1_000_000n) + 72 * 3600_000 - 1
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'recent' })
    f.options.now += 2
    expect(entry(f)).toMatchObject({ verdict: 'ELIGIBLE (report only)' })
  })
  it('ignored large files are KEEP cannot-archive', () => {
    const f = setup(); const dir = repository(f)
    writeFileSync(join(dir, 'ignored'), '')
    truncateSync(join(dir, 'ignored'), 101 * 1024 ** 2)
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'cannot-archive' })
  })
  it.skipIf(process.platform === 'win32')('special ignored files are KEEP cannot-archive', () => {
    const f = setup(); const dir = repository(f)
    execFileSync('mkfifo', [join(dir, 'ignored')])
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'cannot-archive' })
  })
   it('D3 all outside-sweep sentinels and a node_modules symlink remain byte-identical', () => {
    const f = setup(); const dir = repository(f)
    for (const suffix of ['.claude/scripts/.worktrees/W', 'worktrees/W', '.claude/reports/X', '.claude/archives/X']) {
      mkdirSync(join(f.project, suffix), { recursive: true }); writeFileSync(join(f.project, suffix, 'sentinel'), suffix)
    }
    mkdirSync(join(dir, 'node_modules')); symlinkSync(f.root, join(dir, 'node_modules', 'outside'))
    const before = fingerprint(f.project)
    sweep!.scanProject(f.options)
     expect(fingerprint(f.project)).toEqual(before)
   })
   it.skipIf(process.platform === 'win32')('G20 a read-only entry is inspected without chmod or metadata changes', () => {
     const f = setup(); const dir = repository(f)
     chmodSync(dir, 0o555)
     try {
       const before = fingerprint(f.project)
       sweep!.scanProject(f.options)
       expect(fingerprint(f.project)).toEqual(before)
     } finally { chmodSync(dir, 0o755) }
   })
  it('sweep tests use injected procfs; only the designated host diagnostic reads the real host', () => {
    const dir = new URL('.', import.meta.url)
    for (const name of readdirSync(dir).filter(name => /^worktree-sweep-.*\.test\.ts$/.test(name) && name !== 'worktree-sweep-host.test.ts')) {
      const text = readFileSync(new URL(name, dir), 'utf8')
      expect(text).not.toContain("'" + '/pro' + 'c')
    }
  })
  it('G26 every CLI command preserves the whole project file list, sizes, mtimes and bytes', () => {
    const f = setup(); const dir = repository(f); writeFileSync(join(dir, 'tracked'), 'keep me')
    const before = fingerprint(f.project)
    for (const [index, args] of [[], ['run', '--mode', 'report'], ['run', '--mode', 'auto'], ['run', '--mode', 'apply'],
      ['purge'], ['restore', 'anything'], ['status'], ['--help']].entries()) {
      const command = () => execFileSync(process.execPath, [cli, ...args, '--project', f.project, '--out', join(f.root, `report-${index}.json`)], { env: f.env, stdio: 'pipe' })
      if (index <= 2 || index === 7) expect(command).not.toThrow()
      else expect(command).toThrow()
      expect(fingerprint(f.project), args.join(' ')).toEqual(before)
    }
  })
  it.skipIf(process.platform === 'win32')('G26 external Git clean filters cannot write during a report', () => {
    const f = setup(); const dir = repository(f)
    writeFileSync(join(dir, '.gitattributes'), 'tracked filter=fixture\n')
    git(dir, f.env, 'add', '.gitattributes')
    git(dir, f.env, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'attributes')
    git(dir, f.env, 'config', 'filter.fixture.clean', 'printf marker > ignored; /bin/cat')
    writeFileSync(join(dir, 'tracked'), 'edit here\n'); utimesSync(join(dir, 'tracked'), 0, 0)
    const before = fingerprint(f.project)
    const verdict = entry(f)
    expect(fingerprint(f.project), 'external clean filter must remain unexecuted').toEqual(before)
    expect(verdict).toMatchObject({ verdict: 'KEEP', reason: 'git-status-failed', detail: expect.stringContaining('filter') })
  })
  it('D5 recursive submodule status is kept without entering another git execution context', () => {
    const f = setup(); const dir = repository(f)
    const head = git(dir, f.env, 'rev-parse', 'HEAD').trim()
    git(dir, f.env, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`)
    const before = fingerprint(f.project)
    expect(entry(f)).toMatchObject({ verdict: 'KEEP', reason: 'git-status-failed', detail: expect.stringContaining('submodule') })
    expect(fingerprint(f.project)).toEqual(before)
  })
  it.each(['environment', 'global config'])('G26 inherited Git trace targets cannot write into the project (%s)', origin => {
    const f = setup(); repository(f)
    const trace = join(f.project, 'trace.log')
    if (origin === 'global config') {
      f.env.GIT_CONFIG_GLOBAL = join(f.root, 'global.config')
      writeFileSync(f.env.GIT_CONFIG_GLOBAL, `[trace2]\n eventTarget = ${JSON.stringify(trace)}\n`)
    } else f.env.GIT_TRACE = trace
    const before = fingerprint(f.project)
    sweep!.scanProject(f.options)
    expect(fingerprint(f.project), 'Git trace must not write during a report').toEqual(before)
  })
  it('G26 inherited Git context cannot conceal uncommitted work in an entry', () => {
    const f = setup(); const dir = repository(f); const other = repository(f, 'other')
    writeFileSync(join(dir, 'tracked'), 'owner change\n')
    f.env.GIT_DIR = join(other, '.git'); f.env.GIT_WORK_TREE = other
    const verdict = sweep!.scanProject(f.options).entries.find((row: { path: string }) => row.path === dir)
    expect(verdict).toMatchObject({ verdict: 'KEEP', reason: 'uncommitted' })
  })
  it('G21 apply is refused; auto and default are report-only', () => {
    const f = setup(); repository(f)
    let output = ''
    try { execFileSync(process.execPath, [cli, 'run', '--mode', 'apply'], { env: f.env, stdio: 'pipe' }) }
    catch (e) { output = String((e as { stderr: Buffer }).stderr) }
    expect(output).toBe('worktree sweep: apply is not available in this version (deletion design open)\n')
    execFileSync(process.execPath, [cli, 'run', '--mode', 'auto', '--out', join(f.root, 'report.json')], { env: f.env })
    expect(JSON.parse(readFileSync(join(f.root, 'report.json'), 'utf8')).mode).toBe('report')
  })
  it('rejects an existing output and a symlink output', () => {
    const f = setup(); repository(f); const before = fingerprint(f.project)
    const target = join(f.root, 'existing'); writeFileSync(target, 'sentinel')
    const link = join(f.root, 'link'); symlinkSync(join(f.project, 'created'), link)
    for (const out of [target, link]) {
      expect(() => execFileSync(process.execPath, [cli, 'run', '--out', out], { env: f.env, stdio: 'pipe' })).toThrow()
    }
    expect(readFileSync(target, 'utf8')).toBe('sentinel'); expect(fingerprint(f.project)).toEqual(before)
   })

const quietMs = 72 * 3600_000
type SweepRow = { name: string; reason: string; verdict: string; bytes: number | null; ageHours: number | null }
const row = (report: { entries: SweepRow[] }, name: string) => report.entries.find(entry => entry.name === name)!

it.each([false, true])('B1 shared-file ctime is quiet, with a readable control (real write=%s)', async realWrite => {
  const f = setup()
  const linked = repository(f, 'linked'); const control = repository(f, 'control')
  for (const dir of [linked, control]) {
    mkdirSync(join(dir, 'node_modules', '.pnpm', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.pnpm', 'pkg', 'index.js'), 'x\n')
  }
  const file = join(linked, 'node_modules', '.pnpm', 'pkg', 'index.js')
  const before = lstatSync(file, { bigint: true }); const created = Date.now()
  // Wait for the observation cutoff to pass before causing the real link-count change.
  await vi.waitUntil(() => Date.now() > created + 1000, { timeout: 5000 })
  linkSync(file, join(f.root, 'store-link'))
  const after = lstatSync(file, { bigint: true })
  expect(after.nlink).toBeGreaterThan(1n)
  expect(after.ctimeNs).toBeGreaterThan(before.ctimeNs)
  expect(after.mtimeNs).toBe(before.mtimeNs)
  const options = { ...f.options, now: created + quietMs + 1000 }
  const report = sweep!.scanProject(options)
  expect(row(report, 'control').reason, 'single-link control must be quiet').toBe('eligible')
  expect(row(report, 'linked').reason, 'a hard-link ctime bump is not worktree activity').toBe('eligible')
  if (!realWrite) return
  writeFileSync(file, 'real write\n')
  expect(lstatSync(file, { bigint: true }).mtimeNs).toBeGreaterThan(after.mtimeNs)
  const written = sweep!.scanProject(options)
  expect(row(written, 'control').reason, 'control must stay quiet after the shared-file write').toBe('eligible')
  expect(row(written, 'linked')).toMatchObject({ verdict: 'KEEP', reason: 'recent' })
})

it('B2 every entry receives a fresh inventory budget regardless of its position', () => {
  const f = setup()
  const names = Array.from({ length: 14 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`)
  for (const name of names) repository(f, name)
  let calls = 0
  sweep!.scanProject({ ...f.options, clock: () => { calls++; return 0 } })
  const perEntry = Math.ceil(calls / names.length)
  const stepMs = Math.floor(48000 / perEntry)
  let time = 0
  const report = sweep!.scanProject({ ...f.options, clock: () => { time += stepMs; return time } })
  const reasons = names.map(name => row(report, name).reason)
  expect(reasons, `reasons by position: ${reasons.join(', ')}`).toEqual(names.map(() => 'eligible'))
})

it('B2 global exhaustion lists every remaining entry as KEEP scan-deadline', () => {
  const f = setup()
  const names = ['a-first', 'b-later', 'c-last'] as const
  const first = repository(f, names[0]); repository(f, names[1]); repository(f, names[2])
  mkdirSync(join(f.source, 'd-plain')); mkdirSync(join(f.source, 'e-snapshot.base'))
  let time = 0
  const examined: string[] = []
  const gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
    if (args.includes('status')) { examined.push(args[args.indexOf('-C') + 1]!); time = 1001 }
    return spawnSync(cmd, args, options)
  }
  const report = sweep!.scanProject({ ...f.options, gitRun, clock: () => time, scanBudgetMs: 1000 })
  expect(row(report, names[0]).reason).toBe('eligible')
  expect(report.entries.slice(1).map((entry: SweepRow) => [entry.name, entry.verdict, entry.reason, entry.bytes, entry.ageHours]))
    .toEqual([...names.slice(1), 'd-plain', 'e-snapshot.base'].map(name => [name, 'KEEP', 'scan-deadline', null, null]))
  expect(examined, 'expired entries must not run per-entry Git status').toEqual([first])
})

it('B2 an entry exceeding its own budget is cannot-archive and the next entry still runs', () => {
  const f = setup(); const slow = repository(f, 'a-slow'); repository(f, 'b-fast')
  let time = 0; let armed = false; let charged = false
  const clock = () => {
    if (armed && !charged) { time += 120001; charged = true }
    return time
  }
  const gitRun = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
    if (args.includes('--absolute-git-dir') && args[args.indexOf('-C') + 1] === slow) armed = true
    return spawnSync(cmd, args, options)
  }
  const report = sweep!.scanProject({ ...f.options, clock, gitRun })
  expect(row(report, 'a-slow')).toMatchObject({ verdict: 'KEEP', reason: 'cannot-archive' })
  expect(row(report, 'b-fast').reason).toBe('eligible')
})
