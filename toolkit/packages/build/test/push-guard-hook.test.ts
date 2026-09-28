import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/host/ has no declaration
import { matchesGuardPath, normalizePushPath } from '../../../../plugin/bin/lib/host/push-guard-identity.mjs'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const installer = join(root, 'plugin/bin/wt-push-guard-install.mjs')
const engine = join(root, 'plugin/bin/wt-push-scope-check.mjs')
const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-hook-'))
  made.push(dir)
  const local = join(dir, 'local')
  const bare = join(dir, 'home-dev-lab', 'workflow-toolbox.git')
  mkdirSync(join(dir, 'home-dev-lab'))
  const env = sealedPluginCliEnv(dir, { HOME: join(dir, 'home'), GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  function call(cwd: string, cmd: string, args: string[], input?: string) {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', input })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  function git(cwd: string, ...args: string[]) {
    const r = call(cwd, 'git', args)
    if (r.status !== 0) throw Error(`git ${args.join(' ')}: ${r.out}`)
    return r.out.trim()
  }
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare)
  git(bare, 'config', 'receive.denyDeleteCurrent', 'ignore')
  git(dir, 'init', '-q', '-b', 'main', local)
  git(local, 'remote', 'add', 'public', bare)
  function commit(name: string) {
    writeFileSync(join(local, `${name}.txt`), name)
    git(local, 'add', '.')
    git(local, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', name)
    return git(local, 'rev-parse', 'HEAD')
  }
  const A = commit('A')
  git(local, 'push', '-q', 'public', 'main')
  function install(...args: string[]) { return call(local, process.execPath, [installer, ...args, '--repo', local]) }
  const installed = install('--install', '--guard-remote', 'public', '--guard-path', 'home-dev-lab/workflow-toolbox')
  if (installed.status !== 0) throw Error(installed.out)
  const auth = join(local, '.git', 'wt-push-authorized.json')
  function authorize(scope: unknown) { writeFileSync(auth, JSON.stringify(scope)) }
  function push(...args: string[]) { return call(local, 'git', ['push', ...args]) }
  function hook(remote: string, url: string, input: string) {
    return call(local, 'sh', [join(local, '.git/hooks/pre-push'), remote, url], input)
  }
  return { dir, local, bare, A, env, git, call, commit, install, authorize, auth, push, hook }
}

function pinnedSnapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => `${e.parentPath}/${e.name}:${readFileSync(join(e.parentPath, e.name)).toString('hex')}`).sort()
}

// Each injected failure runs the actual installer with only its filesystem operations substituted.
function faultInstall(f: ReturnType<typeof fixture>, fault: 'place' | 'discard') {
  const script = `import { runInstaller } from ${JSON.stringify(join(root, 'plugin/bin/lib/host/push-guard-install.mjs'))};
    import * as fs from 'node:fs';
    import { basename, join } from 'node:path';
    const ops = { ...fs,
      renameSync(from, to) {
        if (${JSON.stringify(fault)} === 'place' && from.includes('.stage-') && basename(to) === 'wt-push-guard') throw Error('injected placement failure');
        return fs.renameSync(from, to);
      },
      rmSync(path, options) {
        if (${JSON.stringify(fault)} === 'discard' && path.includes('.old-')) {
          fs.rmSync(join(path, 'config.json')); throw Error('injected partial discard');
        }
        return fs.rmSync(path, options);
      },
    };
    runInstaller(['--install', '--repo', ${JSON.stringify(f.local)}, '--guard-path', 'home-dev-lab/workflow-toolbox'], ops);`
  return f.call(f.local, process.execPath, ['--input-type=module', '-e', script])
}

