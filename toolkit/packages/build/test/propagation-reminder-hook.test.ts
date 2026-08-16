import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-propagation-reminder-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let journalDir: string
let dedupDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-propagation-journal-'))
  dedupDir = mkdtempSync(join(tmpdir(), 'wt-propagation-dedup-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
  rmSync(dedupDir, { recursive: true, force: true })
})

function run(toolName: string, filePath: string, sessionId?: string) {
  const payload: Record<string, unknown> = {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
  }
  if (sessionId !== undefined) payload.session_id = sessionId
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      WT_GUARD_JOURNAL_DIR: journalDir,
      WT_PROPAGATION_REMINDER_DIR: dedupDir,
    },
  })
  return {
    warned: res.stdout.trim() !== '',
    stdout: res.stdout,
    status: res.status,
  }
}

describe('wt-propagation-reminder-hook', () => {
  it('WARN: a shipped plugin file was edited', () => {
    const r = run('Write', '/home/x/repo/plugin/bin/wt-something-hook.mjs')
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('PROPAGATION')
    expect(r.stdout).toContain('ADOPTERS')
    expect(r.status).toBe(0)
  })

  it('WARN: machine tooling under a config dir scripts/ was edited', () => {
    const r = run('Edit', '/home/x/.claude/scripts/hooks/some-hook.mjs')
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('every session on this machine')
  })

  it('WARN: an agent definition under a config dir was edited', () => {
    const r = run('MultiEdit', '/home/x/.claude/agents/pilot.md')
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('sessions using this config dir')
  })

  it('SILENT: ambient rules under <config-dir>/rules — owned by the horizon hook', () => {
    const r = run('Write', '/home/x/.claude/rules/some-rule.md')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: an ordinary project file outside every scoped dir', () => {
    const r = run('Edit', '/home/x/repo/src/index.ts')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: not a Write/Edit/MultiEdit tool', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    expect(res.stdout).toBe('')
  })

  it('DEDUP: repeated edit of the SAME file in ONE session fires only once', () => {
    const file = '/home/x/repo/plugin/bin/wt-something-hook.mjs'
    const first = run('Write', file, 'session-A')
    const second = run('Edit', file, 'session-A')
    expect(first.warned).toBe(true)
    expect(second.warned).toBe(false)
    expect(second.status).toBe(0)
  })

  it('DEDUP: a DIFFERENT file in the same session still fires', () => {
    run('Write', '/home/x/repo/plugin/bin/wt-one-hook.mjs', 'session-B')
    const r = run('Write', '/home/x/repo/plugin/bin/wt-two-hook.mjs', 'session-B')
    expect(r.warned).toBe(true)
  })

  it('DEDUP: the SAME file in a NEW session fires again', () => {
    const file = '/home/x/repo/plugin/bin/wt-something-hook.mjs'
    run('Write', file, 'session-C')
    const r = run('Edit', file, 'session-D')
    expect(r.warned).toBe(true)
  })

  it('DEDUP: an UNRESOLVABLE session (no session_id) always fires, never suppressed', () => {
    const file = '/home/x/repo/plugin/bin/wt-something-hook.mjs'
    const first = run('Write', file) // no session_id at all
    const second = run('Edit', file) // still no session_id
    expect(first.warned).toBe(true)
    expect(second.warned).toBe(true)
  })

  it('is registered as a PostToolUse hook on Write|Edit|MultiEdit in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PostToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Write|Edit|MultiEdit')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) =>
        h.command?.includes('wt-propagation-reminder-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})
