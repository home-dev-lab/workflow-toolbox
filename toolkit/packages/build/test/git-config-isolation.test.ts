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

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 }

// The origin path of one `git config --list --show-scope --show-origin` line. Git C-quotes an
// origin that needs quoting, and Git for Windows does so for every backslash path:
// `global	file:"C:\\Users\\…\\gitconfig"	key=value`. Undo the quoting (octal escapes included,
// which Git uses for non-ASCII bytes) and compare with one separator.
function originPath(line: string): string {
  const origin = line.split('\t')[1] ?? ''
  const raw = origin.startsWith('file:') ? origin.slice('file:'.length) : origin
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw.replaceAll('\\', '/')
  const bytes: number[] = []
  const chars = Array.from(raw.slice(1, -1))
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? ''
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      continue
    }
    const octal = /^[0-7]{3}$/.exec(chars.slice(i + 1, i + 4).join(''))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8))
      i += 3
    } else {
      const escaped = chars[i + 1] ?? ''
      const code = C_ESCAPES[escaped]
      bytes.push(...(code === undefined ? Buffer.from(escaped, 'utf8') : [code]))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8').replaceAll('\\', '/')
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
    const owned = (suiteGlobal ?? '').replaceAll('\\', '/')
    const foreignGlobal = entries
      .filter((line) => line.startsWith('global\t'))
      .filter((line) => originPath(line) !== owned)
    expect(foreignGlobal, 'global-scope entries from a file the suite does not own').toEqual([])

    const signing = git(cwd, ['config', '--type=bool', '--get', 'commit.gpgsign'], process.env)
    expect(signing.stdout.trim()).toBe('false')
  })

  it('reads the origin of a scope line in the plain, the Git for Windows quoted and the octal-escaped forms', () => {
    // Verbatim shape of a Windows runner line: C-quoted, every backslash doubled.
    const windows = 'global\tfile:"C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\wt-git-config-suite-5wvUPJ\\\\gitconfig"\tuser.name=Workflow Toolbox Test'
    expect(originPath(windows)).toBe('C:/Users/RUNNER~1/AppData/Local/Temp/wt-git-config-suite-5wvUPJ/gitconfig')
    expect(originPath('global\tfile:/tmp/wt-git-config-suite-x/gitconfig\tcommit.gpgsign=false')).toBe('/tmp/wt-git-config-suite-x/gitconfig')
    expect(originPath('global\tfile:"/tmp/caf\\303\\251/gitconfig"\ttag.gpgsign=false')).toBe('/tmp/café/gitconfig')
    expect(originPath('global\tfile:"/tmp/a\\"b/gitconfig"\tk=v')).toBe('/tmp/a"b/gitconfig')
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
