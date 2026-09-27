import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error JS quality scanner
import { scanHostPrimitives } from '../../../scripts/host-primitive-census.mjs'
// @ts-expect-error JS scheduling policy
import { spawningTestFiles } from '../../../scripts/spawning-test-files.mjs'
// @ts-expect-error host adapter is a JS module
import { commandIO } from '../../../../plugin/bin/lib/host/command-io.mjs'
// @ts-expect-error JS plugin entrypoint
import { dispatch } from '../../../../plugin/bin/lib/crossos-dispatch.mjs'
// @ts-expect-error JS plugin module
import { ciBranchFor, matchesHostPath, verdictFromEvidence } from '../../../../plugin/bin/lib/crossos-verdict.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const fixtureDir = join(import.meta.dirname, 'fixtures/crossos-dispatch')
const temporary: string[] = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
// The fixture repository is reached through a NON-canonical path, the way macOS (/var -> /private/var) and Windows
// runners (8.3 short names in TEMP) present it: git reports the canonical path, the test holds the other spelling.
// On POSIX a symlink reproduces that on every runner; Windows runners already present a short-name TEMP.
function scratchDir() {
  const real = mkdtempSync(join(tmpdir(), 'crossos-')); temporary.push(real)
  if (process.platform === 'win32') return real
  const link = `${real}-link`; symlinkSync(real, link); temporary.unshift(link)
  return link
}
// The authorization path exactly as the dispatcher and the hook resolve it (git --absolute-git-dir), never a spelling
// built from the fixture directory.
function authPathOf(dir: string) {
  return join(git(dir, 'rev-parse', '--absolute-git-dir'), 'wt-push-authorized.json')
}
function fixture() {
  const dir = scratchDir()
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  mkdirSync(join(dir, '.github'))
  copyFileSync(join(root, '.github/cross-os-host-layer.json'), join(dir, '.github/cross-os-host-layer.json'))
  writeFileSync(join(dir, 'README.md'), 'base')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  mkdirSync(join(dir, 'plugin/bin'), { recursive: true })
  writeFileSync(join(dir, 'plugin/bin/host.mjs'), 'host')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'host change')
  const host = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'README.md'), 'docs')
  git(dir, 'commit', '-qam', 'documentation')
  const docs = git(dir, 'rev-parse', 'HEAD')
  return { dir, base, host, docs }
}
function output() { const lines: string[] = []; return { lines, print: (line: string) => lines.push(line) } }
function publicFixture() {
  const f = fixture(); const bare = join(f.dir, 'public.git')
  git(f.dir, 'init', '-q', '--bare', bare)
  git(f.dir, 'remote', 'add', 'public', bare)
  git(f.dir, 'push', 'public', `${f.base}:refs/heads/main`)
  git(f.dir, 'fetch', 'public', 'main')
  copyFileSync(join(fixtureDir, 'pre-push'), join(f.dir, '.git/hooks/pre-push'))
  chmodSync(join(f.dir, '.git/hooks/pre-push'), 0o755)
  mkdirSync(join(f.dir, 'plugin/bin/lib'), { recursive: true })
  copyFileSync(join(root, 'plugin/bin/wt-push-scope-check.mjs'), join(f.dir, 'plugin/bin/wt-push-scope-check.mjs'))
  copyFileSync(join(root, 'plugin/bin/lib/cli-help.mjs'), join(f.dir, 'plugin/bin/lib/cli-help.mjs'))
  writeFileSync(join(f.dir, 'plugin/bin/package.json'), '{"type":"module"}')
  return f
}
function fakeGh(f: ReturnType<typeof fixture>, conclusion = 'success', status = 'completed') {
  const calls: string[][] = []
  let dispatched = false
  const io = {
    ...commandIO,
    run(program: string, args: string[], opts: { cwd: string }) {
      if (program !== 'gh') return commandIO.run(program, args, opts)
      calls.push(args)
      if (!args.includes('-R') || args[args.indexOf('-R') + 1] !== 'owner/repo') throw new Error('gh must pin -R')
      if (args[0] === 'workflow') { dispatched = true; return { status: 0, stdout: '', stderr: '' } }
      let value: unknown
      if (args[1] === 'list') value = dispatched ? [{ databaseId: 23, url: 'https://github.com/owner/repo/actions/runs/23', event: 'workflow_dispatch', headBranch: `card/ci-${f.host.slice(0, 12)}`, headSha: f.host, status }] : []
       else if (args.includes('--job')) return { status: 0, stdout: readFileSync(join(fixtureDir, 'sample-job-log-excerpt.txt'), 'utf8'), stderr: '' }
       else {
         const sample = JSON.parse(readFileSync(join(fixtureDir, 'sample-run-view.json'), 'utf8'))
          // The platform reports the run's own head: the commit whose record names this run id, else the fixture's host commit.
          const runId = Number(args[2])
          const store = join(f.dir, '.git/wt-crossos')
          const owner = existsSync(store) ? readdirSync(store).filter((name) => name.endsWith('.json'))
            .map((name) => JSON.parse(readFileSync(join(store, name), 'utf8'))).find((record) => record.runId === runId) : undefined
          const headSha = owner?.sha ?? f.host
          value = { ...sample, event: 'workflow_dispatch', headBranch: `card/ci-${headSha.slice(0, 12)}`, headSha, status, conclusion, jobs: [
            { databaseId: 42, name: 'matrix (macos-latest)', conclusion },
            { databaseId: 43, name: 'matrix (ubuntu-latest)', conclusion: 'success' },
            { databaseId: 44, name: 'matrix (windows-latest)', conclusion: 'success' },
          ] }
       }
      return { status: 0, stdout: JSON.stringify(value), stderr: '' }
    },
    sleep: async () => {},
  }
  return { io, calls }
}

