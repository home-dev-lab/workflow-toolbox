import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { scanPlugin, scanSource, type Justifications } from './helpers/hook-output-scan.js'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error runtime helper has no declaration file
import { prepareSdkRole } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'

const PLUGIN = fileURLToPath(new URL('../../../../plugin', import.meta.url))
const SCAN_ROOT = process.env.WT_HOOK_OUTPUT_ROOT ?? PLUGIN
const roots: string[] = []
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'wt-hook-output-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function runScript(root: string, script: string, input?: unknown) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', cwd: root, input: JSON.stringify(input),
    env: sealedPluginCliEnv(root, { CLAUDE_PLUGIN_DATA: join(root, 'plugin-data'), WT_GUARD_MODE: 'enforce', WT_ADOPT_REFRESH: 'notice-only', WT_GUARD_JOURNAL_DIR: join(root, 'journal') }),
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

function moduleUrl(file: string) { return JSON.stringify(pathToFileURL(join(PLUGIN, file)).href) }

function proveJournalProjection() {
  const root = scratch()
  const parsed = runScript(root, `import { emitGuardNotice } from ${moduleUrl('bin/lib/guard-journal.mjs')};
    emitGuardNotice({payload: {agent_id: 'child'}, reachSubagents: true, stdoutJson: {
      hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: 'fixture', permissionDecision: 'deny'}
    }});`)
  expect(parsed).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'fixture' } })
}

function proveAdoptEvents() {
  const root = scratch()
  for (const event of ['SessionStart', 'PostToolUse']) {
    const parsed = runScript(root, `import { main } from ${moduleUrl('bin/wt-adopt-check-hook.mjs')}; main();`, {
      hook_event_name: event, source: 'startup', tool_name: 'Bash', cwd: root, tool_input: { command: 'git push public HEAD:main' },
    })
    expect(parsed.hookSpecificOutput.hookEventName).toBe(event)
    expect(parsed.hookSpecificOutput.additionalContext).toEqual(expect.any(String))
  }
}

