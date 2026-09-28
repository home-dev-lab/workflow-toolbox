// wt-push-scope-check must authorize exactly the commits a push would put where they were not:
//   - a NEW destination ref: commits not reachable from any branch or tag the remote advertises;
//   - an EXISTING destination ref: commits not reachable from that ref's current tip (the remote
//     sha git hands the pre-push hook), whatever the remote holds elsewhere.
//
// Measured 2026-09-25 and 2026-09-26: pushing a new card branch to `public` was refused with 40+
// "UNAUTHORIZED COMMIT" lines, every one of them already on the remote through another live card
// branch, because the guard measured against `<remote>/main` only. The first fix excluded every
// advertised commit for every push, which let `git push public card/x:main` land a live card
// branch's history on main with an empty scope (review, round 2). Both directions are locked here.
//
// Every case builds REAL throwaway repositories with local bare repositories as fake remotes: the
// guard's whole job is asking git what the remote holds, so a stubbed git would test the mock.
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
const ZERO = '0'.repeat(40)

const SEAL_ROOT = mkdtempSync(join(tmpdir(), 'wt-push-scope-seal-'))
const SEALED = sealedPluginCliEnv(SEAL_ROOT, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' })
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
 *   other   -> A-B   (a live card branch: B is already published, but NOT on main)
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
  const A = commit(local, 'A')
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
  const E = commit(other, 'E')
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/foreign')
  return { root, bare, local, A, B, C, D, E }
}

type Opts = { remote?: string; remoteSha?: string; url?: string; branch?: string; env?: NodeJS.ProcessEnv }

function run(f: { root: string; local: string }, scope: unknown, ref: string, o: Opts = {}) {
  const auth = join(f.root, `auth-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(auth, JSON.stringify(scope))
  const args = [GUARD, '--remote', o.remote ?? 'fake', '--ref', ref, '--authorized', auth]
  if (o.branch !== undefined && o.remoteSha === undefined) args.push('--branch', o.branch)
  if (o.remoteSha !== undefined) args.push('--remote-sha', o.remoteSha)
  if (o.url !== undefined) args.push('--url', o.url)
  const res = spawnSync(process.execPath, args, { cwd: f.local, encoding: 'utf8', env: o.env ?? SEALED })
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` }
}

