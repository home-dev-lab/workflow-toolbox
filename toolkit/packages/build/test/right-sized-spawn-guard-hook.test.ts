import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { resolveAgentModelPin } from '../../../../plugin/bin/lib/agent-model-pin.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-right-sized-spawn-guard-hook.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runToolInput(tool_input: unknown, setup?: (root: string) => void, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-right-sized-spawn-'))
  roots.push(root)
  setup?.(root)
  const journal = join(root, 'journal')
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', session_id: 's-1', cwd: root, tool_input }),
    encoding: 'utf8',
    env: sealedPluginCliEnv(root, {
      CLAUDE_CODE_SUBAGENT_MODEL: undefined,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: undefined,
      WT_GUARD_JOURNAL_DIR: journal,
      WT_GUARD_JOURNAL_NOW: '2026-09-25T12:00:00Z',
      ...env,
    }),
  })
  const journalPath = join(journal, '2026-W39.ndjson')
  return { status: result.status, stdout: result.stdout, journal: existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '' }
}

function run(subagent_type: unknown, prompt: unknown = '', model?: string) {
  return runToolInput({ ...(subagent_type === undefined ? {} : { subagent_type }), prompt, ...(model === undefined ? {} : { model }) })
}

function expectModelWarning(result: ReturnType<typeof runToolInput>) {
  expect(result.status).toBe(0)
  const output = JSON.parse(result.stdout) as Record<string, unknown>
  const hook = output.hookSpecificOutput as Record<string, unknown>
  expect(hook.hookEventName).toBe('PreToolUse')
  expect(hook.additionalContext).toEqual(expect.stringContaining('model pin'))
  expect(JSON.stringify(output)).not.toContain('permissionDecision')
  expect(output).not.toHaveProperty('continue')
  const records = result.journal.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  const warnings = records.filter((record) => record.class === 'model-unpinned')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toMatchObject({ class: 'model-unpinned', decision: 'warned' })
}

