// live-config-tree-guard-hook.test.ts — behavior gate for the PreToolUse/Bash guard against
// git commands that switch the working tree of a LIVE ambient rules directory. Drives the
// REAL hook as a child process against isolated fixture paths, never the real ~/.claude.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-live-config-tree-guard-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The REAL host environment this test runs in sets CLAUDE_CONFIG_DIR (this repo is itself
// worked on inside a Claude Code session) — and CLAUDE_CONFIG_DIR wins over the HOME-based
// `.claude*` heuristic. Every fixture must scrub it, or a fixture's HOME override is silently
// ignored and the hook resolves the REAL live rules directory instead of the fixture's.
function withoutRealConfigDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.CLAUDE_CONFIG_DIR
  return clean
}

/** A fixture with `<home>/.claude/rules` present as a real git working tree (a `.git` dir). */
function gitFixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-live-tree-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  const rulesDir = join(home, '.claude', 'rules')
  mkdirSync(join(rulesDir, '.git'), { recursive: true })
  return { root, home, rulesDir, env: withoutRealConfigDir({ ...process.env, HOME: home }) }
}

/** A fixture where `<home>/.claude/rules` exists but is NOT a git working tree. */
function nonGitFixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-live-tree-nogit-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  const rulesDir = join(home, '.claude', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  return { root, home, rulesDir, env: withoutRealConfigDir({ ...process.env, HOME: home }) }
}

function runHook(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  extraArgv: string[] = [],
): { status: number | null; stdout: string; decision: string | null; systemMessage: string | null } {
  const res = spawnSync(process.execPath, [HOOK, ...extraArgv], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  let decision: string | null = null
  let systemMessage: string | null = null
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const out = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    decision = (out?.['permissionDecision'] as string | undefined) ?? null
    systemMessage = (parsed?.['systemMessage'] as string | undefined) ?? null
  } catch {
    /* leave both null */
  }
  return { status: res.status, stdout, decision, systemMessage }
}

describe('wt-live-config-tree-guard-hook — CATCHES the near-miss pattern (default warn posture)', () => {
  it('warns (does not deny) on a plain git switch to the live rules dir, by default', () => {
    const f = gitFixture('switch')
    const r = runHook(`git -C ${f.rulesDir} switch some-branch`, f.root, f.env)
    expect(r.decision).toBeNull()
    expect(r.systemMessage, 'must not be silent').toBeTruthy()
    expect(r.systemMessage).toContain('LIVE CONFIG TREE')
  })

  it('catches the exact near-miss: cd into the live dir then reset --hard, split across &&', () => {
    const f = gitFixture('split-cd')
    const r = runHook(`cd ${f.rulesDir} && git reset --hard origin/main`, f.root, f.env)
    expect(r.systemMessage, 'must not be silent — this is the pattern that defeated the first draft').toBeTruthy()
  })

  it('denies when WT_LIVE_CONFIG_TREE_GUARD_MODE=deny is set', () => {
    const f = gitFixture('deny-mode')
    const r = runHook(`git -C ${f.rulesDir} checkout other-branch`, f.root, {
      ...f.env,
      WT_LIVE_CONFIG_TREE_GUARD_MODE: 'deny',
    })
    expect(r.decision).toBe('deny')
  })

  it('is silenced entirely when WT_LIVE_CONFIG_TREE_GUARD_MODE=off is set', () => {
    const f = gitFixture('off-mode')
    const r = runHook(`git -C ${f.rulesDir} reset --hard`, f.root, {
      ...f.env,
      WT_LIVE_CONFIG_TREE_GUARD_MODE: 'off',
    })
    expect(r.stdout).toBe('')
  })

  it('honors an explicit CLAUDE_CONFIG_DIR for an arbitrarily-named config directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-live-tree-customdir-'))
    roots.push(root)
    const configDir = join(root, 'srv', 'claude-config')
    mkdirSync(join(configDir, 'rules', '.git'), { recursive: true })
    const r = runHook(`git -C ${join(configDir, 'rules')} checkout -b work`, root, {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    })
    expect(r.systemMessage, 'must not be silent — CLAUDE_CONFIG_DIR names this as the rules root').toBeTruthy()
  })
})

describe('wt-live-config-tree-guard-hook — does NOT block legitimate work', () => {
  it('never touches the recommended remedy: git worktree add', () => {
    const f = gitFixture('worktree-add')
    const r = runHook(`git -C ${f.rulesDir} worktree add ../elsewhere -b fix`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches an ordinary commit', () => {
    const f = gitFixture('commit')
    const r = runHook(`git -C ${f.rulesDir} commit -m "edit a rule"`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches git status', () => {
    const f = gitFixture('status')
    const r = runHook(`git -C ${f.rulesDir} status`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches a pathspec checkout (`checkout -- <file>`), only a branch-shaped one', () => {
    const f = gitFixture('checkout-pathspec')
    const r = runHook(`git -C ${f.rulesDir} checkout -- some-rule.md`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches a git command targeting an unrelated project worktree', () => {
    const f = gitFixture('other-dir')
    const otherDir = join(f.root, 'projects', 'my-repo')
    mkdirSync(otherDir, { recursive: true })
    const r = runHook(`git -C ${otherDir} switch feature-branch`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('is fully INERT when the resolved rules directory is not a git working tree', () => {
    const f = nonGitFixture('inert')
    const r = runHook(`git -C ${f.rulesDir} reset --hard`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('does not guess at an unresolvable target (a shell variable)', () => {
    const f = gitFixture('unresolvable')
    const r = runHook(`git -C "$RULES_DIR" checkout other`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('fails safe on malformed stdin', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: '{not valid JSON', encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('')
  })
})

describe('wt-live-config-tree-guard-hook — --diagnose is legible', () => {
  it('reports active:true and isGitRepo:true for a fixture with a live git rules dir', () => {
    const f = gitFixture('diag-active')
    const res = spawnSync(process.execPath, [HOOK, '--diagnose'], { encoding: 'utf8', env: f.env })
    const parsed = JSON.parse((res.stdout ?? '').trim())
    expect(parsed.isGitRepo).toBe(true)
    expect(parsed.active).toBe(true)
  })

  it('reports active:false and isGitRepo:false for a fixture with a non-git rules dir', () => {
    const f = nonGitFixture('diag-inert')
    const res = spawnSync(process.execPath, [HOOK, '--diagnose'], { encoding: 'utf8', env: f.env })
    const parsed = JSON.parse((res.stdout ?? '').trim())
    expect(parsed.isGitRepo).toBe(false)
    expect(parsed.active).toBe(false)
  })
})
