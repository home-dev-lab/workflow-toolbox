// Shared by model routing, effort resolution, and the options display.
export function executorFamilyForModel(model) {
  if (typeof model !== 'string') return null
  if (/^[^/\s]+\/[^/\s]+$/.test(model)) return 'gpt-lane'
  if (['haiku', 'sonnet', 'opus', 'fable'].includes(model)) return 'claude-sdk'
  return null
}

export const EXECUTOR_DEFAULTS = Object.freeze({
  'gpt-lane': {
    standard: { critic: 'openai/gpt-6-sol', code: 'openai/gpt-6-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' },
    hard: { critic: 'openai/gpt-6-astra', code: 'openai/gpt-6-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' },
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
