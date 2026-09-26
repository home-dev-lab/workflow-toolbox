// Shared by model routing, effort resolution, and the options display.
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
