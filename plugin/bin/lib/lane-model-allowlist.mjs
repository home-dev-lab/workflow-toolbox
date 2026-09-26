import { readWorkflowToolboxPluginOption, resolveWorkflowToolboxOption } from './plugin-options.mjs'

export const DEFAULT_LANE_MODELS = Object.freeze([
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-sol',
  'openai/gpt-6-luna',
  'openai/gpt-6-sol',
  'openai/gpt-6-astra',
])

// Aide-memoire kept up to date with variants we have verified; never an authority on what providers expose.
const KNOWN_VARIANTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

// Owner decision 2026-09-24 (wt-suite #4039): pilots and implementation run at medium. Hard pilots
// and orchestrators keep high.
// Owner decision 2026-09-26 12:17 +01:00 (GPT lane executor role table): critic max, code high,
// review medium, refutation medium. Astra reviews Sol's code (avoids same-model self-review);
// Artificial Analysis ranks Astra medium above Sol max for +45% cost, and our own bench found Sol
// already correct at medium-to-high on a hard task, with high->xhigh the worst-value step.
const VARIANT_ROLES = Object.freeze({
  pilot: ['pilot_variant', 'WT_PILOT_VARIANT', 'medium'],
  pilotHard: ['pilot_hard_variant', 'WT_PILOT_HARD_VARIANT', 'high'],
  orchestrator: ['orchestrator_variant', 'WT_ORCHESTRATOR_VARIANT', 'high'],
  sdkPilot: ['sdk_pilot_variant', 'WT_SDK_PILOT_VARIANT', 'medium'],
  sdkPilotHard: ['sdk_pilot_hard_variant', 'WT_SDK_PILOT_HARD_VARIANT', 'high'],
  sdkOrchestrator: ['sdk_orchestrator_variant', 'WT_SDK_ORCHESTRATOR_VARIANT', 'high'],
  critic: ['executor_critic_variant', 'WT_EXECUTOR_CRITIC_VARIANT', 'max'],
  code: ['executor_code_variant', 'WT_EXECUTOR_CODE_VARIANT', 'high'],
  review: ['executor_review_variant', 'WT_EXECUTOR_REVIEW_VARIANT', 'medium'],
  refutation: ['executor_refutation_variant', 'WT_EXECUTOR_REFUTATION_VARIANT', 'medium'],
})

export function variantRefusal(variant, model) {
  if (KNOWN_VARIANTS.includes(variant)) return null
  return `wt-lane: Refused: variant ${variant} is unknown for model ${model}; known variants: ${KNOWN_VARIANTS.join(', ')}. Choose a known variant, or pass --allow-unknown-variant to force it and leave an audit trace.`
}

export function resolveRoleVariant(role, model, { env = process.env, settingsEnv = {}, readPluginOption = readWorkflowToolboxPluginOption } = {}) {
  const definition = VARIANT_ROLES[role]
  if (!definition) throw new Error(`unknown variant role: ${String(role)}`)
  const [option, envKey, base] = definition
  const plugin = readPluginOption(option, { env })
  for (const [bag, source] of [[plugin.present && plugin.value ? { [envKey]: plugin.value } : {}, 'plugin option'], [env, 'env'], [settingsEnv, 'settings']]) {
    if (!Object.prototype.hasOwnProperty.call(bag, envKey)) continue
    const value = bag[envKey]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${envKey} must be a non-empty variant name`)
    const variant = value.trim()
    const refusal = variantRefusal(variant, model)
    if (refusal) throw new Error(refusal)
    return { value: variant, origin: 'override', source, forced: false }
  }
  // Forced xhigh is kept ONLY for gpt-5.6-sol, where it was measured; gpt-6-sol code now falls
  // through to the role base ('high', owner table 2026-09-26).
  if (role === 'code' && /gpt-5\.6-sol/i.test(model)) return { value: 'xhigh', origin: 'model profile', source: 'profile', forced: false }
  return { value: base, origin: 'role base', source: 'profile', forced: false }
}

export function resolveLaneModelAllowlist({ env = process.env } = {}) {
  const configured = resolveWorkflowToolboxOption('lane_models', { env }).value.trim()
  if (!configured) return [...DEFAULT_LANE_MODELS]
  return [...new Set(configured.split(/[\s,]+/).filter(Boolean))]
}

export function laneModelRefusal(model, options) {
  const allowed = resolveLaneModelAllowlist(options)
  if (allowed.includes(model)) return null
  return `wt-lane: Refused: model ${model} is not in the lane model allow-list (${allowed.join(', ')}); set WT_LANE_MODELS to the full list to allow (it replaces the default).`
}