async function proveSdkFallback() {
  const root = scratch()
  const context = join(root, 'context-mode')
  mkdirSync(join(context, '.claude-plugin'), { recursive: true })
  mkdirSync(join(context, 'hooks'))
  writeFileSync(join(context, '.claude-plugin/plugin.json'), '{}')
  writeFileSync(join(context, 'hooks/hooks.json'), '{}')
  const prepared = prepareSdkRole('tdd', {
    worktree: root, exists: () => true, env: { ...sealedPluginCliEnv(root), WT_CONTEXT_MODE_ROOT: context },
    adapterOptions: { runScript: async () => ({ code: 1, stdout: '', stderr: 'fixture failure' }), log: () => {} },
  })
  const callback = prepared.hooks.PreToolUse[0].hooks[0]
  for (const input of [{ hook_event_name: 'PreToolUse' }, {}]) {
    const parsed = JSON.parse(JSON.stringify(await callback(input)))
    expect(parsed.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
  }
}

const JUSTIFIED: Justifications = new Map([
  ['bin/lib/guard-journal.mjs:output.hookEventName', {
    reason: 'Subagent projection copies the event from the statically checked caller envelope; serialized opt-in route exercised here.', prove: proveJournalProjection,
  }],
  ['bin/wt-adopt-check-hook.mjs:event', {
    reason: 'resolveEvent selects SessionStart or PostToolUse; both real hook output routes are parsed here.', prove: proveAdoptEvents,
  }],
  ["bin/lib/sdk-role-profile.mjs:input?.hook_event_name ?? 'PreToolUse'", {
    reason: 'SDK fallback echoes the registered input event, defaulting to PreToolUse; callback results are serialized here.', prove: proveSdkFallback,
  }],
])

it('every plugin hookSpecificOutput emission carries its registered hookEventName', () => {
  const result = scanPlugin(SCAN_ROOT, JUSTIFIED)
  expect(result.emissions).toBeGreaterThan(40)
  expect(result.problems, result.problems.join('\n')).toEqual([])
  expect([...result.justified].sort()).toEqual([...JUSTIFIED.keys()].sort())
})

it.each([...JUSTIFIED])('serialized dynamic event contract: %s', async (_key, entry) => { await entry.prove() })

const RULE_DECISIONS: Array<Record<string, unknown> | undefined> = [undefined, {}, { hookEventName: undefined }, { hookEventName: 'PostToolUse', permissionDecision: 'deny' }]
it.each(RULE_DECISIONS)(
  'rule decision writer owns the event regardless of caller input: %j', (decision) => {
    const parsed = runScript(scratch(), `import { writeRuleDecision } from ${moduleUrl('bin/lib/host/rule-narrative-process.mjs')};
      writeRuleDecision(${decision === undefined ? 'undefined' : JSON.stringify(decision)});`)
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    if (decision?.permissionDecision) expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  },
)

const invalidSources = [
  ['missing field', 'write({hookSpecificOutput: {permissionDecision: "deny"}})'],
  ['unresolved shorthand', 'write({hookSpecificOutput})'],
  ['conditional bad branch', 'write({hookSpecificOutput: warn ? {hookEventName: "PreToolUse"} : {}})'],
  ['bad local initializer', 'function f() {const output = {}; write({hookSpecificOutput: output})}'],
  ['bad local reassignment', 'function f() {let output = {hookEventName: "PreToolUse"}; output = {}; write({hookSpecificOutput: output})}'],
  ['conditional event assignment', 'function f() {const output = {}; if (warn) output.hookEventName = "PreToolUse"; write({hookSpecificOutput: output})}'],
  ['spread overrides event', 'write({hookSpecificOutput: {hookEventName: "PreToolUse", ...unknown}})'],
  ['spread assigns undefined', 'write({hookSpecificOutput: {hookEventName: "PreToolUse", ...{hookEventName: undefined}}})'],
  ['element assignment', 'out["hookSpecificOutput"] = unresolved'],
  ['resolved element key', 'function f(){const key = "hookSpecificOutput"; out[key] = unresolved}'],
  ['member assignment', 'out.hookSpecificOutput = {}'],
  ['JSON missing field', 'write(\'{"hookSpecificOutput":{}}\')'],
  ['JSON sibling field', 'write(\'{"hookSpecificOutput":{},"hookEventName":"PreToolUse"}\')'],
  ['JSON second bad envelope', 'write(\'[{"hookSpecificOutput":{"hookEventName":"PreToolUse"}},{"hookSpecificOutput":{}}]\')'],
  ['wrong registration', 'write({hookSpecificOutput: {hookEventName: "Stop"}})'],
  ['non-literal event', 'write({hookSpecificOutput: {hookEventName: event}})'],
]
it.each(invalidSources)('scanner rejects %s', (_name, source) => {
  expect(scanSource('fixture.mjs', source!, new Set(['PreToolUse'])).problems.length).toBeGreaterThan(0)
})

it.each([
  'write({hookSpecificOutput: warn ? {hookEventName: "PreToolUse"} : {hookEventName: "PreToolUse"}})',
  'function f(){const output = {hookEventName: "PreToolUse"}; output.additionalContext = "context"; write({hookSpecificOutput: output})}',
  'function f(){const output = warn ? {additionalContext: "context"} : {permissionDecision: "deny"}; write({hookSpecificOutput: {hookEventName: "PreToolUse", ...output}})}',
  'write({hookSpecificOutput: {...unknown, hookEventName: "PreToolUse"}})',
  'function f(){const hookSpecificOutput = {hookEventName: "PreToolUse"}; write({hookSpecificOutput})}',
  'out["hookSpecificOutput"] = {hookEventName: "PreToolUse"}',
])('scanner accepts supported construction %s', (source) => {
  expect(scanSource('fixture.mjs', source, new Set(['PreToolUse'])).problems).toEqual([])
})

function pluginCopy() {
  const root = scratch()
  cpSync(join(PLUGIN, 'bin'), join(root, 'bin'), { recursive: true })
  cpSync(join(PLUGIN, '.claude-plugin'), join(root, '.claude-plugin'), { recursive: true })
  return root
}

it('family lock catches one removed event on a disposable plugin copy', () => {
  const root = pluginCopy()
  const file = join(root, 'bin/wt-version-guard-hook.mjs')
  const original = readFileSync(file, 'utf8')
  expect(scanPlugin(root, JUSTIFIED).problems).toEqual([])
  writeFileSync(file, original.replace("hookEventName: 'PreToolUse', ", ''))
  const result = scanPlugin(root, JUSTIFIED)
  expect(result.problems).toEqual([expect.stringMatching(/bin\/wt-version-guard-hook\.mjs:\d+: hookSpecificOutput requires a provable hookEventName/)])
  writeFileSync(file, original)
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(scanPlugin(root, JUSTIFIED).problems).toEqual([])
})

it('registration coverage refuses a new unsupported hook executable', () => {
  const root = pluginCopy()
  const manifest = join(root, '.claude-plugin/plugin.json')
  const value = JSON.parse(readFileSync(manifest, 'utf8'))
  value.hooks.PreToolUse.push({ hooks: [{ command: 'python "${CLAUDE_PLUGIN_ROOT}/bin/new-hook.py"' }] })
  writeFileSync(manifest, JSON.stringify(value))
  expect(scanPlugin(root, JUSTIFIED).problems).toContain('bin/new-hook.py: registered hook executable type is unsupported')
})

it('automatically covers a newly added emitter outside the current guard names', () => {
  const root = pluginCopy()
  writeFileSync(join(root, 'bin/new-hook.mjs'), 'write({hookSpecificOutput: {additionalContext: "fixture"}})')
  expect(scanPlugin(root, JUSTIFIED).problems).toContainEqual(expect.stringContaining('bin/new-hook.mjs:1: hookSpecificOutput requires'))
})
