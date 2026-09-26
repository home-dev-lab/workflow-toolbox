// wt-push-scope-check must authorize exactly the commits a push would TRANSFER: those not
// reachable from any ref the remote advertises at push time.
//
// Measured 2026-09-25 and 2026-09-26: pushing a new card branch to `public` was refused with 40+
// "UNAUTHORIZED COMMIT" lines, every one of them already on the remote through another live card
// branch, because the guard measured against `<remote>/main` only. The one genuinely new commit was
// buried among commits that disclose nothing.
//
// Every case builds REAL throwaway repositories with a local bare repository as the fake remote:
// the guard's whole job is asking git what the remote holds, so a stubbed git would test the mock.
// Hermetic: `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so no machine signing setting
// reaches these repositories, and HOME / state / config dirs sealed under a throwaway root.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GUARD = join(REPO_ROOT, 'plugin/bin/wt-push-scope-check.mjs')

const SEAL_ROOT = mkdtempSync(join(tmpdir(), 'wt-push-scope-seal-'))
const SEALED = sealedPluginCliEnv(SEAL_ROOT, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
afterAll(() => rmSync(SEAL_ROOT, { recursive: true, force: true }))

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout.trim()
}

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`)
  git(cwd, 'add', '.')
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', name)
  return git(cwd, 'rev-parse', 'HEAD')
}

/**
 * A local clone whose remote `fake` is a bare repository holding:
 *   main    -> A
 *   other   -> A-B   (a live card branch: B is already published)
 *   gone    -> deleted on the remote AFTER it was fetched, so `fake/gone` -> A-D is a STALE
 *              remote-tracking ref: D is not on the remote any more.
 *   foreign -> A-E   pushed from another clone, never fetched here (E is unknown locally)
 * and a local branch `card` = A-B-C (C is the only commit new to the remote).
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-push-scope-'))
  made.push(root)
  const bare = join(root, 'remote.git')
  const local = join(root, 'local')
  const other = join(root, 'other-clone')
  git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  git(root, 'init', '-q', '-b', 'main', local)
  git(local, 'remote', 'add', 'fake', bare)
  commit(local, 'A')
  git(local, 'push', '-q', 'fake', 'main')
  git(local, 'checkout', '-q', '-b', 'other')
  const B = commit(local, 'B')
  git(local, 'push', '-q', 'fake', 'other')
  git(local, 'checkout', '-q', '-b', 'gone', 'main')
  const D = commit(local, 'D')
  git(local, 'push', '-q', 'fake', 'gone')
  git(local, 'fetch', '-q', 'fake')
  git(bare, 'update-ref', '-d', 'refs/heads/gone')
  git(local, 'checkout', '-q', '-b', 'card', 'other')
  const C = commit(local, 'C')
  git(root, 'clone', '-q', bare, other)
  commit(other, 'E')
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/foreign')
  return { root, local, B, C, D }
}

function run(cwd: string, root: string, scope: unknown, ref: string, remote = 'fake') {
  const auth = join(root, `auth-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(auth, JSON.stringify(scope))
  const res = spawnSync(process.execPath, [GUARD, '--remote', remote, '--branch', 'main', '--ref', ref, '--authorized', auth], {
    cwd,
    encoding: 'utf8',
    env: SEALED,
  })
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` }
}

describe('wt-push-scope-check: the outgoing set is what the remote does not already hold', () => {
  it('passes when the scope names only the commit new to the remote, although another commit is absent from <remote>/main', () => {
    const f = fixture()
    const r = run(f.local, f.root, { commits: [f.C] }, 'card')
    expect(r.out).not.toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
    expect(r.status, r.out).toBe(0)
  })

  it('refuses a genuinely new commit that the scope does not name, and names only that commit', () => {
    const f = fixture()
    const r = run(f.local, f.root, { commits: [] }, 'card')
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.C.slice(0, 7)}`)
    expect(r.out).not.toContain(f.B.slice(0, 7))
    expect(r.out).toContain('1 unauthorized commit(s) out of 1')
  })

  it('counts only the new commit against maxCount', () => {
    const f = fixture()
    expect(run(f.local, f.root, { maxCount: 1 }, 'card').status).toBe(0)
    expect(run(f.local, f.root, { maxCount: 0 }, 'card').status).toBe(1)
  })

  it('trusts what the remote ADVERTISES, never a stale remote-tracking ref for a branch the remote deleted', () => {
    const f = fixture()
    git(f.local, 'checkout', '-q', '-b', 'card2', 'gone')
    const r = run(f.local, f.root, { commits: [] }, 'card2')
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.D.slice(0, 7)}`)
  })

  it('reports nothing to push when every commit is already on the remote', () => {
    const f = fixture()
    const r = run(f.local, f.root, { commits: [] }, 'other')
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('no commits to push')
  })

  it('fails closed when the remote cannot be queried', () => {
    const f = fixture()
    git(f.local, 'remote', 'add', 'dead', join(f.root, 'does-not-exist.git'))
    const r = run(f.local, f.root, { commits: [f.C] }, 'card', 'dead')
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('could not list the refs')
  })
})
