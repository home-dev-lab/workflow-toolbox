import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConsent } from './lane-consent-check-core.mjs'

const PLUGIN_CONFIG_PREFIX = 'workflow-toolbox@'

const DEFINITIONS = Object.freeze({
  executor_lane_consent: { envKey: 'WT_EXECUTOR_LANE_CONSENT', type: 'boolean', defaultValue: false },
  adopt_refresh: { envKey: 'WT_ADOPT_REFRESH', type: 'string', defaultValue: 'session' },
  lane_skills: { envKey: 'WT_LANE_SKILLS', type: 'string', defaultValue: '' },
  lane_models: { envKey: 'WT_LANE_MODELS', type: 'string', defaultValue: 'openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-5.6-sol,openai/gpt-6-astra' },
  artifact_server: { envKey: 'WT_ARTIFACT_SERVER', type: 'boolean', defaultValue: true },
  artifact_server_roots: { envKey: 'WT_ARTIFACT_SERVER_ROOTS', type: 'string', defaultValue: null },
  artifact_server_port: { envKey: 'WT_ARTIFACT_SERVER_PORT', type: 'number', defaultValue: null },
  artifact_server_idle_grace_s: { envKey: 'WT_ARTIFACT_SERVER_IDLE_GRACE_S', type: 'number', defaultValue: 600 },
  artifact_server_deny: { envKey: 'WT_ARTIFACT_SERVER_DENY', type: 'string', defaultValue: '' },
  planka_mcp_url: { envKey: 'WT_PLANKA_MCP_URL', type: 'string', defaultValue: '' },
  second_opinion_fable_max_pct: { envKey: 'WT_SECOND_OPINION_FABLE_MAX_PCT', type: 'number', defaultValue: 90 },
  lane_orphan_cleanup: { envKey: 'WT_LANE_ORPHAN_CLEANUP', type: 'string', defaultValue: 'observe' },
  lane_stall_minutes: { envKey: 'WT_LANE_STALL_MINUTES', type: 'number', defaultValue: 10 },
  release_branch: { envKey: 'WT_RELEASE_BRANCH', type: 'string', defaultValue: '' },
  pilot_model: { envKey: 'WT_PILOT_MODEL', type: 'string', defaultValue: 'opus' },
  pilot_hard_model: { envKey: 'WT_PILOT_HARD_MODEL', type: 'string', defaultValue: 'opus' },
  orchestrator_model: { envKey: 'WT_ORCHESTRATOR_MODEL', type: 'string', defaultValue: 'opus' },
  sdk_pilot_model: { envKey: 'WT_SDK_PILOT_MODEL', type: 'string', defaultValue: 'opus' },
  sdk_pilot_hard_model: { envKey: 'WT_SDK_PILOT_HARD_MODEL', type: 'string', defaultValue: 'opus' },
  sdk_orchestrator_model: { envKey: 'WT_SDK_ORCHESTRATOR_MODEL', type: 'string', defaultValue: 'opus' },
  pilot_variant: { envKey: 'WT_PILOT_VARIANT', type: 'string', defaultValue: 'high' },
  pilot_hard_variant: { envKey: 'WT_PILOT_HARD_VARIANT', type: 'string', defaultValue: 'high' },
  orchestrator_variant: { envKey: 'WT_ORCHESTRATOR_VARIANT', type: 'string', defaultValue: 'high' },
  sdk_pilot_variant: { envKey: 'WT_SDK_PILOT_VARIANT', type: 'string', defaultValue: 'high' },
  sdk_pilot_hard_variant: { envKey: 'WT_SDK_PILOT_HARD_VARIANT', type: 'string', defaultValue: 'high' },
  sdk_orchestrator_variant: { envKey: 'WT_SDK_ORCHESTRATOR_VARIANT', type: 'string', defaultValue: 'high' },
  sdk_pilot_max_active: { envKey: 'WT_SDK_PILOT_MAX_ACTIVE', type: 'number', defaultValue: 3 },
  executor_critic_model: { envKey: 'WT_EXECUTOR_CRITIC_MODEL', type: 'string', defaultValue: '' },
  executor_code_model: { envKey: 'WT_EXECUTOR_CODE_MODEL', type: 'string', defaultValue: '' },
  executor_review_model: { envKey: 'WT_EXECUTOR_REVIEW_MODEL', type: 'string', defaultValue: '' },
  executor_refutation_model: { envKey: 'WT_EXECUTOR_REFUTATION_MODEL', type: 'string', defaultValue: '' },
  executor_critic_variant: { envKey: 'WT_EXECUTOR_CRITIC_VARIANT', type: 'string', defaultValue: 'high' },
  executor_code_variant: { envKey: 'WT_EXECUTOR_CODE_VARIANT', type: 'string', defaultValue: '' },
  executor_review_variant: { envKey: 'WT_EXECUTOR_REVIEW_VARIANT', type: 'string', defaultValue: 'high' },
  executor_refutation_variant: { envKey: 'WT_EXECUTOR_REFUTATION_VARIANT', type: 'string', defaultValue: 'high' },
  configDir: { envKey: null, type: 'string', defaultValue: '' },
  livenessDir: { envKey: null, type: 'string', defaultValue: '' },
  suiteRoot: { envKey: null, type: 'string', defaultValue: '' },
  extraRoots: { envKey: null, type: 'string', defaultValue: '' },
  pollMs: { envKey: null, type: 'number', defaultValue: 2000 },
  collectorTimeoutMs: { envKey: null, type: 'number', defaultValue: 30000 },
  activeWindowMin: { envKey: null, type: 'number', defaultValue: 10 },
  linkBase: { envKey: null, type: 'string', defaultValue: '' },
  plankaBaseUrl: { envKey: null, type: 'string', defaultValue: '' },
  plankaConfigFile: { envKey: null, type: 'string', defaultValue: '' },
})

