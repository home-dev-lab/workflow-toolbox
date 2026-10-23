import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  return { root, bin, env, state, target: join(env.HOME!, '.workflow-toolbox/ssh-sign-retry/wt-ssh-sign-retry.mjs') }
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

function hideLookupMarker(f: Fixture) {
  const preload = join(f.root, 'hide-marker.cjs')
  // Mask only the lookup read, so inode tests cannot pass via marker rejection.
  writeFileSync(preload, `const fs = require('node:fs'), read = fs.readSync; fs.readSync = function(fd, buffer, offset, length, position) { if (buffer.length === 1024 && length === 1024 && position === 0) return 0; return read.call(this, fd, buffer, offset, length, position) }; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
}

  fakeIt.each([0, 1, 2, 3])('sign with %i initial failures: bounded retries and uncontaminated output', (failures) => {
    const f = fixture()
    const wrapper = installed(f)
    scenario(f, failures)
    const result = invoke(f, SIGN, wrapper)
    expect(result.error).toBeUndefined()
    expect(state(f).calls, 'a third signing attempt must never happen').toHaveLength(Math.min(failures + 1, 2))
    expect(result.status, result.stderr.toString()).toBe(failures >= 2 ? 23 : 0)
    expect(result.stdout).toEqual(failures >= 2 ? Buffer.alloc(0) : Buffer.from([83, 73, 71, 0, 255, 10]))
    expect(result.stderr.toString().match(/retrying because/g) ?? []).toHaveLength(Math.min(failures, 1))
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
    expect(result.stderr.toString()).toContain(`retrying because ${message} (attempt 2/2 in 1s)`)
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
    hideLookupMarker(f)
    const result = invoke(f, SIGN, f.target, `${selfDir}${delimiter}${f.bin}`)
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(state(f).calls).toHaveLength(1)
  })

  fakeIt('fails clearly without launching itself when PATH contains only itself', () => {
    const f = fixture()
    installed(f)
    symlinkSync(f.target, join(f.root, 'ssh-keygen'))
    chmodSync(f.target, 0o755)
    hideLookupMarker(f)
    const result = invoke(f, SIGN, f.target, f.root)
    expect(result.status).toBe(127)
    expect(result.stderr.toString()).toContain('not found on PATH (the retry wrapper itself is excluded)')
    expect(state(f).calls).toHaveLength(0)
  })

  fakeIt('executes the configured Git command with spaces and apostrophes in its path', () => {
    const f = fixture()
    f.env.HOME = join(f.root, "home with ' quote")
    f.env.USERPROFILE = f.env.HOME
    f.target = join(f.env.HOME, '.workflow-toolbox/ssh-sign-retry/wt-ssh-sign-retry.mjs')
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
    expect(configured).toContain('.workflow-toolbox/ssh-sign-retry/wt-ssh-sign-retry.mjs')
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

function fakeProgram(f: Fixture, body: string) {
  writeFileSync(join(f.bin, 'ssh-keygen'), `#!${process.execPath}\n${body}\n`)
}

function liveInvocation(f: Fixture, args: string[], options: { closeInput?: boolean; releaseOnStderr?: boolean } = {}) {
  return new Promise<{ status: number | null; timedOut: boolean; stdout: Buffer; stderr: Buffer; early: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE, ...args], { cwd: f.root, env: { ...f.env, PATH: f.bin } })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let timedOut = false, early = false
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5000)
    child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes))
    child.stderr.on('data', (bytes: Buffer) => {
      stderr.push(bytes)
      early ||= !existsSync(join(f.root, 'exited'))
      if (options.releaseOnStderr) writeFileSync(join(f.root, 'release'), '')
      if (bytes.includes('READY')) child.stdin.end(Buffer.from([0, 255, 13, 10, 120]))
    })
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', (status) => {
      clearTimeout(timeout)
      child.stdin.destroy()
      resolve({ status, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), early })
    })
    if (options.closeInput) child.stdin.end('payload')
  })
}

