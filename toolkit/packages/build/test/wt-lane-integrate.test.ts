import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
const { integrateLane, parseIntegrateArgs } = await import(process.env.WT_INTEGRATION_MODULE
  ?? new URL('../../../../plugin/bin/lib/lane-integrate.mjs', import.meta.url).href)

const roots: string[] = []
const CLI = fileURLToPath(new URL('../../../../plugin/bin/wt-lane.mjs', import.meta.url))
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function command(program: string, args: string[], options: Record<string, unknown> = {}) {
  return spawnSync(program, args, { encoding: 'utf8', env: HERMETIC, ...options })
}
function ciEvidence(args: string[]) {
  if (args.includes('--json') && args.includes('url')) return { status: 0, stdout: 'https://example.test/actions/runs/42\n', stderr: '' }
  if (args.includes('--json') && args.includes('jobs')) return { status: 0, stdout: '{"jobs":[{"name":"test","conclusion":"failure"}]}', stderr: '' }
  if (args.includes('nameWithOwner')) return { status: 0, stdout: 'owner/repo\n', stderr: '' }
  if (args[0] === 'api') return { status: 0, stdout: '', stderr: '' }
  if (args.includes('--log')) return { status: 0, stdout: '', stderr: '' }
  return { status: 1, stdout: '', stderr: 'unexpected gh command' }
}

function git(cwd: string, ...args: string[]) {
  const result = command('git', args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-integrate-'))); roots.push(root)
  const repository = join(root, 'repository'); const lane = join(root, 'lane'); const into = join(root, 'into')
  mkdirSync(repository)
  git(repository, 'init', '-q', '-b', 'fixture-root')
  git(repository, 'config', 'user.name', 'Fixture')
  git(repository, 'config', 'user.email', 'fixture@example.test')
  git(repository, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repository, 'base.txt'), 'base\n')
  writeFileSync(join(repository, '.gitignore'), '.lane/\nnode_modules\n')
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ scripts: { quality: 'node toolkit/scripts/quality-changed.mjs' } }))
  const toolkit = fileURLToPath(new URL('../../..', import.meta.url))
  copyQualityModule(join(toolkit, 'scripts/quality-changed.mjs'), join(repository, 'toolkit/scripts/quality-changed.mjs'))
  mkdirSync(join(repository, 'plugin'))
  writeFileSync(join(repository, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'base')
  git(repository, 'worktree', 'add', '-q', '-b', 'develop', into, 'HEAD')
  git(repository, 'worktree', 'add', '-q', '-b', 'card/test-lane', lane, 'HEAD')
  symlinkSync(join(toolkit, 'node_modules'), join(into, 'node_modules'), 'junction')
  mkdirSync(join(lane, '.lane'))
  const report = join(lane, '.lane', 'report.md')
  writeFileSync(report, '# Report\n\n## Verification\nChanges are uncommitted and focused tests pass.\n')
  const message = join(root, 'message.txt'); writeFileSync(message, 'Integrate fixture lane\n\nFixture body.\n')
  const archiveRoot = join(root, 'archive')
  const stdout: string[] = []; const stderr: string[] = []
  return { root, repository, lane, into, report, message, archiveRoot, stdout, stderr }
}