function expectSilentModelPin(result: ReturnType<typeof runToolInput>) {
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  const records = result.journal.trim() ? result.journal.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
  expect(records.filter((record) => record.class === 'model-unpinned')).toEqual([])
  // A positive control keeps this case red until the warning actually exists.
  expectModelWarning(run('workflow-toolbox:leaf-readonly'))
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
    const result = run('general-purpose', 'This is unusual.\ngeneral-purpose because: it needs an unavailable specialist tool', 'sonnet')
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
    ], 'sonnet')
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

  it('warns when a known plugin agent has no model pin, without denying the spawn', () => {
    expectModelWarning(run('workflow-toolbox:leaf-readonly'))
  })

  it('treats an explicit inherit model as unpinned', () => {
    expectModelWarning(runToolInput({ subagent_type: 'workflow-toolbox:wt-chores', model: 'inherit', prompt: 'Read' }))
  })

  it('does not warn when the spawn pins its model', () => {
    expectSilentModelPin(runToolInput({ subagent_type: 'workflow-toolbox:leaf-readonly', model: 'haiku', prompt: 'Read' }))
  })

  it('exempts fork even without a model pin', () => {
    expectSilentModelPin(run('fork', 'Continue'))
  })

  it('reads a custom agent model pin from the active config directory', () => {
    const result = runToolInput({ subagent_type: 'custom-worker', prompt: 'Read' }, (root) => {
      const agents = join(root, 'claude-config', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\nmodel: "sonnet"\n---\nRead.\n')
    })
    expectSilentModelPin(result)
  })

  it('warns for an unpinned custom agent in the active config directory', () => {
    const result = runToolInput({ subagent_type: 'custom-worker' }, (root) => {
      const agents = join(root, 'claude-config', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\n---\nRead.\n')
    })
    expectModelWarning(result)
  })

  it('mutes a model-pin warning in observe mode and journals the silent detection', () => {
    const result = runToolInput({ subagent_type: 'workflow-toolbox:leaf-readonly' }, undefined, { WT_GUARD_MODE: 'observe' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.journal.trim().split('\n').map((line) => JSON.parse(line))).toMatchObject([
      { class: 'model-unpinned', decision: 'silent', mode: 'observe' },
    ])
  })

  it('treats YAML tilde as a missing model pin', () => {
    const result = runToolInput({ subagent_type: 'custom-worker' }, (root) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\nmodel: ~\n---\nRead.\n')
    })
    expectModelWarning(result)
  })

  it('warns for a custom agent with no frontmatter model pin', () => {
    const result = runToolInput({ subagent_type: 'custom-worker', prompt: 'Read' }, (root) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\n---\nRead.\n')
    })
    expectModelWarning(result)
  })

  it('treats a custom agent frontmatter model of inherit as unpinned', () => {
    const result = runToolInput({ subagent_type: 'custom-worker', prompt: 'Read' }, (root) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\nmodel: inherit\n---\nRead.\n')
    })
    expectModelWarning(result)
  })

  it('resolves a third-party plugin agent through its installed definition', () => {
    const result = runToolInput({ subagent_type: 'example-plugin:worker', prompt: 'Read' }, (root) => {
      const plugin = join(root, 'plugin-install')
      const config = join(root, 'claude-config', 'plugins')
      mkdirSync(join(plugin, 'agents'), { recursive: true })
      mkdirSync(config, { recursive: true })
      writeFileSync(join(plugin, 'agents', 'worker.md'), '---\nname: worker\nmodel: opus\n---\nRead.\n')
      writeFileSync(join(config, 'installed_plugins.json'), JSON.stringify({ plugins: { 'example-plugin@market': [{ installPath: plugin }] } }))
      mkdirSync(join(config, 'marketplaces', 'market', '.claude-plugin'), { recursive: true })
      writeFileSync(join(config, 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'example-plugin' }] }))
    })
    expectSilentModelPin(result)
  })

  it('warns for an installed third-party plugin agent without a frontmatter model pin', () => {
    const result = runToolInput({ subagent_type: 'example-plugin:worker', prompt: 'Read' }, (root) => {
      const plugin = join(root, 'plugin-install')
      const config = join(root, 'claude-config', 'plugins')
      mkdirSync(join(plugin, 'agents'), { recursive: true })
      mkdirSync(config, { recursive: true })
      writeFileSync(join(plugin, 'agents', 'worker.md'), '---\nname: worker\n---\nRead.\n')
      writeFileSync(join(config, 'installed_plugins.json'), JSON.stringify({ plugins: { 'example-plugin@market': [{ installPath: plugin }] } }))
      mkdirSync(join(config, 'marketplaces', 'market', '.claude-plugin'), { recursive: true })
      writeFileSync(join(config, 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'example-plugin' }] }))
    })
    expectModelWarning(result)
  })

  it('fails open for a type with no resolvable definition', () => {
    expectSilentModelPin(run('missing-agent-type', 'Read'))
  })

  it('warns rather than denies an unpinned general-purpose spawn with a reason', () => {
    expectModelWarning(run('general-purpose', 'general-purpose because: no specialist fits'))
  })

  it('never replaces the existing general-purpose refusal with a model-pin warning', () => {
    const result = run('general-purpose', 'Implement this.')
    expect(result.stdout).not.toContain('model pin')
    expect(result.journal).not.toContain('model-unpinned')
    expectModelWarning(run('workflow-toolbox:leaf-readonly'))
  })

  it('honors a project Explore definition before the built-in, including an unpinned control', () => {
    const projectAgent = (model: string) => (root: string) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'Explore.md'), `---\nname: Explore\ndescription: Search the project.\n${model}---\nRead.\n`)
    }
    expectSilentModelPin(runToolInput({ subagent_type: 'Explore' }, projectAgent('model: sonnet\n')))
    expectModelWarning(runToolInput({ subagent_type: 'Explore' }, projectAgent('')))
  })

  it.each([['empty', ''], ['absent', undefined]])('warns for %s implicit general-purpose with a reason', (_label, type) => {
    const prompt = 'general-purpose because: no specialist fits'
    const result = run(type, prompt)
    expectModelWarning(result)
    expect(result.stdout).toContain('no subagent_type')
    expectSilentModelPin(run(type, prompt, 'sonnet'))
  })

  it('parses an inline YAML comment on inherit instead of treating it as a pin', () => {
    const result = runToolInput({ subagent_type: 'custom-worker' }, (root) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\nmodel: inherit # comment\n---\nRead.\n')
    })
    expectModelWarning(result)
  })

  it('resolves a nested file by frontmatter identity, pinned and unpinned', () => {
    const nestedAgent = (model: string) => (root: string) => {
      const agents = join(root, '.claude', 'agents', 'sub', 'dir')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'file-name.md'), `---\nname: nested-worker\ndescription: Read nested files.\n${model}---\nRead.\n`)
    }
    expectSilentModelPin(runToolInput({ subagent_type: 'nested-worker' }, nestedAgent('model: opus\n')))
    expectModelWarning(runToolInput({ subagent_type: 'nested-worker' }, nestedAgent('')))
  })

  it('stays silent when the matching definition has malformed frontmatter', () => {
    const result = runToolInput({ subagent_type: 'custom-worker' }, (root) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: [broken\n---\nRead.\n')
    })
    expectSilentModelPin(result)
  })

  it('lets spawn-level inherit override a pinned definition', () => {
    const projectAgent = (root: string) => {
      const agents = join(root, '.claude', 'agents')
      mkdirSync(agents, { recursive: true })
      writeFileSync(join(agents, 'custom-worker.md'), '---\nname: custom-worker\ndescription: Read.\nmodel: sonnet\n---\nRead.\n')
    }
    expectModelWarning(runToolInput({ subagent_type: 'custom-worker', model: 'inherit' }, projectAgent))
    expectSilentModelPin(runToolInput({ subagent_type: 'custom-worker' }, projectAgent))
  })

  it('fails open for thrown and explicitly unresolved definitions', () => {
    expect(resolveAgentModelPin('custom-worker', { resolve: () => { throw Error('read failed') } })).toEqual({ status: 'unknown', type: 'custom-worker' })
    expect(resolveAgentModelPin('custom-worker', { resolve: () => ({ unresolved: 'x' }) })).toEqual({ status: 'unknown', type: 'custom-worker' })
    expectModelWarning(run('workflow-toolbox:leaf-readonly'))
  })

  describe('model precedence and built-in defaults', () => {
    const missing = () => null
    const noModel = () => ({ data: {} })
    const model = (value: unknown) => () => ({ data: { model: value } })
    const pin = (type: string, resolve: () => unknown, env: NodeJS.ProcessEnv = {}, requestedModel?: string) =>
      resolveAgentModelPin(type, { resolve, env, requestedModel })

    it.each(['statusline-setup', 'claude-code-guide'])('uses the own default of %s', (type) => {
      expect(pin(type, missing)).toEqual({ status: 'pinned', type })
    })

    it.each(['Explore', 'Plan'])('does not let the environment default override built-in %s', (type) => {
      expect(pin(type, missing, { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })).toEqual({ status: 'unpinned', type })
    })

    it.each(['general-purpose', 'claude'])('uses the environment default for built-in %s', (type) => {
      expect(pin(type, missing, { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })).toEqual({ status: 'pinned', type })
      expect(pin(type, missing)).toEqual({ status: 'unpinned', type })
    })

    it('lets a user definition shadow a built-in default', () => {
      expect(pin('statusline-setup', noModel)).toEqual({ status: 'unpinned', type: 'statusline-setup' })
    })

    it.each([noModel, model(''), model('null'), model('~')])('uses the environment default when a definition has no model pin', (resolve) => {
      expect(pin('worker', resolve, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })).toEqual({ status: 'pinned', type: 'worker' })
    })

    it.each(['inherit', ''])('treats environment default %s as unset', (defaultModel) => {
      expect(pin('worker', noModel, { CLAUDE_CODE_SUBAGENT_MODEL: defaultModel })).toEqual({ status: 'unpinned', type: 'worker' })
    })

    it('does not let the environment default override explicit inherit at spawn or definition', () => {
      const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }
      expect(pin('worker', model('sonnet'), env, 'inherit')).toEqual({ status: 'unpinned', type: 'worker' })
      expect(pin('worker', model('inherit'), env)).toEqual({ status: 'unpinned', type: 'worker' })
    })

    it('forces the environment model over explicit pins and built-in defaults', () => {
      const env = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }
      expect(pin('worker', model('inherit'), env, 'sonnet')).toEqual({ status: 'pinned', type: 'worker' })
      expect(pin('Explore', missing, env)).toEqual({ status: 'pinned', type: 'Explore' })
    })

    it('forces the main model when the environment model is unset or inherit', () => {
      for (const defaultModel of [undefined, 'inherit']) {
        const env = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_SUBAGENT_MODEL: defaultModel }
        expect(pin('worker', model('sonnet'), env, 'opus')).toEqual({ status: 'unpinned', type: 'worker' })
      }
    })

    it('exempts fork even when its definition has no model and force is enabled', () => {
      expect(pin('fork', noModel, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })).toEqual({ status: 'exempt', type: 'fork' })
    })

    it('treats tilde as YAML null without an environment default', () => {
      expect(pin('worker', model('~'))).toEqual({ status: 'unpinned', type: 'worker' })
    })
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
