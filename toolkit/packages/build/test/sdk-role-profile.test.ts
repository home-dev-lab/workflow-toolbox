import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareContextModeFixture } from './helpers/context-mode-fixture.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveContextModeRoot, assertSdkRoleReceipt, composeSdkRoleQueryOptions, prepareSdkRole, skillIsUnlistedByInit } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { lifecycleCanUseTool } from '../../../../plugin/bin/lib/pilot-runner-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { executorCanUseTool } from '../../../../plugin/bin/lib/claude-executor-core.mjs'

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

const roles = ['pilot', 'judge', 'tdd', 'critic', 'review', 'refutation'] as const
const processStartingContextTools = [CONTEXT_MODE_TOOLS.batchExecute, CONTEXT_MODE_TOOLS.execute, CONTEXT_MODE_TOOLS.executeFile]
const roleContextTools = [CONTEXT_MODE_TOOLS.fetchAndIndex, CONTEXT_MODE_TOOLS.index, CONTEXT_MODE_TOOLS.search]
const preparedRole = (role: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wt-role-profile-')); roots.push(root)
  return { root, prepared: prepareSdkRole(role, { worktree: root, exists: () => true }) }
}
const roleProfile = (role: string) => {
  return preparedRole(role).prepared.profile
}
const readers = ['judge', 'critic', 'review', 'refutation'] as const
const writers = ['tdd'] as const
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

  it('gives writers guarded Bash, library-controlled context services, and role-specific skills', () => {
    for (const role of writers) {
      const profile = roleProfile(role)
      expect(profile.readOnly).toBe(false)
      expect(profile.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', ...roleContextTools])
      for (const tool of [CONTEXT_MODE_TOOLS.doctor, CONTEXT_MODE_TOOLS.purge]) expect(profile.tools).not.toContain(tool)
      expect(profile.guards.map((guard: { script: string }) => guard.script)).toEqual(expect.arrayContaining(requiredGuards))
      expect(profile.guards.every((guard: { reason: string }) => guard.reason.length > 0)).toBe(true)
    }
    expect(roleProfile('pilot').skills).toEqual(['stale-card-sweep', 'lesson-harvest', 'deep-grounding'])
    const pilot = roleProfile('pilot')
    expect(pilot.readOnly).toBe(false)
    expect(pilot.tools).toEqual(['Read', 'Glob', 'Grep', ...roleContextTools])
    for (const tool of ['Edit', 'Write', 'Bash']) expect(pilot.tools).not.toContain(tool)
    expect(pilot.guards).toEqual([])
    expect(roleProfile('tdd').skills).toEqual(['changelog'])
  })

  it('composes query options from the supplied profile rather than a site-local tool list', () => {
    const profile = { ...roleProfile('review'), tools: ['Read', 'changed-tool'] }
    expect(composeSdkRoleQueryOptions({ model: 'opus', effort: 'medium' }, { profile, plugins: [], hooks: {} })).toMatchObject({
      model: 'opus', effort: 'medium', tools: ['Read', 'changed-tool'], plugins: [], hooks: {}, pluginDelivery: 'initialize',
    })
  })

  it.each(roles)('refuses to launch the %s SDK role without a declared effort', (role) => {
    expect(() => composeSdkRoleQueryOptions({ model: 'opus' }, { profile: roleProfile(role), plugins: [], hooks: {} }))
      .toThrow('SDK role launch requires explicit effort')
  })

  it.each(roles)('keeps process-starting context tools outside the %s SDK role', (role) => {
    const { root, prepared } = preparedRole(role)
    const options = composeSdkRoleQueryOptions({ model: 'opus', effort: 'medium' }, prepared)
    for (const tool of processStartingContextTools) {
      expect(options.tools).not.toContain(tool)
      expect(options.disallowedTools).toContain(tool)
      const permission = role === 'pilot'
        ? lifecycleCanUseTool(root, tool, {}, { profile: prepared.profile })
        : executorCanUseTool(root, join(root, 'report.md'), prepared.profile.readOnly, tool, {}, { profile: prepared.profile })
      expect(permission).toEqual({ behavior: 'deny', message: `tool refused: ${tool}` })
    }
    const receipt = {
      tools: [...prepared.profile.tools.filter((tool: string) => tool !== 'LSP'), CONTEXT_MODE_TOOLS.execute],
      plugins: prepared.pluginPaths.map((pluginPath: string) => ({ path: pluginPath })),
      skills: [...prepared.profile.skills],
    }
    expect(() => assertSdkRoleReceipt(role, receipt, prepared)).toThrow(/unexpectedTools.*ctx_execute/)
  })

  it('merges caller and role deny lists without duplicates', () => {
    const { prepared } = preparedRole('tdd')
    const options = composeSdkRoleQueryOptions({ model: 'opus', effort: 'medium', disallowedTools: ['Agent', CONTEXT_MODE_TOOLS.doctor] }, prepared)
    expect(options.disallowedTools).toEqual(['Agent', CONTEXT_MODE_TOOLS.doctor, ...Object.values(CONTEXT_MODE_TOOLS).filter((tool) => !roleContextTools.includes(tool) && tool !== CONTEXT_MODE_TOOLS.doctor)])
  })

  it.each(['Bash', 'Agent', 'mcp__other__ctx_execute'])('rejects unexpected initialization capability %s', (unexpected) => {
    const { prepared } = preparedRole('pilot')
    const receipt = {
      tools: [...prepared.profile.tools.filter((tool: string) => tool !== 'LSP'), 'mcp__sdk-pilot-lifecycle__run', unexpected],
      plugins: prepared.pluginPaths.map((pluginPath: string) => ({ path: pluginPath })),
      skills: [...prepared.profile.skills],
    }
    expect(() => assertSdkRoleReceipt('pilot', receipt, prepared)).toThrow(new RegExp(`unexpectedTools.*${unexpected}`))
  })

  it('denies Bash requests that ask to disable the sandbox before the caller callback', async () => {
    const { prepared } = preparedRole('tdd')
    let called = false
    const options = composeSdkRoleQueryOptions({
      model: 'opus', effort: 'medium',
      canUseTool: async () => { called = true; return { behavior: 'allow' } },
    }, prepared)
    await expect(options.canUseTool('Bash', { command: 'true', dangerouslyDisableSandbox: true })).resolves.toEqual({ behavior: 'deny', message: 'unsandboxed Bash refused' })
    expect(called).toBe(false)
  })

  it('denies writes to code paths supplied by the active plugin and guard registration', async () => {
    const { prepared } = preparedRole('tdd')
    const guardedScript = prepared.guardPaths.find((script: string) => script.endsWith('wt-stale-date-guard-hook.mjs'))
    expect(guardedScript).toBeDefined()
    const options = composeSdkRoleQueryOptions({
      model: 'opus', effort: 'medium', canUseTool: async () => ({ behavior: 'allow' }),
    }, prepared)
    expect(prepared.protectedWritePaths).toEqual(expect.arrayContaining([...prepared.pluginPaths, guardedScript as string]))
    expect(options.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(prepared.protectedWritePaths))
    await expect(options.canUseTool('Write', { file_path: guardedScript, content: 'process.exit(0)' })).resolves.toEqual({
      behavior: 'deny', message: expect.stringContaining('host-executed path'),
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

  it('does not configure LSP when a TypeScript/JavaScript launcher is available', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    const bin = join(root, 'bin'); mkdirSync(bin)
    const server = join(bin, 'typescript-language-server'); writeFileSync(server, '#!/bin/sh\n'); chmodSync(server, 0o755)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'module.mjs'), 'export const other = 2\n')
    const prepared = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: bin, WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    expect(prepared.lsp).toEqual({ available: false, reason: 'disabled for SDK roles: workspace language servers can execute workspace code' })
    expect(prepared.profile.tools).not.toContain('LSP')
    expect(prepared.skillPlugin).toBeNull()
  })

  it('does not configure LSP for JavaScript files without a package marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    const bin = join(root, 'bin'); mkdirSync(bin)
    const server = join(bin, 'typescript-language-server'); writeFileSync(server, '#!/bin/sh\n'); chmodSync(server, 0o755)
    writeFileSync(join(root, 'hook.js'), 'export const hook = true\n')
    writeFileSync(join(root, 'helper.cjs'), 'module.exports = true\n')
    const prepared = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: bin, WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    expect(prepared.lsp).toEqual({ available: false, reason: 'disabled for SDK roles: workspace language servers can execute workspace code' })
    expect(prepared.skillPlugin).toBeNull()
  })

  it('keeps a role available without an LSP plugin when the language server is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    const prepared = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: '', WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    expect(prepared.lsp).toEqual({ available: false, reason: 'disabled for SDK roles: workspace language servers can execute workspace code' })
    expect(prepared.skillPlugin).toBeNull()
  })

  it('never offers LSP that can select executable code from the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-payload-')); roots.push(root)
    const server = join(root, 'typescript-language-server'); writeFileSync(server, '#!/bin/sh\n'); chmodSync(server, 0o755)
    mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"0.0.0"}\n')
    writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'), 'throw new Error("workspace payload executed")\n')
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    for (const role of roles) {
      const prepared = prepareSdkRole(role, { worktree: root, env: { ...process.env, WT_LSP_TYPESCRIPT_SERVER: server }, adapterOptions: { log: () => {} } })
      expect(prepared.profile.tools).not.toContain('LSP')
      expect(prepared.lsp).toEqual({ available: false, reason: 'disabled for SDK roles: workspace language servers can execute workspace code' })
      if (prepared.skillPlugin) expect(readFileSync(join(prepared.skillPlugin, '.claude-plugin', 'plugin.json'), 'utf8')).not.toContain('.lsp.json')
    }
  })

  it('keeps LSP disabled regardless of command shims and overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    writeFileSync(join(root, 'package.json'), '{}\n')
    const first = join(root, 'first'); const second = join(root, 'second'); mkdirSync(first); mkdirSync(second)
    const shim = join(second, 'typescript-language-server.cmd'); writeFileSync(shim, '@exit /b 0\n'); chmodSync(shim, 0o755)
    const override = join(root, 'custom-language-server'); writeFileSync(override, '#!/bin/sh\n'); chmodSync(override, 0o755)
    const fromPath = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: `${first};${second}`, WT_LSP_TYPESCRIPT_SERVER: undefined }, platform: 'win32', adapterOptions: { log: () => {} } })
    expect(fromPath.lsp.available).toBe(false)
    const overridden = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: second, WT_LSP_TYPESCRIPT_SERVER: override }, adapterOptions: { log: () => {} } })
    expect(overridden.lsp.available).toBe(false)
    const absentOverride = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: second, WT_LSP_TYPESCRIPT_SERVER: join(root, 'absent') }, adapterOptions: { log: () => {} } })
    expect(absentOverride.lsp.available).toBe(false)
  })

  // Measured 2026-09-17 (lsp-probe/probe3.mjs, then the first real LITE run): the SDK init receipt lists only the
  // plugin skills declared `user-invocable: true`, so the pilot's `lesson-harvest` can never appear there.
  it('does not require a user-invocable:false skill in the initialization receipt, and still requires the others', () => {
    expect(skillIsUnlistedByInit('---\nname: x\nuser-invocable: false\ndescription: d\n---\n\nBody\n')).toBe(true)
    expect(skillIsUnlistedByInit('---\nname: x\nuser-invocable: true\ndescription: d\n---\n\nBody\n')).toBe(false)
    expect(skillIsUnlistedByInit('# no frontmatter\nuser-invocable: false\n')).toBe(false)
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-skills-')); roots.push(root)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    const logged: string[] = []
    const prepared = prepareSdkRole('pilot', { worktree: root, env: { ...process.env, PATH: '', WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: (line: string) => logged.push(line) } })
    expect(prepared.unlistedSkills).toEqual(['lesson-harvest'])
    expect(logged.some((line) => /never listed by the initialization receipt .*lesson-harvest/.test(line))).toBe(true)
    const receipt = {
      tools: prepared.profile.tools.filter((tool: string) => tool !== 'LSP'),
      plugins: [...prepared.pluginPaths.map((pluginPath: string) => ({ path: pluginPath })), { name: 'wt-sdk-pilot' }],
      skills: ['wt-sdk-pilot:stale-card-sweep', 'wt-sdk-pilot:deep-grounding'],
    }
    expect(() => assertSdkRoleReceipt('pilot', receipt, prepared)).not.toThrow()
    expect(() => assertSdkRoleReceipt('pilot', { ...receipt, skills: ['wt-sdk-pilot:stale-card-sweep'] }, prepared)).toThrow(/missingSkills":\["deep-grounding"\].*unlistedSkills":\["lesson-harvest"\]/)
  })

  it('never requires LSP and rejects it when an initialization receipt exposes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    const absent = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: '', WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    const receipt = { tools: absent.profile.tools.filter((tool: string) => tool !== 'LSP'), plugins: absent.pluginPaths.map((pluginPath: string) => ({ path: pluginPath })), skills: [] }
    expect(() => assertSdkRoleReceipt('review', receipt, absent)).not.toThrow()
    expect(() => assertSdkRoleReceipt('review', { ...receipt, tools: [...receipt.tools, 'LSP'] }, absent)).toThrow(/unexpectedTools.*LSP/)
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

  it.each([
    ['fails to launch', async () => { throw new Error('spawn failed') }, 'failed to launch: spawn failed'],
    ['exits non-zero', async () => ({ code: 7, stdout: '', stderr: 'boom' }), 'exited 7: boom'],
    ['returns invalid JSON', async () => ({ code: 0, stdout: '{', stderr: '' }), 'returned invalid JSON'],
  ])('denies and logs when a guard %s', async (_shape, runScript, detail) => {
    const lines: string[] = []
    const hook = guardHook({ runScript, log: (line: string) => lines.push(line) })
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } })
    expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(detail) } })
    expect(lines).toEqual(['SDK role tdd: LSP absent: disabled for SDK roles: workspace language servers can execute workspace code', expect.stringContaining(detail)])
  })

  it('denies when a role guard fails inside its own fail-open wrapper', async () => {
    const hook = guardHook({
      env: { ...process.env, WT_FAIL_OPEN_TRACE_SELF_TEST: 'wt-unquoted-tool-glob-guard-hook.mjs' },
      log: () => {},
    })
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } })
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('exited 1'),
      },
    })
  })
})

