import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error Standalone plugin helpers have no declaration surface.
import { detectedMcpServerNames, initUserRegistry, loadGroundingRegistry, loadGroundingRegistryReport, outboundClaimTool, transcriptGroundingStatus } from '../../../../plugin/bin/lib/grounding-sources.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PROMPT_HOOK = join(REPO_ROOT, 'plugin/bin/wt-grounding-prompt-hook.mjs')
const SEND_HOOK = join(REPO_ROOT, 'plugin/bin/wt-grounding-pre-send-hook.mjs')
const SOURCES_CLI = join(REPO_ROOT, 'plugin/bin/wt-grounding-sources.mjs')
const roots: string[] = []

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = join(tmpdir(), `wt-grounding-${process.pid}-${Math.random().toString(16).slice(2)}`)
  roots.push(root)
  const pluginRoot = join(root, 'plugin')
  const configDir = join(root, 'config')
  const projectDir = join(root, 'project')
  const stateDir = join(root, 'state')
  mkdirSync(join(pluginRoot, 'config'), { recursive: true })
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const defaults = [
    { family: 'docs', query: 'rg {{query}} .', holds: 'docs', stale_after_days: 30 },
    { family: 'repo', query: 'git log --all -S {{query}}', holds: 'history', stale_after_days: 7 },
  ]
  writeFileSync(join(pluginRoot, 'config', 'grounding-sources.json'), JSON.stringify(defaults))
  return {
    root, pluginRoot, configDir, projectDir, stateDir,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_OPTION_GROUNDING_SOURCES: join(configDir, 'grounding-sources.json'),
      WT_GROUNDING_STATE_DIR: stateDir,
      WT_GUARD_JOURNAL_DIR: join(stateDir, 'guard-journal'),
      WT_GUARD_JOURNAL_TEST_ORIGIN: '1',
      WT_GROUNDING_DEFAULT_REGISTRY: join(pluginRoot, 'config', 'grounding-sources.json'),
      PATH: join(root, 'empty-bin'),
    },
  }
}

function runHook(file: string, payload: unknown, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [file], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

function transcript(file: string, records: unknown[]) {
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const tool = (name: string, input: unknown = {}) => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
})

