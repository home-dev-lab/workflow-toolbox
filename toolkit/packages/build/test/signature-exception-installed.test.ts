import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error plain ESM fixture
import { attestation, exceptionFixture } from './helpers/atrium-attestation-fixture.mjs'

const root = resolve(process.env.WT_SIGNATURE_TEST_ROOT ?? fileURLToPath(new URL('../../../..', import.meta.url)))
const installer = join(root, 'plugin/bin/wt-push-guard-install.mjs')
const hook = join(root, 'plugin/bin/wt-check-commit-signatures-hook.mjs')
const cli = join(root, 'plugin/bin/wt-signature-exception.mjs')
const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })

function repositoryFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-signature-install-'))
  made.push(dir)
  const f = exceptionFixture(dir)
  const local = join(dir, 'local'), bare = join(dir, 'remote.git')
  const env = sealedPluginCliEnv(dir, { GIT_CONFIG_GLOBAL: join(dir, 'global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' })
  writeFileSync(env.GIT_CONFIG_GLOBAL!, '')
  const call = (cmd: string, args: string[], input?: string) => {
    const r = spawnSync(cmd, args, { cwd: local, env, input, encoding: 'utf8', timeout: 15_000 })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout }
  }
  mkdirSync(local)
  function git(...args: string[]) {
    const r = call('git', args)
    if (r.status !== 0) throw Error(r.out)
    return r.stdout.trim()
  }
  git('init', '-q', '--bare', '-b', 'main', bare)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  git('remote', 'add', 'public', bare)
  const commit = (name: string) => {
    writeFileSync(join(local, name), name); git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', name)
    return git('rev-parse', 'HEAD')
  }
  const A = commit('A')
  git('push', '-q', 'public', 'main')
  const B = commit('B')
  git('config', 'commit.gpgsign', 'true')
  return { ...f, dir, local, bare, env, A, B, call, git, commit }
}

function fixture(install = true) {
  const f = repositoryFixture()
  const { local, bare, B, call } = f
  const installGuard = () => call(process.execPath, [installer, '--install', '--repo', local, '--guard-remote', 'public', '--owner-keys', f.config.ownerKeysFile, '--exception-state', f.config.exceptionStateDir])
  if (install) { const r = installGuard(); if (r.status !== 0) throw Error(r.out) }
  const statement = (ref = 'refs/heads/main', sha = B) => `workflow-toolbox signature exception v1: allow updating ${bare} ${ref} to ${sha} once, although it carries commits without an acceptable signature`
  const relay = (ref?: string, sha?: string) => { const answer = attestation(statement(ref, sha), f.owner); f.relay(answer); return answer }
  const authorize = () => writeFileSync(join(local, '.git/wt-push-authorized.json'), JSON.stringify({ maxCount: 100 }))
  const push = (ref = 'HEAD:refs/heads/main') => call('git', ['push', 'public', ref])
  const pre = (command = 'git push public main') => {
    const r = call(process.execPath, [hook], JSON.stringify({ session_id: 'test-session', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: local, tool_input: { command } }))
    return { ...r, payload: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : undefined }
  }
  return { ...f, installGuard, statement, relay, relayAttestation: f.relay, authorize, push, pre }
}

function replacePinned(f: ReturnType<typeof fixture>, name: string, text: string) {
  const dir = join(f.local, '.git/hooks/wt-push-guard')
  writeFileSync(join(dir, name), text)
  const manifestFile = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.files[name] = createHash('sha256').update(text).digest('hex')
  writeFileSync(manifestFile, JSON.stringify(manifest))
}

