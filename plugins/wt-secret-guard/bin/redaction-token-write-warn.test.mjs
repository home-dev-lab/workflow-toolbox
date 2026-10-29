import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const token = 'secret:' + 'assignment' + '#' + 'b1c2d3'
const wrapper = path.join(import.meta.dirname, 'redaction-token-write-warn.mjs')
const payload = (name, data) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: data, cwd: os.tmpdir() })
const run = input => spawnSync(process.execPath, [wrapper], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000 })

test('shipped wrapper warns only using additionalContext for all generic surfaces', () => {
  const cases = [['Write', { content: token }], ['Edit', { new_string: token }], ['MultiEdit', { edits: [{ new_string: token }] }], ['NotebookEdit', { new_source: token }], ['Bash', { command: `git commit -m '${token}'` }], ['mcp__atrium__speak', { text: token }]]
  for (const [name, data] of cases) {
    const result = run(payload(name, data))
    assert.equal(result.status, 0, 'shipped wrapper must exit zero')
    const output = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(output), ['hookSpecificOutput'])
    assert.deepEqual(Object.keys(output.hookSpecificOutput), ['hookEventName', 'additionalContext'])
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse')
    const text = output.hookSpecificOutput.additionalContext
    for (const word of ['warn-only', 'went through', 'REPAIR', 'never guess', 'grep -nE']) assert.ok(text.includes(word))
    assert.equal(text.includes(token), false)
    assert.equal(result.stderr, '')
  }
})

test('shipped wrapper is silent for malformed clean exempt and unsupported calls', () => {
  const cases = ['{', payload('Write', { content: 'clean' }), payload('Write', { content: token, file_path: 'plugins/wt-secret-guard/docs/a.md' }), payload('Bash', { command: `printf '%s' '${token}'` }), payload('mcp__other__comment', { text: token }), { ...payload('Write', { content: token }), hook_event_name: 'PostToolUse' }]
  for (const input of cases) {
    const result = run(input)
    assert.equal(result.status, 0, 'silent shipped wrapper must exit zero')
    assert.equal(result.stdout + result.stderr, '')
  }
})

test('F7 shipped closed stdout exits zero with empty stderr', async () => {
  const child = spawn(process.execPath, [wrapper], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.destroy()
  const closed = new Promise(resolve => child.on('close', code => resolve(code)))
  child.stdin.end(JSON.stringify(payload('Write', { content: token })))
  assert.equal(await closed, 0, 'F7: closed stdout must exit zero')
  assert.equal(stderr, '', 'F7: closed stdout must not emit stderr')
})

test('shipped wrapper silently survives missing core import', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-shipped-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.copyFileSync(wrapper, path.join(dir, 'wrapper.mjs'))
  const result = spawnSync(process.execPath, [path.join(dir, 'wrapper.mjs')], { input: JSON.stringify(payload('Write', { content: token })), encoding: 'utf8' })
  assert.equal(result.status, 0, 'missing shipped core must exit zero')
  assert.equal(result.stdout + result.stderr, '')
})

test('plugin registers all persisted generic tools with a five-second timeout', () => {
  const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../.claude-plugin/plugin.json'), 'utf8'))
  assert.ok(config.hooks.PreToolUse, 'PreToolUse matcher must be registered')
  const entry = config.hooks.PreToolUse[0]
  const tools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'mcp__plugin_atrium_atrium__speak', 'mcp__plugin_atrium_atrium__amend_held_message', 'mcp__plugin_atrium_atrium__edit_message', 'mcp__atrium__speak']
  assert.deepEqual(entry.matcher.split('|'), tools)
  assert.equal(entry.hooks[0].timeout, 5)
  assert.equal(entry.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/redaction-token-write-warn.mjs"')
  assert.ok(config.hooks.SessionStart)
})
