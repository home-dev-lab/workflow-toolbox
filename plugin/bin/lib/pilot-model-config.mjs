const DEFAULT_MODEL = 'sonnet'
const MODEL_KEYS = {
  pilot: 'WT_PILOT_MODEL',
  pilotHard: 'WT_PILOT_HARD_MODEL',
  orchestrator: 'WT_ORCHESTRATOR_MODEL',
}

const GPT_PILOT_MESSAGE =
  'GPT pilot runs as an opencode runner; see the SDK-pilot spike card'

export function assertHarnessModel(value) {
  if (
    typeof value !== 'string'
    || !value
    || !['haiku', 'sonnet', 'opus', 'fable'].includes(value)
    && !value.startsWith('claude-')
  ) {
    throw new Error(`${GPT_PILOT_MESSAGE}; refused model value: ${String(value)}`)
  }
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
      const value = source === 'env' ? env[key] : source === 'settings' ? settingsEnv[key] : DEFAULT_MODEL
      assertHarnessModel(value)
      return [role, { value, source }]
    }),
  )
}
