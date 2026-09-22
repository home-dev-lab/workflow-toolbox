import { resolveConsent } from './lane-consent-check-core.mjs'
import { resolveRoleVariant } from './lane-model-allowlist.mjs'
import { hasModelPluginValue, readWorkflowToolboxPluginOption } from './plugin-options.mjs'

// Owner decisions 2026-09-14: the harness pilot and orchestrator (agents spawned by a session, no
// enforced lifecycle) run on Opus, Fable for hard cards; the SDK runner's pilot and orchestrator run on
// Opus in every cell, because the lifecycle server and stronger critic/refutation executors carry the rigour.
const DEFAULT_MODELS = {
  pilot: 'opus',
  pilotHard: 'fable',
  orchestrator: 'opus',
  sdkPilot: 'opus',
  sdkPilotHard: 'opus',
  sdkOrchestrator: 'opus',
}
const MODEL_KEYS = {
  pilot: ['pilot_model', 'WT_PILOT_MODEL'],
  pilotHard: ['pilot_hard_model', 'WT_PILOT_HARD_MODEL'],
  orchestrator: ['orchestrator_model', 'WT_ORCHESTRATOR_MODEL'],
  sdkPilot: ['sdk_pilot_model', 'WT_SDK_PILOT_MODEL'],
  sdkPilotHard: ['sdk_pilot_hard_model', 'WT_SDK_PILOT_HARD_MODEL'],
  sdkOrchestrator: ['sdk_orchestrator_model', 'WT_SDK_ORCHESTRATOR_MODEL'],
}

// A pilot's model is always a HARNESS alias (or a full claude-* id). A GPT pilot is not a
// different runner: it is the same alias launched under a profile whose env remaps it —
// `ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.6-terra` behind a local proxy is how GPT sessions run on
// the owner's machines (Frederic, wt-suite #1536, 2026-09-09). So a raw provider model in a
// WT_*_MODEL key is refused with THAT remedy, and the resolver reports the EFFECTIVE model the
// profile will actually run, so the spawn line never claims "sonnet" about a terra pilot.
const ALIASES = ['haiku', 'sonnet', 'opus', 'fable']
const GPT_PILOT_MESSAGE =
  'a raw provider model is not a harness model: keep the alias (sonnet, opus, fable) and remap it in the profile env with ANTHROPIC_DEFAULT_<ALIAS>_MODEL, the way GPT sessions run here'

function remapKey(alias) {
  return `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`
}

/** The model a harness alias resolves to under this env/settings profile, with its provenance. */
export function effectiveModel(value, { env = {}, settingsEnv = {} } = {}) {
  if (!ALIASES.includes(value)) return { effective: value, remappedBy: null }
  const key = remapKey(value)
  for (const [bag, name] of [[env, 'env'], [settingsEnv, 'settings']]) {
    const mapped = bag[key]
    if (typeof mapped === 'string' && mapped.trim()) return { effective: mapped.trim(), remappedBy: `${key} (${name})` }
  }
  return { effective: value, remappedBy: null }
}

export function assertHarnessModel(value) {
  if (
    typeof value !== 'string'
    || !value
    || !ALIASES.includes(value)
    && !value.startsWith('claude-')
  ) {
    throw new Error(`${GPT_PILOT_MESSAGE}; refused model value: ${String(value)}`)
  }
  return value
}

export function assertHarnessAlias(value) {
  if (!ALIASES.includes(value)) throw new Error(`executor Claude override must be a harness model alias (${ALIASES.join(', ')}); refused model value: ${String(value)}`)
  return value
}

function resolveModelInput(plugin, key, env, settingsEnv, fallback) {
  if (hasModelPluginValue(plugin)) {
    return { value: plugin.value, source: 'plugin option' }
  }
  if (Object.prototype.hasOwnProperty.call(env, key)) return { value: env[key], source: 'env' }
  if (Object.prototype.hasOwnProperty.call(settingsEnv, key)) return { value: settingsEnv[key], source: 'settings' }
  return { value: fallback, source: 'default' }
}

export function resolvePilotModels({ env = {}, settingsEnv = {}, readPluginOption = readWorkflowToolboxPluginOption } = {}) {
  return Object.fromEntries(
    Object.entries(MODEL_KEYS).map(([role, [option, key]]) => {
      const plugin = readPluginOption(option, { env })
      const { value, source } = resolveModelInput(plugin, key, env, settingsEnv, DEFAULT_MODELS[role])
      assertHarnessModel(value)
      const effective = effectiveModel(value, { env, settingsEnv })
      return [role, { value, source, ...effective, variant: resolveRoleVariant(role, effective.effective, { env, settingsEnv, readPluginOption }) }]
    }),
  )
}

const EXECUTOR_KEYS = {
  critic: ['executor_critic_model', 'WT_EXECUTOR_CRITIC_MODEL'],
  code: ['executor_code_model', 'WT_EXECUTOR_CODE_MODEL'],
  review: ['executor_review_model', 'WT_EXECUTOR_REVIEW_MODEL'],
  refutation: ['executor_refutation_model', 'WT_EXECUTOR_REFUTATION_MODEL'],
}
const EXECUTOR_DEFAULTS = {
  'gpt-lane': {
    standard: { critic: 'openai/gpt-5.6-sol', code: 'openai/gpt-5.6-sol', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' },
    hard: { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6-astra', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' },
  },
  'claude-sdk': {
    standard: { critic: 'opus', code: 'sonnet', review: 'opus', refutation: 'opus' },
    hard: { critic: 'fable', code: 'opus', review: 'opus', refutation: 'fable' },
  },
}

function assertProviderModel(value) {
  if (typeof value !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new Error(`executor GPT override must be a provider model (provider/model); refused model value: ${String(value)}`)
  }
  return value
}

export function resolveExecutorProfile({ worktree, route, hard = false, env = {}, settingsEnv = {}, resolveConsentImpl = resolveConsent, readPluginOption = readWorkflowToolboxPluginOption }) {
  if (!['LITE', 'FULL'].includes(route)) throw new Error(`unknown executor route: ${String(route)}`)
  const executor = resolveConsentImpl(worktree, env).outcome === 'true' ? 'gpt-lane' : 'claude-sdk'
  const defaults = EXECUTOR_DEFAULTS[executor][hard ? 'hard' : 'standard']
  const resolved = Object.fromEntries(Object.entries(EXECUTOR_KEYS).map(([role, [option, key]]) => {
    const plugin = readPluginOption(option, { env })
    const selected = resolveModelInput(plugin, key, env, settingsEnv, defaults[role])
    const value = executor === 'gpt-lane'
      ? assertProviderModel(selected.value)
      : assertHarnessAlias(selected.value)
    return [role, { value, source: selected.source, variant: resolveRoleVariant(role, value, { env, settingsEnv, readPluginOption }) }]
  }))
  return {
    executor,
    models: Object.fromEntries(Object.entries(resolved).map(([role, model]) => [role, model.value])),
    modelSources: Object.fromEntries(Object.entries(resolved).map(([role, model]) => [role, model.source])),
    variants: Object.fromEntries(Object.entries(resolved).map(([role, model]) => [role, model.variant.value])),
    variantOrigins: Object.fromEntries(Object.entries(resolved).map(([role, model]) => [role, model.variant.origin])),
  }
}