describe('cross-OS dispatch', () => {
  it('reconciles every primitive and spawning test with a live host-layer glob', () => {
    const entries = JSON.parse(readFileSync(join(root, '.github/cross-os-host-layer.json'), 'utf8')).entries
    const globs = entries.map((entry: { glob: string; why: string }) => entry.glob)
    expect(new Set(globs).size).toBe(globs.length)
    for (const entry of entries) expect(entry.why.trim().length).toBeGreaterThan(0)
    const tracked = [...git(root, 'ls-files').split('\n'), '.github/cross-os-host-layer.json']
    for (const glob of globs) expect(tracked.some((file) => matchesHostPath(file, glob)), glob).toBe(true)
    for (const finding of scanHostPrimitives().findings) {
      expect(globs.some((glob: string) => matchesHostPath(`plugin/${finding.file}`, glob)), finding.file).toBe(true)
    }
    for (const file of spawningTestFiles) {
      expect(globs.some((glob: string) => matchesHostPath(`toolkit/${file}`, glob)), file).toBe(true)
    }
  })

  it('decides host and docs commits from the list in each commit', async () => {
    const f = fixture(); const out = output()
    expect(await dispatch(['decide', '--merge', f.host, '--repo', f.dir], { print: out.print })).toBe(0)
    expect(out.lines.join('\n')).toContain('DECISION: run')
    expect(out.lines.at(-1)).toBe('RESULT: run')
    out.lines.length = 0
    expect(await dispatch(['decide', '--merge', f.docs, '--repo', f.dir], { print: out.print })).toBe(0)
    expect(out.lines.join('\n')).toContain('REASON: none of 1 changed files')
    expect(out.lines.at(-1)).toBe('RESULT: skip')
  })

  it('release-check applies the ref list to commits made before that list existed', async () => {
    const f = fixture(); const out = output()
    git(f.dir, 'checkout', '-q', f.base)
    git(f.dir, 'rm', '-q', '.github/cross-os-host-layer.json')
    git(f.dir, 'commit', '-qm', 'remove list')
    mkdirSync(join(f.dir, 'plugin/bin'), { recursive: true })
    writeFileSync(join(f.dir, 'plugin/bin/host.mjs'), 'old host')
    git(f.dir, 'add', '.')
    git(f.dir, 'commit', '-qm', 'old host')
    const old = git(f.dir, 'rev-parse', 'HEAD')
    mkdirSync(join(f.dir, '.github'), { recursive: true })
    copyFileSync(join(root, '.github/cross-os-host-layer.json'), join(f.dir, '.github/cross-os-host-layer.json'))
    git(f.dir, 'add', '.')
    git(f.dir, 'commit', '-qm', 'restore list')
    const ref = git(f.dir, 'rev-parse', 'HEAD')
    const code = await dispatch(['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', ref], { print: out.print })
    expect(code, out.lines.join('\n')).toBe(0)
    expect(out.lines).toContain(`UNCHECKED ${old} old host`)
  })

  it('reads command output larger than the default execFile buffer', () => {
    const result = commandIO.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(3*1024*1024))"], { cwd: root })
    expect(result.status).toBe(0)
    expect(result.stdout.length).toBe(3 * 1024 * 1024)
  })

  it('parses a colored prefix before the last log tab', async () => {
    const f = publicFixture(); const fake = fakeGh(f, 'failure'); const out = output()
    const io = { ...fake.io, run(program: string, args: string[], opts: { cwd: string }) {
      if (program === 'gh' && args.includes('--job')) return { status: 0, stdout: "job\t\u001b[31mstep\u001b[0m\tdate FAIL packages/build/test/example.test.ts > suite > case", stderr: '' }
      return fake.io.run(program, args, opts)
    } }
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })).toBe(1)
    expect(out.lines).toContain('FAILED TEST packages/build/test/example.test.ts > suite > case')
  })

  it('permits replaying an already-public commit with empty authorized commits', async () => {
    const f = publicFixture(); const auth = authPathOf(f.dir)
    writeFileSync(auth, JSON.stringify({ commits: [f.host] }))
    git(f.dir, 'push', 'public', `${f.host}:refs/heads/main`)
    rmSync(auth)
    git(f.dir, 'fetch', 'public', 'main')
    const out = output()
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io: fakeGh(f).io, print: out.print }), out.lines.join('\n')).toBe(0)
    expect(out.lines.at(-1)).toBe('RESULT: green')
  })

  it('rejects mismatched evidence and multiple new dispatches and deletes their branches', async () => {
    for (const kind of ['headSha', 'multiple']) {
      const f = publicFixture(); const fake = fakeGh(f); const out = output()
      const io = { ...fake.io, run(program: string, args: string[], opts: { cwd: string }) {
        const result = fake.io.run(program, args, opts)
        if (program !== 'gh' || args[1] !== 'list' || !JSON.parse(result.stdout).length) return result
        const runs = JSON.parse(result.stdout)
        if (kind === 'headSha') runs[0].headSha = f.docs
        else runs.push({ ...runs[0], databaseId: 24 })
        return { ...result, stdout: JSON.stringify(runs) }
      } }
      expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print }), out.lines.join('\n')).toBe(3)
      expect(out.lines.at(-1)).toBe('RESULT: mismatch')
      expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
    }
  })

  it('retains a timed-out branch for collect, then deletes it with deletion-only authorization', async () => {
    const f = publicFixture(); const fake = fakeGh(f); const out = output(); let pending = true
    const auth = authPathOf(f.dir)
    const authAtDelete: unknown[] = []
    let clock = 100000
    const io = { ...fake.io, now: () => clock += 1000, push(args: string[], cwd: string) {
      if (args.includes('--delete')) authAtDelete.push(JSON.parse(readFileSync(auth, 'utf8')))
      return commandIO.push(args, cwd)
    }, run(program: string, args: string[], opts: { cwd: string }) {
      const result = fake.io.run(program, args, opts)
      if (pending && program === 'gh' && args[1] === 'view' && !args.includes('--job')) return { ...result, stdout: JSON.stringify({ status: 'in_progress', conclusion: '', jobs: [] }) }
      return result
    } }
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo', '--timeout-min', '0.000001'], { io, print: out.print })).toBe(4)
    expect(JSON.parse(readFileSync(join(f.dir, '.git/wt-crossos', `${f.host}.json`), 'utf8')).status).toBe('timed_out')
    expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).not.toBe('')
    pending = false
    expect(await dispatch(['collect', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })).toBe(0)
    expect(authAtDelete).toEqual([{ maxCount: 0 }])
    expect(existsSync(auth)).toBe(false)
    expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
  })

  it('deletes a successful run with maxCount zero and removes its authorization', async () => {
    const f = publicFixture(); const auth = authPathOf(f.dir)
    const deletionScopes: unknown[] = []
    const io = { ...fakeGh(f).io, push(args: string[], cwd: string) {
      if (args.includes('--delete')) deletionScopes.push(JSON.parse(readFileSync(auth, 'utf8')))
      return commandIO.push(args, cwd)
    } }
    const out = output()
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })).toBe(0)
    expect(deletionScopes).toEqual([{ maxCount: 0 }])
    expect(existsSync(auth)).toBe(false)
    expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
  })

  it('refuses a push whose hook exited 0 without the scope-check receipt, and removes the branch it created', async () => {
    const f = publicFixture(); const out = output()
    // A hook that names the guard but never runs it: the push succeeds, so only the receipt can tell.
    writeFileSync(join(f.dir, '.git/hooks/pre-push'), '#!/bin/sh\n# wt-push-scope-check is not called here\nexit 0\n')
    chmodSync(join(f.dir, '.git/hooks/pre-push'), 0o755)
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io: fakeGh(f).io, print: out.print })).toBe(2)
    expect(out.lines.join('\n')).toContain('guard did not run')
    expect(out.lines.at(-1)).toBe('RESULT: error')
    expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
    expect(existsSync(authPathOf(f.dir))).toBe(false)
  })

  it('refuses to delete a branch outside the generated CI namespace', async () => {
    const f = publicFixture(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, branch: 'main', url: 'https://example.test/run/23' }))
    const out = output()
    expect(await dispatch(['collect', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io: fakeGh(f).io, print: out.print })).toBe(2)
    expect(out.lines.join('\n')).toContain('refusing branch deletion: main')
  })

  it('removes its authorization after the hook refuses a push', async () => {
    const f = publicFixture(); const out = output()
    const fake = fakeGh(f)
    const io = { ...fake.io, run(program: string, args: string[], opts: { cwd: string }) {
      if (program === 'git' && args[0] === 'rev-list' && args[1]?.startsWith('public/main..')) return { status: 0, stdout: `${f.base}\n`, stderr: '' }
      return fake.io.run(program, args, opts)
    } }
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })).toBe(2)
    expect(out.lines.join('\n')).toContain('git push public')
    expect(existsSync(authPathOf(f.dir))).toBe(false)
  })

  it('checks the checkout real hook when installed', async (context) => {
    const hook = git(root, 'rev-parse', '--git-path', 'hooks/pre-push')
    const path = resolve(root, hook)
    if (!existsSync(path) || !readFileSync(path, 'utf8').includes('wt-push-scope-check')) {
      context.skip(`checkout hook missing wt-push-scope-check: ${path}`)
      return
    }
    const f = publicFixture(); const target = join(f.dir, '.git/hooks/pre-push')
    copyFileSync(path, target); chmodSync(target, 0o755)
    const auth = authPathOf(f.dir)
    writeFileSync(auth, JSON.stringify({ commits: git(f.dir, 'rev-list', `public/main..${f.host}`).split('\n') }))
    const push = spawnSync('git', ['push', 'public', `${f.host}:refs/heads/card/ci-${f.host.slice(0, 12)}`], { cwd: f.dir, env, encoding: 'utf8' })
    expect(push.status, push.stderr).toBe(0)
    rmSync(auth, { force: true })
    const refused = spawnSync('git', ['push', 'public', `${f.docs}:refs/heads/card/ci-${f.docs.slice(0, 12)}`], { cwd: f.dir, env, encoding: 'utf8' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toMatch(/no authorized scope|no live authorization/)
  })

  it('runs the real public pre-push hook with exclusive authorization, then rejects a missing authorization', () => {
    const f = publicFixture()
    const auth = authPathOf(f.dir)
    writeFileSync(auth, JSON.stringify({ commits: git(f.dir, 'rev-list', `public/main..${f.host}`).split('\n') }))
    const push = spawnSync('git', ['push', 'public', `${f.host}:refs/heads/card/ci-${f.host.slice(0, 12)}`], { cwd: f.dir, env, encoding: 'utf8' })
    expect(push.status, push.stderr).toBe(0)
    expect(push.stderr + push.stdout).toMatch(/wt-push-scope-check: .*— OK/)
    rmSync(auth)
    const refused = spawnSync('git', ['push', 'public', `${f.docs}:refs/heads/card/ci-${f.docs.slice(0, 12)}`], { cwd: f.dir, env, encoding: 'utf8' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('no authorized scope')
  })

  it('pushes with the real hook, pins the dispatch repository, collects a red job full log and deletes the branch', async () => {
    const f = publicFixture(); const { io, calls } = fakeGh(f, 'failure'); const out = output()
    const code = await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })
    expect(code, out.lines.join('\n')).toBe(1)
    expect(out.lines).toContain('FAILED TEST packages/build/test/sdk-pilot-lifecycle-server.test.ts > runner-hosted SDK pilot lifecycle > the shipped launcher keeps ordinary descendants in the terminated lane group [requires POSIX process groups and modes]')
    expect(out.lines.join('\n')).toContain('BLOCKER: host-layer merge')
    expect(out.lines.at(-1)).toBe('RESULT: red')
    expect(calls.some((args) => args.includes('--job') && args.includes('--log'))).toBe(true)
    expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
    expect(readFileSync(join(f.dir, '.git/wt-crossos', `${f.host}.card.md`), 'utf8')).toContain('matrix (macos-latest)')
    expect(() => readFileSync(authPathOf(f.dir))).toThrow()
  })

  it('refuses an existing authorization with its metadata and does not remove it', async () => {
    const f = publicFixture(); const { io } = fakeGh(f); const out = output()
    const path = authPathOf(f.dir)
    writeFileSync(path, JSON.stringify({ commits: [f.base, f.host] }))
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })).toBe(2)
    expect(out.lines.join('\n')).toContain('already-on-public/main=1')
    expect(out.lines.join('\n')).toContain(`rm '${path}'`)
    expect(readFileSync(path, 'utf8')).toContain(f.host)
  })

  it('marks an unfinished newest recorded host commit pending, and a later success supersedes a red', async () => {
    const f = publicFixture(); const out = output()
    const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, workflow: 'cross-os.yml', status: 'in_progress' }))
    const fake = fakeGh(f, 'failure', 'completed')
    const args = ['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', f.docs]
    expect(await dispatch(args, { io: fake.io, print: out.print })).toBe(1)
    expect(out.lines.at(-1)).toBe('RESULT: red run=23')
    out.lines.length = 0
    expect(await dispatch(args, { io: fakeGh(f, '', 'in_progress').io, print: out.print })).toBe(5)
    expect(out.lines.at(-1)).toBe('RESULT: pending run=23')
    out.lines.length = 0
    rmSync(join(store, `${f.host}.json`))
    expect(await dispatch(args, { io: fake.io, print: out.print })).toBe(0)
    expect(out.lines).toContain(`UNCHECKED ${f.host} host change`)
    expect(out.lines.at(-1)).toContain('RESULT: unchecked')
  })

  it('uses the newest host-layer run as the release verdict, regardless of an older green or red', async () => {
    const f = publicFixture(); const out = output(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(f.dir, 'plugin/bin/host.mjs'), 'second host change')
    git(f.dir, 'commit', '-qam', 'second host change')
    const latest = git(f.dir, 'rev-parse', 'HEAD')
    const args = ['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', latest]
    const record = (sha: string, runId: number, conclusion: string) => writeFileSync(join(store, `${sha}.json`), JSON.stringify({ sha, runId, workflow: 'cross-os.yml', status: 'completed', conclusion }))
    record(f.host, 10, 'success'); record(latest, 11, 'failure')
    expect(await dispatch(args, { io: fakeGh(f, 'failure').io, print: out.print })).toBe(1)
    expect(out.lines.at(-1)).toBe('RESULT: red run=11')
    out.lines.length = 0
    record(f.host, 10, 'failure'); record(latest, 11, 'success')
    expect(await dispatch(args, { io: fakeGh(f).io, print: out.print })).toBe(0)
    expect(out.lines.at(-1)).toBe('RESULT: green run=11')
  })

  it('keeps push triggers confined to main and release tags, with ref-scoped non-cancelling concurrency', () => {
    const workflow = readFileSync(join(root, '.github/workflows/cross-os.yml'), 'utf8')
    expect(workflow).toContain('branches: [main]')
    expect(workflow).toContain("tags: ['workflow-toolbox--v*']")
    expect(workflow).toContain('group: cross-os-${{ github.ref }}')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('refuses a non-public remote before pushing even when it points to the public repository', async () => {
    const f = publicFixture(); git(f.dir, 'remote', 'add', 'other', git(f.dir, 'remote', 'get-url', 'public'))
    const out = output()
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo', '--remote', 'other'], { io: fakeGh(f).io, print: out.print })).toBe(2)
    expect(git(f.dir, 'ls-remote', '--heads', 'other', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
    expect(out.lines.join('\n')).toContain('only public')
  })

  it('refuses collection through a non-public remote without deleting a branch', async () => {
    const f = publicFixture(); git(f.dir, 'remote', 'add', 'other', git(f.dir, 'remote', 'get-url', 'public'))
    const out = output()
    expect(await dispatch(['collect', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo', '--remote', 'other'], { io: fakeGh(f).io, print: out.print })).toBe(2)
    expect(out.lines.join('\n')).toContain('only public')
  })

  it('never creates a record for a dry-run when none exists', async () => {
    const f = publicFixture(); const out = output()
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo', '--dry-run'], { io: fakeGh(f).io, print: out.print })).toBe(0)
    expect(existsSync(join(f.dir, '.git/wt-crossos', `${f.host}.json`))).toBe(false)
  })

  it('always refreshes cached success and reports failure, pending, or a gh error', async () => {
    const f = publicFixture(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, workflow: 'cross-os.yml', status: 'completed', conclusion: 'success' }))
    const args = ['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', f.docs]
    expect(await dispatch(args, { io: fakeGh(f, 'failure').io, print: output().print })).toBe(1)
    expect(await dispatch(args, { io: fakeGh(f, '', 'in_progress').io, print: output().print })).toBe(5)
    const fake = fakeGh(f)
    const io = { ...fake.io, run(program: string, argv: string[], opts: { cwd: string }) {
      if (program === 'gh' && argv[1] === 'view') return { status: 1, stdout: '', stderr: 'unavailable' }
      return fake.io.run(program, argv, opts)
    } }
    expect(await dispatch(args, { io, print: output().print })).toBe(2)
  })

  it.each([
    ['empty jobs', []],
    ['missing windows', [{ name: 'ubuntu', conclusion: 'success' }, { name: 'macos', conclusion: 'success' }]],
    ['skipped job', [{ name: 'ubuntu', conclusion: 'success' }, { name: 'macos', conclusion: 'success' }, { name: 'windows', conclusion: 'skipped' }]],
  ])('rejects a successful conclusion with %s in release-check and collect', async (_reason, jobs) => {
    const f = publicFixture(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, workflow: 'cross-os.yml', branch: `card/ci-${f.host.slice(0, 12)}`, url: 'https://github.com/owner/repo/actions/runs/23' }))
    const fake = fakeGh(f); const out = output()
    const io = { ...fake.io, run(program: string, argv: string[], opts: { cwd: string }) {
      if (program === 'gh' && argv[1] === 'view' && !argv.includes('--job')) return { status: 0, stdout: JSON.stringify({ event: 'workflow_dispatch', headBranch: `card/ci-${f.host.slice(0, 12)}`, headSha: f.host, status: 'completed', conclusion: 'success', jobs }), stderr: '' }
      return fake.io.run(program, argv, opts)
    } }
    expect(await dispatch(['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', f.docs], { io, print: out.print })).toBe(1)
    expect(out.lines.join('\n')).toContain('MATRIX INCOMPLETE:')
    const auth = authPathOf(f.dir)
    writeFileSync(auth, JSON.stringify({ commits: git(f.dir, 'rev-list', `public/main..${f.host}`).split('\n') }))
    git(f.dir, 'push', 'public', `${f.host}:refs/heads/card/ci-${f.host.slice(0, 12)}`); rmSync(auth)
    expect(await dispatch(['collect', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: output().print })).toBe(1)
  })

  it('a complete matrix with one failed job is COMPLETE, not incomplete, in release-check and collect', async () => {
    const f = publicFixture(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, workflow: 'cross-os.yml', branch: `card/ci-${f.host.slice(0, 12)}`, url: 'https://github.com/owner/repo/actions/runs/23' }))
    const jobs = [
      { name: 'matrix (ubuntu-latest)', conclusion: 'success' },
      { name: 'matrix (windows-latest)', conclusion: 'failure' },
      { name: 'matrix (macos-latest)', conclusion: 'success' },
    ]
    const fake = fakeGh(f); const out = output()
    const io = { ...fake.io, run(program: string, argv: string[], opts: { cwd: string }) {
      if (program === 'gh' && argv[1] === 'view' && !argv.includes('--job')) return { status: 0, stdout: JSON.stringify({ event: 'workflow_dispatch', headBranch: `card/ci-${f.host.slice(0, 12)}`, headSha: f.host, status: 'completed', conclusion: 'failure', jobs }), stderr: '' }
      return fake.io.run(program, argv, opts)
    } }
    expect(await dispatch(['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', f.docs], { io, print: out.print })).toBe(1)
    expect(out.lines.join('\n')).toContain('MATRIX COMPLETE: 1 of 3 jobs failed (matrix (windows-latest))')
    expect(out.lines.join('\n')).not.toContain('MATRIX INCOMPLETE')
    const auth = authPathOf(f.dir)
    writeFileSync(auth, JSON.stringify({ commits: git(f.dir, 'rev-list', `public/main..${f.host}`).split('\n') }))
    git(f.dir, 'push', 'public', `${f.host}:refs/heads/card/ci-${f.host.slice(0, 12)}`); rmSync(auth)
    const out2 = output()
    expect(await dispatch(['collect', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out2.print })).toBe(1)
    expect(out2.lines.join('\n')).toContain('MATRIX COMPLETE: 1 of 3 jobs failed (matrix (windows-latest))')
    expect(out2.lines.join('\n')).not.toContain('MATRIX INCOMPLETE')
  })

  it('ignores a verdict recorded for another workflow', async () => {
    const f = publicFixture(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, workflow: 'other.yml' }))
    const out = output()
    expect(await dispatch(['release-check', '--repo', f.dir, '--repo-slug', 'owner/repo', '--base', f.base, '--ref', f.docs], { io: fakeGh(f).io, print: out.print })).toBe(0)
    expect(out.lines.at(-1)).toContain('RESULT: unchecked')
  })

  it('does not overwrite run evidence on skip or dry-run', async () => {
    const f = publicFixture(); const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    for (const [sha, flags] of [[f.docs, []], [f.host, ['--dry-run']]] as const) {
      const path = join(store, `${sha}.json`); writeFileSync(path, JSON.stringify({ sha, runId: 23 }))
      expect(await dispatch(['run', '--merge', sha, '--repo', f.dir, '--repo-slug', 'owner/repo', ...flags], { io: fakeGh(f).io, print: output().print })).toBe(0)
      expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe(23)
    }
  })

  it('deletes a completed branch even when evidence persistence fails', async () => {
    const f = publicFixture(); const fake = fakeGh(f); const out = output()
    const io = { ...fake.io, writeText(path: string, text: string, exclusive?: boolean) {
      if (path.endsWith(`${f.host}.json`)) throw new Error('evidence write failed')
      return commandIO.writeText(path, text, exclusive)
    } }
    // Start from a recorded run and a remotely existing branch.
    const auth = authPathOf(f.dir); writeFileSync(auth, JSON.stringify({ commits: git(f.dir, 'rev-list', `public/main..${f.host}`).split('\n') }))
    git(f.dir, 'push', 'public', `${f.host}:refs/heads/card/ci-${f.host.slice(0, 12)}`); rmSync(auth)
    const store = join(f.dir, '.git/wt-crossos'); mkdirSync(store)
    writeFileSync(join(store, `${f.host}.json`), JSON.stringify({ sha: f.host, runId: 23, branch: `card/ci-${f.host.slice(0, 12)}`, url: 'https://github.com/owner/repo/actions/runs/23' }))
    expect(await dispatch(['collect', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: out.print })).toBe(2)
    expect(out.lines.join('\n')).toContain('evidence write failed')
    expect(git(f.dir, 'ls-remote', '--heads', 'public', `refs/heads/card/ci-${f.host.slice(0, 12)}`)).toBe('')
  })

  it('cleans up an authorization created by a failed exclusive write', async () => {
    const f = publicFixture(); const auth = authPathOf(f.dir)
    const fake = fakeGh(f)
    const io = { ...fake.io, writeText(path: string, text: string, exclusive?: boolean) {
      commandIO.writeText(path, text, exclusive)
      if (path === auth && exclusive) throw new Error('write failed after create')
    } }
    expect(await dispatch(['run', '--merge', f.host, '--repo', f.dir, '--repo-slug', 'owner/repo'], { io, print: output().print })).toBe(2)
    expect(existsSync(auth)).toBe(false)
  })
})