function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
}

function pluginOption(settings, key, type) {
  const configs = settings?.pluginConfigs
  if (!configs || typeof configs !== 'object') return { present: false }
  const values = Object.entries(configs)
    .filter(([pluginId]) => pluginId.startsWith(PLUGIN_CONFIG_PREFIX))
    .map(([, config]) => config?.options?.[key])
    .filter((value) => typeof value === type)
  if (values.length === 0 || values.some((value) => !Object.is(value, values[0]))) return { present: false }
  return { present: true, value: values[0] }
}

function readSettings(env) {
  try {
    return JSON.parse(readFileSync(path.join(configDir(env), 'settings.json'), 'utf8'))
  } catch {
    return null
  }
}

export function readWorkflowToolboxPluginOption(key, { env = process.env } = {}) {
  const definition = DEFINITIONS[key]
  if (!definition) throw new Error(`unknown workflow-toolbox plugin option: ${key}`)
  return pluginOption(readSettings(env), key, definition.type)
}

export function hasModelPluginValue(plugin) {
  return plugin.present && typeof plugin.value === 'string' && plugin.value.trim() !== ''
}

function envValue(definition, env) {
  if (!definition.envKey) return { present: false }
  const raw = env[definition.envKey]
  if (raw === undefined) return { present: false }
  if (definition.type === 'boolean') return { present: true, value: raw !== '0' }
  if (definition.type === 'number') return { present: true, value: Number(raw) }
  return { present: true, value: raw }
}

export function resolveWorkflowToolboxOption(key, { env = process.env } = {}) {
  const definition = DEFINITIONS[key]
  if (!definition) throw new Error(`unknown workflow-toolbox plugin option: ${key}`)
  const option = readWorkflowToolboxPluginOption(key, { env })
  if (option.present && (!key.endsWith('_model') || hasModelPluginValue(option))) return { value: option.value, source: 'plugin option' }
  const fallback = envValue(definition, env)
  if (fallback.present) return { value: fallback.value, source: 'env' }
  return { value: definition.defaultValue, source: 'default' }
}

function redactValue(value, option, envKey) {
  if (typeof value !== 'string') return value
  if (!/model/i.test(option) && /token|secret|password|key/i.test(`${option} ${envKey ?? ''}`)) return '[redacted]'
  try {
    const relative = value.startsWith('//')
    const url = relative ? new URL(value, 'https://redaction.invalid') : new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    return relative ? url.toString().replace(/^https:/, '') : url.toString()
  } catch {
    return value
  }
}