fakeIt.each([['-Y', 'sign'], ['-Y', 'verify']])('review: skips distinct wrapper copies for %j', (...args) => {
  const f = fixture()
  const dirs = ['copy-a', 'copy-b'].map((name) => join(f.root, name))
  for (const dir of dirs) {
    mkdirSync(dir)
    copyFileSync(installed(f), join(dir, 'ssh-keygen'))
    chmodSync(join(dir, 'ssh-keygen'), 0o755)
  }
  symlinkSync(process.execPath, join(f.bin, 'node'))
  const guard = join(f.root, 'depth.cjs')
  // Independent bound: even a resolver regression cannot create an uncontrolled loop.
  writeFileSync(guard, `const depth = Number(process.env.WT_TEST_WRAPPER_DEPTH || 0); if (depth >= 3) process.exit(89); process.env.WT_TEST_WRAPPER_DEPTH = String(depth + 1);`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(guard)}`
  const result = invoke(f, args, join(dirs[0]!, 'ssh-keygen'), [...dirs, f.bin].join(delimiter))
  expect(result.status, result.stderr.toString()).toBe(0)
  expect(state(f).calls).toHaveLength(1)
})

fakeIt.each([
  ['-Y', 'sign', '-Yverify'], ['-Ysign', '-Yverify'], ['--', '-Y', 'sign'],
  ['-f', '-Y', 'sign'], ['-n', '-Y', 'sign'], ['-Y', 'sign', '-l'],
])('review: passes ambiguous or non-signing option vector %j once', (...args) => {
  const f = fixture()
  scenario(f, 3)
  const result = invoke(f, args)
  expect(result.status).toBe(23)
  expect(state(f).calls).toHaveLength(1)
  expect(result.stdout).toEqual(Buffer.from('FAILED-OUTPUT'))
  expect(result.stderr).toEqual(Buffer.from('No private key found for public key\n'))
})

fakeIt('review: attached signing operation retries and replays input', () => {
  const f = fixture()
  scenario(f, 1)
  const result = invoke(f, ['-qYsign', '-n', 'git', '-fkey', '-'])
  expect(result.status).toBe(0)
  expect(state(f).calls).toHaveLength(2)
  expect(new Set(state(f).calls.map((call) => call.input)).size).toBe(1)
})

fakeIt('review: verify with a final attached operation exits without stdin EOF', async () => {
  const f = fixture()
  fakeProgram(f, `process.stdout.write('verify output'); process.stderr.write('No private key found\\n'); process.exit(23)`)
  const result = await liveInvocation(f, ['-Y', 'sign', '-Yverify'])
  expect(result.timedOut).toBe(false)
  expect(result.status).toBe(23)
  expect(result.stdout.toString()).toBe('verify output')
})

fakeIt('review: named-file permanent signing error exits without stdin EOF', async () => {
  const f = fixture()
  fakeProgram(f, `process.stderr.write('missing fake key\\n'); process.exit(23)`)
  const result = await liveInvocation(f, ['-Y', 'sign', '-f', 'missing fake key', '-n', 'git', 'named-file'])
  expect(result.timedOut).toBe(false)
  expect(result.status).toBe(23)
  expect(result.stderr.toString()).toBe('missing fake key\n')
})

fakeIt('review: child starts before stdin EOF and receives the subsequent binary input', async () => {
  const f = fixture()
  const program = readFileSync(join(f.bin, 'ssh-keygen'), 'utf8')
  writeFileSync(join(f.bin, 'ssh-keygen'), program.replace('\n', `\nprocess.stderr.write('READY\\n');\n`))
  const result = await liveInvocation(f, SIGN)
  expect(result.timedOut).toBe(false)
  expect(result.status).toBe(0)
  expect(state(f).calls[0]?.input).toBe(Buffer.from([0, 255, 13, 10, 120]).toString('base64'))
})

fakeIt('review: child stderr is visible before child closure', async () => {
  const f = fixture()
  fakeProgram(f, `const fs = require('node:fs'), path = require('node:path'); const root = process.env.WT_FAKE_ROOT;
process.stderr.write('bad key format\\n');
const timer = setInterval(() => { if (fs.existsSync(path.join(root, 'release'))) process.exit(23) }, 10);
setTimeout(() => { clearInterval(timer); fs.writeFileSync(path.join(root, 'exited'), ''); process.exit(23) }, 1500);`)
  const result = await liveInvocation(f, SIGN, { closeInput: true, releaseOnStderr: true })
  expect(result.early).toBe(true)
  expect(result.status).toBe(23)
  expect(result.stderr.toString()).toBe('bad key format\n')
})

function raceWriter(f: Fixture, when: 'after-check' | 'before-write') {
  const preload = join(f.root, 'race.cjs')
  writeFileSync(preload, `const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const raw = cp.spawnSync; let checks = 0, raced = false;
function race() {
  raced = true;
  const r = raw('git', ['config', '--global', 'gpg.ssh.program', 'concurrent signer'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(process.env.WT_FAKE_ROOT, 'race.json'), JSON.stringify({ status: r.status, stderr: r.stderr }));
}
cp.spawnSync = function(command, args, options) {
  const write = command === 'git' && args.includes('--add');
  if (${JSON.stringify(when)} === 'before-write' && write && !raced) race();
  const result = raw(command, args, options);
  if (command === 'git' && args.includes('--get-all') && ++checks === 2 && ${JSON.stringify(when)} === 'after-check' && !raced) race();
  return result;
}; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
}

it.each(['after-check', 'before-write'] as const)('review: concurrent signer %s is never overridden', (when) => {
  const f = fixture()
  raceWriter(f, when)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const race = JSON.parse(readFileSync(join(f.root, 'race.json'), 'utf8')) as { status: number; stderr: string }
  const values = git(f, ['config', '--global', '--get-all', 'gpg.ssh.program']).stdout.trimEnd().split('\n')
  expect(values).toHaveLength(1)
  if (race.status === 0) {
    expect(values).toEqual(['concurrent signer'])
    expect(result.stdout).toContain('PRESENT (left alone)')
  } else {
    expect(race.stderr).toContain('could not lock config file')
    expect(values[0]).toContain(f.target)
  }
  expect(existsSync(`${f.env.GIT_CONFIG_GLOBAL}.lock`)).toBe(false)
})

it('review: cleanup never removes a successor writer lock', () => {
  const f = fixture()
  const preload = join(f.root, 'successor-lock.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const remove = fs.rmSync;
fs.rmSync = function(file, options) {
  const result = remove(file, options);
  if (file === process.env.GIT_CONFIG_GLOBAL + '.lock') fs.writeFileSync(file, 'successor writer', { flag: 'wx' });
  return result;
}; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const lock = `${f.env.GIT_CONFIG_GLOBAL}.lock`
  expect(existsSync(lock)).toBe(true)
  expect(readFileSync(lock, 'utf8')).toBe('successor writer')
})

fakeIt('r3: removing the adopting linked worktree preserves the shared signer', () => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  expect(git(f, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']).status).toBe(0)
  const worktree = join(f.root, 'disposable')
  expect(git(f, ['worktree', 'add', '--quiet', '--detach', worktree]).status).toBe(0)
  const result = spawnSync(process.execPath, [INSTALLER, '--set', 'ssh-sign-retry', '--install'], { cwd: worktree, env: f.env, encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const command = git(f, ['config', '--local', '--get', 'gpg.ssh.program']).stdout.replace(/\n$/, '')
  expect(git(f, ['worktree', 'remove', '--force', worktree]).status).toBe(0)
  const signed = spawnSync('/bin/sh', ['-c', `${command} "$@"`, 'configured', ...SIGN], { cwd: f.root, env: { ...f.env, PATH: f.bin }, input: 'payload', encoding: 'utf8' })
  expect(signed.status, signed.stderr).toBe(0)
  expect(state(f).calls).toHaveLength(1)
  expect(command).toContain(join(f.env.HOME!, '.workflow-toolbox', 'ssh-sign-retry').replaceAll('\\', '/'))
})

it.each(['trailing space ', 'embedded\nnewline'])('r3: preserves global config filename %j', (name) => {
  const f = fixture()
  f.env.GIT_CONFIG_GLOBAL = join(f.root, name)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(git(f, ['config', '--global', '--get', 'gpg.ssh.program']).status).toBe(0)
  expect(existsSync(f.env.GIT_CONFIG_GLOBAL)).toBe(true)
  expect(existsSync(f.env.GIT_CONFIG_GLOBAL.trimEnd())).toBe(!name.endsWith(' '))
})

it('r3: preserves newlines in repository config paths', () => {
  const f = fixture()
  f.root = join(f.root, 'repository\nname ')
  mkdirSync(f.root)
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(git(f, ['config', '--local', '--get', 'gpg.ssh.program']).status).toBe(0)
})

function configRace(f: Fixture, file: string) {
  const preload = join(f.root, 'graph-race.cjs')
  writeFileSync(preload, `const cp = require('node:child_process'), fs = require('node:fs'); const raw = cp.spawnSync; let raced = false;
cp.spawnSync = function(command, args, options) {
  if (command === 'git' && args.includes('--add') && !raced) {
    raced = true;
    const r = raw('git', ['config', '--file', ${JSON.stringify(file)}, 'gpg.ssh.program', 'company signer'], { encoding: 'utf8' });
    fs.writeFileSync(${JSON.stringify(join(f.root, 'graph-race.json'))}, JSON.stringify({ status: r.status, stderr: r.stderr }));
  }
  return raw(command, args, options);
}; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
}

function assertEffectiveRaceResult(f: Fixture, kind: string, result: ReturnType<typeof adopt>) {
  expect(git(f, ['config', '--get', 'gpg.ssh.program']).stdout).toContain(kind === 'worktree' ? 'company signer' : f.target)
  expect(result.stdout).toContain(kind === 'worktree' ? 'REFUSED' : 'gpg.ssh.program WROTE')
  if (kind === 'worktree') expect(git(f, ['config', '--local', '--get', 'gpg.ssh.program']).status).toBe(1)
}

it.each(['include', 'relative include', 'home include', 'conditional include', 'nested include', 'missing include', 'system', 'worktree'])('r5: leaves concurrent %s files unlocked and checks the effective signer', (kind) => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  let file = join(f.root, 'included\nconfig ')
  if (kind === 'system') {
    f.env.GIT_CONFIG_NOSYSTEM = undefined
    f.env.GIT_CONFIG_SYSTEM = file
    writeFileSync(file, '')
  } else if (kind === 'worktree') {
    expect(git(f, ['config', '--local', 'extensions.worktreeConfig', 'true']).status).toBe(0)
    file = join(f.root, '.git', 'config.worktree')
  } else {
    if (kind === 'home include') {
      mkdirSync(f.env.HOME!, { recursive: true })
      file = join(f.env.HOME!, 'signing.inc')
    }
    const value = kind === 'relative include' ? '../included\nconfig ' : file
    const key = kind === 'conditional include' ? 'includeIf.gitdir:**/.git.path' : 'include.path'
    expect(git(f, ['config', '--local', key, kind === 'home include' ? '~/signing.inc' : value]).status).toBe(0)
    if (kind !== 'missing include') writeFileSync(file, '')
    if (kind === 'nested include') {
      const nested = join(f.root, 'nested config')
      expect(git(f, ['config', '--file', file, 'include.path', nested]).status).toBe(0)
      file = nested
      writeFileSync(file, '')
    }
  }
  configRace(f, file)
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const race = JSON.parse(readFileSync(join(f.root, 'graph-race.json'), 'utf8')) as { status: number; stderr: string }
  expect(race.status, 'only the config being written is locked').toBe(0)
  assertEffectiveRaceResult(f, kind, result)
  expect(existsSync(`${file}.lock`)).toBe(false)
})

fakeIt.each([['named-file'], ['a', 'b'], ['--', 'named-file'], ['-', '-'], ['--', '-', '-']])('r3: named-file signing %j executes once without repeating side effects', (...operands) => {
  const f = fixture()
  scenario(f, 3, 'agent refused')
  const args = ['-Y', 'sign', '-f', 'fake key', '-n', 'git', ...operands]
  const result = invoke(f, args)
  expect(state(f).calls).toHaveLength(1)
  expect(result.status).toBe(23)
  expect(result.stdout).toEqual(Buffer.from('FAILED-OUTPUT'))
  expect(result.stderr).toEqual(Buffer.from('agent refused\n'))
})

it('r5: changing the global write target during acquisition refuses publication', () => {
  const f = fixture()
  f.env.GIT_CONFIG_GLOBAL = undefined
  const xdg = join(f.env.XDG_CONFIG_HOME!, 'git/config')
  const home = join(f.env.HOME!, '.gitconfig')
  mkdirSync(join(xdg, '..'), { recursive: true })
  mkdirSync(f.env.HOME!, { recursive: true })
  writeFileSync(xdg, '')
  const preload = join(f.root, 'new-edge.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const open = fs.openSync; let changed = false;
fs.openSync = function(file, ...args) {
  if (!changed && String(file) === ${JSON.stringify(xdg + '.lock')}) {
    changed = true;
    fs.writeFileSync(${JSON.stringify(home)}, '');
  }
  return open.call(this, file, ...args);
}; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('Git configuration write target changed')
  expect(readFileSync(xdg, 'utf8')).toBe('')
  expect(readFileSync(home, 'utf8')).toBe('')
  expect(existsSync(xdg + '.lock')).toBe(false)
})

it('r3: legacy project copies are not implicitly selected for the shared signer', () => {
  const f = fixture()
  installed(f)
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  const legacy = join(f.root, '.claude/scripts/wt-ssh-sign-retry.mjs')
  mkdirSync(join(legacy, '..'), { recursive: true })
  copyFileSync(f.target, legacy)
  rmSync(f.target)
  expect(git(f, ['config', '--global', '--unset', 'gpg.ssh.program']).status).toBe(0)
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(existsSync(f.target)).toBe(true)
  expect(git(f, ['config', '--local', '--get', 'gpg.ssh.program']).stdout).toContain(f.target)
})

it.each(['home', 'xdg'])('r3: implicit %s global config preserves newline-containing paths', (location) => {
  const f = fixture()
  f.env.GIT_CONFIG_GLOBAL = undefined
  f.env.HOME = join(f.root, 'home\nname ')
  f.env.USERPROFILE = f.env.HOME
  f.env.XDG_CONFIG_HOME = join(f.root, 'xdg\nname ')
  const file = location === 'home' ? join(f.env.HOME, '.gitconfig') : join(f.env.XDG_CONFIG_HOME, 'git/config')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '')
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(git(f, ['config', '--global', '--get', 'gpg.ssh.program']).status).toBe(0)
  expect(readFileSync(file, 'utf8')).toContain('program =')
})

fakeIt.each(['empty', 'missing'])('r5: a symlink/.. %s include remains outside the write lock', (kind) => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  mkdirSync(join(f.root, 'cfg'))
  mkdirSync(join(f.root, 'srv/subdir'), { recursive: true })
  symlinkSync(join(f.root, 'srv/subdir'), join(f.root, 'cfg/link'))
  const file = join(f.root, 'srv/signer.inc')
  if (kind === 'empty') writeFileSync(file, '')
  // Do not use path.join: lexical normalization is precisely the bug being tested.
  const include = `${f.root}/cfg/link/../signer.inc`
  expect(git(f, ['config', '--local', 'include.path', include]).status).toBe(0)
  configRace(f, file)
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const race = JSON.parse(readFileSync(join(f.root, 'graph-race.json'), 'utf8')) as { status: number; stderr: string }
  expect(race.status, 'included files are not locked').toBe(0)
  expect(git(f, ['config', '--get-all', 'gpg.ssh.program']).stdout).toContain(f.target)
  expect(existsSync(join(f.root, 'cfg/signer.inc'))).toBe(false)
  expect(existsSync(`${file}.lock`)).toBe(false)
})

function divergentHomes(f: Fixture) {
  f.env.USERPROFILE = join(f.root, 'node-home')
  const preload = join(f.root, 'windows-node-home.cjs')
  // Simulate native Windows Node's home choice while the actual Git follows HOME.
  writeFileSync(preload, `require('node:os').homedir = () => process.env.USERPROFILE; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
}

it('r4: global target follows Git HOME when USERPROFILE and Node home differ', () => {
  const f = fixture()
  f.env.GIT_CONFIG_GLOBAL = undefined
  f.env.XDG_CONFIG_HOME = undefined
  divergentHomes(f)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(git(f, ['config', '--global', '--get', 'gpg.ssh.program']).status, 'Git must read the global setting reported WROTE').toBe(0)
  expect(readFileSync(join(f.env.HOME!, '.gitconfig'), 'utf8')).toContain('program =')
  expect(existsSync(join(f.env.USERPROFILE!, '.gitconfig'))).toBe(false)
})

it('r5: home-expanded includes remain unlocked when HOME and USERPROFILE differ', () => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  mkdirSync(f.env.HOME!, { recursive: true })
  const file = join(f.env.HOME!, 'signer.inc')
  writeFileSync(file, '')
  expect(git(f, ['config', '--local', 'include.path', '~/signer.inc']).status).toBe(0)
  divergentHomes(f)
  configRace(f, file)
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const race = JSON.parse(readFileSync(join(f.root, 'graph-race.json'), 'utf8')) as { status: number }
  expect(race.status, 'included files are not locked').toBe(0)
  expect(existsSync(join(f.env.USERPROFILE!, 'signer.inc'))).toBe(false)
})

it.each(['foreign-user', 'unreadable', 'missing directory'])('r4: ignores inactive includeIf targeting %s', (kind) => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  const file = kind === 'foreign-user' ? '~workflow-toolbox-no-such-user/config' : join(f.root, kind, 'config')
  if (kind === 'unreadable') {
    mkdirSync(join(f.root, kind))
    writeFileSync(file, '[invalid\n')
    chmodSync(file, 0)
  }
  expect(git(f, ['config', '--local', 'includeIf.gitdir:/never-this-repository/.path', file]).status).toBe(0)
  expect(git(f, ['config', '--list', '--includes']).status).toBe(0)
  const preload = join(f.root, 'inactive-guard.cjs')
  // Assert no attempted lock even when the test runs as an account that can read mode 000.
  writeFileSync(preload, `const fs = require('node:fs'), open = fs.openSync; fs.openSync = function(file, ...args) { if (String(file) === ${JSON.stringify(file + '.lock')}) throw Error('inactive include lock attempted'); return open.call(this, file, ...args) }; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('gpg.ssh.program WROTE --local')
  if (kind === 'missing directory') expect(existsSync(join(f.root, kind))).toBe(false)
})

it.each(['relative gitdir', 'hasconfig with equals', 'onbranch'])('r5: Git evaluates active %s includes without discovery locks', (kind) => {
  const f = fixture()
  expect(git(f, ['init', '--quiet', '--initial-branch=probe']).status).toBe(0)
  const file = join(f.root, 'conditional-empty.inc')
  writeFileSync(file, '')
  const conditions = {
    'relative gitdir': 'gitdir:./.git',
    'hasconfig with equals': 'hasconfig:remote.*.url:ssh://example.invalid/project?owner=team',
    onbranch: 'onbranch:probe',
  }
  expect(git(f, ['config', '--local', 'remote.origin.url', 'ssh://example.invalid/project?owner=team']).status).toBe(0)
  expect(git(f, ['config', kind === 'relative gitdir' ? '--global' : '--local', `includeIf.${conditions[kind as keyof typeof conditions]}.path`, file]).status).toBe(0)
  writeFileSync(file, '[test]\nincludeActive = true\n')
  expect(git(f, ['config', '--get', 'test.includeActive']).status, 'real Git must activate the fixture include').toBe(0)
  writeFileSync(file, '')
  configRace(f, file)
  const result = adopt(f, ['--set', 'ssh-sign-retry', '--install'])
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const race = JSON.parse(readFileSync(join(f.root, 'graph-race.json'), 'utf8')) as { status: number }
  expect(race.status, 'conditional included files are not locked').toBe(0)
})

function afterPublication(f: Fixture, body: string) {
  const preload = join(f.root, 'after-publication.cjs')
  writeFileSync(preload, `const fs = require('node:fs'), cp = require('node:child_process'), rename = fs.renameSync; let changed = false;
fs.renameSync = function(from, to) { const result = rename.call(this, from, to); if (!changed && to === process.env.GIT_CONFIG_GLOBAL) { changed = true; ${body} } return result }; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
}

function refusalFixture() {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  expect(git(f, ['config', '--global', 'user.signingkey', 'key::fixture']).status).toBe(0)
  const included = join(f.root, 'included')
  writeFileSync(included, '')
  expect(git(f, ['config', '--local', 'include.path', included]).status).toBe(0)
  return { f, included, config: f.env.GIT_CONFIG_GLOBAL! }
}

const INVALID_CONFIG_CASES = [
  ['user.signingkey', '[user]\nsigningkey = /synthetic/key-', 0xff],
  ['user.signingkey', '[user]\nsigningkey = /synthetic/key-', 0xfe],
  ['gpg.ssh.defaultKeyCommand', '[gpg "ssh"]\ndefaultKeyCommand = /synthetic/key-', 0xff],
  ['gpg.ssh.defaultKeyCommand', '[gpg "ssh"]\ndefaultKeyCommand = /synthetic/key-', 0xfe],
] as const

it.each(INVALID_CONFIG_CASES)('r6: refuses a non-UTF-8 %s after publication (%s, byte %i)', (key, header, byte) => {
  const { f, included, config } = refusalFixture()
  expect(git(f, ['config', '--global', key, '/synthetic/key-�.pub']).status).toBe(0)
  const before = readFileSync(config)
  const changed = Buffer.concat([Buffer.from(header), Buffer.from([byte]), Buffer.from('.pub\n')])
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(included)}, Buffer.from('${changed.toString('base64')}', 'base64'));`)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout, 'invalid Git bytes must refuse instead of comparing replacement characters').toContain('REFUSED')
  expect(result.stdout).toContain('non-UTF-8')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
})

it('r6: refuses a non-UTF-8 signer colliding with the intended command', () => {
  const { f, included, config } = refusalFixture()
  f.env.HOME = join(f.root, 'home-�')
  const before = readFileSync(config)
  afterPublication(f, `const bytes = fs.readFileSync(to), index = bytes.indexOf(Buffer.from('�')); if (index < 0) throw Error('missing replacement-character fixture'); fs.writeFileSync(${JSON.stringify(included)}, Buffer.concat([bytes.subarray(0, index), Buffer.from([255]), bytes.subarray(index + 3)]));`)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout, 'invalid Git bytes must refuse instead of comparing replacement characters').toContain('REFUSED')
  expect(result.stdout).toContain('non-UTF-8')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
})

it.each(['[user]\nsigningkey = ', '[gpg "ssh"]\nprogram = ', '[gpg "ssh"]\ndefaultKeyCommand = '])('r6: refuses initially invalid Git bytes in %j', (header) => {
  const f = fixture()
  const config = f.env.GIT_CONFIG_GLOBAL!
  const before = Buffer.concat([Buffer.from(header + '/synthetic/key-'), Buffer.from([255]), Buffer.from('.pub\n')])
  writeFileSync(config, before)
  const result = adopt(f)
  expect(result.stdout + result.stderr, 'invalid Git bytes must refuse instead of comparing replacement characters').toContain('REFUSED')
  expect(result.stdout + result.stderr).toContain('non-UTF-8')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
})

it('r6: a valid UTF-8 leading BOM is part of signing-key identity', () => {
  const { f, included, config } = refusalFixture()
  expect(git(f, ['config', '--global', 'user.signingkey', '\ufeffkey::fixture']).status).toBe(0)
  const before = readFileSync(config)
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(included)}, '[user]\\nsigningkey = key::fixture\\n');`)
  const result = adopt(f)
  expect(result.stdout).toContain('REFUSED')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
})

fakeIt.each([0o2640, 0o7640])('r6: rollback restores special mode %i despite a restrictive umask', (mode) => {
  const { f, included, config } = refusalFixture()
  chmodSync(config, mode)
  const before = readFileSync(config)
  afterPublication(f, `process.umask(0o077); fs.writeFileSync(${JSON.stringify(included)}, '[gpg "ssh"]\\nprogram = changed signer\\n');`)
  const result = adopt(f)
  expect(result.stdout).toContain('REFUSED')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
  expect(statSync(config).mode & 0o7777, 'rollback must preserve all mode bits').toBe(mode)
})

it('r6: rollback restores the original inode and owner', () => {
  const { f, included, config } = refusalFixture()
  const original = statSync(config)
  const before = readFileSync(config)
  const alias = join(f.root, 'original-config-link')
  linkSync(config, alias)
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(included)}, '[gpg "ssh"]\\nprogram = changed signer\\n');`)
  const result = adopt(f)
  expect(result.stdout).toContain('REFUSED')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
  expect(statSync(config).ino, 'rollback must restore the original inode').toBe(original.ino)
  expect(statSync(config).dev).toBe(original.dev)
  expect(statSync(config).uid).toBe(original.uid)
  expect(statSync(config).gid).toBe(original.gid)
  expect(statSync(config).ino).toBe(statSync(alias).ino)
})

function configAcl(f: Fixture, config: string, install = false) {
  let script = 'import os,struct,sys\np=sys.argv[1]\n'
  // A named self entry is valid even when a user namespace maps only this UID.
  if (install) script += 'entries=[(1,6,0xffffffff),(2,4,os.getuid()),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)]\nos.setxattr(p,"system.posix_acl_access",struct.pack("<I",2)+b"".join(struct.pack("<HHI",*e) for e in entries))\n'
  script += 'try: print(os.getxattr(p,"system.posix_acl_access").hex())\nexcept OSError: print("absent")\n'
  return spawnSync('python3', ['-c', script, config], { env: f.env, encoding: 'utf8' })
}

it('r6: rollback preserves a native POSIX ACL on the original file', ({ skip }) => {
  const { f, included, config } = refusalFixture()
  const acl = configAcl(f, config, true)
  if (acl.status !== 0) skip('native POSIX ACL fixture requires Python and filesystem ACL support')
  const before = readFileSync(config)
  const mode = statSync(config).mode
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(included)}, '[gpg "ssh"]\\nprogram = changed signer\\n');`)
  const result = adopt(f)
  expect(result.stdout).toContain('REFUSED')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
  expect(statSync(config).mode).toBe(mode)
  expect(configAcl(f, config).stdout, 'rollback must preserve the original POSIX ACL').toBe(acl.stdout)
})

it('r6: unavailable identity preservation refuses before publication', () => {
  const { f, config } = refusalFixture()
  const before = readFileSync(config)
  const original = statSync(config)
  const preload = join(f.root, 'no-hardlinks.cjs')
  writeFileSync(preload, `require('node:fs').linkSync = () => { throw Error('hardlinks unavailable on fixture filesystem') }; require('node:module').syncBuiltinESMExports();`)
  f.env.NODE_OPTIONS += ` --require ${JSON.stringify(preload)}`
  const result = adopt(f)
  expect(result.stdout + result.stderr).toContain('REFUSED: cannot preserve original config identity, owner and ACLs')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(config)).toEqual(before)
  expect(statSync(config).ino).toBe(original.ino)
  expect(statSync(config).mode).toBe(original.mode)
})

