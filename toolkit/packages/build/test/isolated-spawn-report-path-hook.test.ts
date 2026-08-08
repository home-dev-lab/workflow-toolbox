import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-isolated-spawn-report-path-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-isolated-spawn-journal-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

function run(toolInput: Record<string, unknown>) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: toolInput,
    }),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
  })
  return {
    warned: res.stdout.includes('systemMessage'),
    stdout: res.stdout,
    status: res.status,
  }
}

describe('wt-isolated-spawn-report-path-hook', () => {
  it('WARN: isolated spawn briefed to write to an absolute out-of-tree path', () => {
    const r = run({
      name: 'port-guards',
      isolation: 'worktree',
      prompt: 'Write your report to /home/doublefx/projects/wt-suite/.claude/reports/x.md when done.',
    })
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('/home/doublefx/projects/wt-suite/.claude/reports/x.md')
    expect(r.status).toBe(0)
  })

  it('SILENT: isolated spawn whose write target is already inside a worktrees dir', () => {
    const r = run({
      name: 'port-guards',
      isolation: 'worktree',
      prompt: 'Write your report to /home/doublefx/projects/wt-suite/worktrees/port-guards/report.md.',
    })
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: no isolation at all', () => {
    const r = run({
      name: 'anon',
      prompt: 'Write your report to /home/doublefx/projects/report.md.',
    })
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: isolated spawn with no absolute write target named', () => {
    const r = run({
      name: 'port-guards',
      isolation: 'worktree',
      prompt: 'Just fix the bug and say what you did.',
    })
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: not the Agent tool', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    expect(res.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Agent in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Agent')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) =>
        h.command?.includes('wt-isolated-spawn-report-path-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})
