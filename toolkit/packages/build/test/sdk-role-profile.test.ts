import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareContextModeFixture } from './helpers/context-mode-fixture.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { composeSdkRoleQueryOptions, prepareSdkRole } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'

prepareContextModeFixture()

const CONTEXT_PREFIX = 'mcp__plugin_context-mode_context-mode__'
const CONTEXT_MODE_TOOLS = {
  batchExecute: `${CONTEXT_PREFIX}ctx_batch_execute`, doctor: `${CONTEXT_PREFIX}ctx_doctor`, execute: `${CONTEXT_PREFIX}ctx_execute`,
  executeFile: `${CONTEXT_PREFIX}ctx_execute_file`, fetchAndIndex: `${CONTEXT_PREFIX}ctx_fetch_and_index`, index: `${CONTEXT_PREFIX}ctx_index`,
  insight: `${CONTEXT_PREFIX}ctx_insight`, purge: `${CONTEXT_PREFIX}ctx_purge`, search: `${CONTEXT_PREFIX}ctx_search`, stats: `${CONTEXT_PREFIX}ctx_stats`,
}
// The callback adapter is reached the way the runner reaches it: through a prepared role's hooks (first writer guard).
const guardHook = (adapterOptions: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), 'wt-guard-hook-')); roots.push(root)
  const prepared = prepareSdkRole('tdd', { worktree: root, adapterOptions })
  return prepared.hooks.PreToolUse[0].hooks[0] as (input: unknown) => Promise<Record<string, unknown>>
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const roles = ['pilot', 'judge', 'tdd', 'harden', 'critic', 'review', 'refutation'] as const
const roleProfile = (role: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wt-role-profile-')); roots.push(root)
  return prepareSdkRole(role, { worktree: root, exists: () => true }).profile
}
const readers = ['judge', 'critic', 'review', 'refutation'] as const
const writers = ['tdd', 'harden'] as const
const requiredGuards = [
  'wt-unquoted-tool-glob-guard-hook.mjs', 'wt-merge-chain-guard-hook.mjs',
  'wt-concurrent-test-guard-hook.mjs', 'wt-piped-gate-exit-code-guard-hook.mjs',
  'wt-pgrep-env-dump-guard-hook.mjs', 'wt-git-commit-backtick-guard-hook.mjs',
  'wt-var-colon-modifier-guard-hook.mjs', 'wt-find-newermt-format-guard-hook.mjs',
  'wt-pipestatus-bash-only-guard-hook.mjs', 'wt-missing-package-script-guard-hook.mjs',
  'wt-main-guard-hook.mjs', 'wt-gate-evidence-guard-hook.mjs',
  'wt-stale-date-guard-hook.mjs', 'wt-rule-convention-guard-hook.mjs',
  'wt-shipped-twin-check-hook.mjs',
]

