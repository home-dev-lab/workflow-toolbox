import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-main-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let sandboxHome: string

beforeEach(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), 'wt-main-guard-test-'))
})

afterEach(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})

function run(command: string, opts: { agentId?: string; cwd?: string } = {}) {
  const payload: Record<string, unknown> = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: opts.cwd ?? sandboxHome,
  }
  if (opts.agentId) payload.agent_id = opts.agentId
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: sandboxHome },
  })
  return {
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

function journalLines(): Array<Record<string, unknown>> {
  const p = join(sandboxHome, '.local', 'state', 'wt-main-guard', 'journal.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function initGitRepo(dir: string, branch = 'main') {
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', '-q', '-b', branch, dir])
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.co'])
  spawnSync('git', ['-C', dir, 'config', 'user.name', 't'])
  writeFileSync(join(dir, 'f.txt'), 'x')
  spawnSync('git', ['-C', dir, 'add', '-A'])
  spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
}

describe('wt-main-guard-hook — measured-BLOCKING classes', () => {
  it('RED: denies npm publish', () => {
    const r = run('cd pkg && npm publish')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('npm/pnpm/yarn publish is a release action')
  })

  it('RED: denies pnpm publish', () => {
    const r = run('pnpm publish --no-git-checks')
    expect(r.denied).toBe(true)
  })

  it('RED: denies a force-push (--force)', () => {
    const r = run('git push origin my-branch --force')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('force-push overwrites remote history')
  })

  it('RED: denies a force-push (--force-with-lease)', () => {
    const r = run('git push --force-with-lease origin my-branch')
    expect(r.denied).toBe(true)
  })

  it('RED: denies a remote branch deletion (--delete)', () => {
    const r = run('git push origin --delete stale-branch')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('remote branch deletion is remote-destructive')
  })

  it('RED: denies a remote branch deletion (: refspec form)', () => {
    const r = run('git push origin :stale-branch')
    expect(r.denied).toBe(true)
  })

  it('RED: denies rm -rf targeting the home directory', () => {
    const r = run('rm -rf ~')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('home directory')
  })

  it('RED: denies rm -rf targeting $HOME', () => {
    const r = run('rm -rf $HOME')
    expect(r.denied).toBe(true)
  })

  it('RED: denies rm -rf targeting the filesystem root', () => {
    const r = run('rm -rf /')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('filesystem root')
  })
})

describe('wt-main-guard-hook — measured-FALSE-POSITIVE classes now JOURNAL-ONLY', () => {
  it('GREEN: allows (but journals) rm -rf on a git repository root — worktree/clone purge is routine', () => {
    const target = join(sandboxHome, 'throwaway-clone')
    initGitRepo(target)
    const r = run(`rm -rf ${target}`)
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'rm-catastrophic' && l.decision === 'allowed-journaled')).toBe(true)
  })

  it('GREEN: allows (but journals) rm -rf "$VAR" where $VAR cannot be statically resolved', () => {
    const r = run('D=$(mktemp -d); rm -rf "$D"')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    const lines = journalLines()
    expect(
      lines.some((l) => l.class === 'rm-catastrophic' && String(l.reason).includes('cannot be statically resolved')),
    ).toBe(true)
  })

  it('GREEN: allows (but journals) rm -rf on a glob target', () => {
    const r = run('rm -rf /tmp/prov-fixture-*')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })
})

describe('wt-main-guard-hook — legitimate near-misses stay silent', () => {
  it('GREEN: an ordinary named-remote push is not a violation', () => {
    const r = run('git push origin my-branch')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().length).toBe(0)
  })

  it('GREEN: an ordinary rm -rf on a plain (non-git, non-home, non-root) directory is journal-only, not denied', () => {
    const target = join(sandboxHome, 'scratch', 'build-dir')
    mkdirSync(target, { recursive: true })
    const r = run(`rm -rf ${target}`)
    expect(r.denied).toBe(false)
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'rm-other')).toBe(true)
  })

  it('GREEN: "npm publish" mentioned inside a single-quoted commit message is not a violation', () => {
    const r = run("git commit -m 'about npm publish workflow, not running it'")
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: "npm publish" mentioned inside a heredoc body is not a violation', () => {
    const r = run(["git commit -F - <<'MSG'", 'fixes the npm publish docs', 'MSG'].join('\n'))
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: --force mentioned inside a double-quoted string is not a violation', () => {
    const r = run('echo "run git push --force only if you really mean it"')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: a quoted rm target under a real path stays visible to classification (not blinded by quote-stripping)', () => {
    const target = join(sandboxHome, 'with spaces')
    mkdirSync(target, { recursive: true })
    const r = run(`rm -rf "${target}"`)
    expect(r.denied).toBe(false) // ordinary dir, not catastrophic — but must be CLASSIFIED, not skipped
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'rm-other')).toBe(true)
  })
})

describe('wt-main-guard-hook — journal-only merge direction', () => {
  it('journals (never denies) a merge INTO main while on main', () => {
    const repo = join(sandboxHome, 'repo')
    initGitRepo(repo, 'main')
    spawnSync('git', ['-C', repo, 'branch', 'feature'])
    const r = run('git merge feature', { cwd: repo })
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'merge-into-main')).toBe(true)
  })

  it('stays a true no-op merging main INTO a feature branch (the reverse direction)', () => {
    const repo = join(sandboxHome, 'repo2')
    initGitRepo(repo, 'main')
    spawnSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature'])
    const r = run('git merge main', { cwd: repo })
    expect(r.denied).toBe(false)
    expect(journalLines().length).toBe(0)
  })
})

describe('wt-main-guard-hook — scope', () => {
  it('no-ops for any subagent call (agent_id present) — the pilot guard already covers it', () => {
    const r = run('rm -rf /', { agentId: 'agent-pilot-1' })
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('no-ops for a non-Bash tool', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: 'npm publish' },
    }
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, HOME: sandboxHome },
    })
    expect(res.stdout).toBe('')
  })

  it('stays out of the way for an ordinary command with no matching shape', () => {
    const r = run('git status')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().length).toBe(0)
  })
})

describe('wt-main-guard-hook — escape hatch', () => {
  it('a byte-exact allow-once override consumes itself and lets the exact command through', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const command = 'rm -rf /'
    writeFileSync(
      join(stateDir, 'allow-once.json'),
      JSON.stringify({ command, reason: 'deliberate wipe of a disposable VM, verified by hand' }),
    )
    const r = run(command)
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(existsSync(join(stateDir, 'allow-once.json'))).toBe(false) // single-use
    const lines = journalLines()
    expect(lines.some((l) => l.decision === 'override-allow')).toBe(true)
  })

  it('does not consume the override for a DIFFERENT command (byte-exact match only)', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, 'allow-once.json'),
      JSON.stringify({ command: 'rm -rf /', reason: 'unrelated' }),
    )
    const r = run('rm -rf ~')
    expect(r.denied).toBe(true)
    expect(existsSync(join(stateDir, 'allow-once.json'))).toBe(true) // untouched
  })
})

describe('wt-main-guard-hook — registration', () => {
  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-main-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
