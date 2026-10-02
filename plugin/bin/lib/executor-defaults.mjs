// Shared by model routing, effort resolution, and the options display.
export function executorFamilyForModel(model) {
  if (typeof model !== 'string') return null
  if (/^[^/\s]+\/[^/\s]+$/.test(model)) return 'gpt-lane'
  if (['haiku', 'sonnet', 'opus', 'fable'].includes(model)) return 'claude-sdk'
  return null
}

// The ONE definition of the default external-lane model allow-list. plugin-options.mjs derives the
// lane_models option default from it and lane-model-allowlist.mjs re-exports it; the manifest
// (plugin.json, which cannot import) is held equal by the plugin-options resolver-default lock.
export const DEFAULT_LANE_MODELS = Object.freeze([
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-sol',
  'openai/gpt-6-luna',
  'openai/gpt-6-sol',
  'openai/gpt-6-astra',
  'openai/gpt-6.1-sol',
])

export const EXECUTOR_DEFAULTS = Object.freeze({
  'gpt-lane': {
    standard: { critic: 'openai/gpt-6-sol', code: 'openai/gpt-6.1-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' },
    hard: { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6.1-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' },
  },
  'claude-sdk': {
    standard: { critic: 'opus', code: 'sonnet', review: 'opus', refutation: 'opus' },
    hard: { critic: 'opus', code: 'opus', review: 'opus', refutation: 'opus' },
  },
})

export const EXECUTOR_VARIANT_BASES = Object.freeze({
  openai: { critic: 'max', code: 'high', review: 'medium', refutation: 'medium' },
  claude: { critic: 'xhigh', code: 'medium', review: 'xhigh', refutation: 'xhigh' },
})
