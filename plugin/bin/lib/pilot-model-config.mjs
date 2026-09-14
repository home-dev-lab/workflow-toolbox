import { resolveConsent } from './lane-consent-check-core.mjs'

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
  pilot: 'WT_PILOT_MODEL',
  pilotHard: 'WT_PILOT_HARD_MODEL',
  orchestrator: 'WT_ORCHESTRATOR_MODEL',
  sdkPilot: 'WT_SDK_PILOT_MODEL',
  sdkPilotHard: 'WT_SDK_PILOT_HARD_MODEL',
  sdkOrchestrator: 'WT_SDK_ORCHESTRATOR_MODEL',
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

export function resolvePilotModels({ env = {}, settingsEnv = {} } = {}) {
  return Object.fromEntries(
    Object.entries(MODEL_KEYS).map(([role, key]) => {
      const source = Object.prototype.hasOwnProperty.call(env, key)
        ? 'env'
        : Object.prototype.hasOwnProperty.call(settingsEnv, key)
          ? 'settings'
          : 'default'
      const value = source === 'env' ? env[key] : source === 'settings' ? settingsEnv[key] : DEFAULT_MODELS[role]
      assertHarnessModel(value)
      return [role, { value, source, ...effectiveModel(value, { env, settingsEnv }) }]
    }),
  )
}

const EXECUTOR_KEYS = {
  critic: 'WT_EXECUTOR_CRITIC_MODEL',
  code: 'WT_EXECUTOR_CODE_MODEL',
  review: 'WT_EXECUTOR_REVIEW_MODEL',
  refutation: 'WT_EXECUTOR_REFUTATION_MODEL',
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

export function resolveExecutorProfile({ worktree, route, hard = false, env = {}, settingsEnv = {}, resolveConsentImpl = resolveConsent }) {
  if (!['LITE', 'FULL'].includes(route)) throw new Error(`unknown executor route: ${String(route)}`)
  const executor = resolveConsentImpl(worktree, env).outcome === 'true' ? 'gpt-lane' : 'claude-sdk'
  const defaults = EXECUTOR_DEFAULTS[executor][hard ? 'hard' : 'standard']
  const models = Object.fromEntries(Object.entries(EXECUTOR_KEYS).map(([role, key]) => {
    const value = Object.prototype.hasOwnProperty.call(env, key)
      ? env[key]
      : Object.prototype.hasOwnProperty.call(settingsEnv, key)
        ? settingsEnv[key]
        : defaults[role]
    return [role, executor === 'gpt-lane' ? assertProviderModel(value) : assertHarnessAlias(value)]
  }))
  return { executor, models }
}
