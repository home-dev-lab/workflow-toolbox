import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN_CONFIG_PREFIX = 'workflow-toolbox@'

const DEFINITIONS = Object.freeze({
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

function readPluginOption(env, key, type) {
  try {
    const settings = JSON.parse(readFileSync(path.join(configDir(env), 'settings.json'), 'utf8'))
    return pluginOption(settings, key, type)
  } catch {
    return { present: false }
  }
}

function envValue(definition, env) {
  const raw = env[definition.envKey]
  if (raw === undefined) return { present: false }
  if (definition.type === 'boolean') return { present: true, value: raw !== '0' }
  if (definition.type === 'number') return { present: true, value: Number(raw) }
  return { present: true, value: raw }
}

export function resolveWorkflowToolboxOption(key, { env = process.env } = {}) {
  const definition = DEFINITIONS[key]
  if (!definition) throw new Error(`unknown workflow-toolbox plugin option: ${key}`)
  const option = readPluginOption(env, key, definition.type)
  if (option.present) return { value: option.value, source: 'plugin option' }
  const fallback = envValue(definition, env)
  if (fallback.present) return { value: fallback.value, source: 'env' }
  return { value: definition.defaultValue, source: 'default' }
}
