import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { checkSignatures } from '../../../../plugin/bin/lib/commit-signature-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-check-commit-signatures.mjs')
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-check-commit-signatures-hook.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const PILOT_TEMPLATE = join(REPO_ROOT, 'plugin/agent-templates/pilot.md')
const PILOT_LAUNCH = join(REPO_ROOT, 'plugin/launch-agents/agents/pilot.md')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeTraceFile(tag: string) {
  const root = mkRoot(`${tag}-trace`)
  return join(root, 'git-trace.jsonl')
}

function mkRoot(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-commit-signatures-${tag}-`))
  roots.push(root)
  return root
}

function makeFakeGitEnv(tag: string, vars: Record<string, string | undefined> = {}) {
  const root = mkRoot(tag)
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  mkdirSync(bin, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const gitPath = join(bin, 'git')
  writeFileSync(
    gitPath,
    String.raw`#!/usr/bin/env node
const args = process.argv.slice(2)
const stripRepo = (argv) => argv[0] === '-C' ? argv.slice(2) : argv
const rest = stripRepo(args)
const out = (s) => process.stdout.write(String(s))
const err = (s) => process.stderr.write(String(s))
if (process.env.FAKE_GIT_NOT_REPO === '1' && rest[0] === 'rev-parse' && rest[1] === '--git-dir') {
  err('fatal: not a git repository')
  process.exit(128)
}
if (rest[0] === 'rev-parse' && rest[1] === '--git-dir') {
  out('.git\n')
  process.exit(0)
}
if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') {
  out((process.env.FAKE_GIT_HEAD || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') + '\n')
  process.exit(0)
}
if (rest[0] === 'rev-parse' && rest[1] === '--symbolic-full-name' && rest[2] === '@{push}') {
  if (process.env.FAKE_GIT_PUSH_REF === undefined) process.exit(128)
  out(process.env.FAKE_GIT_PUSH_REF + '\n')
  process.exit(0)
}
if (rest[0] === 'rev-parse' && rest[1] === '--symbolic-full-name' && rest[2] === '@{upstream}') {
  if (process.env.FAKE_GIT_UPSTREAM_REF === undefined) process.exit(128)
  out(process.env.FAKE_GIT_UPSTREAM_REF + '\n')
  process.exit(0)
}
if (rest[0] === 'remote' && rest.length === 1) {
  out((process.env.FAKE_GIT_REMOTES || '') + '\n')
  process.exit(0)
}
if (rest[0] === 'symbolic-ref' && rest[1] === '--quiet' && rest[2] === '--short' && rest[3] === 'HEAD') {
  if (process.env.FAKE_GIT_BRANCH === undefined) process.exit(128)
  out(process.env.FAKE_GIT_BRANCH + '\n')
  process.exit(0)
}
if (rest[0] === 'config' && rest[1] === '--get' && rest[2] === '--bool' && rest[3] === 'commit.gpgsign') {
  if (process.env.FAKE_GIT_COMMIT_GPGSIGN === undefined) process.exit(1)
  out(process.env.FAKE_GIT_COMMIT_GPGSIGN + '\n')
  process.exit(0)
}
if (rest[0] === 'config' && rest[1] === '--get' && rest[2] === 'user.signingkey') {
  if (process.env.FAKE_GIT_SIGNINGKEY === undefined) process.exit(1)
  out(process.env.FAKE_GIT_SIGNINGKEY + '\n')
  process.exit(0)
}
if (rest[0] === 'log') {
  if (process.env.FAKE_GIT_TRACE) require('node:fs').appendFileSync(process.env.FAKE_GIT_TRACE, JSON.stringify(rest) + '\n')
  if (process.env.FAKE_GIT_BAD_RANGE === '1') {
    err('fatal: bad revision range')
    process.exit(128)
  }
  out(process.env.FAKE_GIT_LOG || '')
  process.exit(0)
}
err('unexpected fake git args: ' + JSON.stringify(rest))
process.exit(99)
`,
    { mode: 0o755 },
  )
  return {
    repo,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ''}`,
      ...vars,
    },
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env })
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
}

