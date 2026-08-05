// signatures-workflow-step.test.ts — behaviour lock for the shell script embedded in
// .github/workflows/signatures.yml's "Verify every commit in the range is signed" step.
//
// This job was shipped once (de2766b), reverted 4 minutes later after its own first real
// CI run (dc92993), for two reasons that never showed up in local testing: GitHub invokes
// `run:` blocks as `bash -e {0}`, which silently ate the checker's exit code; and SSH
// signatures cannot be verified at all without `gpg.ssh.allowedSignersFile` wired, so every
// commit — signed or not — read as unverifiable. A follow-up review then found a third gap:
// a new-branch push (no event-supplied base) checked only the tip, letting a signed tip
// smuggle in unsigned ancestors underneath it.
//
// The script itself lives inside YAML, where nothing executes it under test by default —
// so this file extracts the literal step script from the real YAML (never a hand-copied
// duplicate, which would drift silently) and replays it under `bash -e`, GitHub's own
// invocation shape, against scratch git repos built to exercise each of the three defects.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WORKFLOW = join(REPO_ROOT, '.github/workflows/signatures.yml')
const PLUGIN_BIN = join(REPO_ROOT, 'plugin/bin')

// Extract the literal `run: |` block of the "Verify every commit..." step. Matches the
// YAML's own 10-space indentation under that step; dedents it into a standalone script.
function extractStepScript(): string {
  const yaml = readFileSync(WORKFLOW, 'utf8')
  const marker = 'name: Verify every commit in the range is signed'
  const idx = yaml.indexOf(marker)
  if (idx === -1) throw new Error('step not found in signatures.yml — did the step name change?')
  const runIdx = yaml.indexOf('run: |\n', idx)
  if (runIdx === -1) throw new Error('run: | block not found for the signature-verification step')
  const bodyStart = runIdx + 'run: |\n'.length
  const lines: string[] = []
  for (const line of yaml.slice(bodyStart).split('\n')) {
    if (line.length > 0 && !line.startsWith('          ')) break
    lines.push(line.startsWith('          ') ? line.slice(10) : line)
  }
  const script = lines.join('\n')
  if (!script.includes('CHECKER=')) throw new Error('extracted script looks wrong — sanity check failed')
  return script
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-sig-workflow-${tag}-`))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', ...env },
  })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  }
  return res.stdout.trim()
}

// The tests need REAL SSH signatures verifiable via allowed_signers — reuse this
// machine's own signing key exactly as the fixture in commit-signature-check.test.ts
// does, so a genuinely signed commit is genuinely verifiable in the scratch repo.
const SIGNING_KEY = '/home/doublefx/.ssh/id_ed25519_github.pub'
const ALLOWED_SIGNERS_LINE = readFileSync('/home/doublefx/.ssh/allowed_signers', 'utf8')

function initSignableRepo(tag: string): string {
  const root = mkRoot(tag)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'Test'])
  git(root, ['config', 'user.email', 'webdoublefx@gmail.com'])
  git(root, ['config', 'gpg.format', 'ssh'])
  git(root, ['config', 'user.signingkey', SIGNING_KEY])
  writeFileSync(join(root, 'allowed_signers'), ALLOWED_SIGNERS_LINE)
  git(root, ['config', 'gpg.ssh.allowedSignersFile', join(root, 'allowed_signers')])
  cpSync(PLUGIN_BIN, join(root, 'plugin', 'bin'), { recursive: true })
  return root
}

function commit(root: string, file: string, content: string, message: string, signed: boolean) {
  writeFileSync(join(root, file), content)
  git(root, ['add', file])
  git(root, ['config', 'commit.gpgsign', signed ? 'true' : 'false'])
  git(root, ['commit', '-q', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function runStep(root: string, env: Record<string, string>) {
  const scriptPath = join(root, '__step.sh')
  writeFileSync(scriptPath, extractStepScript())
  const res = spawnSync('bash', ['-e', scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', ...env },
  })
  return { out: `${res.stdout ?? ''}${res.stderr ?? ''}`, code: res.status }
}

describe('signatures.yml verification step — new-branch merge-base fallback', () => {
  it('catches an unsigned ancestor under a signed tip on a brand-new branch (the bypass a review found)', () => {
    const root = initSignableRepo('newbranch-catch')
    commit(root, 'f.txt', 'a', 'main c1 signed', true)
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commit(root, 'f.txt', 'ab', 'feature c2 UNSIGNED', false)
    const tip = commit(root, 'f.txt', 'abc', 'feature c3 signed tip', true)

    const { out, code } = runStep(root, {
      BEFORE: '0000000000000000000000000000000000000000',
      HEAD_SHA: tip,
      PR_BASE: '',
      PR_HEAD: '',
      DEFAULT_BRANCH: 'main',
    })

    // Before the fix this was exit 0 (tip-only) — the exact bypass under test.
    expect(code).toBe(1)
    expect(out).toContain('feature c2 UNSIGNED')
    expect(out).toContain('merge-base with main')
  })

  it('passes a brand-new branch whose commits, including ancestors, are all genuinely signed', () => {
    const root = initSignableRepo('newbranch-clean')
    commit(root, 'f.txt', 'a', 'main c1 signed', true)
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commit(root, 'f.txt', 'ab', 'feature c2 signed', true)
    const tip = commit(root, 'f.txt', 'abc', 'feature c3 signed', true)

    const { out, code } = runStep(root, {
      BEFORE: '0000000000000000000000000000000000000000',
      HEAD_SHA: tip,
      PR_BASE: '',
      PR_HEAD: '',
      DEFAULT_BRANCH: 'main',
    })

    expect(code).toBe(0)
    expect(out).toContain('carry a good signature')
  })

  it('checks an ORPHAN branch\'s full history, not just its tip (no common ancestor with the default branch)', () => {
    const root = initSignableRepo('orphan-branch')
    commit(root, 'f.txt', 'a', 'main c1 signed', true)
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    // A branch with NO shared history with main — merge-base with origin/main exists as
    // a ref but produces no common ancestor. The first version of this fix silently fell
    // back to tip-only here too, which was the exact bypass this locks.
    git(root, ['checkout', '-q', '--orphan', 'orphanbranch'])
    git(root, ['rm', '-qf', '--cached', '-r', '.'])
    commit(root, 'g.txt', 'x', 'orphan c1 UNSIGNED', false)
    const tip = commit(root, 'g.txt', 'xy', 'orphan c2 signed tip', true)

    const { out, code } = runStep(root, {
      BEFORE: '0000000000000000000000000000000000000000',
      HEAD_SHA: tip,
      PR_BASE: '',
      PR_HEAD: '',
      DEFAULT_BRANCH: 'main',
    })

    expect(code).toBe(1)
    expect(out).toContain('orphan c1 UNSIGNED')
    expect(out).toContain('orphan branch')
  })

  it('falls back to honest tip-only checking when the default branch cannot be resolved (root commit)', () => {
    const root = initSignableRepo('root-commit')
    const tip = commit(root, 'f.txt', 'a', 'root commit signed', true)
    // No origin/<default> ref exists at all — simulates a repo's very first commit.

    const { out, code } = runStep(root, {
      BEFORE: '0000000000000000000000000000000000000000',
      HEAD_SHA: tip,
      PR_BASE: '',
      PR_HEAD: '',
      DEFAULT_BRANCH: 'main',
    })

    expect(code).toBe(0)
    expect(out).toContain('checking the tip commit only')
  })
})

describe('signatures.yml verification step — the reverted -e defect stays fixed', () => {
  it('reports an ordinary unsigned-tip finding under `bash -e`, never a silently swallowed exit', () => {
    const root = initSignableRepo('e-flag-lock')
    const before = commit(root, 'f.txt', 'a', 'c1 signed', true)
    const tip = commit(root, 'f.txt', 'ab', 'c2 UNSIGNED', false)

    const { out, code } = runStep(root, {
      BEFORE: before,
      HEAD_SHA: tip,
      PR_BASE: '',
      PR_HEAD: '',
      DEFAULT_BRANCH: 'main',
    })

    expect(code).toBe(1)
    expect(out).toContain('Unsigned commit(s) found')
    expect(out).toContain('c2 UNSIGNED')
  })
})
