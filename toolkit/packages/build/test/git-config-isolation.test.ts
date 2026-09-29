// git-config-isolation.test.ts — locks card 1838017282: no git process started during `pnpm test`
// reads the machine's global or system git configuration, or reaches the machine's SSH agent.
//
// The mechanism under test is test-support/git-config-isolation.setup.ts (a vitest `setupFiles`
// module). This file does NOT import it: every assertion starts a real git child the way an
// ordinary test does (inheriting `process.env`, optionally with its own HOME) and checks what that
// child actually sees. Remove the setup file from vitest.config.mts and each case goes red:
//   - the fixture commit reads the deliberately broken signing config planted in its HOME and fails
//     ("Couldn't load public key …") — on every OS, whether or not the machine has a git config;
//   - `git config --list --show-scope` shows global entries from a file the suite does not own.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const BROKEN_SIGNING_CONFIG = [
  '[commit]',
  '\tgpgsign = true',
  '[tag]',
  '\tgpgsign = true',
  '[gpg]',
  '\tformat = ssh',
  '[user]',
  '\tsigningkey = /nonexistent/wt-git-isolation-key.pub',
  '',
].join('\n')

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env })
}

describe('git configuration isolation for every test worker (card 1838017282)', () => {
  it('a fixture commit ignores a broken signing config in its HOME and needs no local identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-git-isolation-lock-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(join(home, '.config', 'git'), { recursive: true })
    writeFileSync(join(home, '.gitconfig'), BROKEN_SIGNING_CONFIG)
    writeFileSync(join(home, '.config', 'git', 'config'), BROKEN_SIGNING_CONFIG)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    // The common test shape: inherit the worker env, point HOME at a fixture directory.
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') }

    const init = git(repo, ['init', '-q'], env)
    expect(init.status, init.stderr).toBe(0)
    const commit = git(repo, ['commit', '--allow-empty', '-q', '-m', 'fixture'], env)
    expect(commit.status, `fixture commit failed: ${commit.stderr}`).toBe(0)
    const object = git(repo, ['cat-file', 'commit', 'HEAD'], env)
    expect(object.status, object.stderr).toBe(0)
    expect(object.stdout).not.toMatch(/^gpgsig /m)
    expect(object.stdout).toMatch(/^author .* <[^>]+\.invalid> /m)
  })

  it('a fixture repo with its own identity still never signs through an inherited signing config', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-git-isolation-sign-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home)
    writeFileSync(join(home, '.gitconfig'), BROKEN_SIGNING_CONFIG)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') }

    expect(git(repo, ['init', '-q'], env).status).toBe(0)
    expect(git(repo, ['config', 'user.name', 'Fixture'], env).status).toBe(0)
    expect(git(repo, ['config', 'user.email', 'fixture@example.invalid'], env).status).toBe(0)
    // Identity is local, so the only thing left that can fail this commit is signing.
    const commit = git(repo, ['commit', '--allow-empty', '-q', '-m', 'fixture'], env)
    expect(commit.status, `fixture commit failed: ${commit.stderr}`).toBe(0)
  })

  it('a child git sees no system entry and no global entry outside the suite-owned file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wt-git-isolation-scope-'))
    roots.push(cwd)
    const suiteGlobal = process.env.GIT_CONFIG_GLOBAL
    expect(suiteGlobal, 'GIT_CONFIG_GLOBAL is set for every worker').toBeTruthy()
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1')

    const listed = git(cwd, ['config', '--list', '--show-scope', '--show-origin'], process.env)
    expect(listed.status, listed.stderr).toBe(0)
    const entries = listed.stdout.split('\n').filter(Boolean)
    expect(entries.filter((line) => line.startsWith('system\t')), 'system-scope entries').toEqual([])
    // Git for Windows may print the origin with either separator; compare with one.
    const slash = (text: string) => text.replaceAll('\\', '/')
    const foreignGlobal = entries
      .filter((line) => line.startsWith('global\t'))
      .filter((line) => !slash(line).startsWith(`global\tfile:${slash(suiteGlobal ?? '')}\t`))
    expect(foreignGlobal, 'global-scope entries from a file the suite does not own').toEqual([])

    const signing = git(cwd, ['config', '--type=bool', '--get', 'commit.gpgsign'], process.env)
    expect(signing.stdout.trim()).toBe('false')
  })

  it('a child process does not inherit the SSH agent socket', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.SSH_AUTH_SOCK ?? "<unset>")'], {
      encoding: 'utf8',
      env: process.env,
    })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('<unset>')
  })
})