describe('commit-signature-core', () => {
  it('signing not configured + an unsigned commit in range → signingExpected:false and no offenders reported', () => {
    const report = checkSignatures({
      configLines: [],
      logLines: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tN\tunsigned commit'],
    })
    expect(report.signingExpected).toBe(false)
    expect(report.offenders).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('signing configured + all G → silent outcome at the core', () => {
    const report = checkSignatures({
      configLines: ['commit.gpgsign=true'],
      logLines: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tG\tgood commit'],
    })
    expect(report.signingExpected).toBe(true)
    expect(report.offenders).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('signing configured + one N among several G → exactly that one offender', () => {
    const report = checkSignatures({
      configLines: ['commit.gpgsign=true'],
      logLines: [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tG\tgood 1',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tN\tunsigned',
        'cccccccccccccccccccccccccccccccccccccccc\tG\tgood 2',
      ],
    })
    expect(report.offenders).toEqual([
      { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'N', subject: 'unsigned', meaning: 'no signature' },
    ])
  })

  it('B, E, and R are each preserved with their own letter and meaning', () => {
    const report = checkSignatures({
      configLines: ['commit.gpgsign=true'],
      logLines: [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tB\tbad',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tE\terror',
        'cccccccccccccccccccccccccccccccccccccccc\tR\trevoked',
      ],
    })
    expect(report.offenders).toEqual([
      { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'B', subject: 'bad', meaning: 'bad signature' },
      { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'E', subject: 'error', meaning: 'signature check error' },
      { sha: 'cccccccccccccccccccccccccccccccccccccccc', status: 'R', subject: 'revoked', meaning: 'revoked signing key' },
    ])
  })

  it('user.signingkey set but commit.gpgsign absent → still signingExpected:true', () => {
    const report = checkSignatures({
      configLines: ['user.signingkey=ssh-ed25519 AAAA'],
      logLines: [],
    })
    expect(report.signingExpected).toBe(true)
  })

  it('malformed or empty git output does not throw', () => {
    expect(() =>
      checkSignatures({
        configLines: ['commit.gpgsign=true'],
        logLines: ['', 'not-tab-delimited'],
      }),
    ).not.toThrow()
    const report = checkSignatures({
      configLines: ['commit.gpgsign=true'],
      logLines: ['', 'not-tab-delimited'],
    })
    expect(report.offenders).toEqual([])
    expect(report.reasons).toHaveLength(1)
  })
})

describe('wt-check-commit-signatures.mjs', () => {
  it('signing not configured + unsigned HEAD → exit 0 and empty output', () => {
    const { repo, env } = makeFakeGitEnv('cli-silent-unsigned', {
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tN\tunsigned head\n',
    })
    const res = runCli(['--repo', repo], env)
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
  })

  it('signing configured + all G → silent, exit 0', () => {
    const { repo, env } = makeFakeGitEnv('cli-silent-good', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tG\tgood head\n',
    })
    const res = runCli(['--repo', repo], env)
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('signing configured + one N among several G → exit 1 and exactly that finding, with one cause hint', () => {
    const { repo, env } = makeFakeGitEnv('cli-one-n', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_LOG:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tG\tgood 1\n' +
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tN\tunsigned\n' +
        'cccccccccccccccccccccccccccccccccccccccc\tG\tgood 2\n',
      FAKE_GIT_HEAD: 'dddddddddddddddddddddddddddddddddddddddd',
    })
    const res = runCli(['--repo', repo, '--range', 'public/main..main'], env)
    expect(res.status).toBe(1)
    const lines = res.stdout.trim().split('\n')
    expect(lines.filter((line) => line.includes('Common cause:'))).toHaveLength(1)
    expect(res.stdout).toContain('bbbbbbb: N (no signature) — unsigned')
    expect(res.stdout).toContain('rebase the commits in public/main..main')
    expect(res.stdout).toContain('git rebase --exec')
  })

  it('B, E, and R surface with their letters instead of generic unsigned text', () => {
    const { repo, env } = makeFakeGitEnv('cli-letters', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_LOG:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tB\tbad\n' +
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tE\terror\n' +
        'cccccccccccccccccccccccccccccccccccccccc\tR\trevoked\n',
      FAKE_GIT_HEAD: 'dddddddddddddddddddddddddddddddddddddddd',
    })
    const res = runCli(['--repo', repo, '--range', 'public/main..main'], env)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('aaaaaaa: B (bad signature)')
    expect(res.stdout).toContain('bbbbbbb: E (signature check error)')
    expect(res.stdout).toContain('ccccccc: R (revoked signing key)')
  })

  it('user.signingkey set but commit.gpgsign absent still enforces the check', () => {
    const { repo, env } = makeFakeGitEnv('cli-signingkey', {
      FAKE_GIT_SIGNINGKEY: 'ssh-ed25519 AAAA',
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tN\tunsigned head\n',
      FAKE_GIT_HEAD: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    const res = runCli(['--repo', repo], env)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('Fix: git commit --amend --no-edit -S')
  })

  it('bad range or not a git repo exits 2', () => {
    const badRange = makeFakeGitEnv('cli-bad-range', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_BAD_RANGE: '1',
    })
    const badRangeRes = runCli(['--repo', badRange.repo, '--range', 'bad..range'], badRange.env)
    expect(badRangeRes.status).toBe(2)

    const notRepo = makeFakeGitEnv('cli-not-repo', {
      FAKE_GIT_NOT_REPO: '1',
    })
    const notRepoRes = runCli(['--repo', notRepo.repo], notRepo.env)
    expect(notRepoRes.status).toBe(2)
  })
})

describe('wt-check-commit-signatures-hook.mjs', () => {
  it('does not run on a non-commit Bash command', () => {
    const { env } = makeFakeGitEnv('hook-non-commit')
    const res = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      },
      env,
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('stays silent when HEAD is signed or signing is not expected', () => {
    const signed = makeFakeGitEnv('hook-signed', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tG\tsigned head\n',
    })
    const signedRes = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        cwd: signed.repo,
        tool_input: { command: 'git commit -m "x"' },
      },
      signed.env,
    )
    expect(signedRes.stdout).toBe('')

    const notExpected = makeFakeGitEnv('hook-not-expected', {
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tN\tunsigned head\n',
    })
    const notExpectedRes = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        cwd: notExpected.repo,
        tool_input: { command: 'git commit -m "x"' },
      },
      notExpected.env,
    )
    expect(notExpectedRes.stdout).toBe('')
  })

  it('emits hook output when a commit command leaves HEAD unsigned in a signing-required repo', () => {
    const { repo, env } = makeFakeGitEnv('hook-unsigned', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tN\tunsigned head\n',
      FAKE_GIT_HEAD: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    const res = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git commit -m "x"' },
      },
      env,
    )
    expect(res.status).toBe(0)
    const payload = JSON.parse(res.stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(payload.hookSpecificOutput.additionalContext).toContain('COMMIT SIGNATURE PROBLEM')
    expect(payload.hookSpecificOutput.additionalContext).toContain('Fix: git commit --amend --no-edit -S')
  })

  it('never blocks and degrades to silence on git/CLI failure', () => {
    const { repo, env } = makeFakeGitEnv('hook-fail-open', {
      FAKE_GIT_NOT_REPO: '1',
    })
    const res = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git commit -m "x"' },
      },
      env,
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('excludes only the TARGET remote refs, never every remote-tracking ref', () => {
    // ⚠ A bare `--not --remotes` excludes whatever ANY tracking ref reaches. Measured on this
    // repository 2026-08-20: 43 such refs, of which 31 are leftovers from a deleted remote and
    // 11 belong to a never-pushed archive — only ONE is a push target. On a range that would
    // genuinely add 62 commits to the public remote, the bare form reported ZERO. A guard that
    // goes silent on exactly the commits it exists to inspect is worse than no guard.
    const trace = makeTraceFile('range-target-remote')
    const { repo, env } = makeFakeGitEnv('range-target-remote', {
      FAKE_GIT_BRANCH: 'main',
      FAKE_GIT_PUSH_REF: 'refs/remotes/public/main',
      FAKE_GIT_REMOTES: 'public\nmirror',
      FAKE_GIT_TRACE: trace,
    })
    const res = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git push public main' },
      },
      env,
    )
    expect(res.status).toBe(0)
    const traced = readFileSync(trace, 'utf8')
    expect(traced).toContain('--remotes=public')
    // and never the unscoped form, which is what hid the 62
    expect(traced).not.toMatch(/"--remotes"(?!=)/)
  })

  it('derives the outgoing range from the branch upstream for git push with no explicit remote', () => {
    const trace = makeTraceFile('hook-range-upstream')
    const { repo, env } = makeFakeGitEnv('hook-range-upstream', {
      FAKE_GIT_BRANCH: 'main',
      FAKE_GIT_PUSH_REF: 'refs/remotes/origin/main',
      FAKE_GIT_TRACE: trace,
    })
    const res = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git push' },
      },
      env,
    )
    expect(res.status).toBe(0)
    expect(readFileSync(trace, 'utf8')).toContain('refs/remotes/origin/main..HEAD')
  })

  it('derives the outgoing range from the push command when the refspec names HEAD explicitly', () => {
    const trace = makeTraceFile('hook-range-explicit')
    const { repo, env } = makeFakeGitEnv('hook-range-explicit', {
      FAKE_GIT_BRANCH: 'release',
      FAKE_GIT_PUSH_REF: 'refs/remotes/origin/release',
      FAKE_GIT_TRACE: trace,
    })
    const res = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git push origin HEAD' },
      },
      env,
    )
    expect(res.status).toBe(0)
    expect(readFileSync(trace, 'utf8')).toContain('refs/remotes/origin/release..HEAD')
  })

  it('blocks a push before it starts when the derived outgoing range contains an unsigned commit', () => {
    const trace = makeTraceFile('hook-push-blocks')
    const { repo, env } = makeFakeGitEnv('hook-push-blocks', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_BRANCH: 'main',
      FAKE_GIT_PUSH_REF: 'refs/remotes/origin/main',
      FAKE_GIT_LOG: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tN\tunsigned outgoing\n',
      FAKE_GIT_HEAD: 'dddddddddddddddddddddddddddddddddddddddd',
      FAKE_GIT_TRACE: trace,
    })
    const res = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git push' },
      },
      env,
    )
    expect(res.status).toBe(0)
    const payload = JSON.parse(res.stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('bbbbbbb: N (no signature)')
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('before the network round-trip')
    expect(readFileSync(trace, 'utf8')).toContain('refs/remotes/origin/main..HEAD')
  })

  it('stays silent on a fully signed outgoing range and lets the push proceed', () => {
    const { repo, env } = makeFakeGitEnv('hook-push-signed', {
      FAKE_GIT_COMMIT_GPGSIGN: 'true',
      FAKE_GIT_BRANCH: 'main',
      FAKE_GIT_PUSH_REF: 'refs/remotes/origin/main',
      FAKE_GIT_LOG: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tG\tsigned outgoing\n',
    })
    const res = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: 'git push' },
      },
      env,
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })
})

describe('commit-signature wiring and pilot definition-of-done', () => {
  it('registers the PreToolUse/Bash hook in plugin.json', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    const group = (manifest.hooks?.PreToolUse ?? []).find((entry) =>
      (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes('wt-check-commit-signatures-hook.mjs')),
    )
    expect(group).toBeTruthy()
    expect(group?.matcher).toBe('Bash')
  })

  it('registers the PostToolUse/Bash hook in plugin.json', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    const group = (manifest.hooks?.PostToolUse ?? []).find((entry) =>
      (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes('wt-check-commit-signatures-hook.mjs')),
    )
    expect(group).toBeTruthy()
    expect(group?.matcher).toBe('Bash')
  })

  it('adds the one-line signature verification instruction to both pilot definitions, byte-identically', () => {
    const template = readFileSync(PILOT_TEMPLATE, 'utf8')
    const launch = readFileSync(PILOT_LAUNCH, 'utf8')
    const needle = "After `git commit`, verify the new commit's signature with `git log -1 --format='%h %G? %s'` before calling the step done."
    expect(template).toContain(needle)
    expect(launch).toContain(needle)
    expect(template).toBe(launch)
  })
})