it('r6: failed rollback explicitly reports incomplete restoration and retains the original', () => {
  const { f, included, config } = refusalFixture()
  const before = readFileSync(config)
  const original = statSync(config)
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(included)}, '[gpg "ssh"]\\nprogram = changed signer\\n'); fs.renameSync = function(from, to) { if (String(from).endsWith('.original')) throw Error('fixture restore denied'); return rename.call(this, from, to) };`)
  const result = adopt(f)
  expect(result.stdout + result.stderr).toContain('rollback incomplete: cannot restore original config bytes, mode, owner and ACLs')
  expect(result.stdout).not.toContain('WROTE')
  expect(result.status).toBe(1)
  const backupDirectory = readdirSync(f.root).find(name => name.startsWith('gitconfig.adopt-'))!
  const backup = join(f.root, backupDirectory, 'config.original')
  expect(result.stdout + result.stderr).toContain(backup)
  expect(readFileSync(backup)).toEqual(before)
  expect(statSync(backup).ino).toBe(original.ino)
})

it.each([
  ['gpg.ssh.program', 'included signer'], ['user.signingkey', 'key::B'],
  ['user.signingkey', ''], ['user.signingkey', 'key::A\n'],
  ['gpg.ssh.defaultKeyCommand', 'different key command'],
])('r5: postcondition refuses changed %s=%j and restores exact file bytes and mode', (key, value) => {
  const f = fixture()
  installed(f)
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  expect(git(f, ['config', '--global', '--unset', 'gpg.ssh.program']).status).toBe(0)
  expect(git(f, ['config', '--global', 'user.signingkey', 'key::A']).status).toBe(0)
  const file = join(f.root, 'included')
  writeFileSync(file, '')
  expect(git(f, ['config', '--local', 'include.path', file]).status).toBe(0)
  chmodSync(f.env.GIT_CONFIG_GLOBAL!, 0o600)
  const before = readFileSync(f.env.GIT_CONFIG_GLOBAL!)
  const mode = statSync(f.env.GIT_CONFIG_GLOBAL!).mode
  const changed = join(f.root, 'changed-config')
  expect(git(f, ['config', '--file', changed, key, value]).status).toBe(0)
  // Direct replacement reaches the postcondition even on versions that lock includes.
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(file)}, fs.readFileSync(${JSON.stringify(changed)}));`)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout, 'a mismatched effective signing config must refuse').toContain('gpg.ssh.program REFUSED')
  expect(result.stdout).toContain(JSON.stringify(value))
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(f.env.GIT_CONFIG_GLOBAL!)).toEqual(before)
  expect(statSync(f.env.GIT_CONFIG_GLOBAL!).mode).toBe(mode)
  expect(existsSync(`${f.env.GIT_CONFIG_GLOBAL}.lock`)).toBe(false)
})