describe('deep-grounding source registry', () => {
  it('lets the user override defaults while project entries can only add families', () => {
    const f = fixture()
    writeFileSync(join(f.configDir, 'grounding-sources.json'), JSON.stringify([
      { family: 'repo', query: 'git show {{query}}', holds: 'user history', stale_after_days: 5 },
      { family: 'tickets', query: 'mcp__jira__search', holds: 'tickets', stale_after_days: 2 },
    ]))
    writeFileSync(join(f.projectDir, '.claude', 'grounding-sources.json'), JSON.stringify([
      { family: 'repo', query: 'git grep {{query}}', holds: 'project code', stale_after_days: 1 },
    ]))

    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    expect(entries.map((entry: { family: string; layer: string; query: string }) => [entry.family, entry.layer, entry.query])).toEqual([
      ['docs', 'plugin', 'rg {{query}} .'],
      ['repo', 'user', 'git show {{query}}'],
      ['tickets', 'user', 'mcp__jira__search'],
    ])
  })

  it('warns when a registry layer or entry is dropped', () => {
    const f = fixture()
    writeFileSync(join(f.configDir, 'grounding-sources.json'), JSON.stringify([
      { family: 'broken', query: '', holds: 'nothing', stale_after_days: 1 },
    ]))
    writeFileSync(join(f.projectDir, '.claude', 'grounding-sources.json'), '{bad json')
    const report = loadGroundingRegistryReport({ cwd: f.projectDir, env: f.env })
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('user entry 1'), expect.stringContaining('project layer'),
    ]))
  })

  it('resolves the user registry from plugin settings when the hook env export is absent', () => {
    const f = fixture()
    const registry = join(f.root, 'chosen.json')
    writeFileSync(registry, JSON.stringify([{ family: 'chosen', query: 'git log {{query}}', holds: 'x', stale_after_days: 1 }]))
    writeFileSync(join(f.configDir, 'settings.json'), JSON.stringify({
      pluginConfigs: { 'workflow-toolbox@test': { options: { grounding_sources: registry } } },
    }))
    const env: NodeJS.ProcessEnv = { ...f.env }
    delete env.CLAUDE_PLUGIN_OPTION_GROUNDING_SOURCES
    expect(loadGroundingRegistry({ cwd: f.projectDir, env }).some((entry: { family: string }) => entry.family === 'chosen')).toBe(true)
  })

  it('flags a missing binary or MCP tool without claiming present', () => {
    const f = fixture()
    writeFileSync(join(f.configDir, 'grounding-sources.json'), JSON.stringify([
      { family: 'tickets', query: 'mcp__jira__search', holds: 'tickets', stale_after_days: 2 },
    ]))
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env, availableTools: ['mcp__memory__search'] })
    expect(entries.find((entry: { family: string }) => entry.family === 'docs').missing).toBe(true)
    expect(entries.find((entry: { family: string }) => entry.family === 'tickets').missing).toBe(true)
  })

  it('init never overwrites an existing user registry', () => {
    const f = fixture()
    const target = join(f.configDir, 'grounding-sources.json')
    writeFileSync(target, 'keep me')
    expect(initUserRegistry({ target, env: f.env, configDir: f.configDir })).toMatchObject({ written: false, reason: 'exists' })
    expect(readFileSync(target, 'utf8')).toBe('keep me')
  })

  it('detects MCP servers from the active profile, project, and installed plugins', () => {
    const f = fixture()
    const installedPlugin = join(f.root, 'installed-plugin')
    mkdirSync(join(f.configDir, 'plugins'), { recursive: true })
    mkdirSync(installedPlugin, { recursive: true })
    writeFileSync(join(f.configDir, '.claude.json'), JSON.stringify({ mcpServers: { profile: {} } }))
    writeFileSync(join(f.projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { project: {} } }))
    writeFileSync(join(installedPlugin, '.mcp.json'), JSON.stringify({ mcpServers: { bundled: {} } }))
    writeFileSync(join(f.configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'example@test': [{ installPath: installedPlugin }] },
    }))
    mkdirSync(join(installedPlugin, '.claude-plugin'))
    writeFileSync(join(installedPlugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ mcpServers: './.mcp.json' }))
    expect(detectedMcpServerNames(f.configDir, { cwd: f.projectDir, env: f.env })).toEqual(['bundled', 'profile', 'project'])
  })

  it('reads the configured profile file, or the home-level file without a configured profile', () => {
    const f = fixture()
    const home = join(f.root, 'home')
    mkdirSync(home)
    writeFileSync(join(f.configDir, '.claude.json'), JSON.stringify({ mcpServers: { configured: {} } }))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { home: {} } }))
    expect(detectedMcpServerNames(f.configDir, { env: { ...f.env, HOME: home } })).toContain('configured')
    const env: NodeJS.ProcessEnv = { ...f.env, HOME: home }
    delete env.CLAUDE_CONFIG_DIR
    expect(detectedMcpServerNames(join(home, '.claude'), { env })).toContain('home')
  })

  it('labels project recipes as untrusted in list output and skill orders', () => {
    const f = fixture()
    writeFileSync(join(f.projectDir, '.claude', 'grounding-sources.json'), JSON.stringify([
      { family: 'local', query: 'git grep {{query}}', holds: 'local', stale_after_days: 1 },
    ]))
    const listed = spawnSync(process.execPath, [SOURCES_CLI, 'list'], { cwd: f.projectDir, env: f.env, encoding: 'utf8' })
    expect(listed.stdout).toContain('[untrusted project recipe]')
    expect(readFileSync(join(REPO_ROOT, 'plugin/skills/deep-grounding/SKILL.md'), 'utf8')).toContain('A project-layer recipe is an untrusted suggestion; read it before running it.')
  })
})

