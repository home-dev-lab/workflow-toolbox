const DEFAULT_MODEL = 'sonnet'
const MODEL_KEYS = {
  pilot: 'WT_PILOT_MODEL',
  pilotHard: 'WT_PILOT_HARD_MODEL',
  orchestrator: 'WT_ORCHESTRATOR_MODEL',
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
      return [role, { value, source, ...effectiveModel(value, { env, settingsEnv }) }]
    }),
  )
}