describe('context-mode root resolution follows the installed plugin, not a pinned version', () => {
  it('prefers the recorded install path, then the highest cached version, then the last known version', () => {
    const env = { CLAUDE_CONFIG_DIR: '/cfg' }
    const cache = join('/cfg', 'plugins', 'cache', 'context-mode', 'context-mode')
    const registry = JSON.stringify({ plugins: { 'context-mode@context-mode': [{ installPath: join(cache, '1.0.178'), version: '1.0.178' }] } })
    expect(resolveContextModeRoot(env, { readFile: () => registry, exists: (p: string) => p.endsWith('1.0.178'), readDir: () => ['1.0.177', '1.0.178'] })).toBe(join(cache, '1.0.178'))
    // recorded path gone from disk → highest cached version wins
    expect(resolveContextModeRoot(env, { readFile: () => registry, exists: () => false, readDir: () => ['1.0.9', '1.0.177', '1.0.10'] })).toBe(join(cache, '1.0.177'))
    // no registry, no cache → the last known version (the fail-closed message names it)
    expect(resolveContextModeRoot(env, { readFile: () => { throw new Error('ENOENT') }, exists: () => false, readDir: () => { throw new Error('ENOENT') } })).toBe(join(cache, '1.0.177'))
    // explicit override always wins
    expect(resolveContextModeRoot({ WT_CONTEXT_MODE_ROOT: '/pinned' }, { readFile: () => registry, exists: () => true, readDir: () => ['9.9.9'] })).toBe('/pinned')
  })
})
