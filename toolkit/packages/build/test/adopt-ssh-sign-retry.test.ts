import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const INSTALLER = join(ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const SOURCE = join(ROOT, 'plugin/bin/lib/host/wt-ssh-sign-retry.mjs')
const SIGN = ['-Y', 'sign', '-n', 'git', '-f', 'fake public key', '-']
const roots: string[] = []
const fakeIt = process.platform === 'win32' ? it.skip : it
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-ssh-retry-'))
  roots.push(root)
  const bin = join(root, 'fake bin')
  mkdirSync(bin)
  const seal = join(root, 'network-seal.cjs')
  // Unconditional, outside the subject: mutations cannot disable the network seal.
  writeFileSync(seal, `const deny = () => { throw new Error('network sealed by test') }; require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny; for (const m of ['node:http', 'node:https']) { require(m).request = deny; require(m).get = deny }; globalThis.fetch = deny; require('node:module').syncBuiltinESMExports();`)
  const env = sealedPluginCliEnv(root, {
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: join(root, 'no-system'),
    GIT_CONFIG: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: '',
    XDG_CONFIG_HOME: join(root, 'xdg'), SSH_AUTH_SOCK: undefined, SSH_AGENT_PID: undefined,
    WT_PLUGIN_ROOT: join(ROOT, 'plugin'), CLAUDE_PLUGIN_ROOT: join(ROOT, 'plugin'),
    NODE_OPTIONS: `--require ${JSON.stringify(seal)}`, WT_FAKE_ROOT: root,
  })
  const state = join(root, 'state.json')
  writeFileSync(state, JSON.stringify({ failures: 0, calls: [], message: 'No private key found for public key' }))
  const fake = join(bin, 'ssh-keygen')
  writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'); const p = require('node:path').join(process.env.WT_FAKE_ROOT, 'state.json'); const s = JSON.parse(fs.readFileSync(p)); const input = fs.readFileSync(0); s.calls.push({ args: process.argv.slice(2), input: input.toString('base64') }); fs.writeFileSync(p, JSON.stringify(s)); const failed = s.calls.length <= s.failures; process.stdout.write(failed ? Buffer.from('FAILED-OUTPUT') : Buffer.from([83, 73, 71, 0, 255, 10])); process.stderr.write(failed ? s.message + '\\n' : Buffer.from([79, 75, 0, 255, 10])); process.exit(failed ? 23 : 0);\n`)
  chmodSync(fake, 0o755)
  return { root, bin, env, state, target: join(root, 'claude-config/scripts/wt-ssh-sign-retry.mjs') }
}