describe('owner exceptions through installed guard and disposable hook session', () => {
  it('states no exception exists without an active install and includes a measured policy sentence', () => {
    const f = fixture(false)
    const r = f.pre()
    expect(r.payload.permissionDecision).toBe('deny')
    expect(r.payload.permissionDecisionReason).toContain('no exception exists')
    expect(r.payload.permissionDecisionReason).toContain('Remote signature requirement')
    expect(r.payload.permissionDecisionReason).not.toContain('expected to reject')
  })
  it('keeps ordinary non-push commands silent even when they mention git as an argument', () => {
    const f = fixture()
    expect(f.pre('echo git push public main').payload).toBeUndefined()
  })
  it('defaults closed, previews without a claim, then pushes once using install paths despite HOME changes', () => {
    const f = fixture()
    f.authorize()
    expect(f.push().out).toContain('no-answer')
    const answer = f.relay()
    const preview = f.pre()
    expect(preview.payload?.permissionDecision, preview.out).not.toBe('deny')
    expect(preview.out).toContain('pre-push guard will spend')
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
    f.env.HOME = join(f.dir, 'different-home')
    const pushed = f.push()
    expect(pushed.status, pushed.out).toBe(0)
    expect(f.git('--git-dir', f.bare, 'rev-parse', 'main')).toBe(f.B)
    expect(existsSync(join(f.config.exceptionStateDir, 'claims', `${answer.request_id}.json`))).toBe(true)
    expect(readFileSync(join(f.config.exceptionStateDir, 'exceptions.jsonl'), 'utf8')).toContain('opened')
  })
})

