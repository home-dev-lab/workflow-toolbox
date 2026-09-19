import fs from 'node:fs'

const DEFAULT_PRICE_TABLE_FILE = new URL('../../pricing/model-prices.json', import.meta.url)
export const PRICE_UNKNOWN = 'price unknown'

export function loadModelPrices(file = DEFAULT_PRICE_TABLE_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function normalizeModelId(model, table) {
  const value = String(model ?? '').toLowerCase().replace(/^(?:anthropic|openai)\//, '')
  const matches = Object.keys(table?.models ?? {}).filter((canonical) => {
    const bare = canonical.replace(/^(?:anthropic|openai)\//, '')
    return value === bare || new RegExp(`^${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(value)
  })
  return matches.length === 1 ? matches[0] : null
}

export function priceTokens(model, tokens, table) {
  const canonical = normalizeModelId(model, table)
  if (!canonical) return PRICE_UNKNOWN
  const price = table.models[canonical]
  const amount = (Number(tokens.input) || 0) * price.input
    + (Number(tokens.cache_write) || 0) * (price.cache_write ?? 0)
    + (Number(tokens.cache_read) || 0) * price.cache_read
    + (Number(tokens.output) || 0) * price.output
  return amount / 1_000_000
}

export function priceRunCost(cost, table = loadModelPrices()) {
  const priced = structuredClone(cost)
  const unknownModels = new Set()
  let runUsd = 0
  for (const phase of priced.phases ?? []) {
    let phaseUsd = 0
    let phaseUnknown = false
    for (const [model, tokens] of Object.entries(phase.models ?? {})) {
      tokens.usd = priceTokens(model, tokens, table)
      if (tokens.usd === PRICE_UNKNOWN) { phaseUnknown = true; unknownModels.add(model) } else phaseUsd += tokens.usd
    }
    phase.usd = phaseUnknown ? PRICE_UNKNOWN : phaseUsd
    if (!phaseUnknown) runUsd += phaseUsd
  }
  priced.price_table = { version: table.version, as_of: table.as_of }
  priced.price_unknown_models = [...unknownModels].sort()
  if (priced.totals && priced.totals !== 'unknown') priced.totals.usd = unknownModels.size ? PRICE_UNKNOWN : runUsd
  return priced
}