describe('installed pinned pre-push guard (local bare remotes only)', () => {
  it('bounds the union once across two destination refs and consumes only after approval', () => {
    const f = fixture()
    f.git(f.local, 'checkout', '-qb', 'one')
    const B = f.commit('B')
    f.git(f.local, 'checkout', '-qb', 'two', 'main')
    const C = f.commit('C')
    f.authorize({ maxCount: 1 })
    const refused = f.push('public', 'one:refs/heads/one', 'two:refs/heads/two')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('outside the authorized scope')
    expect(existsSync(f.auth)).toBe(true)
    f.authorize({ commits: [B, C] })
    const passed = f.push('public', 'one:refs/heads/one', 'two:refs/heads/two')
    expect(passed.status, passed.out).toBe(0)
    expect(passed.out).toMatch(/wt-push-scope-check: .*— OK/)
    expect(existsSync(f.auth)).toBe(false)
    expect(f.git(f.bare, 'rev-parse', 'refs/heads/two')).toBe(C)
  })

  it('guards another remote, bare path and insteadOf alias, but passes a different repo', () => {
    const f = fixture()
    f.commit('B')
    f.git(f.local, 'remote', 'add', 'other', f.bare)
    for (const target of ['other', f.bare]) {
      const r = f.push(target, 'HEAD:refs/heads/main')
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toContain('single-use')
    }
    f.git(f.local, 'config', `url.${f.bare}.insteadOf`, 'localalias:')
    const alias = f.push('localalias:', 'HEAD:refs/heads/main')
    expect(alias.status, alias.out).not.toBe(0)
    const privateBare = join(f.dir, 'home-dev-lab', 'workflow-toolbox-private.git')
    f.git(f.dir, 'init', '-q', '--bare', privateBare)
    const unrelated = f.push(privateBare, 'HEAD:refs/heads/main')
    expect(unrelated.status, unrelated.out).toBe(0)
  })

  it('allows an existing sibling bare repository through a relative push URL and named remote', () => {
    const f = fixture()
    const B = f.commit('B')
    const sibling = join(f.dir, 'other.git')
    f.git(f.dir, 'init', '-q', '--bare', sibling)
    expect(normalizePushPath('../other.git', f.local)).toBe(normalizePushPath(sibling))
    const direct = f.push('../other.git', 'HEAD:refs/heads/main')
    expect(direct.status, direct.out).toBe(0)
    expect(f.git(sibling, 'rev-parse', 'main')).toBe(B)
    f.git(f.local, 'remote', 'add', 'sibling', '../other.git')
    const named = f.push('sibling', 'HEAD:refs/heads/m')
    expect(named.status, named.out).toBe(0)
    expect(f.git(sibling, 'rev-parse', 'm')).toBe(B)
    expect(existsSync(f.auth)).toBe(false)
  })

  it('guards a relative local path resolving to the guarded bare repository', () => {
    const f = fixture()
    f.commit('B')
    for (const url of ['../home-dev-lab/workflow-toolbox.git', './../home-dev-lab/workflow-toolbox.git']) {
      const refused = f.push(url, 'HEAD:refs/heads/main')
      expect(refused.status, refused.out).not.toBe(0)
      expect(refused.out).toContain('single-use authorization missing')
      expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
    }
  })

  it('rejects a relative local path that does not resolve to an existing directory', () => {
    const f = fixture()
    expect(() => normalizePushPath('./missing.git', f.local)).toThrow('unmeasurable push URL: ./missing.git')
    const B = f.commit('B')
    const refused = f.hook('other', './missing.git', `refs/heads/main ${B} refs/heads/main ${f.A}\n`)
    expect(refused.status, refused.out).toBe(2)
    expect(refused.out).toContain('use an absolute path or a named remote')
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
  })

  it('guards the configured URL path without any configured guarded remote names', () => {
    const f = fixture()
    f.commit('B')
    const reinstalled = f.install('--install', '--guard-path', 'home-dev-lab/workflow-toolbox')
    expect(reinstalled.status, reinstalled.out).toBe(0)
    const denied = f.push(f.bare, 'HEAD:refs/heads/main')
    expect(denied.status, denied.out).not.toBe(0)
    expect(denied.out).toContain('single-use')
  })

  it('normalizes URL path identity with host aliases, ports, decoding and segment boundaries', () => {
    const urls = ['https://GITHUB.com:443/home-dev-lab/workflow-toolbox.git/', 'ssh://git@ssh.github.com:443/home-dev-lab/workflow-toolbox.git', 'git@alias:home-dev-lab//workflow-toolbox', 'ssh://git@github.com:22/home-dev-lab%2Fworkflow-toolbox.git']
    for (const url of urls) expect(normalizePushPath(url)).toBe('home-dev-lab/workflow-toolbox')
    for (const url of ['C:\\Users\\x\\home-dev-lab\\workflow-toolbox.git', 'D:/repos\\home-dev-lab\\workflow-toolbox.git']) {
      expect(matchesGuardPath(url, ['home-dev-lab/workflow-toolbox']), url).toBe(true)
    }
    expect(normalizePushPath('C:\\Users\\x\\home-dev-lab\\workflow-toolbox.git')).toBe('c:/users/x/home-dev-lab/workflow-toolbox')
    expect(matchesGuardPath('C:\\Users\\x\\home-dev-lab\\workflow-toolbox-private.git', ['home-dev-lab/workflow-toolbox'])).toBe(false)
    expect(normalizePushPath('git@alias:home-dev-lab/workflow-toolbox-private.git')).not.toBe('home-dev-lab/workflow-toolbox')
    expect(matchesGuardPath('ssh://git@alias:443/a/home-dev-lab/workflow-toolbox.git', ['home-dev-lab/workflow-toolbox'])).toBe(true)
    expect(matchesGuardPath('ssh://git@alias:443/a/home-dev-lab/workflow-toolbox-private.git', ['home-dev-lab/workflow-toolbox'])).toBe(false)
  })

  it.each([
    ['git@[0:0:0:0:0:ffff:140.82.112.3]:home-dev-lab/workflow-toolbox.git', 'home-dev-lab/workflow-toolbox'],
    ['git@[2001:db8::1]:x/y.git', 'x/y'],
    ['git@[2001:db8::1:22]:x/y.git', 'x/y'],
    ['[example.com:2222]:x/y.git', 'x/y'],
    ['ssh://git@[::1]:22/x/y.git', 'x/y'],
  ])('normalizes the repository path after a bracketed host in %s', (url, path) => {
    expect(normalizePushPath(url)).toBe(path)
  })

  it('fails closed on an unterminated bracketed scp-like host', () => {
    const url = 'git@[0:0:0:0:0:ffff:140.82.112.3:x/y.git'
    expect(() => normalizePushPath(url)).toThrow(`unmeasurable push URL: ${url}`)
  })

  it('refuses a bracketed IPv6 scp-like destination through the installed shim without connecting', () => {
    const f = fixture()
    const B = f.commit('B')
    const localBare = join(f.local, 'home-dev-lab', 'workflow-toolbox.git')
    mkdirSync(join(f.local, 'home-dev-lab'))
    f.git(f.local, 'init', '-q', '--bare', localBare)
    const url = 'git@[::1]:home-dev-lab/workflow-toolbox.git'
    const refused = f.hook('other', url, `refs/heads/main ${B} refs/heads/main ${f.A}\n`)
    expect(refused.status, refused.out).toBe(1)
    expect(refused.out).toContain('wt-push-scope-check: single-use authorization missing')
    expect(f.call(localBare, 'git', ['show-ref']).status).toBe(1)
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
  })

  it('resolves dot segments and decoded spellings to one guarded repository path', () => {
    for (const url of ['https://github.com/home-dev-lab/workflow-toolbox.git/.', 'https://github.com/home-dev-lab/./workflow-toolbox.git', 'https://github.com/home-dev-lab/x/../workflow-toolbox.git', 'https://github.com/home-dev-lab/%2e/workflow-toolbox.git', 'https://github.com/home-dev-lab/x/%2e%2e/workflow-toolbox.git']) {
      expect(normalizePushPath(url)).toBe('home-dev-lab/workflow-toolbox')
    }
  })

  it('rejects ambiguous URL syntax before comparing repository identities', () => {
    for (const url of ['ext::sh -c true', 'fd::7', 'x::anything', '/repo/../../elsewhere', '/repo?query', '/repo#fragment']) {
      expect(() => normalizePushPath(url)).toThrow(`unmeasurable push URL: ${url}`)
    }
  })

  it('guards equivalent dot-segment paths through the installed hook', () => {
    const f = fixture()
    f.commit('B')
    mkdirSync(join(f.dir, 'x'))
    for (const spelling of [`${f.bare}/.`, `${f.dir}/x/../home-dev-lab/workflow-toolbox.git`, `${f.dir}/./home-dev-lab/workflow-toolbox.git`]) {
      const refused = f.push(spelling, 'HEAD:main')
      expect(refused.status, refused.out).not.toBe(0)
      expect(refused.out).toContain('single-use authorization missing')
      expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
    }
    for (const spelling of ['https://github.com/home-dev-lab/%2e/workflow-toolbox.git', 'https://github.com/home-dev-lab/x/%2e%2e/workflow-toolbox.git']) {
      const result = f.hook('other', spelling, `refs/heads/main ${f.git(f.local, 'rev-parse', 'HEAD')} refs/heads/main ${f.A}\n`)
      expect(result.status, result.out).toBe(1)
      expect(result.out).toContain('single-use authorization missing')
    }
  })

  it('fails closed on unmeasurable URLs, including all remote-helper prefixes', () => {
    const f = fixture()
    const B = f.commit('B')
    for (const url of [`${f.bare}/../../../../../../escape`, `${f.bare}?query=1`, `${f.bare}#fragment`, 'ext::sh -c true', 'fd::7', 'x::anything']) {
      const refused = f.hook('other', url, `refs/heads/main ${B} refs/heads/main ${f.A}\n`)
      expect(refused.status, `${url}: ${refused.out}`).toBe(2)
      expect(refused.out).toContain(`unmeasurable push URL: ${url}`)
      expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
    }
  })

  it('manual unknown --branch refuses until explicitly --new-branch', () => {
    const f = fixture()
    f.commit('B')
    f.authorize({ maxCount: 1 })
    const args = [engine, '--remote', 'public', '--branch', 'not-there', '--ref', 'HEAD', '--authorized', f.auth]
    const unknown = f.call(f.local, process.execPath, args)
    expect(unknown.status, unknown.out).toBe(2)
    expect(unknown.out).toContain('pass --new-branch')
    const newBranch = f.call(f.local, process.execPath, [...args, '--new-branch'])
    expect(newBranch.status, newBranch.out).toBe(0)
    const mixed = f.call(f.local, process.execPath, [...args, '--remote-sha', f.A])
    expect(mixed.status, mixed.out).toBe(2)
    expect(mixed.out).toContain('mutually exclusive')
  })

  it('uses installed engine, detects installed edits, and check detects non-executable shim', () => {
    const f = fixture()
    f.commit('B')
    const workcopy = readFileSync(engine)
    expect(readFileSync(join(f.local, '.git/hooks/wt-push-guard/bin/wt-push-scope-check.mjs')).equals(workcopy)).toBe(true)
    mkdirSync(join(f.local, 'plugin/bin'), { recursive: true })
    writeFileSync(join(f.local, 'plugin/bin/wt-push-scope-check.mjs'), 'process.exit(0)\n')
    const denied = f.push('public', 'HEAD:main')
    expect(denied.status, denied.out).not.toBe(0)
    expect(denied.out).toContain('single-use')
    const installed = join(f.local, '.git/hooks/wt-push-guard/bin/wt-push-scope-check.mjs')
    writeFileSync(installed, Buffer.concat([readFileSync(installed), Buffer.from('\n// tampered\n')]))
    f.authorize({ maxCount: 1 })
    const tampered = f.push('public', 'HEAD:main')
    expect(tampered.status, tampered.out).not.toBe(0)
    expect(tampered.out).toContain('missing or changed')
    expect(f.install('--check').status).toBe(1)
    expect(f.install('--install', '--guard-remote', 'public', '--guard-path', 'home-dev-lab/workflow-toolbox').status).toBe(0)
    expect(f.install('--check').status).toBe(0)
    if (process.platform !== 'win32') {
      chmodSync(join(f.local, '.git/hooks/pre-push'), 0o644)
      const check = f.install('--check')
      expect(check.status, check.out).toBe(1)
      expect(check.out).toContain('not executable')
    }
  })

  it('rejects a user-owned shim executable by others but not by its owner', () => {
    if (process.platform === 'win32') return
    const f = fixture()
    chmodSync(join(f.local, '.git/hooks/pre-push'), 0o641)
    const check = f.install('--check')
    expect(check.status, check.out).toBe(1)
    expect(check.out).toContain('not executable')
  })

  it('preserves the entire old installation after failed placement and does not roll back after partial discard', () => {
    const f = fixture()
    const installed = join(f.local, '.git/hooks/wt-push-guard')
    const before = pinnedSnapshot(installed)
    const failed = faultInstall(f, 'place')
    expect(failed.status, failed.out).toBe(2)
    expect(pinnedSnapshot(installed)).toEqual(before)
    const discarded = faultInstall(f, 'discard')
    expect(discarded.status, discarded.out).toBe(0)
    expect(discarded.out).toContain('warning')
    expect(f.install('--check').status).toBe(0)
  })

  it('reinstalls an intact guard twice and checks its pinned source', () => {
    const f = fixture()
    const second = f.install('--install', '--guard-remote', 'public', '--guard-path', 'home-dev-lab/workflow-toolbox')
    expect(second.status, second.out).toBe(0)
    const third = f.install('--install', '--guard-remote', 'public', '--guard-path', 'home-dev-lab/workflow-toolbox')
    expect(third.status, third.out).toBe(0)
    const check = f.install('--check')
    expect(check.status, check.out).toBe(0)
  })

  it('checks requested identities against the installed config', () => {
    const f = fixture()
    const same = f.install('--check', '--guard-remote', 'public', '--guard-path', 'home-dev-lab/workflow-toolbox')
    expect(same.status, same.out).toBe(0)
    const wrongRemote = f.install('--check', '--guard-remote', 'other')
    expect(wrongRemote.status, wrongRemote.out).toBe(1)
    expect(wrongRemote.out).toContain('guardRemotes mismatch')
    const wrongPath = f.install('--check', '--guard-path', 'elsewhere/other')
    expect(wrongPath.status, wrongPath.out).toBe(1)
    expect(wrongPath.out).toContain('guardPaths mismatch')
  })

  it('blocks missing destination tip and broken new-ref listing, keeping authorization', () => {
    const f = fixture()
    f.commit('B')
    f.authorize({ maxCount: 1 })
    const bogus = 'f'.repeat(40)
    const stdin = `refs/heads/main ${f.git(f.local, 'rev-parse', 'HEAD')} refs/heads/main ${bogus}\n`
    const installed = join(f.local, '.git/hooks/wt-push-guard')
    const run = (input: string, url = f.bare) => f.call(f.local, process.execPath, [join(installed, 'bin/wt-push-scope-check.mjs'), '--pre-push', '--remote', 'public', '--url', url, '--authorized', f.auth, '--install-dir', installed], input)
    const missing = run(stdin)
    expect(missing.status, missing.out).toBe(2)
    expect(missing.out).toContain('not in this clone')
    const zero = '0'.repeat(40)
    const inaccessible = run(`refs/heads/main ${f.git(f.local, 'rev-parse', 'HEAD')} refs/heads/new ${zero}\n`, join(f.dir, 'home-dev-lab', 'absent.git'))
    expect(inaccessible.status, inaccessible.out).toBe(2)
    expect(existsSync(f.auth)).toBe(true)
    rmSync(f.auth)
    const remedy = run(`refs/heads/main ${f.git(f.local, 'rev-parse', 'HEAD')} refs/heads/new ${zero}\n`, join(f.dir, 'home-dev-lab', 'absent.git'))
    expect(remedy.status, remedy.out).toBe(1)
    expect(remedy.out).toContain('(none computed — could not measure outgoing commits:')
  })

  it('consumes once, refuses a second push with remedy, and passes zero-count deletion', () => {
    const f = fixture()
    const B = f.commit('B')
    f.authorize({ commits: [B] })
    const approved = f.push('public', 'main')
    expect(approved.status, approved.out).toBe(0)
    const second = f.push('public', 'main:refs/heads/new')
    expect(second.status, second.out).not.toBe(0)
    expect(second.out).toContain('single-use')
    expect(second.out).toContain("printf '%s\\n'")
    const command = second.out.split('\n').find((line) => line.startsWith("printf '%s\\n'"))
    expect(command).toBeDefined()
    const remedy = f.call(f.local, 'sh', ['-c', command!])
    expect(remedy.status, remedy.out).toBe(0)
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))).toEqual({ commits: [] })
    f.authorize({ maxCount: 0 })
    const deletion = f.push('public', ':refs/heads/main')
    expect(deletion.status, deletion.out).toBe(0)
    expect(deletion.out).toContain('no commits to push — OK')
    expect(existsSync(f.auth)).toBe(false)
  })

  it('consumes one approved dry-run attempt without updating the remote', () => {
    const f = fixture()
    const B = f.commit('B')
    f.authorize({ commits: [B] })
    const dry = f.push('--dry-run', 'public', 'main')
    expect(dry.status, dry.out).toBe(0)
    expect(dry.out).toContain('authorization consumed')
    expect(existsSync(f.auth)).toBe(false)
    expect(f.git(f.bare, 'rev-parse', 'refs/heads/main')).toBe(f.A)
  })

  it('retains authorization when an existing destination fails signature policy', () => {
    const f = fixture()
    const B = f.commit('B')
    f.authorize({ commits: [B] })
    f.git(f.local, 'config', 'commit.gpgsign', 'true')
    const refused = f.push('public', 'main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('authorized SCOPE was fine')
    expect(existsSync(f.auth)).toBe(true)
  })

  it('uses the unreplaced graph for both scope and signature checks', () => {
    const f = fixture()
    const B = f.commit('B')
    f.git(f.local, 'push', '--no-verify', 'public', 'main')
    f.git(f.local, 'checkout', '-qb', 'new', f.A)
    const N = f.commit('N')
    f.git(f.local, 'replace', '--graft', B, f.A, N)
    f.git(f.local, 'config', 'commit.gpgsign', 'true')
    f.authorize({ commits: [N] })
    const refused = f.push('--dry-run', '--force', 'public', 'new:main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('signature check refused')
    expect(existsSync(f.auth)).toBe(true)
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(B)
  })

  it('measures outgoing commits without replacement refs through the pinned hook', () => {
    const f = fixture()
    const B = f.commit('B')
    f.git(f.local, 'push', '--no-verify', 'public', 'main')
    f.git(f.local, 'checkout', '-qb', 'new', f.A)
    const N = f.commit('N')
    f.git(f.local, 'replace', '--graft', B, f.A, N)
    f.authorize({ commits: [] })
    const refused = f.push('--dry-run', '--force', 'public', 'new:main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain(`UNAUTHORIZED COMMIT: ${N.slice(0, 12)}`)
    expect(existsSync(f.auth)).toBe(true)
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(B)
  })

  it('refuses two push URLs on a differently named guarded destination before consuming authorization', () => {
    const f = fixture()
    f.commit('B')
    f.git(f.local, 'remote', 'add', 'release', f.bare)
    f.git(f.local, 'config', '--add', 'remote.release.pushurl', f.bare)
    f.git(f.local, 'config', '--add', 'remote.release.pushurl', f.bare)
    f.authorize({ maxCount: 1 })
    const refused = f.push('--dry-run', 'release', 'main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('multiple push URLs')
    expect(existsSync(f.auth)).toBe(true)
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
  })

  it('measures the existing destination rather than history already on a second remote ref', () => {
    const f = fixture()
    const B = f.commit('B')
    f.git(f.local, 'push', '--no-verify', 'public', 'HEAD:refs/heads/other')
    f.authorize({ commits: [] })
    const refused = f.push('--dry-run', 'public', 'main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain(`UNAUTHORIZED COMMIT: ${B.slice(0, 12)}`)
    expect(existsSync(f.auth)).toBe(true)
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
  })

  it('accepts the exact positive maxCount and counts overlapping refs only once', () => {
    const f = fixture()
    const B = f.commit('B')
    f.authorize({ maxCount: 1 })
    const approved = f.push('public', 'main:refs/heads/main', 'main:refs/heads/other')
    expect(approved.status, approved.out).toBe(0)
    expect(approved.out).toContain('all 1 commit(s) covered')
    expect(f.git(f.bare, 'rev-parse', 'refs/heads/other')).toBe(B)
  })

  it('counts shared commits only once across overlapping destination ranges', () => {
    const f = fixture()
    f.commit('B')
    const C = f.commit('C')
    f.authorize({ maxCount: 2 })
    const approved = f.push('public', 'main:refs/heads/main', 'main:refs/heads/other')
    expect(approved.status, approved.out).toBe(0)
    expect(approved.out).toContain('all 2 commit(s) covered')
    expect(f.git(f.bare, 'rev-parse', 'refs/heads/other')).toBe(C)
  })

  it.each([{ maxCount: -1 }, { commits: 'abc' }, { commits: [1] }])('rejects valid JSON with invalid scope %j', (scope) => {
    const f = fixture()
    f.commit('B')
    f.authorize(scope)
    const refused = f.push('--dry-run', 'public', 'main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('authorization FILE malformed')
    expect(existsSync(f.auth)).toBe(true)
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
  })

  it('reports changed source separately from a broken pinned copy', () => {
    const f = fixture()
    const sourceBin = join(f.dir, 'source', 'bin')
    cpSync(join(root, 'plugin/bin'), sourceBin, { recursive: true })
    const sourceInstaller = join(sourceBin, 'wt-push-guard-install.mjs')
    const fresh = f.call(f.local, process.execPath, [sourceInstaller, '--install', '--repo', f.local, '--guard-remote', 'public', '--guard-path', 'home-dev-lab/workflow-toolbox'])
    expect(fresh.status, fresh.out).toBe(0)
    const source = join(sourceBin, 'lib/host/push-guard-identity.mjs')
    const installed = join(f.local, '.git/hooks/wt-push-guard/bin/lib/host/push-guard-identity.mjs')
    writeFileSync(installed, readFileSync(installed).toString() + '// changed\n')
    expect(f.install('--check').status).toBe(1)
    writeFileSync(installed, readFileSync(source))
    writeFileSync(source, readFileSync(source).toString() + '// newer source\n')
    const ahead = f.call(f.local, process.execPath, [sourceInstaller, '--check', '--repo', f.local])
    expect(ahead.status, ahead.out).toBe(3)
    expect(ahead.out).toContain('source differs')
  })

  it('detects an authorization changed between rename and verification', () => {
    const f = fixture()
    const B = f.commit('B')
    f.authorize({ commits: [B] })
    const script = `import { runPrePush } from ${JSON.stringify(join(f.local, '.git/hooks/wt-push-guard/bin/lib/host/push-guard-runtime.mjs'))};
      import { writeFileSync } from 'node:fs';
      runPrePush({ installDir: ${JSON.stringify(join(f.local, '.git/hooks/wt-push-guard'))}, remote: 'public',
        url: ${JSON.stringify(f.bare)}, authorized: ${JSON.stringify(f.auth)},
        afterConsume: (path) => writeFileSync(path, '{"commits":[]}') });`
    const input = `refs/heads/main ${B} refs/heads/main ${f.A}\n`
    const result = f.call(f.local, process.execPath, ['--input-type=module', '-e', script], input)
    expect(result.status, result.out).toBe(1)
    expect(result.out).toContain('authorization changed after rename')
    expect(f.git(f.bare, 'rev-parse', 'main')).toBe(f.A)
  })

  it('requires a fresh authorization to publish an annotated release tag after main', () => {
    const f = fixture()
    const B = f.commit('B')
    f.authorize({ commits: [B] })
    expect(f.push('public', 'main').status).toBe(0)
    f.git(f.local, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'workflow-toolbox--v1', '-m', 'release', B)
    const missing = f.push('--dry-run', 'public', 'refs/tags/workflow-toolbox--v1')
    expect(missing.status, missing.out).not.toBe(0)
    expect(missing.out).toContain('single-use authorization missing')
    f.authorize({ commits: [] })
    const tagged = f.push('public', 'refs/tags/workflow-toolbox--v1')
    expect(tagged.status, tagged.out).toBe(0)
    expect(f.git(f.bare, 'rev-parse', 'refs/tags/workflow-toolbox--v1^{}')).toBe(B)
  })

  it('refuses malformed stdin, malformed authorization, foreign hook, hooksPath and multi-pushurl', () => {
    const f = fixture()
    f.commit('B')
    const installed = join(f.local, '.git/hooks/wt-push-guard')
    const cmd = [join(installed, 'bin/wt-push-scope-check.mjs'), '--pre-push', '--remote', 'public', '--url', f.bare, '--authorized', f.auth, '--install-dir', installed]
    const malformed = f.call(f.local, process.execPath, cmd, 'invalid line\n')
    expect(malformed.status, malformed.out).toBe(2)
    expect(malformed.out).toContain('malformed pre-push stdin line')
    writeFileSync(f.auth, '{invalid')
    const malformedAuth = f.push('public', 'main')
    expect(malformedAuth.status, malformedAuth.out).not.toBe(0)
    expect(malformedAuth.out).toContain('authorization FILE malformed')
    f.git(f.local, 'config', '--add', 'remote.public.pushurl', f.bare)
    f.git(f.local, 'config', '--add', 'remote.public.pushurl', f.bare)
    const multi = f.push('public', 'main')
    expect(multi.status, multi.out).not.toBe(0)
    expect(multi.out).toContain('multiple push URLs')
    f.git(f.local, 'config', '--unset-all', 'remote.public.pushurl')
    f.git(f.local, 'config', 'core.hooksPath', join(f.dir, 'alternative-hooks'))
    const check = f.install('--check')
    expect(check.status, check.out).toBe(1)
    expect(check.out).toContain('core.hooksPath')
    expect(f.install('--install', '--guard-remote', 'public').status).toBe(2)
    f.git(f.local, 'config', '--unset', 'core.hooksPath')
    writeFileSync(join(f.local, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n')
    const foreign = f.install('--install', '--guard-remote', 'public')
    expect(foreign.status, foreign.out).toBe(2)
    expect(foreign.out).toContain('foreign pre-push')
    const replaced = f.install('--install', '--guard-remote', 'public', '--replace-existing')
    expect(replaced.status, replaced.out).toBe(0)
    expect(readdirSync(join(f.local, '.git/hooks')).filter((name) => name.startsWith('pre-push.replaced-'))).toHaveLength(1)
  })

  it('refuses a guarded remote with two push URLs before spending authorization', () => {
    const f = fixture()
    f.commit('B')
    f.authorize({ maxCount: 1 })
    f.git(f.local, 'config', '--add', 'remote.public.pushurl', f.bare)
    f.git(f.local, 'config', '--add', 'remote.public.pushurl', f.bare)
    const refused = f.push('public', 'main')
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('multiple push URLs on a guarded remote are not supported')
    expect(existsSync(f.auth)).toBe(true)
    expect(f.git(f.bare, 'rev-parse', 'refs/heads/main')).toBe(f.A)
  })

  it('treats --help as a remote value, not a bypass', () => {
    const f = fixture()
    const B = f.commit('B')
    const installed = join(f.local, '.git/hooks/wt-push-guard')
    const input = `refs/heads/main ${B} refs/heads/main ${f.A}\n`
    const result = f.call(f.local, process.execPath, [join(installed, 'bin/wt-push-scope-check.mjs'), '--pre-push', '--remote', '--help', '--url', f.bare, '--authorized', f.auth, '--install-dir', installed], input)
    expect(result.status, result.out).not.toBe(0)
    expect(result.out).toContain('single-use')
  })

  it('uses the linked worktree git directory for authorization, not the common hooks directory', () => {
    const f = fixture()
    const linked = join(f.dir, 'linked')
    f.git(f.local, 'worktree', 'add', '-qb', 'linked', linked, 'main')
    writeFileSync(join(linked, 'linked.txt'), 'linked')
    f.git(linked, 'add', '.')
    f.git(linked, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'linked')
    const B = f.git(linked, 'rev-parse', 'HEAD')
    const gitDir = f.git(linked, 'rev-parse', '--absolute-git-dir')
    const auth = join(gitDir, 'wt-push-authorized.json')
    const refused = f.call(linked, 'git', ['push', 'public', 'HEAD:refs/heads/linked'])
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain(auth)
    writeFileSync(auth, JSON.stringify({ commits: [B] }))
    const approved = f.call(linked, 'git', ['push', 'public', 'HEAD:refs/heads/linked'])
    expect(approved.status, approved.out).toBe(0)
    expect(existsSync(auth)).toBe(false)
  })

  it('refuses a second insteadOf rewrite before listing any new destination', () => {
    const f = fixture()
    const B = f.commit('B')
    f.git(f.local, 'config', `url.${f.bare}.insteadOf`, 'again:')
    f.authorize({ maxCount: 1 })
    const installed = join(f.local, '.git/hooks/wt-push-guard')
    const zero = '0'.repeat(40)
    const result = f.call(f.local, process.execPath, [join(installed, 'bin/wt-push-scope-check.mjs'), '--pre-push', '--remote', 'public', '--url', 'again:', '--authorized', f.auth, '--install-dir', installed], `refs/heads/main ${B} refs/heads/new ${zero}\n`)
    expect(result.status, result.out).toBe(2)
    expect(result.out).toMatch(/push URL is rewritten again|unmeasurable push URL/)
  })

  it('refuses shallow and grafted ancestry rather than undercounting', () => {
    const f = fixture()
    f.commit('B')
    f.authorize({ maxCount: 1 })
    const shallowPath = join(f.local, '.git/shallow')
    writeFileSync(shallowPath, `${f.A}\n`)
    const shallow = f.push('public', 'main')
    expect(shallow.status, shallow.out).not.toBe(0)
    expect(shallow.out).toContain('shallow repository or grafted history')
    rmSync(shallowPath)
    const grafts = join(f.local, '.git/info/grafts')
    writeFileSync(grafts, `${f.A}\n`)
    const grafted = f.push('public', 'main')
    expect(grafted.status, grafted.out).not.toBe(0)
    expect(grafted.out).toContain('shallow repository or grafted history')
    rmSync(grafts)
    const withEnv = spawnSync('git', ['push', 'public', 'main'], { cwd: f.local, encoding: 'utf8', env: { ...f.env, GIT_GRAFT_FILE: join(f.dir, 'missing-grafts') } })
    expect(withEnv.status, withEnv.stderr).not.toBe(0)
    expect(withEnv.stderr).toContain('shallow repository or grafted history')
  })

  it('answers help only as the sole argument and refuses unknown installer options', () => {
    const f = fixture()
    const help = f.call(f.local, process.execPath, [installer, '--help'])
    expect(help.status, help.out).toBe(0)
    expect(help.out).toContain('--install')
    const unknown = f.install('--help')
    expect(unknown.status, unknown.out).toBe(2)
    expect(unknown.out).toContain('unknown argument')
  })
})