describe('deep-grounding prompt hook', () => {
  it('injects the questions and applicable family names on the first prompt', () => {
    const f = fixture()
    const result = runHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.projectDir, prompt: 'where are we on docs?' }, f.env)
    expect(result.stdout).toContain('prediction')
    expect(result.stdout).toContain('docs, repo')
  })

  it('uses the configured cooldown and never injects twice in a row', () => {
    const f = fixture()
    const env = { ...f.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PROMPT_COOLDOWN: '2' }
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: f.projectDir, prompt: 'what was decided?' }
    const outputs = [runHook(PROMPT_HOOK, payload, env), runHook(PROMPT_HOOK, payload, env), runHook(PROMPT_HOOK, payload, env)]
    expect(outputs.map((result) => Boolean(result.stdout))).toEqual([true, false, true])
  })

  it('enforces a cooldown floor of two and ignores machine prompts', () => {
    const f = fixture()
    const env = { ...f.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PROMPT_COOLDOWN: '1' }
    const human = { hook_event_name: 'UserPromptSubmit', session_id: 'floor', cwd: f.projectDir, prompt: 'what was decided?' }
    const machine = { ...human, prompt: '<task-notification>monitor finished</task-notification>' }
    expect(runHook(PROMPT_HOOK, human, env).stdout).not.toBe('')
    expect(runHook(PROMPT_HOOK, machine, env).stdout).toBe('')
    expect(runHook(PROMPT_HOOK, human, env).stdout).toBe('')
    expect(runHook(PROMPT_HOOK, human, env).stdout).not.toBe('')
  })

  it('re-fires first-context guidance after a transcript compaction', () => {
    const f = fixture()
    const transcriptPath = join(f.root, 'prompt.jsonl')
    transcript(transcriptPath, [user('first')])
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'compact', cwd: f.projectDir, transcript_path: transcriptPath, prompt: 'first' }
    expect(runHook(PROMPT_HOOK, payload, f.env).stdout).toContain('Applicable source families')
    appendFileSync(transcriptPath, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'compact-1' })}\n`)
    expect(runHook(PROMPT_HOOK, { ...payload, prompt: 'after compact' }, f.env).stdout).toContain('Applicable source families')
  })

  it('does not journal prompt injections as guard firings', () => {
    const f = fixture()
    runHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 's3', cwd: f.projectDir, prompt: 'does X exist?' }, f.env)
    expect(readdirSync(f.stateDir)).not.toContain('guard-journal')
  })

  it('does not re-fire first-context guidance when a capped transcript key becomes unknown', () => {
    const f = fixture()
    const transcriptPath = join(f.root, 'growing.jsonl')
    transcript(transcriptPath, [user('first')])
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'growing', cwd: f.projectDir, transcript_path: transcriptPath, prompt: 'first' }
    expect(runHook(PROMPT_HOOK, payload, f.env).stdout).toContain('Applicable source families')
    appendFileSync(transcriptPath, `${'x'.repeat(2 * 1024 * 1024 + 1)}\n`)
    expect(runHook(PROMPT_HOOK, { ...payload, prompt: 'second' }, f.env).stdout).toBe('')
  })
})

describe('deep-grounding pre-send hook', () => {
  function setup(records: unknown[], envExtra: NodeJS.ProcessEnv = {}) {
    const f = fixture()
    const transcriptPath = join(f.root, 'session.jsonl')
    transcript(transcriptPath, records)
    const payload = {
      hook_event_name: 'PreToolUse', session_id: 'send-session', cwd: f.projectDir,
      transcript_path: transcriptPath, tool_name: 'mcp__plugin_atrium_atrium__speak', tool_input: { message: 'claim' },
    }
    return { f, payload, env: { ...f.env, ...envExtra } }
  }

  it('observes by default without refusing, and refuse mode passes an identical retry', () => {
    const x = setup([user('prepare the reply')])
    expect(runHook(SEND_HOOK, x.payload, x.env).stdout).toBe('')
    const env = { ...x.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse' }
    const first = runHook(SEND_HOOK, x.payload, env)
    const retry = runHook(SEND_HOOK, x.payload, env)
    expect(first.stdout).toContain('"permissionDecision":"deny"')
    expect(retry.stdout).toBe('')
  })

  it('passes when a registry source was queried since the last user message', () => {
    const x = setup([user('prepare the reply'), tool('Bash', { command: 'git log --all -S decision' })])
    expect(runHook(SEND_HOOK, x.payload, x.env).stdout).toBe('')
  })

  it('counts built-in reads, registered MCP reads, and structural shell recipes', () => {
    const f = fixture()
    const file = join(f.root, 'evidence.jsonl')
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    for (const evidence of [
      tool('Read', { file_path: 'README.md' }),
      tool('mcp__planka__get_comments'),
      tool('Bash', { command: "git -C ../repo log -G 'decision' --all" }),
    ]) {
      transcript(file, [user('status?'), evidence])
      expect(transcriptGroundingStatus(file, entries, { installedMcpNames: ['planka'] }).sourceQueried).toBe(true)
    }
  })

  it('skips malformed tail lines and ignores real reaction records as boundaries', () => {
    const f = fixture()
    const file = join(f.root, 'tail.jsonl')
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    transcript(file, [user('status?'), tool('Read'), {
      type: 'user', isMeta: true, origin: { kind: 'channel', server: 'plugin:atrium:atrium' },
      message: { role: 'user', content: '<channel source="plugin:atrium:atrium" room="room" kind="reaction_notice" message_id="1" action="added">\nReaction on your message from Owner: acknowledged\n</channel>' },
    }])
    appendFileSync(file, '{bad json\n')
    expect(transcriptGroundingStatus(file, entries).sourceQueried).toBe(true)
  })

  it('reads backward within a byte cap instead of requiring the whole transcript', () => {
    const f = fixture()
    const file = join(f.root, 'large.jsonl')
    writeFileSync(file, `${'x'.repeat(4096)}\n`)
    appendFileSync(file, `${[user('status?'), tool('Read')].map((record) => JSON.stringify(record)).join('\n')}\n`)
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    expect(transcriptGroundingStatus(file, entries, { byteCap: 1024 }).sourceQueried).toBe(true)
  })

  it('caps injected family names and labels project additions', () => {
    const f = fixture()
    writeFileSync(join(f.projectDir, '.claude', 'grounding-sources.json'), JSON.stringify([
      { family: 'project-only', query: 'git grep {{query}}', holds: 'x', stale_after_days: 1 },
      { family: 'x'.repeat(500), query: 'git grep {{query}}', holds: 'x', stale_after_days: 1 },
    ]))
    const result = runHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 'bounded', cwd: f.projectDir, prompt: 'status?' }, f.env)
    expect(result.stdout).toContain('[untrusted project] project-only')
    expect(result.stdout.length).toBeLessThan(1000)
  })

  it('treats real direct and queued human channel records as new boundaries', () => {
    const f = fixture()
    const file = join(f.root, 'queued.jsonl')
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    const direct = {
      type: 'user', isMeta: true, origin: { kind: 'channel', server: 'plugin:atrium:atrium' },
      message: { role: 'user', content: '<channel source="plugin:atrium:atrium" room="room" count="1">\nOwner: anonymised request\n</channel>' },
    }
    const queued = {
      type: 'attachment', attachment: {
        type: 'queued_command', commandMode: 'prompt', isMeta: true,
        origin: { kind: 'channel', server: 'plugin:atrium:atrium' },
        prompt: '<channel source="plugin:atrium:atrium" room="room" count="1">\nOwner: anonymised follow-up\n</channel>',
      },
    }
    for (const boundary of [direct, queued]) {
      transcript(file, [user('old'), tool('Read'), boundary])
      expect(transcriptGroundingStatus(file, entries).sourceQueried).toBe(false)
    }
  })

  it('ignores queued agent messages as human boundaries', () => {
    const f = fixture()
    const file = join(f.root, 'agent-message.jsonl')
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    transcript(file, [user('status?'), tool('Read'), {
      type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, prompt: '<agent-message from="worker">finished</agent-message>' },
    }])
    expect(transcriptGroundingStatus(file, entries).sourceQueried).toBe(true)
  })

  it('uses the subagent transcript and passes unknown when it is unavailable', () => {
    const x = setup([user('parent'), tool('Read')])
    const agentPath = join(x.f.root, 'agent.jsonl')
    transcript(agentPath, [user('agent task')])
    const env = { ...x.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse' }
    expect(runHook(SEND_HOOK, { ...x.payload, agent_id: 'a1', agent_transcript_path: agentPath }, env).stdout).toBe('')
    expect(runHook(SEND_HOOK, { ...x.payload, agent_id: 'a2' }, env).stdout).toBe('')
  })

  it('canonicalizes retry input keys while subagent notices stay muted', () => {
    const x = setup([user('prepare')])
    const env = { ...x.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse' }
    const first = { ...x.payload, tool_input: { message: 'claim', room: 'x' } }
    expect(runHook(SEND_HOOK, first, env).stdout).toContain('deny')
    expect(runHook(SEND_HOOK, { ...first, tool_input: { room: 'x', message: 'claim' } }, env).stdout).toBe('')
    expect(runHook(SEND_HOOK, { ...first, agent_id: 'a', agent_transcript_path: x.payload.transcript_path }, env).stdout).toBe('')
  })

  it('passes without journaling when the pre-send check is switched off', () => {
    const x = setup([user('prepare the reply')], { CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'off' })
    expect(runHook(SEND_HOOK, x.payload, x.env).stdout).toBe('')
    expect(existsSync(join(x.f.stateDir, 'guard-journal'))).toBe(false)
  })

  it('journals only would-refuse and refused decisions', () => {
    const x = setup([user('prepare the reply')])
    const env = { ...x.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse' }
    runHook(SEND_HOOK, x.payload, env)
    runHook(SEND_HOOK, x.payload, env)
    const files = readdirSync(join(x.f.stateDir, 'guard-journal'))
    const lines = readFileSync(join(x.f.stateDir, 'guard-journal', files[0]!), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map(({ class: classification, decision }: { class: string; decision: string }) => [classification, decision])).toEqual([['refused', 'blocked']])
  })

  it('uses the shared guard emitter for machine-wide observe mode and subagent muting', () => {
    const x = setup([user('prepare the reply')])
    const base = { ...x.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse' }
    expect(runHook(SEND_HOOK, x.payload, { ...base, WT_GUARD_MODE: 'observe' }).stdout).toBe('')
    expect(runHook(SEND_HOOK, { ...x.payload, agent_id: 'a1', agent_transcript_path: x.payload.transcript_path }, base).stdout).toBe('')
    const files = readdirSync(join(x.f.stateDir, 'guard-journal'))
    const lines = files.flatMap((file) => readFileSync(join(x.f.stateDir, 'guard-journal', file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
    expect(lines.every((line: { class: string }) => line.class === 'would-refuse')).toBe(true)
  })

  it('does not treat a source query before the last user message as current grounding', () => {
    const x = setup([tool('Bash', { command: 'git log --all -S old' }), user('new request')])
    expect(runHook(SEND_HOOK, x.payload, { ...x.env, CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse' }).stdout).toContain('"permissionDecision":"deny"')
  })

  it('matches writing tools only and never classifies get_comments as outbound', () => {
    expect(outboundClaimTool({ tool_name: 'mcp__planka__get_comments' })).toBe(false)
    expect(outboundClaimTool({ tool_name: 'mcp__planka__add_comment' })).toBe(true)
    expect(outboundClaimTool({ tool_name: 'mcp__claude_ai_Slack__slack_send_message' })).toBe(true)
  })

  it('matches MCP evidence by exact server segment and excludes utility servers', () => {
    const f = fixture()
    const file = join(f.root, 'mcp-evidence.jsonl')
    const entries = loadGroundingRegistry({ cwd: f.projectDir, env: f.env })
    for (const name of ['mcp__planner__get_issue', 'mcp__time__get_current_time']) {
      transcript(file, [user('status?'), tool(name)])
      expect(transcriptGroundingStatus(file, entries, { installedMcpNames: ['plan', 'time'] }).sourceQueried).toBe(false)
    }
    transcript(file, [user('status?'), tool('mcp__plan__get_issue')])
    expect(transcriptGroundingStatus(file, entries, { installedMcpNames: ['plan'] }).sourceQueried).toBe(true)
  })
})
