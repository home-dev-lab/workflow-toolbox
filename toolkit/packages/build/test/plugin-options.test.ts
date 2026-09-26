import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helpers have no declaration surface.
import { describeWorkflowToolboxOptions, findOrphanedPluginConfigs, resolveWorkflowToolboxOption } from '../../../../plugin/bin/lib/plugin-options.mjs'
// @ts-expect-error Standalone plugin helpers have no declaration surface.
import { resolveExecutorProfile, resolvePilotModels } from '../../../../plugin/bin/lib/pilot-model-config.mjs'
import manifest from '../../../../plugin/.claude-plugin/plugin.json'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const cases = [
  { option: 'lane_skills', envKey: 'WT_LANE_SKILLS', optionValue: 'option-skill', envValue: 'env-skill', defaultValue: '' },
  { option: 'lane_models', envKey: 'WT_LANE_MODELS', optionValue: 'option/model', envValue: 'env/model', defaultValue: 'openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-5.6-sol,openai/gpt-6-luna,openai/gpt-6-sol,openai/gpt-6-astra' },
  { option: 'artifact_server', envKey: 'WT_ARTIFACT_SERVER', optionValue: false, envValue: '1', defaultValue: true },
  { option: 'artifact_server_roots', envKey: 'WT_ARTIFACT_SERVER_ROOTS', optionValue: 'option=/root', envValue: 'env=/root', defaultValue: null },
  { option: 'artifact_server_port', envKey: 'WT_ARTIFACT_SERVER_PORT', optionValue: 49123, envValue: '49124', defaultValue: null },
  { option: 'artifact_server_idle_grace_s', envKey: 'WT_ARTIFACT_SERVER_IDLE_GRACE_S', optionValue: 42, envValue: '43', defaultValue: 600 },
  { option: 'artifact_server_deny', envKey: 'WT_ARTIFACT_SERVER_DENY', optionValue: '*.option', envValue: '*.env', defaultValue: '' },
  { option: 'planka_mcp_url', envKey: 'WT_PLANKA_MCP_URL', optionValue: 'http://option:1/mcp', envValue: 'http://env:2/mcp', defaultValue: '' },
  { option: 'second_opinion_fable_max_pct', envKey: 'WT_SECOND_OPINION_FABLE_MAX_PCT', optionValue: 72, envValue: '73', defaultValue: 90 },
  { option: 'sdk_pilot_max_active', envKey: 'WT_SDK_PILOT_MAX_ACTIVE', optionValue: 4, envValue: '5', defaultValue: 3 },
  { option: 'release_branch', envKey: 'WT_RELEASE_BRANCH', optionValue: 'stable', envValue: 'release', defaultValue: '' },
  { option: 'adopt_refresh', envKey: 'WT_ADOPT_REFRESH', optionValue: 'notice-only', envValue: 'session', defaultValue: 'session' },
] as const

function fixture(settings?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'wt-plugin-options-'))
  roots.push(root)
  const config = join(root, 'config')
  mkdirSync(config)
  if (settings !== undefined) writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  const project = join(root, 'project')
  mkdirSync(join(project, '.claude'), { recursive: true })
  return { root, config, project, env: { CLAUDE_CONFIG_DIR: config, HOME: root } as NodeJS.ProcessEnv }
}