function consentRow(projectDir, env) {
  const consent = resolveConsent(projectDir, env)
  if (consent.account.source === 'disagreement') {
    return { value: 'false (account plugin option and env var disagree)', source: 'plugin option' }
  }
  if (consent.outcome === 'unknown') {
    return { value: 'false (consent settings unresolved)', source: 'default' }
  }
  if (consent.project.state === 'not_true' && consent.account.state === 'true') {
    return { value: false, source: 'project narrowing' }
  }
  if (consent.account.source === 'userConfig') {
    return { value: consent.account.state === 'true', source: 'plugin option' }
  }
  if (consent.account.source === 'settings env') {
    return { value: consent.account.state === 'true', source: 'env var' }
  }
  return { value: false, source: 'default' }
}

const EXECUTOR_DEFAULT_DESCRIPTIONS = {
  executor_critic_model: 'claude-sdk opus / hard opus; gpt-lane openai/gpt-5.6-sol / hard openai/gpt-6-astra',
  executor_code_model: 'claude-sdk sonnet / hard opus; gpt-lane openai/gpt-5.6-sol / hard openai/gpt-6-astra',
  executor_review_model: 'claude-sdk opus / hard opus; gpt-lane openai/gpt-5.6-sol / hard openai/gpt-5.6-sol',
  executor_refutation_model: 'claude-sdk opus / hard opus; gpt-lane openai/gpt-6-astra / hard openai/gpt-6-astra',
}

function describedResolution(option, definition, env, settings) {
  const plugin = pluginOption(settings, option, definition.type)
  const modelOption = option.endsWith('_model')
  if (plugin.present && (!modelOption || hasModelPluginValue(plugin))) return { value: plugin.value, source: 'plugin option' }
  const processFallback = envValue(definition, env)
  if (processFallback.present) return { value: processFallback.value, source: modelOption ? 'env' : 'env var' }
  const settingsFallback = envValue(definition, settings?.env ?? {})
  if (settingsFallback.present) return { value: settingsFallback.value, source: modelOption ? 'settings' : 'env var' }
  return {
    value: EXECUTOR_DEFAULT_DESCRIPTIONS[option] ?? definition.defaultValue,
    source: 'default',
  }
}

export function describeWorkflowToolboxOptions({ env = process.env, projectDir = process.cwd(), manifest }) {
  const userConfig = manifest?.userConfig ?? {}
  const settings = readSettings(env)
  return Object.entries(userConfig).map(([option, schema]) => {
    const definition = DEFINITIONS[option]
    if (!definition) throw new Error(`manifest option has no workflow-toolbox definition: ${option}`)
    const resolved = option === 'executor_lane_consent'
      ? consentRow(projectDir, env)
      : describedResolution(option, definition, env, settings)
    return {
      option,
      title: schema.title,
      effective: redactValue(resolved.value, option, definition.envKey),
      source: resolved.source,
      defaultValue: Object.prototype.hasOwnProperty.call(schema, 'default') ? schema.default : null,
      envKey: definition.envKey,
    }
  })
}

export function findOrphanedPluginConfigs({ settings, installed, manifest }) {
  const configs = settings?.pluginConfigs
  if (!configs || typeof configs !== 'object' || !installed || typeof installed !== 'object') return []
  const installedMap = installed?.plugins && typeof installed.plugins === 'object' ? installed.plugins : installed
  const installedIds = new Set(installedMap && typeof installedMap === 'object' ? Object.keys(installedMap) : [])
  const workflowToolboxId = [...installedIds].find((id) => id.startsWith(`${PLUGIN_CONFIG_PREFIX}`))
  const declared = new Set(Object.keys(manifest?.userConfig ?? {}))
  return Object.entries(configs)
    .filter(([key]) => !installedIds.has(key))
    .map(([key, config]) => ({
      key,
      moves: Object.keys(config?.options ?? {}).map((option) => ({
        option,
        target: declared.has(option) && workflowToolboxId
          ? `${workflowToolboxId}.options.${option}`
          : `no installed plugin declares ${option}`,
      })),
    }))
}
