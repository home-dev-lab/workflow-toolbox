// rule-edit-horizon-hook.test.ts — behavior gate for the PostToolUse signal that
// makes an ambient-rule edit's session-reload horizon explicit. Drives the REAL
// hook as a child process against isolated fixture paths, never the real ~/.claude.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-rule-edit-horizon-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-rule-horizon-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home, env: { ...process.env, HOME: home } }
}

function runHook(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; context: string } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  let context = ''
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const output = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    context = (output?.['additionalContext'] as string | undefined) ?? ''
  } catch {
    context = ''
  }
  return { status: res.status, stdout, context }
}

describe('wt-rule-edit-horizon-hook — ambient rule edit horizon', () => {
  it('signals an Edit of a project ambient rule resolved from cwd', () => {
    const f = fixture('edit')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '.claude/rules/some-rule.md' },
      cwd: f.root,
    }, f.env)

    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context.toLowerCase()).toContain('session neuve')
    expect(r.context).toContain('some-rule.md')
  })

  it('signals a Write of a project ambient rule', () => {
    const f = fixture('write')
    const file = join(f.root, '.claude', 'rules', 'new-rule.md')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file },
      cwd: f.root,
    }, f.env)

    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context.toLowerCase()).toContain('session neuve')
    expect(r.context).toContain('new-rule.md')
  })

  it('signals a MultiEdit whose path is on the top-level input', () => {
    const f = fixture('multiedit-top-level')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'MultiEdit',
      tool_input: { file_path: '.claude/rules/top-level.md', edits: [] },
      cwd: f.root,
    }, f.env)

    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('top-level.md')
  })

  it('signals a MultiEdit whose path is on its first edit', () => {
    const f = fixture('multiedit-first-edit')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'MultiEdit',
      tool_input: { edits: [{ file_path: '.claude/rules/first-edit.md' }] },
      cwd: f.root,
    }, f.env)

    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('first-edit.md')
  })

  it('stays silent for an agent definition', () => {
    const f = fixture('agent')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(f.root, '.claude', 'agents', 'pilot.md') },
      cwd: f.root,
    }, f.env)
    expect(r.stdout).toBe('')
  })

  it('stays silent outside a .claude configuration directory', () => {
    const f = fixture('source')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(f.root, 'src', 'index.ts') },
      cwd: f.root,
    }, f.env)
    expect(r.stdout).toBe('')
  })

  it('stays silent for non-Markdown files in a rules directory', () => {
    const f = fixture('extension')
    // Ambient rules are Markdown; other files under rules do not participate in this horizon.
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(f.root, '.claude', 'rules', 'notes.txt') },
      cwd: f.root,
    }, f.env)
    expect(r.stdout).toBe('')
  })

  it('fails safe on malformed stdin', () => {
    const r = runHook('{not valid JSON')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('detects a rule under an isolated custom .claude-work config directory', () => {
    const f = fixture('custom-config')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '~/.claude-work/rules/foo.md' },
      cwd: f.root,
    }, f.env)

    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('foo.md')
  })

  it('resolves a backslash tilde path regardless of the host path.sep', () => {
    const f = fixture('win-tilde')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      // '~\\...' must expand even on a POSIX host running this test — the payload's
      // slash style reflects how the tool call was made, not the host platform.
      tool_input: { file_path: '~\\.claude-work\\rules\\win.md' },
      cwd: f.root,
    }, f.env)
    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('win.md')
  })

  it('honors an arbitrarily-named CLAUDE_CONFIG_DIR (no .claude-prefixed ancestor)', () => {
    const f = fixture('custom-env-dir')
    const configDir = join(f.root, 'srv', 'claude-config')
    mkdirSync(join(configDir, 'rules'), { recursive: true })
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(configDir, 'rules', 'policy.md') },
      cwd: f.root,
    }, { ...f.env, CLAUDE_CONFIG_DIR: configDir })

    expect(r.stdout, 'must not be silent — CLAUDE_CONFIG_DIR names this as the rules root').not.toBe('')
    expect(r.context).toContain('policy.md')
  })

  it('stays silent for a "rules" directory nested under .claude but not as its direct child', () => {
    const f = fixture('nested-rules')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      // .claude/agents/rules/x.md — "rules" here is NOT the ambient rules dir.
      tool_input: { file_path: join(f.root, '.claude', 'agents', 'rules', 'x.md') },
      cwd: f.root,
    }, f.env)
    expect(r.stdout).toBe('')
  })

  it('stays silent for a "rules-backup" sibling that also contains a nested rules dir', () => {
    const f = fixture('rules-backup-sibling')
    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(f.root, '.claude', 'rules-backup', 'rules', 'x.md') },
      cwd: f.root,
    }, f.env)
    expect(r.stdout).toBe('')
  })
})
