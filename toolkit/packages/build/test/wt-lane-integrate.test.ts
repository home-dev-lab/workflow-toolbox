import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { integrateLane, parseIntegrateArgs } from '../../../../plugin/bin/lib/lane-integrate.mjs'

const roots: string[] = []
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function command(program: string, args: string[], options: Record<string, unknown> = {}) {
  return spawnSync(program, args, { encoding: 'utf8', env: HERMETIC, ...options })
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
  writeFileSync(join(repository, '.gitignore'), '.lane/\n')
  mkdirSync(join(repository, 'plugin'))
  writeFileSync(join(repository, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'base')
  git(repository, 'worktree', 'add', '-q', '-b', 'develop', into, 'HEAD')
  git(repository, 'worktree', 'add', '-q', '-b', 'card/test-lane', lane, 'HEAD')
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

describe('lane integration', () => {
  it('commits outside .lane, merges in the named integration worktree, and verifies the archive', async () => {
    const f = fixture(); writeFileSync(join(f.lane, 'delivered.txt'), 'delivered\n')
    const calls: string[][] = []
    const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
      calls.push([program, ...args])
      return command(program, args, { ...runOptions, env: HERMETIC })
    }

    const code = await integrateLane(options(f, { runner }))

    expect(code, f.stderr.join('\n')).toBe(0)
    expect(existsSync(join(f.archiveRoot, 'lane', 'lane', 'report.md'))).toBe(true)
    expect(git(f.into, 'show', 'HEAD:delivered.txt')).toBe('delivered')
    expect(command('git', ['-C', f.lane, 'cat-file', '-e', 'HEAD:.lane/report.md']).status).not.toBe(0)
    expect(git(f.into, 'log', '-1', '--format=%s')).toBe('merge: Integrate fixture lane')
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

  it('resolves a CHANGELOG-only conflict with ours before theirs', async () => {
    const f = fixture()
    writeFileSync(join(f.into, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- ours\n')
    git(f.into, 'add', '.'); git(f.into, 'commit', '-qm', 'ours')
    writeFileSync(join(f.lane, 'plugin', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- theirs\n')

    expect(await integrateLane(options(f)), f.stderr.join('\n')).toBe(0)
    const merged = readFileSync(join(f.into, 'plugin', 'CHANGELOG.md'), 'utf8')
    expect(merged).toContain('- ours\n- theirs\n')
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
    expect(plan).toContain(`integration tree=${f.into} HEAD=${intoHead}`)
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
    mkdirSync(join(inside.into, 'toolkit'))
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

    const forced = fixture(); writeFileSync(join(forced.lane, 'change.txt'), 'change\n'); mkdirSync(join(forced.into, 'toolkit'))
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
    const runner = (program: string, args: string[], runOptions: Record<string, unknown>) => {
      calls.push([program, ...args])
      if (program === 'git') return command(program, args, { ...runOptions, env: HERMETIC })
      if (args[0] === 'workflow') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: '[{"databaseId":42,"status":"completed","conclusion":"failure"}]', stderr: '' }
      if (args.includes('--json') && args.includes('url')) return { status: 0, stdout: 'https://example.test/actions/runs/42\n', stderr: '' }
      if (args.includes('--json') && args.includes('jobs')) return { status: 0, stdout: '{"jobs":[{"name":"test","conclusion":"failure"}]}', stderr: '' }
      if (args.includes('nameWithOwner')) return { status: 0, stdout: 'owner/repo\n', stderr: '' }
      if (args[0] === 'api') return { status: 0, stdout: '', stderr: '' }
      if (args.includes('--log')) return { status: 0, stdout: '', stderr: '' }
      return { status: 1, stdout: '', stderr: 'unexpected gh command' }
    }

    expect(await integrateLane(options(f, { ciBranch: 'ci/dispatch', authorizeFile: join(f.root, 'authorized.json'), dispatch: 'cross-os.yml', wait: true, runner }))).toBe(1)
    expect(f.stdout).toContain('job test: failure')
    expect(f.stdout).toContain('log: 0 bytes (fallback empty — not evidence of no failures)')
    expect(calls.find((argv) => argv[0] === 'gh' && argv[1] === 'api')).toBeTruthy()
  })
})