describe('workflow-toolbox plugin option resolver', () => {
  it.each(cases)('$option: plugin option wins over env', ({ option, envKey, optionValue, envValue }) => {
    const f = fixture({ pluginConfigs: { 'workflow-toolbox@local': { options: { [option]: optionValue } } } })
    f.env[envKey] = envValue
    expect(resolveWorkflowToolboxOption(option, { env: f.env })).toEqual({ value: optionValue, source: 'plugin option' })
  })

  it.each(cases)('$option: env is used without a plugin option', ({ option, envKey, envValue }) => {
    const f = fixture({})
    f.env[envKey] = envValue
    const expected = option === 'artifact_server_port' || option === 'artifact_server_idle_grace_s' || option === 'second_opinion_fable_max_pct' || option === 'sdk_pilot_max_active'
      ? Number(envValue)
      : option === 'artifact_server'
        ? true
        : envValue
    expect(resolveWorkflowToolboxOption(option, { env: f.env })).toEqual({ value: expected, source: 'env' })
  })

  it.each(cases)('$option: default is used without option or env', ({ option, defaultValue }) => {
    const f = fixture({})
    expect(resolveWorkflowToolboxOption(option, { env: f.env })).toEqual({ value: defaultValue, source: 'default' })
  })

  it('falls back to env when settings.json is invalid or unreadable', () => {
    const invalid = fixture()
    writeFileSync(join(invalid.config, 'settings.json'), '{')
    invalid.env.WT_LANE_MODELS = 'env/model'
    expect(resolveWorkflowToolboxOption('lane_models', { env: invalid.env })).toEqual({ value: 'env/model', source: 'env' })

    const unreadable = fixture()
    mkdirSync(join(unreadable.config, 'settings.json'))
    unreadable.env.WT_LANE_MODELS = 'env/model'
    expect(resolveWorkflowToolboxOption('lane_models', { env: unreadable.env })).toEqual({ value: 'env/model', source: 'env' })
  })

  it('keeps every manifest option and its resolver default in lockstep', () => {
    const f = fixture({})
    for (const [key, schema] of Object.entries(manifest.userConfig)) {
      const expected = 'default' in schema ? schema.default : null
      expect(resolveWorkflowToolboxOption(key, { env: f.env }), key).toEqual({ value: expected, source: 'default' })
    }
  })

  it('describes plugin option over env over default and redacts URL credentials and queries', () => {
    const f = fixture({ pluginConfigs: { 'workflow-toolbox@local': { options: { lane_skills: 'option', planka_mcp_url: 'https://user:pass@example.test/mcp?token=hidden' } } } })
    f.env.WT_LANE_SKILLS = 'env'
    const rows = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest })
    expect(rows.find((row: { option: string }) => row.option === 'lane_skills')).toMatchObject({ effective: 'option', source: 'plugin option', defaultValue: '' })
    expect(rows.find((row: { option: string }) => row.option === 'planka_mcp_url')).toMatchObject({ effective: 'https://example.test/mcp', source: 'plugin option' })
    expect(rows.find((row: { option: string }) => row.option === 'pollMs')).toMatchObject({ effective: 2000, source: 'default' })
  })

  it('reads settings env fallbacks and treats empty executor options as dynamic defaults, not overrides', () => {
    const f = fixture({
      env: { WT_EXECUTOR_CODE_MODEL: 'fable', WT_PILOT_MODEL: 'haiku' },
      pluginConfigs: { 'workflow-toolbox@local': { options: { executor_code_model: '' } } },
    })
    const rows = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest })
    expect(rows.find((row: { option: string }) => row.option === 'pilot_model')).toMatchObject({ effective: 'haiku', source: 'settings' })
    expect(rows.find((row: { option: string }) => row.option === 'executor_code_model')).toMatchObject({ effective: 'fable', source: 'settings', defaultValue: '' })

    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'workflow-toolbox@local': { options: { executor_code_model: '' } } } }))
    const defaultRow = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest }).find((row: { option: string }) => row.option === 'executor_code_model')
    expect(defaultRow).toMatchObject({ effective: 'claude-sdk sonnet / hard opus; gpt-lane openai/gpt-6-sol / hard openai/gpt-6-astra', source: 'default' })
  })

  it('reports the same fallback source as both model resolvers for every empty model option', () => {
    const settingsEnv = {
      WT_PILOT_MODEL: 'haiku',
      WT_PILOT_HARD_MODEL: 'opus',
      WT_ORCHESTRATOR_MODEL: 'fable',
      WT_SDK_PILOT_MODEL: 'sonnet',
      WT_SDK_PILOT_HARD_MODEL: 'haiku',
      WT_SDK_ORCHESTRATOR_MODEL: 'opus',
      WT_EXECUTOR_CRITIC_MODEL: 'fable',
      WT_EXECUTOR_CODE_MODEL: 'opus',
      WT_EXECUTOR_REVIEW_MODEL: 'sonnet',
      WT_EXECUTOR_REFUTATION_MODEL: 'haiku',
    }
    const options = {
      pilot_model: '',
      pilot_hard_model: ' ',
      orchestrator_model: '',
      sdk_pilot_model: ' ',
      sdk_pilot_hard_model: '',
      sdk_orchestrator_model: ' ',
      executor_critic_model: '',
      executor_code_model: ' ',
      executor_review_model: '',
      executor_refutation_model: ' ',
    }
    const f = fixture({ env: settingsEnv, pluginConfigs: { 'workflow-toolbox@local': { options } } })
    const rows = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest })
    const pilots = resolvePilotModels({ env: f.env, settingsEnv })
    const executor = resolveExecutorProfile({
      worktree: f.project,
      route: 'FULL',
      env: f.env,
      settingsEnv,
      resolveConsentImpl: () => ({ outcome: 'not_true' }),
    })
    const resolved = {
      pilot_model: pilots.pilot,
      pilot_hard_model: pilots.pilotHard,
      orchestrator_model: pilots.orchestrator,
      sdk_pilot_model: pilots.sdkPilot,
      sdk_pilot_hard_model: pilots.sdkPilotHard,
      sdk_orchestrator_model: pilots.sdkOrchestrator,
      executor_critic_model: { value: executor.models.critic, source: executor.modelSources.critic },
      executor_code_model: { value: executor.models.code, source: executor.modelSources.code },
      executor_review_model: { value: executor.models.review, source: executor.modelSources.review },
      executor_refutation_model: { value: executor.models.refutation, source: executor.modelSources.refutation },
    }
    for (const [option, model] of Object.entries(resolved)) {
      expect(rows.find((row: { option: string }) => row.option === option), option).toMatchObject({ effective: model.value, source: model.source })
    }
  })

  it.each([
    ['ftp://user:pass@example.test/path?token=hidden', 'ftp://example.test/path'],
    ['//user:pass@example.test/path?token=hidden', '//example.test/path'],
  ])('redacts URL userinfo and queries from %s', (url, redacted) => {
    const f = fixture({ pluginConfigs: { 'workflow-toolbox@local': { options: { planka_mcp_url: url } } } })
    const row = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest }).find((item: { option: string }) => item.option === 'planka_mcp_url')
    expect(row?.effective).toBe(redacted)
  })

  it('reports consent env and project narrowing sources without exposing unrelated env values', () => {
    const f = fixture({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } })
    let row = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest }).find((item: { option: string }) => item.option === 'executor_lane_consent')
    expect(row).toMatchObject({ effective: true, source: 'env var' })
    writeFileSync(join(f.project, '.claude', 'settings.local.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    row = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest }).find((item: { option: string }) => item.option === 'executor_lane_consent')
    expect(row).toMatchObject({ effective: false, source: 'project narrowing' })
  })

  it('makes account consent disagreement visible while remaining fail-closed', () => {
    const f = fixture({
      env: { WT_EXECUTOR_LANE_CONSENT: 'true' },
      pluginConfigs: { 'workflow-toolbox@local': { options: { executor_lane_consent: false } } },
    })
    const row = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest }).find((item: { option: string }) => item.option === 'executor_lane_consent')
    expect(row).toMatchObject({ effective: 'false (account plugin option and env var disagree)', source: 'plugin option' })
  })

  it('reports unresolved project consent settings as fail-closed', () => {
    const f = fixture({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } })
    writeFileSync(join(f.project, '.claude', 'settings.local.json'), '{')
    const row = describeWorkflowToolboxOptions({ env: f.env, projectDir: f.project, manifest }).find((item: { option: string }) => item.option === 'executor_lane_consent')
    expect(row).toMatchObject({ effective: 'false (consent settings unresolved)', source: 'default' })
  })

  it('reports orphaned plugin configs with move targets and never modifies settings', () => {
    const settings = { pluginConfigs: {
      'wt-what-is-running@inline': { options: { linkBase: 'http://localhost:8080', mystery: true } },
      'installed@market': { options: { anything: true } },
    } }
    const f = fixture(settings)
    const file = join(f.config, 'settings.json')
    const before = readFileSync(file)
    expect(findOrphanedPluginConfigs({
      settings,
      installed: { plugins: { 'workflow-toolbox@market': [{}], 'installed@market': [{}] } },
      manifest,
    })).toEqual([{ key: 'wt-what-is-running@inline', moves: [
      { option: 'linkBase', target: 'workflow-toolbox@market.options.linkBase' },
      { option: 'mystery', target: 'no installed plugin declares mystery' },
    ] }])
    expect(readFileSync(file)).toEqual(before)
  })

  it('does not claim settings are orphaned when the installed registry is unavailable', () => {
    expect(findOrphanedPluginConfigs({
      settings: { pluginConfigs: { 'workflow-toolbox@market': { options: { lane_skills: 'x' } } } },
      installed: null,
      manifest,
    })).toEqual([])
  })
})