type Fixture = ReturnType<typeof fixture>
type State = { failures: number; message: string; calls: { args: string[]; input: string }[] }
function state(f: Fixture): State { return JSON.parse(readFileSync(f.state, 'utf8')) as State }
function scenario(f: Fixture, failures: number, message = 'No private key found for public key') {
  writeFileSync(f.state, JSON.stringify({ failures, message, calls: [] }))
}
function git(f: Fixture, args: string[]) {
  return spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8' })
}
function adopt(f: Fixture, args = ['--set', 'ssh-sign-retry', '--install', '--global']) {
  return spawnSync(process.execPath, [INSTALLER, ...args], { cwd: f.root, env: f.env, encoding: 'utf8' })
}
function installed(f: Fixture) {
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  return f.target
}
function invoke(f: Fixture, args = SIGN, script = SOURCE, path = f.bin) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: f.root, env: { ...f.env, PATH: path }, input: Buffer.from([0, 255, 13, 10, 120]), timeout: 12000,
  })
}

  fakeIt.each([0, 2, 3])('sign with %i initial failures: bounded retries and uncontaminated output', (failures) => {
    const f = fixture()
    const wrapper = installed(f)
    scenario(f, failures)
    const result = invoke(f, SIGN, wrapper)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr.toString()).toBe(failures === 3 ? 23 : 0)
    expect(state(f).calls).toHaveLength(Math.min(failures + 1, 3))
    expect(result.stdout).toEqual(failures === 3 ? Buffer.alloc(0) : Buffer.from([83, 73, 71, 0, 255, 10]))
    expect(result.stderr.toString().match(/retrying because/g) ?? []).toHaveLength(Math.min(failures, 2))
    for (const call of state(f).calls) {
      expect(call.args).toEqual(SIGN)
      expect(call.input).toBe(Buffer.from([0, 255, 13, 10, 120]).toString('base64'))
    }
  }, 15000)

  fakeIt('verify executes once and preserves binary stdin, stdout, stderr and exit code', () => {
    const f = fixture()
    scenario(f, 3)
    const args = ['-Y', 'verify', '-n', 'git', 'space and $shell; characters']
    const result = invoke(f, args, installed(f))
    expect(result.status).toBe(23)
    expect(state(f).calls).toEqual([{ args, input: Buffer.from([0, 255, 13, 10, 120]).toString('base64') }])
    expect(result.stdout).toEqual(Buffer.from('FAILED-OUTPUT'))
    expect(result.stderr).toEqual(Buffer.from('No private key found for public key\n'))
  })
  fakeIt.each(['No private key found', 'communication with agent failed', 'agent refused', 'agent not present'])('retries matched diagnostic: %s', (message) => {
    const f = fixture()
    scenario(f, 1, message)
    const started = performance.now()
    const result = invoke(f)
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(state(f).calls).toHaveLength(2)
    expect(result.stderr.toString()).toContain(`retrying because ${message} (attempt 2/3 in 1s)`)
    expect(performance.now() - started).toBeGreaterThanOrEqual(1000)
  })

  fakeIt.each(['agent contains no identities', 'bad key format', 'permission denied'])('does not retry unmatched diagnostic: %s', (message) => {
    const f = fixture()
    scenario(f, 3, message)
    const result = invoke(f)
    expect(result.status).toBe(23)
    expect(state(f).calls).toHaveLength(1)
    expect(result.stderr).toEqual(Buffer.from(message + '\n'))
    expect(result.stdout).toEqual(Buffer.alloc(0))
  })

  fakeIt.each([['-Y', 'find-principals'], ['-Y', 'check-novalidate'], ['-l'], ['-Y', 'verify']])('passes through %j once with binary output', (...args) => {
    const f = fixture()
    const result = invoke(f, args)
    expect(result.status).toBe(0)
    expect(state(f).calls).toHaveLength(1)
    expect(result.stdout).toEqual(Buffer.from([83, 73, 71, 0, 255, 10]))
    expect(result.stderr).toEqual(Buffer.from([79, 75, 0, 255, 10]))
  })

  fakeIt.each(['symlink', 'hardlink'])('skips its own PATH %s and resolves the next executable', (kind) => {
    const f = fixture()
    const selfDir = join(f.root, 'self')
    mkdirSync(selfDir)
    const createLink = kind === 'symlink' ? symlinkSync : linkSync
    createLink(installed(f), join(selfDir, 'ssh-keygen'))
    chmodSync(f.target, 0o755)
    const result = invoke(f, SIGN, f.target, `${selfDir}${delimiter}${f.bin}`)
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(state(f).calls).toHaveLength(1)
  })

  fakeIt('fails clearly without launching itself when PATH contains only itself', () => {
    const f = fixture()
    installed(f)
    symlinkSync(f.target, join(f.root, 'ssh-keygen'))
    chmodSync(f.target, 0o755)
    const result = invoke(f, SIGN, f.target, f.root)
    expect(result.status).toBe(127)
    expect(result.stderr.toString()).toContain('not found on PATH (the retry wrapper itself is excluded)')
    expect(state(f).calls).toHaveLength(0)
  })

  fakeIt('executes the configured Git command with spaces and apostrophes in its path', () => {
    const f = fixture()
    f.env.CLAUDE_CONFIG_DIR = join(f.root, "config with ' quote")
    f.target = join(f.env.CLAUDE_CONFIG_DIR, 'scripts/wt-ssh-sign-retry.mjs')
    installed(f)
    const command = git(f, ['config', '--global', '--get', 'gpg.ssh.program']).stdout.trimEnd()
    const result = spawnSync('/bin/sh', ['-c', `${command} "$@"`, 'configured', ...SIGN], {
      cwd: f.root, env: { ...f.env, PATH: f.bin }, input: 'payload', encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(state(f).calls).toEqual([{ args: SIGN, input: Buffer.from('payload').toString('base64') }])
  })

  fakeIt('does not retry an ambiguous vector with multiple operations', () => {
    const f = fixture()
    scenario(f, 3)
    const result = invoke(f, ['-Y', 'verify', '-Y', 'sign'])
    expect(result.status).toBe(23)
    expect(state(f).calls).toHaveLength(1)
    expect(result.stdout).toEqual(Buffer.from('FAILED-OUTPUT'))
  })

  fakeIt('spawn fallback passes verify streams and exit status through once without execve', () => {
    const f = fixture()
    const preload = join(f.root, 'no-execve.cjs')
    writeFileSync(preload, 'process.execve = undefined\n')
    f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
    scenario(f, 3)
    const result = invoke(f, ['-Y', 'verify'])
    expect(result.status).toBe(23)
    expect(state(f).calls).toHaveLength(1)
    expect(result.stdout).toEqual(Buffer.from('FAILED-OUTPUT'))
    expect(result.stderr).toEqual(Buffer.from('No private key found for public key\n'))
  })
  it('check is read-only and install creates a standalone fingerprinted wrapper and global command', () => {
    const f = fixture()
    const check = adopt(f, ['--set', 'ssh-sign-retry', '--check', '--global'])
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.stdout).toContain('gpg.ssh.program ABSENT')
    expect(existsSync(f.target)).toBe(false)
    expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
    installed(f)
    expect(readFileSync(f.target, 'utf8')).toMatch(/^#![^\n]+\n\/\/ installed from workflow-toolbox v.*content sha256:/)
    const configured = git(f, ['config', '--global', '--get', 'gpg.ssh.program'])
    expect(configured.status).toBe(0)
    expect(configured.stdout).toContain(f.target.replaceAll('\\', '/'))
    expect(configured.stdout).toContain(process.execPath.replaceAll('\\', '/'))
    expect(adopt(f, ['--set', 'ssh-sign-retry', '--check', '--global']).stdout).toContain('UP-TO-DATE')
  })

  it.each(['custom signer --flag', ''])('leaves existing global value %j and file bytes alone, including with --force', (value) => {
    const f = fixture()
    expect(git(f, ['config', '--global', 'gpg.ssh.program', value]).status).toBe(0)
    const before = readFileSync(f.env.GIT_CONFIG_GLOBAL!)
    const result = adopt(f, ['--set', 'ssh-sign-retry', '--install', '--global', '--force'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('gpg.ssh.program PRESENT (left alone)')
    expect(result.stdout).toContain(JSON.stringify(value))
    expect(readFileSync(f.env.GIT_CONFIG_GLOBAL!)).toEqual(before)
  })

  it('uses project-local scope by default and preserves it on a second adoption', () => {
    const f = fixture()
    expect(git(f, ['init', '--quiet']).status).toBe(0)
    const args = ['--set', 'ssh-sign-retry', '--install']
    expect(adopt(f, args).status).toBe(0)
    const configured = git(f, ['config', '--local', '--get', 'gpg.ssh.program']).stdout
    expect(configured).toContain('.claude/scripts/wt-ssh-sign-retry.mjs')
    expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
    expect(adopt(f, args).stdout).toContain('PRESENT (left alone)')
    expect(git(f, ['config', '--local', '--get', 'gpg.ssh.program']).stdout).toBe(configured)
  })

  it.each(['global', 'local'])('a pre-existing %s value blocks writes in the other scope', (scope) => {
    const f = fixture()
    expect(git(f, ['init', '--quiet']).status).toBe(0)
    expect(git(f, ['config', `--${scope}`, 'gpg.ssh.program', 'existing']).status).toBe(0)
    const args = ['--set', 'ssh-sign-retry', '--install', ...(scope === 'local' ? ['--global'] : [])]
    const result = adopt(f, args)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('PRESENT (left alone): "existing"')
    expect(git(f, ['config', scope === 'local' ? '--global' : '--local', '--get', 'gpg.ssh.program']).status).toBe(1)
  })

  it('all and ordinary script adoption never install or configure the optional wrapper', () => {
    const f = fixture()
    f.env.CLAUDE_PLUGIN_ROOT = join(ROOT, 'plugin')
    for (const set of ['all', 'scripts']) {
      const result = adopt(f, ['--set', set, '--install', '--global'])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(existsSync(f.target)).toBe(false)
      expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
    }
  })

  it('refresh-only never creates the wrapper or sets git config', () => {
    const f = fixture()
    const result = adopt(f, ['--set', 'ssh-sign-retry', '--install', '--global', '--refresh-only'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(existsSync(f.target)).toBe(false)
    expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
  })

  it('a locally edited wrapper is preserved and never newly configured', () => {
    const f = fixture()
    installed(f)
    expect(git(f, ['config', '--global', '--unset', 'gpg.ssh.program']).status).toBe(0)
    const edited = readFileSync(f.target, 'utf8') + '\n// local edit\n'
    writeFileSync(f.target, edited)
    const result = adopt(f)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(edited)
    expect(result.stdout).toContain('retry wrapper is not a current unedited managed file')
    expect(git(f, ['config', '--global', '--get', 'gpg.ssh.program']).status).toBe(1)
  })

  fakeIt.each(['hand-authored', 'symlink'])('leaves a %s wrapper and Git configuration untouched', (kind) => {
    const f = fixture()
    mkdirSync(join(f.target, '..'), { recursive: true })
    if (kind === 'symlink') symlinkSync(SOURCE, f.target)
    else writeFileSync(f.target, '// hand-authored signer\n')
    const before = readFileSync(f.target)
    const result = adopt(f)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('retry wrapper is not a current unedited managed file')
    expect(readFileSync(f.target)).toEqual(before)
    expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
  })

  it('reports an unreadable Git configuration without overwriting it', () => {
    const f = fixture()
    writeFileSync(f.env.GIT_CONFIG_GLOBAL!, '[invalid\n')
    const result = adopt(f)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('git config failed:')
    expect(readFileSync(f.env.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('[invalid\n')
  })
