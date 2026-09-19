import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { assertHarnessModel, resolveExecutorProfile as resolveExecutorProfileImpl, resolvePilotModels as resolvePilotModelsImpl } from '../../../../plugin/bin/lib/pilot-model-config.mjs'

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
    if (/^WT_(SDK_)?(PILOT|PILOT_HARD|ORCHESTRATOR)_MODEL$/.test(key) || /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key)) continue
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
      pilot: { value: 'haiku', source: 'env', effective: 'haiku', remappedBy: null },
      pilotHard: { value: 'fable', source: 'settings', effective: 'fable', remappedBy: null },
      orchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      sdkPilot: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      sdkPilotHard: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      sdkOrchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
    })
  })

  it('defaults: harness pilot opus, hard fable, orchestrator opus; SDK runner pilot, hard and orchestrator opus (owner 2026-09-14)', () => {
    expect(resolvePilotModels({ env: {}, settingsEnv: {} })).toEqual({
      pilot: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      pilotHard: { value: 'fable', source: 'default', effective: 'fable', remappedBy: null },
      orchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      sdkPilot: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      sdkPilotHard: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
      sdkOrchestrator: { value: 'opus', source: 'default', effective: 'opus', remappedBy: null },
    })
  })

  it.each([
    ['gpt-lane', 'LITE', false, { critic: 'openai/gpt-5.6-sol', code: 'openai/gpt-5.6-sol', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' }],
    ['gpt-lane', 'LITE', true, { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6-astra', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' }],
    ['gpt-lane', 'FULL', false, { critic: 'openai/gpt-5.6-sol', code: 'openai/gpt-5.6-sol', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' }],
    ['gpt-lane', 'FULL', true, { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6-astra', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' }],
    ['claude-sdk', 'LITE', false, { critic: 'opus', code: 'sonnet', review: 'opus', refutation: 'opus' }],
    ['claude-sdk', 'LITE', true, { critic: 'fable', code: 'opus', review: 'opus', refutation: 'fable' }],
    ['claude-sdk', 'FULL', false, { critic: 'opus', code: 'sonnet', review: 'opus', refutation: 'opus' }],
    ['claude-sdk', 'FULL', true, { critic: 'fable', code: 'opus', review: 'opus', refutation: 'fable' }],
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

  it('resolves a pilot plugin option before process env, settings env, and the default', () => {
    const option = (value: string) => () => ({ present: true, value })
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