describe('SDK role profiles', () => {
  it('defines every SDK role from one table', () => {
    for (const role of roles) {
      const profile = roleProfile(role)
      expect(profile).toEqual(expect.objectContaining({ tools: expect.any(Array), guards: expect.any(Array), skills: expect.any(Array), mcpServers: expect.any(Array), readOnly: expect.any(Boolean) }))
    }
    expect(() => roleProfile('unknown')).toThrow('unknown SDK role')
  })

  it('gives readers search-only context access and no writing or execution surface', () => {
    for (const role of readers) {
      const profile = roleProfile(role)
      expect(profile.readOnly).toBe(true)
      expect(profile.tools).toEqual(['Read', 'Glob', 'Grep', CONTEXT_MODE_TOOLS.search])
      expect(profile.tools).not.toContain('Bash')
      expect(profile.tools).not.toContain('Write')
      expect(profile.tools.some((tool: string) => tool.includes('ctx_execute'))).toBe(false)
      expect(profile.guards).toEqual([])
      expect(profile.skills).toEqual([])
    }
  })

  it('gives writers every required guard and role-specific skills', () => {
    for (const role of writers) {
      const profile = roleProfile(role)
      expect(profile.readOnly).toBe(false)
      expect(profile.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', CONTEXT_MODE_TOOLS.search, CONTEXT_MODE_TOOLS.execute]))
      expect(profile.guards.map((guard: { script: string }) => guard.script)).toEqual(expect.arrayContaining(requiredGuards))
      expect(profile.guards.every((guard: { reason: string }) => guard.reason.length > 0)).toBe(true)
    }
    expect(roleProfile('pilot').skills).toEqual(['stale-card-sweep', 'lesson-harvest', 'deep-grounding'])
    const pilot = roleProfile('pilot')
    expect(pilot.readOnly).toBe(false)
    expect(pilot.tools).toEqual(['Read', 'Glob', 'Grep', ...Object.values(CONTEXT_MODE_TOOLS)])
    for (const tool of ['Edit', 'Write', 'Bash']) expect(pilot.tools).not.toContain(tool)
    expect(pilot.guards).toEqual([])
    expect(roleProfile('tdd').skills).toEqual(['changelog'])
    expect(roleProfile('harden').skills).toEqual(['changelog'])
  })

  it('composes query options from the supplied profile rather than a site-local tool list', () => {
    const profile = { ...roleProfile('review'), tools: ['Read', 'changed-tool'] }
    expect(composeSdkRoleQueryOptions({ model: 'opus' }, { profile, plugins: [], hooks: {} })).toMatchObject({
      model: 'opus', tools: ['Read', 'changed-tool'], plugins: [], hooks: {}, pluginDelivery: 'initialize',
    })
  })

  it('fails closed with the missing guard or context-mode path named', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-role-')); roots.push(root)
    expect(() => prepareSdkRole('tdd', { worktree: root, pluginRoot: join(root, 'missing-plugin'), env: { CLAUDE_CONFIG_DIR: join(root, 'config') } })).toThrow(join(root, 'missing-plugin', 'hooks-modules', 'pilot-guard'))
    const pluginRoot = join(root, 'plugin'); mkdirSync(join(pluginRoot, 'hooks-modules', 'pilot-guard', 'hooks'), { recursive: true })
    writeFileSync(join(pluginRoot, 'hooks-modules', 'pilot-guard', 'hooks', 'hooks.json'), '{}')
    writeFileSync(join(pluginRoot, 'hooks-modules', 'pilot-guard', 'hooks', 'hooks.js'), '')
    expect(() => prepareSdkRole('tdd', { worktree: root, pluginRoot, env: { CLAUDE_CONFIG_DIR: join(root, 'config') } })).toThrow(join(root, 'config', 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.177'))
    const context = join(root, 'config', 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.177')
    mkdirSync(join(context, '.claude-plugin'), { recursive: true }); mkdirSync(join(context, 'hooks'))
    writeFileSync(join(context, '.claude-plugin', 'plugin.json'), '{}'); writeFileSync(join(context, 'hooks', 'hooks.json'), '{}')
    expect(() => prepareSdkRole('tdd', { worktree: root, pluginRoot, env: { CLAUDE_CONFIG_DIR: join(root, 'config') } })).toThrow(join(pluginRoot, 'bin', 'wt-unquoted-tool-glob-guard-hook.mjs'))
  })
})

describe('SDK command-guard callback adapter', () => {
  it('passes the SDK payload unchanged and translates the guard deny JSON', async () => {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'find . -name *.ts' }, session_id: 's' }
    let received: unknown
    const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'refused' } }
    const hook = guardHook({ runScript: async (_script: string, input: unknown) => { received = input; return { code: 0, stdout: JSON.stringify(output), stderr: '' } } })
    await expect(hook(payload)).resolves.toEqual(output)
    expect(received).toBe(payload)
  })

  it('returns no decision and logs when a guard exits non-zero', async () => {
    const lines: string[] = []
    const hook = guardHook({ runScript: async () => ({ code: 7, stdout: '', stderr: 'boom' }), log: (line: string) => lines.push(line) })
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } })
    expect(result).not.toHaveProperty('hookSpecificOutput')
    expect(result).not.toHaveProperty('continue')
    expect(lines).toEqual([expect.stringContaining('wt-unquoted-tool-glob-guard-hook.mjs exited 7: boom')])
  })
})
