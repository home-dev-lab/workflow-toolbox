import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-pgrep-env-dump-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-pgrep-journal-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

function run(command: string) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
  })
  return {
    warned: res.stdout.includes('hookSpecificOutput'),
    stdout: res.stdout,
    status: res.status,
  }
}

describe('wt-pgrep-env-dump-guard-hook', () => {
  it('WARN: pgrep -af', () => {
    const r = run("pgrep -af zsh")
    expect(r.warned).toBe(true)
    expect(r.status).toBe(0)
  })

  it('WARN: pgrep -a', () => {
    const r = run('pgrep -a node')
    expect(r.warned).toBe(true)
  })

  it('WARN: ps -ef', () => {
    const r = run('ps -ef | grep node')
    expect(r.warned).toBe(true)
  })

  it('WARN: ps aux', () => {
    const r = run('ps aux')
    expect(r.warned).toBe(true)
  })

  it('WARN: ps -o args= with no -p PID filter', () => {
    const r = run('ps -o args=')
    expect(r.warned).toBe(true)
  })

  it('SILENT: pgrep -f pattern (PID only)', () => {
    const r = run('pgrep -f my-pattern')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: pgrep -c -f pattern (count only)', () => {
    const r = run('pgrep -c -f my-pattern')
    expect(r.warned).toBe(false)
  })

  it('SILENT: bare pgrep with no full-listing flag', () => {
    const r = run('pgrep my-pattern')
    expect(r.warned).toBe(false)
  })

  it('SILENT: ps -o args= -p <pid> (already-identified PID, sanctioned follow-up)', () => {
    const r = run("ps -o args= -p 1234 | cut -c1-120")
    expect(r.warned).toBe(false)
  })

  it('SILENT: bare ps with no full-listing flag', () => {
    const r = run('ps')
    expect(r.warned).toBe(false)
  })

  it('stays out of the way for a command with no pgrep/ps at all', () => {
    const r = run('echo hi')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) =>
        h.command?.includes('wt-pgrep-env-dump-guard-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})
