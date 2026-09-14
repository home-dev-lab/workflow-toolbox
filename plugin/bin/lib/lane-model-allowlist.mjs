export const DEFAULT_LANE_MODELS = Object.freeze([
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-sol',
  'openai/gpt-6-astra',
])

export function resolveLaneModelAllowlist({ env = process.env } = {}) {
  const configured = typeof env.WT_LANE_MODELS === 'string' ? env.WT_LANE_MODELS.trim() : ''
  if (!configured) return [...DEFAULT_LANE_MODELS]
  return [...new Set(configured.split(/[\s,]+/).filter(Boolean))]
}

export function laneModelRefusal(model, options) {
  const allowed = resolveLaneModelAllowlist(options)
  if (allowed.includes(model)) return null
  return `wt-lane: Refused: model ${model} is not in the lane model allow-list (${allowed.join(', ')}); set WT_LANE_MODELS to the full list to allow (it replaces the default).`
}
