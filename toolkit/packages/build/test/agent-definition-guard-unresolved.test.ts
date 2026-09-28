import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../../../')

describe('guard unresolved definitions', () => {
  it('journals an opaque observer instead of trying the pairing checker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-opaque-observer-'))
    try {
      const agents = path.join(dir, '.claude', 'agents')
      const journal = path.join(dir, 'journal')
      fs.mkdirSync(agents, { recursive: true })
      fs.writeFileSync(path.join(agents, 'pilot.md'), '---\nname: pilot\ndescription: worker\nobserver: {unknown: shape}\n---\n')
      const result = spawnSync(process.execPath, [path.join(root, 'plugin', 'bin', 'wt-observer-pairing-guard-hook.mjs')], {
        input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent', cwd: dir, session_id: 's', transcript_path: path.join(dir, 'session.jsonl'), tool_input: { subagent_type: 'pilot', name: 'pilot' }, tool_response: { agent_id: 'a' } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), WT_GUARD_JOURNAL_DIR: journal },
      })
      expect(result.stdout).toContain('unresolved')
      const entries = fs.readdirSync(journal).flatMap((file) => fs.readFileSync(path.join(journal, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'unresolved' })]))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it.each([
    ['wt-spawn-capability-guard-hook.mjs', 'Write your report to /tmp/report.md', 'PreToolUse'],
    ['wt-spawn-readonly-guard-hook.mjs', 'Investigate read-only', 'PreToolUse'],
    ['wt-spawn-channel-guard-hook.mjs', 'Report when done', 'PreToolUse'],
    ['wt-observer-pairing-guard-hook.mjs', 'Report when done', 'PostToolUse'],
  ])('%s journals unresolved rather than silently allowing', (hook, prompt, event) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-unresolved-'))
    try {
      const agents = path.join(dir, '.claude', 'agents')
      const journal = path.join(dir, 'journal')
      fs.mkdirSync(agents, { recursive: true })
      fs.writeFileSync(path.join(agents, 'pilot.md'), '---\nname: pilot\nunknown: [\n---\n')
      const result = spawnSync(process.execPath, [path.join(root, 'plugin', 'bin', hook)], {
        input: JSON.stringify({ hook_event_name: event, tool_name: 'Agent', cwd: dir, session_id: 's', transcript_path: path.join(dir, 'session.jsonl'), tool_input: { subagent_type: 'pilot', prompt, name: 'pilot' }, tool_response: { agent_id: 'a' } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), WT_GUARD_JOURNAL_DIR: journal },
      })
      expect(result.stdout).toContain('unresolved')
      const entries = fs.readdirSync(journal).flatMap((file) => fs.readFileSync(path.join(journal, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'unresolved' })]))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it.each(['different.md', '"name"', 'unreadable subtree'])('readonly guard reports unresolved with %s', (variant) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-renamed-guard-'))
    try {
      const agents = path.join(dir, '.claude', 'agents')
      const journal = path.join(dir, 'journal')
      fs.mkdirSync(agents, { recursive: true })
      if (variant === 'unreadable subtree') fs.symlinkSync('missing', path.join(agents, 'review'))
      else fs.writeFileSync(path.join(agents, variant === 'different.md' ? variant : 'quoted.md'), `---\n${variant === '"name"' ? '"name"' : 'name'}: pilot\ndescription: [broken\n---\n`)
      const result = spawnSync(process.execPath, [path.join(root, 'plugin/bin/wt-spawn-readonly-guard-hook.mjs')], {
        input: JSON.stringify({ tool_name: 'Agent', cwd: dir, session_id: 's', tool_input: { subagent_type: 'pilot', prompt: 'Investigate read-only' } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), WT_GUARD_JOURNAL_DIR: journal },
      })
      expect(result.stdout).toContain('unresolved')
      const events = fs.readdirSync(journal).flatMap((file) => fs.readFileSync(path.join(journal, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'unresolved' })]))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('channel guard accepts inherited wildcard tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-wildcard-guard-'))
    try {
      const agents = path.join(dir, '.claude/agents')
      fs.mkdirSync(agents, { recursive: true })
      fs.writeFileSync(path.join(agents, 'pilot.md'), '---\nname: pilot\ndescription: worker\ntools: "*"\n---\n')
      const result = spawnSync(process.execPath, [path.join(root, 'plugin/bin/wt-spawn-channel-guard-hook.mjs')], {
        input: JSON.stringify({ tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'pilot', prompt: 'Report when done' } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config') },
      })
      expect(result.stdout).toBe('')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it.each(['disallowedTools: [SendMessage]', 'disallowedTools: SendMessage', 'disallowedTools: {SendMessage: true}'])('A10 warns when inherited messaging is denied or opaque: %s', (denial) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-denied-channel-'))
    try {
      const agents = path.join(dir, '.claude/agents')
      fs.mkdirSync(agents, { recursive: true })
      fs.writeFileSync(path.join(agents, 'pilot.md'), `---\nname: pilot\ndescription: worker\n${denial}\n---\n`)
      const result = spawnSync(process.execPath, [path.join(root, 'plugin/bin/wt-spawn-channel-guard-hook.mjs')], {
        input: JSON.stringify({ tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'pilot', prompt: 'Report when done' } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config') },
      })
      expect(result.stdout).toContain(denial.includes('{') ? 'unresolved' : 'no SendMessage')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
