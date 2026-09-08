import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-piped-gate-exit-code-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(command: string) {
  const journalDir = mkdtempSync(join(tmpdir(), 'wt-piped-gate-journal-'))
  try {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'session-test-123',
        tool_input: { command },
      }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    const entries = readdirSync(journalDir)
      .filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    return { result, entries }
  } finally {
    rmSync(journalDir, { recursive: true, force: true })
  }
}

describe('wt-piped-gate-exit-code-guard-hook', () => {
  it('WARN: a piped test gate followed by `$?` warns without blocking and is journaled', () => {
    const { result, entries } = run('pnpm test | tail -5; echo $?')
    expect(result.stdout).toContain('hookSpecificOutput')
    expect(result.stdout).toContain('> file; echo EXIT=$? >> file')
    expect(result.stdout).not.toContain('permissionDecision')
    expect(result.status).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      guard: 'wt-piped-gate-exit-code-guard-hook.mjs',
      decision: 'warned',
      class: 'piped-gate-exit-code',
      session: 'session-test-123',
      evidence: { status: 'dollar-question' },
    })
  })

  it('SILENT: safe file capture reads the gate exit code before any pipe can replace it', () => {
    const { result, entries } = run('pnpm test > f; echo EXIT=$? >> f')
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
    expect(entries).toEqual([])
  })

  it('SILENT: a pipeline whose status is never read', () => {
    const { result, entries } = run('pnpm test | tail -5')
    expect(result.stdout).toBe('')
    expect(entries).toEqual([])
  })

  it('SILENT: pipefail and zsh pipestatus correctly preserve the gate status', () => {
    expect(run('set -o pipefail; pnpm test | tee test.log; echo $?').result.stdout).toBe('')
    expect(run('pnpm test | tail -5; echo ${pipestatus[1]}').result.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const wired = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry: { matcher?: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks?: { command?: string }[] }) => entry.hooks ?? [])
      .some((hook: { command?: string }) => hook.command?.includes('wt-piped-gate-exit-code-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