describe('installed owner exception consumption', () => {
  it.skipIf(process.platform === 'win32')('spends a grant even when the remote rejects, then refuses reuse', () => {
    const f = fixture()
    const reject = join(f.bare, 'hooks/pre-receive')
    writeFileSync(reject, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    f.relay(); f.authorize()
    const first = f.push()
    expect(first.out).toContain('signature exception opened')
    expect(first.status).not.toBe(0)
    expect(f.git('--git-dir', f.bare, 'rev-parse', 'main')).toBe(f.A)
    f.authorize()
    const second = f.push()
    expect(second.status, second.out).not.toBe(0)
    expect(second.out).toContain('already-used')
    rmSync(reject)
    f.relay(); f.authorize()
    expect(f.push().status).toBe(0)
  })
})

describe('installed owner exception invocation integrity', () => {
  it.each([
    'git push --no-verify public main', 'git push --no-ver public main', 'git -c core.hooksPath=/missing push public main',
    'git --config-env=core.hooksPath=OVERRIDE push public main', 'HOME=/elsewhere git push public main',
    'env git push public main', 'sudo git push public main', 'command git push public main',
    'exec git push public main', 'nice git push public main',
    'git config core.hooksPath /missing; git push public main', 'export GIT_CONFIG_COUNT=1; git push public main',
    'git config core.hooksPath /missing && git push public main',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/missing git push public main',
    "git push public main $'--no-verify'", 'git push public main {--no-verify,}', 'git push public main --no-verif?',
    'git push public main "$(printf -- --no-verify)"', 'git push public main `printf -- --no-verify`',
    'git push public main ${NV:---no-verify}', 'git push public main \\--no-verify',
  ])('never delegates a bypassing or prefixed invocation: %s', (command) => {
    const f = fixture(); f.relay()
    expect(f.pre(command).payload?.permissionDecision).toBe('deny')
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
  })
  it('denies inactive hooks and every preview failure without reaching the fail-open catch', () => {
    const f = fixture(); f.relay()
    f.git('config', 'core.hooksPath', join(f.dir, 'other-hooks'))
    expect(f.pre().payload?.permissionDecision).toBe('deny')
    f.git('config', '--unset', 'core.hooksPath')
    rmSync(f.config.ownerKeysFile)
    expect(f.pre().payload?.permissionDecision).toBe('deny')
    expect(f.pre().out).toContain('no-pinned-owner-key')
  })
})

describe('installed owner exception advertised refs', () => {
  it.each(['new', 'deleted'])('checks unsigned commits on a %s remote ref against advertised objects', (kind) => {
    const f = fixture()
    if (kind === 'deleted') {
      f.git('-c', 'core.hooksPath=', 'push', 'public', `${f.A}:refs/heads/target`)
      f.git('--git-dir', f.bare, 'update-ref', '-d', 'refs/heads/target')
      expect(f.git('rev-parse', 'refs/remotes/public/target')).toBe(f.A)
    }
    f.authorize()
    const result = f.push('HEAD:refs/heads/target')
    expect(result.status, result.out).not.toBe(0)
    expect(result.out).toContain('signature check refused')
    f.relay('refs/heads/target'); f.authorize()
    expect(f.push('HEAD:refs/heads/target').status).toBe(0)
  })
})

describe('installed owner exception pinning and configuration', () => {
  it('pins via the CLI and refuses --add', () => {
    const f = fixture()
    for (const flag of ['--help', '-h']) {
      const help = f.call(process.execPath, [cli, flag])
      expect(help.status, help.out).toBe(0)
      expect(help.out).toContain('wt-signature-exception')
    }
    rmSync(f.config.ownerKeysFile)
    const answer = attestation('workflow-toolbox: pin the signing key of this answer as the owner key for signature exceptions', f.owner)
    const file = f.relayAttestation(answer, 'pin.json')
    const args = [cli, 'pin', '--repo', f.local, '--attestation', file]
    const pinned = f.call(process.execPath, args)
    expect(pinned.status, pinned.out).toBe(0)
    expect(f.call(process.execPath, [...args, '--add']).status).not.toBe(0)
    expect(readdirSync(join(f.config.exceptionStateDir, 'inbox'))).toHaveLength(1)
    const status = f.call(process.execPath, [cli, 'status', '--repo', f.local])
    expect(status.status, status.out).toBe(0)
    expect(JSON.parse(status.stdout).recent.join('\n')).toContain('pinned')
  })
  it('names older config explicitly instead of choosing push-time defaults', () => {
    const f = fixture(); f.relay(); f.authorize()
    replacePinned(f, 'config.json', JSON.stringify({ guardRemotes: ['public'], guardPaths: [] }))
    const refused = f.push()
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('install-predates-exceptions')
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
  })
})

describe('installed owner exception checker integrity', () => {
  it.each([
    "process.exit(2)",
    "console.log('not JSON'); process.exit(0)",
    "console.log('not JSON'); process.exit(1)",
    "console.log(JSON.stringify({offenders:[],text:'empty'})); process.exit(1)",
    "console.log(JSON.stringify({offenders:[{sha:'a'.repeat(40),status:'G',subject:'bad'}],text:'bad'})); process.exit(1)",
  ])('refuses a failing or malformed installed checker without attempting an exception: %s', (source) => {
    const f = fixture(); f.relay(); f.authorize()
    replacePinned(f, 'bin/wt-check-commit-signatures.mjs', source)
    const refused = f.push()
    expect(refused.status, refused.out).not.toBe(0)
    expect(refused.out).toContain('no exception attempted')
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
  })
})

describe('installed owner exception target and dependency integrity', () => {
  it('refuses a valid answer for another destination, ref or sha through a real install', () => {
    const f = fixture(); f.authorize()
    f.relay('refs/heads/elsewhere')
    expect(f.push().out).toContain('digest-mismatch')
    f.relay('refs/heads/main', f.A)
    expect(f.push().out).toContain('digest-mismatch')
    f.relay()
    f.git('remote', 'add', 'elsewhere', join(f.dir, 'other.git'))
    f.git('init', '-q', '--bare', join(f.dir, 'other.git'))
    const other = f.call(process.execPath, [cli, 'preview', '--repo', f.local, '--remote', 'elsewhere', '--ref', 'refs/heads/main', '--new', f.B])
    expect(other.status).not.toBe(0)
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
  })
  it('hash-pins the new verifier dependencies and detects tampering', () => {
    const f = fixture()
    const dir = join(f.local, '.git/hooks/wt-push-guard')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.files['bin/lib/signature-exception.mjs']).toBeTruthy()
    const lib = join(dir, 'bin/lib/signature-exception.mjs')
    writeFileSync(lib, readFileSync(lib, 'utf8') + '\n// edited\n')
    f.relay(); f.authorize()
    expect(f.push().out).toContain('missing or changed')
    expect(f.pre().payload?.permissionDecision).toBe('deny')
    if (process.platform !== 'win32') chmodSync(join(f.local, '.git/hooks/pre-push'), 0o755)
  })
})
