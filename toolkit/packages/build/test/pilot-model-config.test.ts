import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { assertHarnessModel, resolveExecutorProfile as resolveExecutorProfileImpl, resolvePilotModels as resolvePilotModelsImpl } from '../../../../plugin/bin/lib/pilot-model-config.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveRoleVariant } from '../../../../plugin/bin/lib/lane-model-allowlist.mjs'

const noPluginOption = () => ({ present: false })
const resolvePilotModels = (options: Record<string, unknown>) => resolvePilotModelsImpl({ ...options, readPluginOption: noPluginOption })
const resolveExecutorProfile = (options: Record<string, unknown>) => resolveExecutorProfileImpl({ ...options, readPluginOption: noPluginOption })

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-pilot-models.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The CLI reads the ambient process env ahead of the profile's settings env, so a machine whose own
// profile sets WT_*_MODEL or ANTHROPIC_DEFAULT_*_MODEL would make these fixtures read the machine, not
// the fixture (measured 2026-09-09: `source=env` on a host with WT_PILOT_MODEL=opus in its settings env).
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^WT_(?:(?:SDK_)?(?:PILOT|PILOT_HARD|ORCHESTRATOR)|EXECUTOR_(?:CRITIC|CODE|REVIEW|REFUTATION))_(?:MODEL|VARIANT)$/.test(key) || /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

