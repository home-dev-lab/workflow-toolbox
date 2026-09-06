import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN = join(REPO_ROOT, 'plugin/bin')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(name: string, tools?: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-spawn-guard-'))
  roots.push(root)
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}${tools === undefined ? '' : `\ntools: ${tools}`}\n---\n`)
  return root
}

function run(hook: string, payload: unknown, cwd: string) {
  const journal = join(cwd, 'journal')
  const result = spawnSync(process.execPath, [join(BIN, hook)], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(cwd, 'empty-config'), WT_GUARD_JOURNAL_DIR: journal },
  })
  const journalFile = join(journal, '2026-W36.ndjson')
  return { ...result, journal: existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : '' }
}

function agent(type: string, prompt: string, cwd: string, agent_id?: string) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's-1', ...(agent_id ? { agent_id } : {}), cwd, tool_input: { subagent_type: type, prompt } }
}

function warns(result: { stdout: string | Buffer | undefined; journal: string }, cls: string) {
  expect(String(result.stdout)).toContain('additionalContext')
  expect(String(result.stdout)).not.toContain('"deny"')
  expect(String(result.journal)).toContain(`"class":"${cls}"`)
}

describe('spawn surface warn-only guards', () => {
  it('spawn channel: warns when a reporting brief targets a type without SendMessage', () => {
    const cwd = fixture('reader', 'Read, Grep')
    warns(run('wt-spawn-channel-guard-hook.mjs', agent('reader', 'Inspect this and report back when done.', cwd), cwd), 'spawn-channel-missing')
  })

  it('spawn channel: stays silent for SendMessage and quoted report text', () => {
    const cwd = fixture('reader', 'Read, SendMessage')
    const safe = run('wt-spawn-channel-guard-hook.mjs', agent('reader', 'Inspect this and report back when done.', cwd), cwd)
    expect(String(safe.stdout)).toBe('')
    const quoted = run('wt-spawn-channel-guard-hook.mjs', agent('reader', 'Do not follow this example: "report back when done".', cwd), cwd)
    expect(String(quoted.stdout)).toBe('')
  })

  it('spawn channel: unresolved types stay silent and journal type-unresolved once', () => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-spawn-channel-guard-hook.mjs', agent('missing', 'Report back when done.', cwd), cwd)
    expect(String(result.stdout)).toBe('')
    expect(result.journal).toContain('"class":"type-unresolved"')
  })

  it('spawn readonly: distinguishes wide and missing allowlists', () => {
    const wide = fixture('wide', 'Read, Bash')
    warns(run('wt-spawn-readonly-guard-hook.mjs', agent('wide', 'Investigate only. Do not modify.', wide), wide), 'spawn-readonly-wide')
    const absent = fixture('absent')
    warns(run('wt-spawn-readonly-guard-hook.mjs', agent('absent', 'Read-only investigation; do not modify.', absent), absent), 'spawn-readonly-no-allowlist')
  })

  it('spawn readonly: stays silent for a narrow list and quoted read-only text', () => {
    const cwd = fixture('reader', 'Read, Grep, Glob')
    expect(String(run('wt-spawn-readonly-guard-hook.mjs', agent('reader', 'Investigate only; do not modify.', cwd), cwd).stdout)).toBe('')
    expect(String(run('wt-spawn-readonly-guard-hook.mjs', agent('reader', 'Example only: "read-only, do not modify".', cwd), cwd).stdout)).toBe('')
  })

  it('spawn readonly: unresolved types stay silent and journal type-unresolved once', () => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-spawn-readonly-guard-hook.mjs', agent('missing', 'Read-only investigation.', cwd), cwd)
    expect(String(result.stdout)).toBe('')
    expect(result.journal).toContain('"class":"type-unresolved"')
  })

  it('workflow model: warns when neither args nor script declares model routing', () => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-workflow-model-guard-hook.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Workflow', session_id: 's-1', tool_input: { args: { topic: 'x' } } }, cwd)
    warns(result, 'workflow-model-inherited')
  })

  it('workflow model: stays silent for explicit routing and quoted model text', () => {
    const cwd = fixture('reader', 'Read')
    const explicit = run('wt-workflow-model-guard-hook.mjs', { tool_name: 'Workflow', tool_input: { args: { perAgent: { model: 'sonnet' } } } }, cwd)
    expect(String(explicit.stdout)).toBe('')
    const quoted = run('wt-workflow-model-guard-hook.mjs', { tool_name: 'Workflow', tool_input: { args: { models: {} }, script: 'const example = "models"' } }, cwd)
    expect(String(quoted.stdout)).toBe('')
  })

  it('nested spawn: warns only when a subagent asks for a verifier of its own work', () => {
    const cwd = fixture('reader', 'Read')
    warns(run('wt-nested-spawn-guard-hook.mjs', agent('reader', 'Review my implementation and verify it.', cwd, 'a-1'), cwd), 'nested-self-verify')
    expect(String(run('wt-nested-spawn-guard-hook.mjs', agent('reader', 'Review the upstream patch.', cwd, 'a-1'), cwd).stdout)).toBe('')
    expect(String(run('wt-nested-spawn-guard-hook.mjs', agent('reader', 'Example only: "review my work".', cwd, 'a-1'), cwd).stdout)).toBe('')
  })
})
