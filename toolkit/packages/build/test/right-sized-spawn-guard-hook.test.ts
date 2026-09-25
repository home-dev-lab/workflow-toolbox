import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-right-sized-spawn-guard-hook.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runToolInput(tool_input: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'wt-right-sized-spawn-'))
  roots.push(root)
  const journal = join(root, 'journal')
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', session_id: 's-1', tool_input }),
    encoding: 'utf8',
    env: sealedPluginCliEnv(root, { WT_GUARD_JOURNAL_DIR: journal, WT_GUARD_JOURNAL_NOW: '2026-09-25T12:00:00Z' }),
  })
  const journalPath = join(journal, '2026-W39.ndjson')
  return { stdout: result.stdout, journal: existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '' }
}

function run(subagent_type: unknown, prompt: unknown = '') {
  return runToolInput({ ...(subagent_type === undefined ? {} : { subagent_type }), prompt })
}

describe('wt-right-sized-spawn-guard-hook', () => {
  it('denies general-purpose without a reason and names every cheaper alternative', () => {
    const result = run('general-purpose', 'Implement the requested change.')
    expect(result.stdout).toContain('"permissionDecision":"deny"')
    expect(result.stdout).toContain('wt-implementer-sonnet')
    expect(result.stdout).toContain('wt-implementer-opus')
    expect(result.stdout).toContain('wt-reviewer')
    expect(result.stdout).toContain('wt-chores')
    expect(result.stdout).toContain('workflow-toolbox:wt-implementer-sonnet')
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

  it.each([
    ['the literal placeholder', 'general-purpose because: <reason>'],
    ['an invisible-only reason', 'general-purpose because: \u200B'],
    ['a line inside a fenced sample', 'Example:\n```text\ngeneral-purpose because: use an unusual specialist\n```'],
  ])('denies %s', (_label, prompt) => {
    expect(run('general-purpose', prompt).stdout).toContain('"permissionDecision":"deny"')
  })

  it('stays silent when the call resumes an existing agent', () => {
    expect(runToolInput({ resume: 'existing-specialist-id', prompt: 'Continue' }).stdout).toBe('')
  })

  it('accepts stringified tool input', () => {
    expect(runToolInput(JSON.stringify({ subagent_type: 'workflow-toolbox:wt-chores', prompt: 'Read' })).stdout).toBe('')
  })

  it('accepts prompt arrays made of text parts', () => {
    const result = run('general-purpose', [
      { type: 'text', text: 'This needs a special route.' },
      { type: 'text', text: 'general-purpose because: the required specialist is unavailable' },
    ])
    expect(result.stdout).toBe('')
    expect(result.journal).toContain('required specialist is unavailable')
  })

  it('passes every non-general-purpose type untouched', () => {
    const result = run('wt-chores', 'Summarize this log.')
    expect(result.stdout).toBe('')
    expect(result.journal).toBe('')
  })

  it('sets an honest recovery expectation for newly created agents', () => {
    expect(run('general-purpose', 'Implement this.').stdout).toContain('start a new session')
  })

  it('is registered as a PreToolUse Agent hook', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }> } }
    const hooks = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry) => entry.matcher === 'Agent')
      .flatMap((entry) => entry.hooks ?? [])
    const hook = hooks.find(({ command }) => command?.includes('wt-right-sized-spawn-guard-hook.mjs'))
    expect(hook).toBeDefined()
    expect(hook?.timeout).toBe(5)
  })
})