describe('pilot model configuration', () => {
  it('resolves process env ahead of settings env, and settings ahead of role defaults', () => {
    expect(resolvePilotModels({
      env: { WT_PILOT_MODEL: 'haiku' },
      settingsEnv: { WT_PILOT_MODEL: 'opus', WT_PILOT_HARD_MODEL: 'fable' },
    })).toEqual({
      pilot: { value: 'haiku', source: 'env', effective: 'haiku', remappedBy: null, variant: { value: 'medium', origin: 'role base', source: 'profile', forced: false } },
      pilotHard: { value: 'fable', source: 'settings', effective: 'fable', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
      orchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
      sdkPilot: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'medium', origin: 'role base', source: 'profile', forced: false } },
      sdkPilotHard: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
      sdkOrchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
    })
  })

  it('defaults every harness and SDK pilot/orchestrator cell to opus with pilots at medium and orchestrators and hard pilots at high (owner 2026-09-22, 2026-09-24)', () => {
    expect(resolvePilotModels({ env: {}, settingsEnv: {} })).toEqual({
      pilot: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'medium', origin: 'role base', source: 'profile', forced: false } },
      pilotHard: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
      orchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
      sdkPilot: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'medium', origin: 'role base', source: 'profile', forced: false } },
      sdkPilotHard: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
      sdkOrchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null, variant: { value: 'high', origin: 'role base', source: 'profile', forced: false } },
    })
  })

  it.each([
    ['gpt-lane', 'LITE', false, { critic: 'openai/gpt-6-sol', code: 'openai/gpt-6-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' }],
    ['gpt-lane', 'LITE', true, { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' }],
    ['gpt-lane', 'FULL', false, { critic: 'openai/gpt-6-sol', code: 'openai/gpt-6-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' }],
    ['gpt-lane', 'FULL', true, { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' }],
    ['claude-sdk', 'LITE', false, { critic: 'opus', code: 'sonnet', review: 'opus', refutation: 'opus' }],
    ['claude-sdk', 'LITE', true, { critic: 'opus', code: 'opus', review: 'opus', refutation: 'opus' }],
    ['claude-sdk', 'FULL', false, { critic: 'opus', code: 'sonnet', review: 'opus', refutation: 'opus' }],
    ['claude-sdk', 'FULL', true, { critic: 'opus', code: 'opus', review: 'opus', refutation: 'opus' }],
  ] as const)('resolves the %s %s hard=%s executor cell', (executor, route, hard, models) => {
    const consent = executor === 'gpt-lane' ? 'true' : 'not_true'
    expect(resolveExecutorProfile({
      worktree: '/worktree', route, hard, env: {}, settingsEnv: {},
      resolveConsentImpl: () => ({ outcome: consent }),
    })).toMatchObject({ executor, models })
  })

  it('treats unresolved consent as Claude and validates family-specific role overrides', () => {
    expect(resolveExecutorProfile({
      worktree: '/worktree', route: 'FULL', hard: false,
      env: { WT_EXECUTOR_CODE_MODEL: 'opus', WT_EXECUTOR_REFUTATION_MODEL: 'fable' },
      settingsEnv: { WT_EXECUTOR_CODE_MODEL: 'opus', WT_EXECUTOR_REVIEW_MODEL: 'sonnet' },
      resolveConsentImpl: () => ({ outcome: 'unknown' }),
    })).toMatchObject({ executor: 'claude-sdk', models: { critic: 'opus', code: 'opus', review: 'sonnet', refutation: 'fable' } })
    expect(() => resolveExecutorProfile({ worktree: '/w', route: 'FULL', hard: false, env: { WT_EXECUTOR_CODE_MODEL: 'sonnet' }, resolveConsentImpl: () => ({ outcome: 'true' }) })).toThrow('provider model')
    expect(() => resolveExecutorProfile({ worktree: '/w', route: 'FULL', hard: false, env: { WT_EXECUTOR_CODE_MODEL: 'openai/gpt-5.6-sol' }, resolveConsentImpl: () => ({ outcome: 'not_true' }) })).toThrow('harness model')
    expect(() => resolveExecutorProfile({ worktree: '/w', route: 'FULL', hard: false, env: { WT_EXECUTOR_CODE_MODEL: 'claude-sonnet-5' }, resolveConsentImpl: () => ({ outcome: 'not_true' }) })).toThrow('harness model alias')
  })

  it('selects the family through the real consent resolver with hermetic settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-executor-consent-')); roots.push(root)
    const config = join(root, 'config'); const worktree = join(root, 'worktree')
    mkdirSync(config); mkdirSync(join(worktree, '.claude'), { recursive: true })
    const env = { CLAUDE_CONFIG_DIR: config, HOME: root }
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: {} }))
    expect(resolveExecutorProfile({ worktree, route: 'LITE', env, settingsEnv: {} }).executor).toBe('claude-sdk')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    expect(resolveExecutorProfile({ worktree, route: 'LITE', env, settingsEnv: {} }).executor).toBe('gpt-lane')
  })

  it('accepts harness aliases and full Claude ids', () => {
    for (const value of ['haiku', 'sonnet', 'opus', 'fable', 'claude-3-7-sonnet-latest']) {
      expect(assertHarnessModel(value)).toBe(value)
    }
  })

  // Owner-approved table 2026-09-26 12:17 +01:00: the forced xhigh code profile is scoped to
  // gpt-5.6-sol only (where it was measured); gpt-6-sol code now falls through to its 'high' role
  // base, and review moves off Sol (so Sol never reviews its own code) onto Astra at 'medium'.
  it('resolves role base, the GPT-5.6-sol code profile, then explicit variant override', () => {
    expect(resolveRoleVariant('review', 'openai/gpt-5.6-sol', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'medium', origin: 'role base' })
    expect(resolveRoleVariant('code', 'openai/gpt-5.6-sol', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'xhigh', origin: 'model profile' })
    expect(resolveRoleVariant('code', 'openai/gpt-6-sol', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'role base' })
    expect(resolveRoleVariant('review', 'openai/gpt-6-astra', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'medium', origin: 'role base' })
    expect(resolveRoleVariant('review', 'openai/gpt-6-astra', { env: { WT_EXECUTOR_REVIEW_VARIANT: 'high' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'override' })
  })

  it.each([
    ['true', { critic: 'max', code: 'high', review: 'medium', refutation: 'medium' }],
    ['not_true', { critic: 'xhigh', code: 'medium', review: 'xhigh', refutation: 'xhigh' }],
  ])('resolves hard-profile efforts for %s', (outcome, variants) => {
    expect(resolveExecutorProfile({ worktree: '/worktree', route: 'FULL', hard: true, env: {}, settingsEnv: {},
      resolveConsentImpl: () => ({ outcome }), })).toMatchObject({ variants })
  })

  it('requires a model before reading overrides and matches OpenAI provider case-insensitively', () => {
    expect(() => resolveRoleVariant('critic', undefined, { env: { WT_EXECUTOR_CRITIC_VARIANT: 'high' }, readPluginOption: noPluginOption })).toThrow('executor role critic: model is required')
    expect(() => resolveRoleVariant('code', 42, { env: {}, readPluginOption: noPluginOption })).toThrow('executor role code: model is required')
    expect(resolveRoleVariant('critic', 'OPENAI/gpt-6-sol', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'max' })
    expect(resolveRoleVariant('critic', 'other/model', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'xhigh' })
  })

  it('refuses max for every Claude alias and full Claude id from every override source', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'claude-sonnet-5']) {
      const envKey = 'WT_EXECUTOR_CRITIC_VARIANT'
      for (const options of [
        { env: { [envKey]: 'max' }, readPluginOption: noPluginOption },
        { env: {}, settingsEnv: { [envKey]: 'max' }, readPluginOption: noPluginOption },
        { env: {}, readPluginOption: () => ({ present: true, value: 'max' }) },
      ]) expect(() => resolveRoleVariant('critic', model, options)).toThrow(`model ${model}: max is never used on Claude; use xhigh`)
    }
  })

  it('refuses --variant max at the Claude executor CLI before resolving an SDK', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-claude-max-')); roots.push(root)
    mkdirSync(join(root, '.lane'))
    const brief = join(root, 'brief.md'); writeFileSync(brief, `# Critic\nWrite the report to \`${join(root, '.lane', 'critic-report.test.md')}\`\n`)
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'plugin/bin/wt-claude-executor.mjs'), '--dir', root, '--brief', brief, '--model', 'opus', '--role', 'critic', '--variant', 'max'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('model opus: max is never used on Claude; use xhigh')
  })

  it('clamps the Luna critic base and refuses explicit max while preserving lower overrides', () => {
    const model = 'openai/gpt-5.6-luna'
    expect(resolveRoleVariant('critic', model, { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'xhigh', origin: 'role base (clamped from max)' })
    for (const options of [
      { env: { WT_EXECUTOR_CRITIC_VARIANT: 'max' }, readPluginOption: noPluginOption },
      { env: {}, settingsEnv: { WT_EXECUTOR_CRITIC_VARIANT: 'max' }, readPluginOption: noPluginOption },
      { env: {}, readPluginOption: () => ({ present: true, value: 'max' }) },
    ]) expect(() => resolveRoleVariant('critic', model, options)).toThrow('variant max is above the xhigh ceiling')
    expect(resolveRoleVariant('critic', model, { env: { WT_EXECUTOR_CRITIC_VARIANT: 'high' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'override' })
    expect(resolveRoleVariant('critic', model, { env: { WT_EXECUTOR_CRITIC_VARIANT: 'none' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'none', origin: 'override' })
  })

  // Owner decision 2026-09-24 (wt-suite #4039, card 1871089222002148813): pilots and implementation
  // run at medium.
  it.each([
    ['pilot', 'opus', 'WT_PILOT_VARIANT', 'pilot_variant'],
    ['sdkPilot', 'opus', 'WT_SDK_PILOT_VARIANT', 'sdk_pilot_variant'],
  ] as const)('resolves the %s role on %s to medium by default, and an explicit override still wins', (role, model, envKey, option) => {
    expect(resolveRoleVariant(role, model, { env: {}, readPluginOption: noPluginOption })).toEqual({ value: 'medium', origin: 'role base', source: 'profile', forced: false })
    expect(resolveRoleVariant(role, model, { env: { [envKey]: 'high' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'override', source: 'env' })
    expect(resolveRoleVariant(role, model, { env: {}, settingsEnv: { [envKey]: 'xhigh' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'xhigh', origin: 'override', source: 'settings' })
    const pluginOption = (key: string) => key === option ? { present: true, value: 'low' } : { present: false }
    expect(resolveRoleVariant(role, model, { env: { [envKey]: 'high' }, readPluginOption: pluginOption })).toMatchObject({ value: 'low', origin: 'override', source: 'plugin option' })
  })

  // GPT executor code runs high; Claude implementation retains medium (#4039).
  it.each([
    ['code', 'sonnet', 'medium', 'WT_EXECUTOR_CODE_VARIANT', 'executor_code_variant'],
    ['code', 'opus', 'medium', 'WT_EXECUTOR_CODE_VARIANT', 'executor_code_variant'],
    ['code', 'openai/gpt-5.6-terra', 'high', 'WT_EXECUTOR_CODE_VARIANT', 'executor_code_variant'],
  ] as const)('resolves the %s role on %s to %s by default, and an explicit override still wins', (role, model, base, envKey, option) => {
    expect(resolveRoleVariant(role, model, { env: {}, readPluginOption: noPluginOption })).toEqual({ value: base, origin: 'role base', source: 'profile', forced: false })
    expect(resolveRoleVariant(role, model, { env: { [envKey]: 'medium' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'medium', origin: 'override', source: 'env' })
    expect(resolveRoleVariant(role, model, { env: {}, settingsEnv: { [envKey]: 'xhigh' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'xhigh', origin: 'override', source: 'settings' })
    const pluginOption = (key: string) => key === option ? { present: true, value: 'low' } : { present: false }
    expect(resolveRoleVariant(role, model, { env: { [envKey]: 'medium' }, readPluginOption: pluginOption })).toMatchObject({ value: 'low', origin: 'override', source: 'plugin option' })
  })

  it.each(['pilotHard', 'sdkPilotHard', 'orchestrator', 'sdkOrchestrator'] as const)('keeps the %s role at high: the medium decision covers pilots and implementation only', (role) => {
    expect(resolveRoleVariant(role, 'opus', { env: {}, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'role base' })
  })

  // GPT role table and prior Claude role bases; explicit overrides still win.
  it.each([
    ['critic', 'xhigh', 'WT_EXECUTOR_CRITIC_VARIANT', 'executor_critic_variant'],
    ['review', 'xhigh', 'WT_EXECUTOR_REVIEW_VARIANT', 'executor_review_variant'],
    ['refutation', 'xhigh', 'WT_EXECUTOR_REFUTATION_VARIANT', 'executor_refutation_variant'],
  ] as const)('resolves the Claude %s role to %s by default, and an explicit override still wins', (role, base, envKey, option) => {
    expect(resolveRoleVariant(role, 'opus', { env: {}, readPluginOption: noPluginOption })).toEqual({ value: base, origin: 'role base', source: 'profile', forced: false })
    expect(resolveRoleVariant(role, 'opus', { env: { [envKey]: 'high' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'override', source: 'env' })
    expect(resolveRoleVariant(role, 'opus', { env: {}, settingsEnv: { [envKey]: 'high' }, readPluginOption: noPluginOption })).toMatchObject({ value: 'high', origin: 'override', source: 'settings' })
    const pluginOption = (key: string) => key === option ? { present: true, value: 'low' } : { present: false }
    expect(resolveRoleVariant(role, 'opus', { env: { [envKey]: 'high' }, readPluginOption: pluginOption })).toMatchObject({ value: 'low', origin: 'override', source: 'plugin option' })
  })

  it('resolves the Claude SDK implementer executor profile and reports each role variant per role', () => {
    const profile = resolveExecutorProfile({ worktree: '/worktree', route: 'LITE', hard: false, env: {}, settingsEnv: {}, resolveConsentImpl: () => ({ outcome: 'not_true' }) })
    expect(profile.variants).toEqual({ critic: 'xhigh', code: 'medium', review: 'xhigh', refutation: 'xhigh' })
    expect(profile.variantOrigins.code).toBe('role base')
  })

  it.each([
    ['not_true', 'claude-sdk', { critic: 'xhigh', code: 'medium', review: 'xhigh', refutation: 'xhigh' }],
    ['true', 'gpt-lane', { critic: 'max', code: 'high', review: 'medium', refutation: 'medium' }],
  ] as const)('resolves real option-free %s executor effort by model family', (outcome, executor, variants) => {
    const config = mkdtempSync(join(tmpdir(), 'wt-executor-variant-')); roots.push(config)
    const profile = resolveExecutorProfileImpl({
      worktree: config, route: 'FULL', env: { CLAUDE_CONFIG_DIR: config }, settingsEnv: {},
      resolveConsentImpl: () => ({ outcome }),
    })
    expect(profile).toMatchObject({ executor, variants })
    expect(Object.values(profile.variantOrigins)).toEqual(['role base', 'role base', 'role base', 'role base'])
  })

  it('treats a definition default as absent, while an actual plugin variant option overrides the base', async () => {
    const { readWorkflowToolboxPluginOption } = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/plugin-options.mjs')).href)
    const config = mkdtempSync(join(tmpdir(), 'wt-executor-option-presence-')); roots.push(config)
    const env = { CLAUDE_CONFIG_DIR: config }
    // pilot_variant has a non-empty definition default ('medium'): the reader still reports absent.
    expect(readWorkflowToolboxPluginOption('pilot_variant', { env })).toEqual({ present: false })
    expect(readWorkflowToolboxPluginOption('executor_critic_variant', { env })).toEqual({ present: false })
    expect(resolveRoleVariant('critic', 'opus', { env })).toMatchObject({ value: 'xhigh', origin: 'role base' })
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'workflow-toolbox@local': { options: { executor_critic_variant: 'high' } } } }))
    expect(readWorkflowToolboxPluginOption('executor_critic_variant', { env })).toEqual({ present: true, value: 'high' })
    expect(resolveRoleVariant('critic', 'opus', { env })).toMatchObject({ value: 'high', origin: 'override', source: 'plugin option' })
  })

  it('honours an explicitly saved effort even when a newer family base differs', () => {
    const config = mkdtempSync(join(tmpdir(), 'wt-saved-effort-')); roots.push(config)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'workflow-toolbox@local': { options: { executor_critic_variant: 'high' } } } }))
    expect(resolveRoleVariant('critic', 'openai/gpt-6-sol', { env: { CLAUDE_CONFIG_DIR: config } })).toMatchObject({ value: 'high', origin: 'override', source: 'plugin option' })
  })

  it('ships pilot effort defaults and empty executor options so model-family bases decide', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'))
    const variants = Object.fromEntries(Object.entries(manifest.userConfig).filter(([key]) => key.endsWith('_variant')).map(([key, schema]) => [key, (schema as { default: string }).default]))
    expect(variants).toEqual({
      pilot_variant: 'medium',
      pilot_hard_variant: 'high',
      orchestrator_variant: 'high',
      sdk_pilot_variant: 'medium',
      sdk_pilot_hard_variant: 'high',
      sdk_orchestrator_variant: 'high',
      executor_critic_variant: '',
      executor_code_variant: '',
      executor_review_variant: '',
      executor_refutation_variant: '',
    })
  })

  it('keeps the runtime option defaults equal to the manifest defaults for every variant option', async () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'))
    const { resolveWorkflowToolboxOption } = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/plugin-options.mjs')).href)
    const configDir = mkdtempSync(join(tmpdir(), 'wt-variant-defaults-'))
    roots.push(configDir)
    const variantKeys = Object.keys(manifest.userConfig).filter((name) => name.endsWith('_variant'))
    expect(variantKeys).toHaveLength(10)
    for (const key of variantKeys) {
      expect(resolveWorkflowToolboxOption(key, { env: { CLAUDE_CONFIG_DIR: configDir } }), key).toEqual({ value: manifest.userConfig[key].default, source: 'default' })
    }
  })

  it('resolves a pilot plugin option before process env, settings env, and the default', () => {
    const option = (value: string) => (key: string) => key === 'pilot_model' ? { present: true, value } : { present: false }
    expect(resolvePilotModelsImpl({
      env: { WT_PILOT_MODEL: 'haiku' },
      settingsEnv: { WT_PILOT_MODEL: 'fable' },
      readPluginOption: option('opus'),
    }).pilot).toMatchObject({ value: 'opus', source: 'plugin option' })
    expect(resolvePilotModels({ env: { WT_PILOT_MODEL: 'haiku' }, settingsEnv: { WT_PILOT_MODEL: 'fable' } }).pilot.source).toBe('env')
    expect(resolvePilotModels({ env: {}, settingsEnv: { WT_PILOT_MODEL: 'fable' } }).pilot.source).toBe('settings')
    expect(resolvePilotModels({ env: {}, settingsEnv: {} }).pilot.source).toBe('default')
  })

  it('resolves executor plugin options first, reports every source, and refuses invalid option values', () => {
    const profile = resolveExecutorProfileImpl({
      worktree: '/w', route: 'FULL', env: { WT_EXECUTOR_CODE_MODEL: 'haiku' }, settingsEnv: { WT_EXECUTOR_CODE_MODEL: 'fable' },
      resolveConsentImpl: () => ({ outcome: 'not_true' }),
      readPluginOption: (key: string) => key === 'executor_code_model' ? { present: true, value: 'opus' } : { present: false },
    })
    expect(profile.models.code).toBe('opus')
    expect(profile.modelSources).toEqual({ critic: 'default', code: 'plugin option', review: 'default', refutation: 'default' })
    expect(() => resolvePilotModelsImpl({ env: {}, settingsEnv: {}, readPluginOption: () => ({ present: true, value: 'openai/gpt-5.6-sol' }) })).toThrow('raw provider model')
  })

  it('refuses GPT and other non-harness values with the alias-remap remedy (Frederic, wt-suite #1536)', () => {
    for (const value of ['openai/gpt-5.6-luna', 'gpt-4o', 'codex', 'zai', '']) {
      expect(() => assertHarnessModel(value)).toThrow(
        'keep the alias (sonnet, opus, fable) and remap it in the profile env with ANTHROPIC_DEFAULT_<ALIAS>_MODEL',
      )
    }
  })

  it('reports the EFFECTIVE model a profile remaps an alias to, env over settings, alias untouched otherwise', () => {
    const models = resolvePilotModels({
      env: { WT_PILOT_MODEL: 'sonnet', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-terra' },
      settingsEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-luna', WT_PILOT_HARD_MODEL: 'fable', ANTHROPIC_DEFAULT_FABLE_MODEL: 'gpt-6-astra', WT_ORCHESTRATOR_MODEL: 'claude-sonnet-5' },
    })
    expect(models.pilot).toMatchObject({ value: 'sonnet', source: 'env', effective: 'gpt-5.6-terra', remappedBy: 'ANTHROPIC_DEFAULT_SONNET_MODEL (env)' })
    expect(models.pilotHard).toMatchObject({ value: 'fable', source: 'settings', effective: 'gpt-6-astra', remappedBy: 'ANTHROPIC_DEFAULT_FABLE_MODEL (settings)' })
    expect(models.orchestrator).toMatchObject({ value: 'claude-sonnet-5', effective: 'claude-sonnet-5', remappedBy: null })
    const plain = resolvePilotModels({ env: {}, settingsEnv: {} })
    expect(plain.pilot).toMatchObject({ value: 'opus', source: 'default', effective: 'opus', remappedBy: null })
  })

  it('prints only the three resolved lines and succeeds for a settings profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-models-cli-'))
    roots.push(root)
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: {
      WT_PILOT_MODEL: 'haiku',
      WT_PILOT_HARD_MODEL: 'opus',
      WT_ORCHESTRATOR_MODEL: 'claude-3-5-sonnet-latest',
    } }))
    const result = spawnSync(process.execPath, [CLI], {
      cwd: root,
      env: scrubbedEnv({ CLAUDE_CONFIG_DIR: config }),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe([
      'pilot=haiku (source=settings)',
      'pilotHard=opus (source=settings)',
      'orchestrator=claude-3-5-sonnet-latest (source=settings)',
      '',
    ].join('\n'))
    expect(result.stderr).toBe('')
  })

  it('exits 2 and names the refusal when a settings value is not a harness model', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-models-cli-refused-'))
    roots.push(root)
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_PILOT_MODEL: 'openai/gpt-5.6-luna' } }))
    const result = spawnSync(process.execPath, [CLI], {
      cwd: root,
      env: scrubbedEnv({ CLAUDE_CONFIG_DIR: config }),
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('keep the alias (sonnet, opus, fable) and remap it in the profile env')
    expect(result.stderr).toContain('refused model value: openai/gpt-5.6-luna')
    expect(result.stdout).toBe('')
  })
})