it('r5: failed postcondition restores an originally absent file to absence', () => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  const file = join(f.root, 'included')
  writeFileSync(file, '')
  expect(git(f, ['config', '--local', 'include.path', file]).status).toBe(0)
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(file)}, '[gpg "ssh"]\\nprogram = other signer\\n');`)
  const result = adopt(f)
  expect(existsSync(f.env.GIT_CONFIG_GLOBAL!), 'rollback must restore absence').toBe(false)
  expect(result.stdout).toContain('REFUSED')
  expect(result.stdout).not.toContain('WROTE')
  expect(result.stdout).toContain('PREPARED')
  expect(existsSync(f.target)).toBe(true)
})

it('r5: a Git postcondition error restores the original file', () => {
  const f = fixture()
  installed(f)
  expect(git(f, ['config', '--global', '--unset', 'gpg.ssh.program']).status).toBe(0)
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  const file = join(f.root, 'included')
  writeFileSync(file, '')
  expect(git(f, ['config', '--local', 'include.path', file]).status).toBe(0)
  const before = readFileSync(f.env.GIT_CONFIG_GLOBAL!)
  afterPublication(f, `fs.writeFileSync(${JSON.stringify(file)}, '[invalid\\n');`)
  const result = adopt(f)
  expect(result.stdout + result.stderr).toContain('REFUSED')
  expect(result.stdout).not.toContain('WROTE')
  expect(readFileSync(f.env.GIT_CONFIG_GLOBAL!)).toEqual(before)
})

it('r5: holds the target lock through publication and the postcondition', () => {
  const f = fixture()
  afterPublication(f, `const r = cp.spawnSync('git', ['config', '--global', 'user.signingkey', 'racer']); fs.writeFileSync(${JSON.stringify(join(f.root, 'held'))}, String(r.status));`)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(readFileSync(join(f.root, 'held'), 'utf8'), 'publication must not release the write lock early').not.toBe('0')
  expect(result.stdout).toContain('gpg.ssh.program WROTE')
})

it.each(['gpg.ssh.program', 'user.signingkey'])('r5: effective %s reads use commit context even with GIT_CONFIG', (key) => {
  const f = fixture()
  expect(git(f, ['init', '--quiet']).status).toBe(0)
  expect(git(f, ['config', '--local', key, 'commit value']).status).toBe(0)
  const hidden = join(f.root, 'explicit-config')
  writeFileSync(hidden, '')
  f.env.GIT_CONFIG = hidden
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain(key === 'gpg.ssh.program' ? 'PRESENT (left alone): "commit value"' : 'gpg.ssh.program WROTE')
  if (key === 'gpg.ssh.program') expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
  else {
    f.env.GIT_CONFIG = undefined
    expect(git(f, ['config', '--global', '--get', 'gpg.ssh.program']).stdout).toContain(f.target)
  }
  expect(readFileSync(hidden, 'utf8')).toBe('')
})

it.each(['', 'key::stable\n', 'key::stable'])('r5: preserves signing key identity %j on successful adoption', (key) => {
  const f = fixture()
  expect(git(f, ['config', '--global', 'user.signingkey', key]).status).toBe(0)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('gpg.ssh.program WROTE')
  expect(git(f, ['config', '--null', '--get', 'user.signingkey']).stdout).toBe(key + '\0')
})

fakeIt.each(['absolute', 'relative'])('r5: PATH follows symlinks before dotdot for an %s entry', (kind) => {
  const f = fixture()
  mkdirSync(join(f.root, 'opt/bin'), { recursive: true })
  mkdirSync(join(f.root, 'srv/team/subdir'), { recursive: true })
  mkdirSync(join(f.root, 'srv/team/bin'))
  symlinkSync(join(f.root, 'srv/team/subdir'), join(f.root, 'opt/link'))
  copyFileSync(join(f.bin, 'ssh-keygen'), join(f.root, 'srv/team/bin/ssh-keygen'))
  writeFileSync(join(f.root, 'opt/bin/ssh-keygen'), `#!${process.execPath}\nprocess.stdout.write('WRONG EXECUTABLE'); process.exit(79);\n`, { mode: 0o755 })
  const directory = `${kind === 'absolute' ? f.root + '/' : ''}opt/link/../bin`
  const result = invoke(f, SIGN, SOURCE, directory)
  expect(result.status, 'PATH must use kernel symlink/.. traversal').toBe(0)
  expect(state(f).calls).toHaveLength(1)
  expect(result.stdout).toEqual(Buffer.from([83, 73, 71, 0, 255, 10]))
})

it('r5: an existing target lock reports no installation and leaves its owner alone', () => {
  const f = fixture()
  writeFileSync(`${f.env.GIT_CONFIG_GLOBAL}.lock`, 'existing writer')
  const result = adopt(f)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('locked by another writer; rerun the same adopt command')
  expect(result.stdout).not.toContain('gpg.ssh.program WROTE')
  expect(readFileSync(`${f.env.GIT_CONFIG_GLOBAL}.lock`, 'utf8')).toBe('existing writer')
  expect(existsSync(f.env.GIT_CONFIG_GLOBAL!)).toBe(false)
})

fakeIt('r5: a dangling write-target symlink keeps its identity and writes its destination', () => {
  const f = fixture()
  const destination = join(f.root, 'actual-config')
  symlinkSync(destination, f.env.GIT_CONFIG_GLOBAL!)
  const result = adopt(f)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('gpg.ssh.program WROTE')
  expect(lstatSync(f.env.GIT_CONFIG_GLOBAL!).isSymbolicLink(), 'the write target alias must remain a symlink').toBe(true)
  expect(readFileSync(destination, 'utf8')).toContain('program =')
})
