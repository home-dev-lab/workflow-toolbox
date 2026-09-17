import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareContextModeFixture } from './helpers/context-mode-fixture.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveContextModeRoot, assertSdkRoleReceipt, composeSdkRoleQueryOptions, prepareSdkRole } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'

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
      expect(profile.tools).toEqual(['Read', 'Glob', 'Grep', 'LSP', CONTEXT_MODE_TOOLS.search])
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
    expect(pilot.tools).toEqual(['Read', 'Glob', 'Grep', 'LSP', ...Object.values(CONTEXT_MODE_TOOLS)])
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

  it('writes an LSP plugin with the resolved command and detected TypeScript and JavaScript languages', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    const bin = join(root, 'bin'); mkdirSync(bin)
    const server = join(bin, 'typescript-language-server'); writeFileSync(server, '#!/bin/sh\n'); chmodSync(server, 0o755)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'module.mjs'), 'export const other = 2\n')
    const prepared = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: bin, WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    expect(prepared.lsp).toEqual({ available: true, command: server, languages: ['typescript', 'javascript'] })
    expect(prepared.profile.tools).toContain('LSP')
    expect(JSON.parse(readFileSync(join(prepared.skillPlugin, '.lsp.json'), 'utf8'))).toEqual({
      typescript: { command: server, args: ['--stdio'], extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript' } },
    })
  })

  it('detects JavaScript from js and cjs files without a package marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    const bin = join(root, 'bin'); mkdirSync(bin)
    const server = join(bin, 'typescript-language-server'); writeFileSync(server, '#!/bin/sh\n'); chmodSync(server, 0o755)
    writeFileSync(join(root, 'hook.js'), 'export const hook = true\n')
    writeFileSync(join(root, 'helper.cjs'), 'module.exports = true\n')
    const prepared = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: bin, WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    expect(prepared.lsp).toEqual({ available: true, command: server, languages: ['javascript'] })
    expect(JSON.parse(readFileSync(join(prepared.skillPlugin, '.lsp.json'), 'utf8'))).toEqual({
      typescript: { command: server, args: ['--stdio'], extensionToLanguage: { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript' } },
    })
  })

  it('keeps a role available without an LSP plugin when the language server is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    const prepared = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: '', WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    expect(prepared.lsp).toEqual({ available: false, reason: 'typescript-language-server not found on PATH' })
    expect(prepared.skillPlugin).toBeNull()
  })

  it('resolves Windows command shims and honours an absolute override only when it is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    writeFileSync(join(root, 'package.json'), '{}\n')
    const first = join(root, 'first'); const second = join(root, 'second'); mkdirSync(first); mkdirSync(second)
    const shim = join(second, 'typescript-language-server.cmd'); writeFileSync(shim, '@exit /b 0\n'); chmodSync(shim, 0o755)
    const override = join(root, 'custom-language-server'); writeFileSync(override, '#!/bin/sh\n'); chmodSync(override, 0o755)
    const fromPath = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: `${first};${second}`, WT_LSP_TYPESCRIPT_SERVER: undefined }, platform: 'win32', adapterOptions: { log: () => {} } })
    expect(fromPath.lsp).toMatchObject({ available: true, command: shim })
    const overridden = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: second, WT_LSP_TYPESCRIPT_SERVER: override }, adapterOptions: { log: () => {} } })
    expect(overridden.lsp).toMatchObject({ available: true, command: override })
    const absentOverride = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: second, WT_LSP_TYPESCRIPT_SERVER: join(root, 'absent') }, adapterOptions: { log: () => {} } })
    expect(absentOverride.lsp).toMatchObject({ available: false })
  })

  it('requires LSP in the initialization receipt only when the prepared server is available', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-sdk-lsp-')); roots.push(root)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    const absent = prepareSdkRole('review', { worktree: root, env: { ...process.env, PATH: '', WT_LSP_TYPESCRIPT_SERVER: undefined }, adapterOptions: { log: () => {} } })
    const receipt = { tools: absent.profile.tools.filter((tool: string) => tool !== 'LSP'), plugins: absent.pluginPaths.map((pluginPath: string) => ({ path: pluginPath })), skills: [] }
    expect(() => assertSdkRoleReceipt('review', receipt, absent)).not.toThrow()
    const server = join(root, 'server'); writeFileSync(server, '#!/bin/sh\n'); chmodSync(server, 0o755)
    const available = prepareSdkRole('review', { worktree: root, env: { ...process.env, WT_LSP_TYPESCRIPT_SERVER: server }, adapterOptions: { log: () => {} } })
    expect(() => assertSdkRoleReceipt('review', { ...receipt, plugins: available.pluginPaths.map((pluginPath: string) => ({ path: pluginPath })) }, available)).toThrow(/missingTools.*LSP/)
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
    expect(lines).toEqual([
      'SDK role tdd: LSP absent: typescript-language-server not found on PATH',
      expect.stringContaining('wt-unquoted-tool-glob-guard-hook.mjs exited 7: boom'),
    ])
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