describe('green only from positive evidence', () => {
  const sha = 'a'.repeat(40)
  const positive = () => ({
    event: 'workflow_dispatch', headBranch: ciBranchFor(sha), headSha: sha, status: 'completed', conclusion: 'success',
    jobs: ['ubuntu-latest', 'windows-latest', 'macos-latest'].map((os) => ({ name: `matrix (${os})`, conclusion: 'success' })),
  })
  // Every way the evidence can be absent, partial, foreign or stale: one field replaced at a time.
  const variants: Record<string, unknown[]> = {
    event: [undefined, null, 'push', 'schedule', ''],
    headBranch: [undefined, null, 'main', 'card/ci-' + 'b'.repeat(12), ''],
    headSha: [undefined, null, 'b'.repeat(40), sha.slice(0, 12), ''],
    status: [undefined, null, 'queued', 'in_progress', 'waiting', ''],
    conclusion: [undefined, null, 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', ''],
    jobs: [undefined, null, [], [{ name: 'matrix (ubuntu-latest)', conclusion: 'success' }]],
  }
  it('the control is green, so a non-green below is the evidence, not a broken judge', () => {
    expect(verdictFromEvidence(positive(), sha).verdict).toBe('green')
  })
  it('no absent, partial or mismatched field yields green', () => {
    for (const [field, values] of Object.entries(variants)) {
      for (const value of values) {
        const run = { ...positive(), [field]: value }
        expect(verdictFromEvidence(run, sha).verdict, `${field}=${JSON.stringify(value)}`).not.toBe('green')
      }
    }
    for (const missing of [undefined, null, {}, 'success', 0]) expect(verdictFromEvidence(missing, sha).verdict).not.toBe('green')
  })
  it('no single job that is missing or not successful yields green', () => {
    for (let index = 0; index < 3; index += 1) {
      const dropped = positive(); dropped.jobs.splice(index, 1)
      expect(verdictFromEvidence(dropped, sha).verdict).not.toBe('green')
      for (const conclusion of ['failure', 'cancelled', 'skipped', null, undefined]) {
        const run = positive(); run.jobs[index] = { ...run.jobs[index], conclusion } as never
        expect(verdictFromEvidence(run, sha).verdict).not.toBe('green')
      }
    }
  })
  it('random combinations of two or more degraded fields never yield green', () => {
    let seed = 20260927
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
    const fields = Object.keys(variants)
    for (let round = 0; round < 500; round += 1) {
      const run: Record<string, unknown> = positive()
      const count = 2 + (next() % (fields.length - 1))
      for (let k = 0; k < count; k += 1) { const field = fields[next() % fields.length] as string; const values = variants[field] as unknown[]; run[field] = values[next() % values.length] }
      expect(verdictFromEvidence(run, sha).verdict, JSON.stringify(run)).not.toBe('green')
    }
  })
  it('a complete matrix with a failed job is red but explicitly not incomplete', () => {
    const run = positive(); run.jobs[1] = { ...run.jobs[1], conclusion: 'failure' } as never
    const result = verdictFromEvidence({ ...run, conclusion: 'failure' }, sha)
    expect(result.verdict).toBe('red')
    expect(result.incomplete).toBe(false)
    expect(result.reason).toBe('1 of 3 jobs failed (matrix (windows-latest))')
  })
  it('a genuinely missing job is still incomplete, never read as a job failure', () => {
    const dropped = positive(); dropped.jobs.splice(1, 1)
    const result = verdictFromEvidence(dropped, sha)
    expect(result.verdict).toBe('red')
    expect(result.incomplete).toBe(true)
  })
  it('a stored record claiming success is not evidence: release-check reads the platform', () => {
    // Stored evidence for another commit is foreign even when everything else is perfect.
    expect(verdictFromEvidence({ ...positive(), headSha: 'c'.repeat(40), headBranch: ciBranchFor('c'.repeat(40)) }, sha).verdict).toBe('unchecked')
  })
})