describe('wt-push-scope-check: a NEW destination ref carries what the remote does not already hold', () => {
  it('passes when the scope names only the commit new to the remote, although another commit is absent from <remote>/main', () => {
    const f = fixture()
    const r = run(f, { commits: [f.C] }, 'card', { remoteSha: ZERO, branch: 'main' })
    expect(r.out).not.toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
    expect(r.status, r.out).toBe(0)
  })

  it('refuses a genuinely new commit that the scope does not name, and names only that commit', () => {
    const f = fixture()
    const r = run(f, { commits: [] }, 'card', { remoteSha: ZERO, branch: 'main' })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.C.slice(0, 7)}`)
    expect(r.out).not.toContain(f.B.slice(0, 7))
    expect(r.out).toContain('1 unauthorized commit(s) out of 1')
  })

  it('counts only the new commit against maxCount', () => {
    const f = fixture()
    expect(run(f, { maxCount: 1 }, 'card', { remoteSha: ZERO, branch: 'main' }).status).toBe(0)
    expect(run(f, { maxCount: 0 }, 'card', { remoteSha: ZERO, branch: 'main' }).status).toBe(1)
  })

  it('trusts what the remote ADVERTISES, never a stale remote-tracking ref for a branch the remote deleted', () => {
    const f = fixture()
    git(f.local, 'checkout', '-q', '-b', 'card2', 'gone')
    const r = run(f, { commits: [] }, 'card2', { remoteSha: ZERO, branch: 'main' })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.D.slice(0, 7)}`)
  })

  it('passes a new card branch with an empty scope when the remote already holds every commit', () => {
    const f = fixture()
    const r = run(f, { commits: [] }, 'other', { remoteSha: ZERO })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('no commits to push')
  })

  it('does not let a commit reachable only from a non-branch, non-tag remote ref (refs/pull/*) count as published', () => {
    const f = fixture()
    git(f.local, 'checkout', '-q', '-b', 'pr', 'main')
    const P = commit(f.local, 'P')
    git(f.local, 'push', '-q', 'fake', 'pr:refs/pull/1/head')
    const r = run(f, { commits: [] }, 'pr', { remoteSha: ZERO })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${P.slice(0, 7)}`)
  })
})

describe('wt-push-scope-check: an EXISTING destination ref carries what its current tip does not hold', () => {
  it('refuses card/x:main with an empty scope although the remote holds card/x on another branch', () => {
    const f = fixture()
    const r = run(f, { commits: [] }, 'other', { remoteSha: f.A, branch: 'main' })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
  })

  it('resolves the destination tip from --branch when no --remote-sha is given', () => {
    const f = fixture()
    const r = run(f, { commits: [] }, 'other', { branch: 'main' })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
  })

  it('counts a force-push that REPLACES main with remote-held history as everything not on the old main', () => {
    const f = fixture()
    git(f.local, 'checkout', '-q', '-b', 'mainM', 'main')
    const M = commit(f.local, 'M')
    git(f.local, 'push', '-q', 'fake', 'mainM:main')
    const refused = run(f, { commits: [] }, 'card', { remoteSha: M })
    expect(refused.status, refused.out).toBe(1)
    expect(refused.out).toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
    expect(refused.out).toContain(`UNAUTHORIZED COMMIT: ${f.C.slice(0, 7)}`)
    expect(refused.out).toContain('2 unauthorized commit(s) out of 2')
    expect(run(f, { commits: [f.B, f.C] }, 'card', { remoteSha: M }).status).toBe(0)
  })

  it('fails closed when the destination tip is not in this clone', () => {
    const f = fixture()
    const r = run(f, { commits: [f.C] }, 'card', { remoteSha: f.E })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('not in this clone')
  })

  it('requires --remote-sha or --branch', () => {
    const f = fixture()
    const r = run(f, { commits: [f.C] }, 'card')
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('--remote-sha')
  })
})

describe('wt-push-scope-check: what git actually sends, whatever the local configuration says', () => {
  it('lists the PUSH url given by --url, not the fetch url of the remote name', () => {
    const f = fixture()
    const pushBare = join(f.root, 'push-only.git')
    git(f.root, 'clone', '-q', '--bare', '--single-branch', '-b', 'main', f.bare, pushBare)
    const r = run(f, { commits: [f.C] }, 'card', { remoteSha: ZERO, url: pushBare })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
  })

  it('uses the configured pushurl when --url is not given', () => {
    const f = fixture()
    const pushBare = join(f.root, 'push-only.git')
    git(f.root, 'clone', '-q', '--bare', '--single-branch', '-b', 'main', f.bare, pushBare)
    git(f.local, 'config', 'remote.fake.pushurl', pushBare)
    const r = run(f, { commits: [f.C] }, 'card', { remoteSha: ZERO })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`UNAUTHORIZED COMMIT: ${f.B.slice(0, 7)}`)
  })

  it('does not let a replace graft hide a new commit behind a published one', () => {
    const f = fixture()
    // N is new (A-N). The graft makes published B claim N as a parent, so under replace refs
    // "not reachable from B" would drop N although git sends it. (Replacing the TIP does not
    // hide it: rev-list still lists the tip's own id — measured, that mutation survived.)
    git(f.local, 'checkout', '-q', '-b', 'sneak', 'main')
    const N = commit(f.local, 'N')
    git(f.local, 'replace', '--graft', f.B, f.A, N)
    const newRef = run(f, { commits: [] }, 'sneak', { remoteSha: ZERO })
    expect(newRef.status, newRef.out).toBe(1)
    expect(newRef.out).toContain(`UNAUTHORIZED COMMIT: ${N.slice(0, 12)}`)
    const existing = run(f, { commits: [] }, 'sneak', { remoteSha: f.B })
    expect(existing.status, existing.out).toBe(1)
    expect(existing.out).toContain(`UNAUTHORIZED COMMIT: ${N.slice(0, 12)}`)
  })

  it('refuses a ref that is not a commit', () => {
    const f = fixture()
    const tree = git(f.local, 'rev-parse', 'card^{tree}')
    const r = run(f, { commits: [] }, tree, { remoteSha: ZERO })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('not a commit')
  })

  it('rejects a scope entry too short to name one commit', () => {
    const f = fixture()
    const r = run(f, { commits: [f.C.slice(0, 1)] }, 'card', { remoteSha: ZERO })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('at least 7 hex')
  })
})

describe('wt-push-scope-check: fails closed when it cannot measure', () => {
  it('when the remote cannot be listed', () => {
    const f = fixture()
    git(f.local, 'remote', 'add', 'dead', join(f.root, 'does-not-exist.git'))
    const r = run(f, { commits: [f.C] }, 'card', { remote: 'dead', remoteSha: ZERO, branch: 'main' })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('could not list the refs')
  })

  it('when git cat-file fails', () => {
    const f = fixture()
    // A PATH shell shim is not selected by Node's Windows executable resolution (git.exe wins).
    // Preload before the guard imports child_process so the failure is injected on every OS.
    const shim = join(f.root, 'refuse-cat-file.cjs')
    writeFileSync(shim, `const child = require('node:child_process');
      const original = child.execFileSync;
      child.execFileSync = function (command, args, options) {
        if (command === 'git' && args.includes('cat-file')) throw Error('shim: cat-file refused');
        return original.call(this, command, args, options);
      };\n`)
    const env = { ...SEALED, NODE_OPTIONS: `${SEALED.NODE_OPTIONS ?? ''} --require="${shim.replaceAll('\\', '/')}"` }
    const r = run(f, { commits: [f.C] }, 'card', { remoteSha: ZERO, env })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('could not check which advertised objects')
  })
})
