import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-right-sized-spawn-guard-hook.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run(subagent_type: unknown, prompt = '') {
  const root = mkdtempSync(join(tmpdir(), 'wt-right-sized-spawn-'))
  roots.push(root)
  const journal = join(root, 'journal')
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', session_id: 's-1', tool_input: { ...(subagent_type === undefined ? {} : { subagent_type }), prompt } }),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journal, WT_GUARD_JOURNAL_NOW: '2026-09-25T12:00:00Z' },
  })
  const journalPath = join(journal, '2026-W39.ndjson')
  return { stdout: result.stdout, journal: existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '' }
}

describe('wt-right-sized-spawn-guard-hook', () => {
  it('denies general-purpose without a reason and names every cheaper alternative', () => {
    const result = run('general-purpose', 'Implement the requested change.')
    expect(result.stdout).toContain('"permissionDecision":"deny"')
    expect(result.stdout).toContain('wt-implementer-sonnet')
    expect(result.stdout).toContain('wt-implementer-opus')
    expect(result.stdout).toContain('wt-reviewer')
    expect(result.stdout).toContain('wt-chores')
    expect(result.journal).toContain('"class":"general-purpose"')
  })

  it('denies an absent subagent type without a reason', () => {
    const result = run(undefined, 'Summarize this log.')
    expect(result.stdout).toContain('"permissionDecision":"deny"')
    expect(result.journal).toContain('"class":"subagent-type-absent"')
  })

  it('allows and journals a line-scoped general-purpose reason', () => {
    const result = run('general-purpose', 'This is unusual.\ngeneral-purpose because: it needs an unavailable specialist tool')
    expect(result.stdout).toBe('')
    expect(result.journal).toContain('"class":"general-purpose-override"')
    expect(result.journal).toContain('unavailable specialist tool')
  })

  it('passes every non-general-purpose type untouched', () => {
    const result = run('wt-chores', 'Summarize this log.')
    expect(result.stdout).toBe('')
    expect(result.journal).toBe('')
  })

  it('is registered as a PreToolUse Agent hook', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> } }
    const commands = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry) => entry.matcher === 'Agent')
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command ?? '')
    expect(commands.some((command) => command.includes('wt-right-sized-spawn-guard-hook.mjs'))).toBe(true)
  })
})