function options(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return {
    dir: f.lane,
    into: f.into,
    message: f.message,
    archiveRoot: f.archiveRoot,
    keepWorktree: true,
    stdout: (line: string) => f.stdout.push(line),
    stderr: (line: string) => f.stderr.push(line),
    readSuiteLock: () => ({ held: false, holder: null, ageMs: null }),
    ...extra,
  }
}

  it.skipIf(process.platform === 'win32')('accepts a symlink alias of the registered lane worktree; Windows covers 8.3 aliases through native realpath canonicalization', async () => {
    const f = fixture()
    const alias = join(f.root, 'lane-alias')
    symlinkSync(f.lane, alias, 'dir')
    writeFileSync(join(f.lane, 'aliased.txt'), 'aliased\n')

    expect(await integrateLane(options(f, { dir: alias })), f.stderr.join('\n')).toBe(0)
    expect(git(f.into, 'show', 'HEAD:aliased.txt')).toBe('aliased')
  })

  it('commits outside .lane, merges in the named integration worktree, and verifies the archive', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'delivered.txt'), 'delivered\n')
    const calls: string[][] = []
    const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
      calls.push([program, ...args])
      return command(program, args, runOptions)
    }

    const code = await integrateLane(options(f, { runner }))

    expect(code, f.stderr.join('\n')).toBe(0)
    expect(existsSync(join(f.archiveRoot, 'lane', 'lane', 'report.md'))).toBe(true)
    expect(git(f.into, 'show', 'HEAD:delivered.txt')).toBe('delivered')
    expect(command('git', ['-C', f.lane, 'cat-file', '-e', 'HEAD:.lane/report.md']).status).not.toBe(0)
    expect(git(f.into, 'log', '-1', '--format=%s')).toBe('merge: Integrate fixture lane')
    expect(git(f.into, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(3)
    expect(git(f.into, 'show', '-s', '--format=%s', 'HEAD^2')).toBe('Integrate fixture lane')
    const merge = calls.filter((argv) => argv[0] === 'git' && argv.includes('merge') && argv.includes('--no-ff'))
    expect(merge).toHaveLength(1)
    expect(merge[0]!.some((arg) => arg.includes('&&') || arg.includes(';'))).toBe(false)
    expect(f.stdout).toEqual([
      'step 1 preflight: EXIT=0', 'step 2 commit: EXIT=0', 'step 3 merge: EXIT=0',
      'step 4 archive: EXIT=0', 'step 5 pre-remove-check: EXIT=0', 'step 6 remove: EXIT=0',
    ])
  })

  it('refuses missing reports, missing messages, retention markers, and clean not-ahead claims', async () => {
    const missingReport = fixture(); rmSync(missingReport.report)
    expect(await integrateLane(options(missingReport))).toBe(1)
    expect(missingReport.stdout.at(-1)).toBe('step 1 preflight: EXIT=1')

    const missingMessage = fixture(); rmSync(missingMessage.message)
    expect(await integrateLane(options(missingMessage))).toBe(1)

    const retained = fixture()
    writeFileSync(join(retained.lane, '.lane', 'worktree-retention.json'), `${JSON.stringify({ version: 1, cardId: '123', retainedAt: new Date().toISOString(), reason: 'review', phase: 'review', worktree: retained.lane, expiry: { boardId: null, removeWhen: 'card is absent or in Done or NotDoing' } })}\n`)
    expect(await integrateLane(options(retained))).toBe(1)
    expect(retained.stderr.join('\n')).toContain('card 123')
    expect(retained.stderr.join('\n')).toContain('wt-worktree-remove.mjs')

    const clean = fixture(); writeFileSync(clean.report, '# Report\n\n## Verification\nNo commit was created.\n')
    expect(await integrateLane(options(clean))).toBe(1)
    expect(clean.stderr.join('\n')).toContain('clean and not ahead')
  })

  it('refuses an integration worktree from another repository', async () => {
    const f = fixture(); const foreign = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    expect(await integrateLane(options(f, { into: foreign.into }))).toBe(1)
    expect(f.stderr.join('\n')).toContain('same repository')
  })

  it('integrates a clean lane that is already ahead without trying to commit nothing', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'ahead.txt'), 'ahead\n')
    git(f.lane, 'add', 'ahead.txt'); git(f.lane, 'commit', '-qm', 'already committed')
    writeFileSync(f.report, '# Report\n\n## Verification\nCommitted changes passed focused tests.\n')

    expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
    expect(git(f.into, 'show', 'HEAD:ahead.txt')).toBe('ahead')
  })

  it('refuses a dirty integration worktree before committing or merging the lane', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'lane\n'); writeFileSync(join(f.into, 'local-notes.txt'), 'local\n')
    const laneHead = git(f.lane, 'rev-parse', 'HEAD'); const intoHead = git(f.into, 'rev-parse', 'HEAD')

    expect(await integrateLane(options(f))).toBe(1)
    expect(f.stderr.join('\n')).toContain('integration worktree is dirty')
    expect(git(f.lane, 'rev-parse', 'HEAD')).toBe(laneHead)
    expect(git(f.into, 'rev-parse', 'HEAD')).toBe(intoHead)
  })

  it('resolves a CHANGELOG-only conflict with ours before theirs', async () => {
    const f = fixture()
    writeFileSync(join(f.into, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- ours\n')
    git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'ours')
    writeFileSync(join(f.lane, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- theirs\n')

    expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
    const merged = readFileSync(join(f.into, 'plugin', 'CHANGELOG.md'), 'utf8')
    expect(merged.replaceAll('\r\n', '\n')).toContain('- ours\n- theirs\n')
    expect(merged).not.toContain('<<<<<<<')
  })

  it('aborts and reports any non-CHANGELOG merge conflict', async () => {
    const f = fixture()
    writeFileSync(join(f.into, 'base.txt'), 'ours\n'); git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'ours')
    writeFileSync(join(f.lane, 'base.txt'), 'theirs\n')

    expect(await integrateLane(options(f))).toBe(1)
    expect(f.stderr.join('\n')).toContain('base.txt')
    expect(existsSync(join(f.repository, '.git', 'worktrees', 'into', 'MERGE_HEAD'))).toBe(false)
    expect(f.stdout.at(-1)).toBe('step 3 merge: EXIT=1')
  })

  it('aborts a CHANGELOG-only merge when the resolution commit fails', async () => {
    const f = fixture()
    writeFileSync(join(f.into, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- ours\n')
    git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'ours')
    writeFileSync(join(f.lane, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- theirs\n')
    const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
      if (program === 'git' && args.includes('commit') && args.includes('--no-edit')) return { status: 1, stdout: '', stderr: 'fixture commit hook refused' }
      return command(program, args, runOptions)
    }

    expect(await integrateLane(options(f, { runner }))).toBe(1)
    expect(f.stderr.join('\n')).toContain('fixture commit hook refused')
    expect(existsSync(join(f.repository, '.git', 'worktrees', 'into', 'MERGE_HEAD'))).toBe(false)
  })

  it('verifies the copied archive before removing the worktree', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    const copy = (source: string, destination: string) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'report.md'), `${readFileSync(join(source, 'report.md'), 'utf8')}tampered\n`)
    }

    expect(await integrateLane(options(f, { keepWorktree: false, copy }))).toBe(1)
    expect(existsSync(f.lane)).toBe(true)
    expect(f.stdout.at(-1)).toBe('step 4 archive: EXIT=1')
  })

  it('refuses an archive destination inside the lane before committing', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    expect(await integrateLane(options(f, { archiveRoot: join(f.lane, 'archive') }))).toBe(1)
    expect(f.stderr.join('\n')).toContain('archive destination must be outside')
    expect(f.stdout).toEqual(['step 1 preflight: EXIT=1'])
  })

  it('runs the optional check before removal, then removes the worktree and merged branch', async () => {
    const refused = fixture(); writeFileSync(join(refused.lane, 'change.txt'), 'change\n')
    expect(await integrateLane(options(refused, { keepWorktree: false, preRemoveCheck: [process.execPath, '-e', 'process.exit(7)'] }))).toBe(1)
    expect(existsSync(refused.lane)).toBe(true)
    expect(refused.stdout.at(-1)).toBe('step 5 pre-remove-check: EXIT=1')

    const removed = fixture(); writeFileSync(join(removed.lane, 'change.txt'), 'change\n')
    expect(await integrateLane(options(removed, { keepWorktree: false })), removed.stderr.join('\n')).toBe(0)
    expect(existsSync(removed.lane)).toBe(false)
    expect(command('git', ['-C', removed.into, 'show-ref', '--verify', '--quiet', 'refs/heads/card/test-lane']).status).not.toBe(0)
  })

  it('re-verifies the live lane archive after a successful pre-remove check mutates evidence', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    const source = `require('node:fs').writeFileSync(require('node:path').join(process.argv[1], '.lane', 'final-check.json'), '{"ok":true}\\n')`

    expect(await integrateLane(options(f, { keepWorktree: false, preRemoveCheck: [process.execPath, '-e', source] }))).toBe(1)
    expect(f.stdout.at(-1)).toBe('step 6 remove: EXIT=1')
    expect(f.stderr.join('\n')).toContain('final-check.json')
    expect(existsSync(f.lane)).toBe(true)
    expect(git(f.into, 'show', 'HEAD:change.txt')).toBe('change')
  })

  it('real integrate CLI keeps the merged lane when a successful check adds unarchived evidence', () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    const source = `require('node:fs').writeFileSync(require('node:path').join(process.argv[1], '.lane', 'cli-final.json'), '{"ok":true}\\n')`

    const result = command(process.execPath, [CLI, 'integrate', '--dir', f.lane, '--into', f.into, '--message', f.message, '--archive-root', f.archiveRoot, '--pre-remove-check', process.execPath, '-e', source])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('step 6 remove: EXIT=1')
    expect(result.stderr).toContain('archive verification failed: missing cli-final.json')
    expect(existsSync(f.lane)).toBe(true)
    expect(git(f.into, 'show', 'HEAD:change.txt')).toBe('change')
  })

  it('prints a checkable dry-run plan with every resolved value and writes nothing', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    const remote = join(f.root, 'public.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-q')
    git(f.repository, 'remote', 'add', 'public', remote)
    git(f.repository, 'push', '-q', 'public', 'fixture-root:main')
    git(f.repository, 'fetch', '-q', 'public')
    const authorizeFile = join(f.root, 'authorized.json')
    const parsed = parseIntegrateArgs(['--dir', f.lane, '--into', f.into, '--message', f.message, '--archive-root', f.archiveRoot, '--pre-remove-check', 'node', 'check.mjs', '--ci-branch', 'ci/test', '--remote', 'public', '--authorize-file', authorizeFile, '--merge-subject', 'custom merge subject', '--dry-run', '--force'])
    expect(parsed).toMatchObject({ preRemoveCheck: ['node', 'check.mjs'], dryRun: true, force: true, mergeSubject: 'custom merge subject' })
    const laneHead = git(f.lane, 'rev-parse', 'HEAD'); const intoHead = git(f.into, 'rev-parse', 'HEAD')

    const code = await integrateLane(options(f, parsed))

    expect(code, f.stderr.join('\n')).toBe(0)
    const plan = f.stdout.join('\n')
    expect(plan).toContain(`lane branch=card/test-lane tip=${laneHead}`)
    const canonicalInto = (realpathSync.native ?? realpathSync)(f.into)
    expect(plan).toContain(`integration tree=${canonicalInto} HEAD=${intoHead}`)
    expect(plan).toContain('commit subject=Integrate fixture lane')
    expect(plan).toContain('merge subject=custom merge subject')
    expect(plan).toContain(`archive destination=${join(f.archiveRoot, 'lane', 'lane')}`)
    expect(plan).toContain('remove worktree=yes')
    expect(plan).toContain(`remote=public authorization file=${authorizeFile} commits=2`)
    expect(git(f.lane, 'rev-parse', 'HEAD')).toBe(laneHead)
    expect(git(f.into, 'rev-parse', 'HEAD')).toBe(intoHead)
    expect(git(f.lane, 'status', '--porcelain')).toContain('change.txt')
    expect(existsSync(f.archiveRoot)).toBe(false)
    expect(existsSync(authorizeFile)).toBe(false)
  })

  it('refuses a suite lock held inside the integration tree, but not one elsewhere, unless forced', async () => {
    const inside = fixture(); writeFileSync(join(inside.lane, 'change.txt'), 'change\n')
    const insideHead = git(inside.into, 'rev-parse', 'HEAD')
    const heldInside = () => ({ held: true, holder: { pid: 4242, cwd: join(inside.into, 'toolkit'), startedAt: new Date(Date.now() - 65_000).toISOString() }, ageMs: 65_000 })
    mkdirSync(join(inside.into, 'toolkit'), { recursive: true })
    expect(await integrateLane(options(inside, { readSuiteLock: heldInside }))).toBe(1)
    expect(inside.stdout.at(-1)).toBe('step 3 merge: EXIT=1')
    expect(inside.stderr.join('\n')).toContain('holder pid 4242')
    expect(inside.stderr.join('\n')).toContain('held for 1m5s')
    expect(git(inside.into, 'rev-parse', 'HEAD')).toBe(insideHead)
    expect(await integrateLane(options(inside)), inside.stderr.join('\n')).toBe(0)
    expect(git(inside.into, 'show', 'HEAD:change.txt')).toBe('change')

    const elsewhere = fixture(); writeFileSync(join(elsewhere.lane, 'change.txt'), 'change\n')
    const otherCwd = join(elsewhere.root, 'other'); mkdirSync(otherCwd)
    expect(await integrateLane(options(elsewhere, { readSuiteLock: () => ({ held: true, holder: { pid: 4343, cwd: otherCwd, startedAt: new Date().toISOString() }, ageMs: 0 }) })), elsewhere.stderr.join('\n')).toBe(0)

    const forced = fixture(); writeFileSync(join(forced.lane, 'change.txt'), 'change\n'); mkdirSync(join(forced.into, 'toolkit'), { recursive: true })
    expect(await integrateLane(options(forced, { force: true, readSuiteLock: () => ({ held: true, holder: { pid: 4444, cwd: join(forced.into, 'toolkit'), startedAt: new Date().toISOString() }, ageMs: 0 }) })), forced.stderr.join('\n')).toBe(0)
  })

  it('refuses a held suite lock whose cwd cannot be read', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    expect(await integrateLane(options(f, { readSuiteLock: () => ({ held: true, holder: { pid: 4545, cwd: join(f.root, 'gone'), startedAt: new Date().toISOString() }, ageMs: 0 }) }))).toBe(1)
    expect(f.stderr.join('\n')).toContain('cwd is unreadable')
    expect(f.stdout.at(-1)).toBe('step 3 merge: EXIT=1')
  })

  it('accepts an explicit merge subject override', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    expect(await integrateLane(options(f, { mergeSubject: 'land: explicit fixture' })), f.stderr.join('\n')).toBe(0)
    expect(git(f.into, 'log', '-1', '--format=%s')).toBe('land: explicit fixture')
  })

  it('writes exactly the authorized rev-list before pushing the CI branch', async () => {
    const f = fixture(); const remote = join(f.root, 'public.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-q')
    git(f.repository, 'remote', 'add', 'public', remote)
    git(f.repository, 'push', '-q', 'public', 'fixture-root:main')
    git(f.repository, 'fetch', '-q', 'public')
    writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    const authorizeFile = join(f.root, 'authorized.json')

    expect(await integrateLane(options(f, { ciBranch: 'ci/test', authorizeFile })), f.stderr.join('\n')).toBe(0)
    const commits = git(f.into, 'rev-list', 'public/main..ci/test').split('\n').filter(Boolean)
    expect(JSON.parse(readFileSync(authorizeFile, 'utf8'))).toEqual({ commits })
    expect(git(remote, 'rev-parse', 'refs/heads/ci/test')).toBe(git(f.into, 'rev-parse', 'ci/test'))
  })

  it('reads CI jobs and reports an empty fallback log as no evidence of no failures', async () => {
    const f = fixture(); const remote = join(f.root, 'public.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-q')
    git(f.repository, 'remote', 'add', 'public', remote)
    git(f.repository, 'push', '-q', 'public', 'fixture-root:main')
    git(f.repository, 'fetch', '-q', 'public')
    writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    const calls: string[][] = []
    let dispatched = false
    const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
      calls.push([program, ...args])
      if (program === 'git' || program === 'pnpm') return command(program, args, runOptions)
      if (args[0] === 'workflow') { dispatched = true; return { status: 0, stdout: '', stderr: '' } }
      if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: dispatched ? '[{"databaseId":42,"status":"completed","conclusion":"failure","event":"workflow_dispatch"}]' : '[]', stderr: '' }
      return ciEvidence(args)
    }

    expect(await integrateLane(options(f, { ciBranch: 'ci/dispatch', authorizeFile: join(f.root, 'authorized.json'), dispatch: 'cross-os.yml', wait: true, runner }))).toBe(1)
    expect(f.stdout).toContain('job test: failure')
    expect(f.stdout).toContain('log: 0 bytes (fallback empty — not evidence of no failures)')
    expect(calls.find((argv) => argv[0] === 'gh' && argv[1] === 'api')).toBeTruthy()
  })

  it('selects the new workflow run dispatched by this command instead of the pre-existing newest run', async () => {
    const f = fixture(); const remote = join(f.root, 'public.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-q')
    git(f.repository, 'remote', 'add', 'public', remote); git(f.repository, 'push', '-q', 'public', 'fixture-root:main'); git(f.repository, 'fetch', '-q', 'public')
    writeFileSync(join(f.lane, 'change.txt'), 'change\n')
    let dispatched = false
    const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
      if (program === 'git' || program === 'pnpm') return command(program, args, runOptions)
      if (args[0] === 'workflow') { dispatched = true; return { status: 0, stdout: '', stderr: '' } }
      if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(dispatched
        ? [{ databaseId: 41, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', createdAt: '2026-09-18T09:00:00Z' }, { databaseId: 42, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', createdAt: new Date().toISOString() }]
        : [{ databaseId: 41, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', createdAt: '2026-09-18T09:00:00Z' }]), stderr: '' }
      if (args.includes('--json') && args.includes('url')) return { status: 0, stdout: `https://example.test/actions/runs/${args[2]}\n`, stderr: '' }
      return { status: 1, stdout: '', stderr: 'unexpected gh command' }
    }

    expect(await integrateLane(options(f, { ciBranch: 'ci/dispatch-own', authorizeFile: join(f.root, 'authorized.json'), dispatch: 'cross-os.yml', runner })), f.stderr.join('\n')).toBe(0)
    expect(f.stdout).toContain('run id=42 url=https://example.test/actions/runs/42')
  })
function copyQualityModule(from: string, to: string, seen = new Set<string>()) {
  if (seen.has(from)) return
  seen.add(from); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to)
  for (const [, relative = ''] of readFileSync(from, 'utf8').matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
    copyQualityModule(resolve(dirname(from), relative), resolve(dirname(to), relative), seen)
  }
}
function installQuality(f: ReturnType<typeof fixture>) {
  const toolkit = fileURLToPath(new URL('../../..', import.meta.url))
  copyQualityModule(join(toolkit, 'scripts/quality-changed.mjs'), join(f.into, 'toolkit/scripts/quality-changed.mjs'))
  copyQualityModule(join(toolkit, 'eslint.config.mjs'), join(f.into, 'toolkit/eslint.config.mjs'))
  writeFileSync(join(f.into, 'toolkit/package.json'), JSON.stringify({ scripts: { quality: 'node scripts/quality-changed.mjs' } }))
  symlinkSync(join(toolkit, 'node_modules'), join(f.into, 'toolkit/node_modules'), 'junction')
  writeFileSync(join(f.into, '.gitignore'), '.lane/\nnode_modules\n')
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'quality entry')
}
function candidateLink(f: ReturnType<typeof fixture>, file: string, target: string, emulated: boolean) {
  if (!emulated) { symlinkSync(target, join(f.lane, file)); return }
  git(f.into, 'config', 'core.symlinks', 'false')
  writeFileSync(join(f.lane, file), target)
  const blob = git(f.lane, 'hash-object', '-w', join(f.lane, file))
  git(f.lane, 'update-index', '--add', '--cacheinfo', `120000,${blob},${file}`)
}
it.each(['toolkit/scripts/lint-scope.mjs', 'plugins/wt-secret-guard/package.json'])('compliant deletion of target chain/config path integrates: %s', async (file) => {
  const f = fixture(); installQuality(f)
  mkdirSync(dirname(join(f.into, file)), { recursive: true })
  writeFileSync(join(f.into, file), file.endsWith('.json') ? '{}' : 'export default []\n')
  if (file.endsWith('.mjs')) {
    const checker = join(f.into, 'toolkit/scripts/quality-changed.mjs')
    writeFileSync(checker, readFileSync(checker, 'utf8').replace("import { dirname }", "import scope from './lint-scope.mjs'\nvoid scope\nimport { dirname }"))
  }
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'target chain input'); git(f.lane, 'merge', '-q', 'develop')
  git(f.lane, 'rm', file)
  if (file.endsWith('.mjs')) {
    const checker = join(f.lane, 'toolkit/scripts/quality-changed.mjs')
    writeFileSync(checker, readFileSync(checker, 'utf8').replace("import scope from './lint-scope.mjs'", 'const scope = []'))
  }
  expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
  expect(command('git', ['-C', f.into, 'cat-file', '-e', `HEAD:${file}`]).status).not.toBe(0)
})
for (const emulated of [false, true]) {
  const suffix = emulated ? ' (Git symlink emulation)' : ''
  const platformSkip = process.platform === 'win32' && !emulated
  it.skipIf(platformSkip)(`compliant docs symlink changes integrate${suffix}`, async () => {
    const f = fixture(); installQuality(f)
    mkdirSync(join(f.lane, 'docs')); candidateLink(f, 'docs/base-link', '../base.txt', emulated)
    expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
  })
  it.skipIf(platformSkip)(`extensionless Node symlinks cannot hide code in a data file${suffix}`, async () => {
    const f = fixture(); installQuality(f)
    const head = git(f.into, 'rev-parse', 'HEAD')
    writeFileSync(join(f.lane, 'plugin/oversized.data'), `#!/usr/bin/env node\nfunction long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
    candidateLink(f, 'plugin/run', 'oversized.data', emulated)
    expect(await integrateLane(options(f))).toBe(1)
    expect(f.stderr.join('\n')).toContain('certification refuses candidate symlink plugin/run')
    expect(git(f.into, 'rev-parse', 'HEAD')).toBe(head)
  })
}
it.skipIf(process.platform === 'win32')('workspace configuration symlinks refuse', async () => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  symlinkSync('../base.txt', join(f.lane, 'toolkit/pnpm-workspace.yaml'))
  expect(await integrateLane(options(f))).toBe(1)
  expect(f.stderr.join('\n')).toContain('certification refuses candidate symlink toolkit/pnpm-workspace.yaml')
})
it('refuses success without target owner-checker execution proof', async () => {
  const f = fixture(); installQuality(f); writeFileSync(join(f.lane, 'delivered.txt'), 'change\n')
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => program === 'pnpm'
    ? { status: 0, stdout: '', stderr: '' } : command(program, args, runOptions)
  expect(await integrateLane(options(f, { runner }))).toBe(1)
  expect(f.stderr.join('\n')).toContain('execution proof missing')
})
it('target pnpm node-options cannot suppress checker pinning', async () => {
  const f = fixture(); installQuality(f)
  writeFileSync(join(f.into, 'toolkit/.npmrc'), 'node-options=--no-warnings\n')
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'target node options'); git(f.lane, 'merge', '-q', 'develop')
  writeFileSync(join(f.lane, 'toolkit/scripts/quality-changed.mjs'), 'process.exit(0)\n')
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    // Model package managers that replace NODE_OPTIONS from their node-options setting.
    return command(program, args, program === 'pnpm' ? { ...runOptions,
      env: { ...(runOptions.env as NodeJS.ProcessEnv), NODE_OPTIONS: '--no-warnings' } } : runOptions)
  }
  expect(await integrateLane(options(f, { runner }))).toBe(1)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
})
it('candidate exemption-list changes cannot exempt candidate code', async () => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  writeFileSync(join(f.lane, 'toolkit/scripts/quality-changed-exemptions.mjs'), "export const exemptPaths = new Set(['plugin/oversized.mjs'])\n")
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  expect(await integrateLane(options(f))).toBe(1)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
})
it('refuses a target quality entry that omits the owner checker', async () => {
  const f = fixture()
  writeFileSync(join(f.into, 'package.json'), JSON.stringify({ scripts: { quality: 'node -e "process.exit(0)"' } }))
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'quality without owner checker')
  writeFileSync(join(f.lane, 'delivered.txt'), 'change\n')
  expect(await integrateLane(options(f))).toBe(1)
  expect(f.stderr.join('\n')).toContain('execution proof missing')
})
it.each(['toolkit/.npmrc', 'toolkit/pnpm-workspace.yaml', 'toolkit/package.json'])('compliant configuration changes are retained after certification: %s', async (file) => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  const contents = file.endsWith('package.json') ? JSON.stringify({ scripts: { quality: 'node -e "process.exit(0)"' } })
    : file.endsWith('.yaml') ? 'packages: []\n' : 'node-options=--no-warnings\n'
  writeFileSync(join(f.lane, file), contents)
  expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
  expect(readFileSync(join(f.into, file), 'utf8')).toBe(contents)
})
it('reports untracked files produced by failed certification', async () => {
  const f = fixture(); installQuality(f); writeFileSync(join(f.lane, 'delivered.txt'), 'change\n')
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (program === 'pnpm') {
      writeFileSync(join(f.into, 'quality-report.json'), '{}')
      return { status: 1, stdout: '', stderr: 'certification refused' }
    }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner }))).toBe(1)
  expect(f.stderr.join('\n')).toContain('rollback incomplete')
  expect(f.stderr.join('\n')).toContain('quality-report.json')
})
it('does not report incomplete rollback when a merge never started', async () => {
  const f = fixture(); writeFileSync(join(f.lane, 'delivered.txt'), 'change\n')
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (args.includes('merge') && args.includes('--no-commit')) return { status: 1, stdout: '', stderr: 'merge did not start' }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner }))).toBe(1)
  expect(f.stderr.join('\n')).toContain('merge did not start')
  expect(f.stderr.join('\n')).not.toContain('rollback incomplete')
})
it.each(['ordinary', 'changelog conflict', 'forced'] as const)('integration refuses a 41-line candidate before committing its merge: %s', async (mode) => {
  const f = fixture(); installQuality(f)
  if (mode === 'changelog conflict') {
    writeFileSync(join(f.into, 'plugin/CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- ours\n')
    git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'ours')
    writeFileSync(join(f.lane, 'plugin/CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- theirs\n')
  }
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const head = git(f.into, 'rev-parse', 'HEAD')
  const bases: (string | undefined)[] = []
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (program === 'pnpm') bases.push((runOptions.env as NodeJS.ProcessEnv).WT_QUALITY_BASE)
    return command(program, args, { ...runOptions, env: { ...(runOptions.env as NodeJS.ProcessEnv), pnpm_config_verify_deps_before_run: 'false' } })
  }
  expect(await integrateLane(options(f, { force: mode === 'forced', runner })), f.stderr.join('\n')).toBe(1)
  expect(git(f.into, 'rev-parse', 'HEAD'), 'a rejected candidate must not be merged').toBe(head)
  expect(git(f.into, 'status', '--porcelain')).toBe('')
  expect(git(f.into, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(3)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
  expect(bases).toEqual([head])
  expect(existsSync(f.archiveRoot)).toBe(false)
})
it.each(['entry', 'checker'])('candidate cannot replace its own certification %s', async (mode) => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  if (mode === 'entry') writeFileSync(join(f.lane, 'toolkit/package.json'), JSON.stringify({ scripts: { quality: 'node -e "process.exit(0)"' } }))
  else writeFileSync(join(f.lane, 'toolkit/scripts/quality-changed.mjs'), 'process.exit(0)\n')
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(1)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
})
it('refuses a target without a quality entry with a remedy', async () => {
  const f = fixture()
  git(f.into, 'rm', 'package.json'); git(f.into, 'commit', '-qm', 'remove quality')
  writeFileSync(join(f.lane, 'change.txt'), 'change\n')
  expect(await integrateLane(options(f))).toBe(1)
  expect(f.stderr.join('\n')).toContain('add scripts.quality')
})
it.skipIf(process.platform === 'win32')('a checker symlink cannot redirect certification into installed dependencies', async () => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  const checker = join(f.lane, 'toolkit/scripts/quality-changed.mjs')
  rmSync(checker)
  symlinkSync('../node_modules/typescript-eslint/dist/index.js', checker)
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(1)
  expect(f.stderr.join('\n')).toContain('certification refuses candidate symlink')
})
it.skipIf(process.platform === 'win32')('candidate package-manager configuration cannot replace the certification shell', async () => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  const shell = join(f.lane, 'toolkit/certify-shell')
  writeFileSync(shell, '#!/bin/sh\nexit 0\n'); chmodSync(shell, 0o755)
  writeFileSync(join(f.lane, 'toolkit/.npmrc'), `script-shell=${join(f.into, 'toolkit/certify-shell')}\n`)
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    const config = join(String(runOptions.cwd), '.npmrc')
    // Exercise script-shell discovery even on package-manager versions that ignore .npmrc.
    if (program === 'pnpm' && existsSync(config)) {
      const shellPath = /^script-shell=(.+)$/m.exec(readFileSync(config, 'utf8'))?.[1]
      if (shellPath) return command(shellPath, [], runOptions)
    }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner })), f.stderr.join('\n')).toBe(1)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
})
it('candidate case-variant configuration cannot replace certification', async () => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  const config = 'toolkit/.NPMRC'
  writeFileSync(join(f.lane, config), 'script-shell=candidate-shell\n')
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    // Model case-insensitive package-manager discovery on every host.
    if (program === 'pnpm' && existsSync(join(String(runOptions.cwd), '.NPMRC'))) return { status: 0, stdout: 'candidate shell bypass', stderr: '' }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner })), f.stderr.join('\n')).toBe(1)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
})
it('case-variant installed dependency updates cannot replace certification', async () => {
  const f = fixture(); installQuality(f); git(f.lane, 'merge', '-q', 'develop')
  const installed = join(f.into, 'toolkit/node_modules')
  rmSync(installed, { recursive: true, force: true }); mkdirSync(installed)
  const dependency = 'toolkit/NODE_MODULES/unsafe.mjs'
  mkdirSync(dirname(join(f.lane, dependency)), { recursive: true })
  writeFileSync(join(f.lane, dependency), 'process.exit(0)\n'); git(f.lane, 'add', '--force', dependency)
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (program === 'pnpm') return { status: 0, stdout: 'altered dependency certified itself', stderr: '' }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner })), f.stderr.join('\n')).toBe(1)
  expect(f.stderr.join('\n')).toContain('certification refuses installed dependency changes')
})
it('target checkers can load unchanged case-variant installed dependency directories', async () => {
  const f = fixture(); mkdirSync(join(f.into, 'runtime/NODE_MODULES'), { recursive: true })
  writeFileSync(join(f.into, '.gitignore'), '.lane/\nruntime/NODE_MODULES/\nnode_modules\n')
  writeFileSync(join(f.into, 'runtime/NODE_MODULES/runtime.mjs'), 'export const ready = true\n')
  writeFileSync(join(f.into, 'package.json'), JSON.stringify({ scripts: { quality: 'node runtime/checker.mjs && node toolkit/scripts/quality-changed.mjs' } }))
  writeFileSync(join(f.into, 'runtime/checker.mjs'), "import { ready } from './NODE_MODULES/runtime.mjs'; if (!ready) process.exit(1)\n")
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'target runtime')
  writeFileSync(join(f.lane, 'delivered.txt'), 'compliant change\n')
  expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
})
it('candidate dependency locks cannot replace the target certification runtime', async () => {
  const f = fixture(); installQuality(f)
  const lock = 'toolkit/pnpm-lock.yaml'
  writeFileSync(join(f.into, lock), "lockfileVersion: '9.0'\nimporters: {}\n")
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'target lock'); git(f.lane, 'merge', '-q', 'develop')
  const candidate = "lockfileVersion: '9.0'\nimporters: {}\n# candidate runtime\n"
  writeFileSync(join(f.lane, lock), candidate)
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (program === 'pnpm' && readFileSync(join(String(runOptions.cwd), 'pnpm-lock.yaml'), 'utf8') === candidate) return { status: 0, stdout: 'candidate dependency runtime', stderr: '' }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner })), f.stderr.join('\n')).toBe(1)
  expect(f.stderr.join('\n')).toContain('max-lines-per-function')
})
it.each(['command', 'environment'])('target checker code is pinned before %s preloads execute', async (mode) => {
  const f = fixture(); installQuality(f)
  writeFileSync(join(f.into, 'toolkit/preload.cjs'), 'module.exports = {}\n')
  const quality = mode === 'command' ? 'node --require ./preload.cjs scripts/quality-changed.mjs' : 'node scripts/quality-changed.mjs'
  writeFileSync(join(f.into, 'toolkit/package.json'), JSON.stringify({ scripts: { quality } }))
  git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'target preload'); git(f.lane, 'merge', '-q', 'develop')
  writeFileSync(join(f.lane, 'toolkit/preload.cjs'), 'process.exit(0)\n')
  writeFileSync(join(f.lane, 'plugin/oversized.mjs'), `function long() {\n${'console.log(1)\n'.repeat(39)}}\n`)
  const previous = process.env.NODE_OPTIONS
  if (mode === 'environment') process.env.NODE_OPTIONS = `${previous ?? ''} --require=${JSON.stringify(join(f.into, 'toolkit/preload.cjs'))}`
  try {
    expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(1)
    expect(f.stderr.join('\n')).toContain('max-lines-per-function')
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
})
it.each(['failed abort', 'dirty abort', 'changed HEAD'])('reports exact rollback state after %s', async (mode) => {
  const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (program === 'pnpm') return { status: 1, stdout: '', stderr: 'certification refused' }
    if (args.includes('--abort')) {
      if (mode === 'failed abort') return { status: 1, stdout: '', stderr: 'abort refused' }
      const result = command(program, args, runOptions)
      if (mode === 'changed HEAD') git(f.into, 'reset', '--hard', git(f.lane, 'rev-parse', 'HEAD'))
      else writeFileSync(join(f.into, 'base.txt'), 'dirty after abort\n')
      return result
    }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner }))).toBe(1)
  expect(f.stderr.join('\n')).toContain('rollback incomplete')
  expect(f.stderr.join('\n')).toContain(mode === 'failed abort' ? 'abort refused' : mode === 'changed HEAD' ? 'tracked=(clean)' : 'tracked= M base.txt')
})
it('refuses index versus certified working-tree divergence before committing', async () => {
  const f = fixture(); writeFileSync(join(f.lane, 'change.txt'), 'change\n')
  const head = git(f.into, 'rev-parse', 'HEAD')
  const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
    if (program === 'pnpm') {
      git(f.into, 'update-index', '--assume-unchanged', 'change.txt')
      writeFileSync(join(f.into, 'change.txt'), 'different certified bytes\n')
      const nonce = (runOptions.env as NodeJS.ProcessEnv).WT_CERTIFICATION_NONCE
      return { status: 0, stdout: `WT_OWNER_CHECKED=${nonce}\n`, stderr: '' }
    }
    return command(program, args, runOptions)
  }
  expect(await integrateLane(options(f, { runner }))).toBe(1)
  expect(f.stderr.join('\n')).toContain('index differs from certified working tree')
  expect(git(f.into, 'rev-parse', 'HEAD')).toBe(head)
})
