import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePluginDataDir } from './plugin-data-dir.mjs'

const DEFAULT_PRICE_TABLE_FILE = new URL('../../pricing/model-prices.json', import.meta.url)
const MAX_PRICE_AGE_MS = 60 * 24 * 60 * 60 * 1000
const PRICE_UNKNOWN = 'price unknown'
const SUBSCRIPTION = 'subscription'

function nonEmpty(value) {
  return typeof value === 'string' && value ? value : null
}

function openCodeCataloguePath({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  let platformBase = path.join(home, '.cache')
  if (platform === 'darwin') platformBase = path.join(home, 'Library', 'Caches')
  else if (platform === 'win32') platformBase = nonEmpty(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local')
  const base = nonEmpty(env.XDG_CACHE_HOME) ?? platformBase
  return path.join(base, 'opencode', 'models.json')
}

function modelPriceOverridePath({ env = process.env } = {}) {
  return path.join(resolvePluginDataDir({ env }).dir, 'model-prices.override.json')
}

function readOptionalJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), mtime: fs.statSync(file).mtime }
  } catch (error) {
    let reason = 'file not found'
    if (error?.code !== 'ENOENT') reason = `unreadable: ${error instanceof Error ? error.message : String(error)}`
    return { value: null, mtime: null, reason }
  }
}

function datedModelId(model) {
  return String(model).replace(/-\d{8}$/, '')
}

function fallbackModels(table) {
  return Object.fromEntries(Object.entries(table.models ?? {}).map(([model, price]) => {
    const key = model.includes('/') ? model : `${price.family}/${model}`
    return [key, { ...price, price_source: 'shipped fallback', verified_at: price.retrieved ?? table.as_of }]
  }))
}

function catalogueModels(catalogue, verifiedAt) {
  const result = {}
  for (const [provider, providerValue] of Object.entries(catalogue ?? {})) {
    for (const [modelKey, modelValue] of Object.entries(providerValue?.models ?? {})) {
      if (!modelValue?.cost || typeof modelValue.cost !== 'object') continue
      const model = modelValue.id ?? modelKey
      result[`${provider}/${model}`] = {
        ...modelValue.cost,
        family: provider,
        price_source: 'OpenCode models.dev catalogue',
        verified_at: verifiedAt,
      }
    }
  }
  return result
}

function overrideModels(override, verifiedAt) {
  return Object.fromEntries(Object.entries(override?.models ?? {}).map(([model, price]) => [model, {
    ...price,
    price_source: 'user override',
    verified_at: price.verified_at ?? price.retrieved ?? override.as_of ?? verifiedAt,
  }]))
}

function loadModelPrices(fileOrOptions = {}) {
  if (typeof fileOrOptions === 'string' || fileOrOptions instanceof URL) return JSON.parse(fs.readFileSync(fileOrOptions, 'utf8'))
  const options = fileOrOptions ?? {}
  const fallbackFile = options.fallbackFile ?? DEFAULT_PRICE_TABLE_FILE
  const catalogueFile = options.catalogueFile ?? openCodeCataloguePath(options)
  const overrideFile = options.overrideFile ?? modelPriceOverridePath(options)
  const fallback = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'))
  const catalogue = readOptionalJson(catalogueFile)
  const override = readOptionalJson(overrideFile)
  const catalogueMtime = catalogue.mtime?.toISOString() ?? null
  const overrideMtime = override.mtime?.toISOString() ?? null
  return {
    version: fallback.version,
    as_of: fallback.as_of,
    loaded_at: (options.now ?? new Date()).toISOString(),
    models: {
      ...fallbackModels(fallback),
      ...catalogueModels(catalogue.value, catalogueMtime),
      ...overrideModels(override.value, overrideMtime),
    },
    source: {
      catalogue_file: String(catalogueFile),
      catalogue_mtime: catalogueMtime,
      catalogue_status: catalogue.value ? 'loaded' : 'fallback',
      ...(catalogue.value ? {} : { catalogue_reason: catalogue.reason }),
      override_file: String(overrideFile),
      override_mtime: overrideMtime,
      override_status: override.value ? 'loaded' : 'absent',
    },
  }
}

function normalizeModelId(model, table, family = null) {
  const raw = datedModelId(String(model ?? '').toLowerCase())
  const models = Object.keys(table?.models ?? {})
  const exact = models.filter((canonical) => {
    const lowered = datedModelId(canonical.toLowerCase())
    if (lowered === raw) return true
    const rowFamily = table.models[canonical]?.family
    return rowFamily && `${String(rowFamily).toLowerCase()}/${lowered}` === raw
  })
  if (exact.length === 1) return exact[0]
  if (raw.includes('/')) return null
  const provider = family ? `${String(family).toLowerCase()}/` : null
  const matches = models.filter((canonical) => {
    const lowered = datedModelId(canonical.toLowerCase())
    return (!provider || lowered.startsWith(provider)) && lowered.split('/').at(-1) === raw
  })
  return matches.length === 1 ? matches[0] : null
}

function selectedPrice(price, contextTokens) {
  const tiers = Array.isArray(price.tiers) ? price.tiers : []
  const tier = tiers
    .filter((candidate) => candidate?.tier?.type === 'context' && contextTokens > Number(candidate.tier.size))
    .sort((left, right) => Number(right.tier.size) - Number(left.tier.size))[0]
  return tier ? { ...price, ...tier, selected_tier: tier.tier } : price
}

function priceDetails(model, tokens, table) {
  const canonical = normalizeModelId(model, table, tokens.family)
  if (!canonical) return { usd: PRICE_UNKNOWN, label: PRICE_UNKNOWN }
  const base = table.models[canonical]
  const contextTokens = (Number(tokens.input) || 0) + (Number(tokens.cache_read) || 0) + (Number(tokens.cache_write) || 0)
  const price = selectedPrice(base, contextTokens)
  const fields = ['input', 'cache_write', 'cache_read', 'output', 'reasoning']
  const rates = fields.map((field) => Number(price[field] ?? (field === 'input' || field === 'output' ? NaN : 0)))
  if (!Number.isFinite(rates[0]) || !Number.isFinite(rates[3])) return { usd: PRICE_UNKNOWN, label: PRICE_UNKNOWN, canonical }
  if (rates.every((rate) => rate === 0)) return { usd: SUBSCRIPTION, label: SUBSCRIPTION, canonical, source: base.price_source }
  const amount = fields.reduce((sum, field, index) => sum + (Number(tokens[field]) || 0) * rates[index], 0) / 1_000_000
  const verifiedAt = base.verified_at ? new Date(base.verified_at) : null
  const loadedAt = table.loaded_at ? new Date(table.loaded_at) : new Date()
  const stale = verifiedAt && Number.isFinite(verifiedAt.getTime()) && loadedAt.getTime() - verifiedAt.getTime() > MAX_PRICE_AGE_MS
  let label = canonical.startsWith('openai/') ? 'API price equivalent' : 'API price'
  if (stale) label = `price not verified since ${verifiedAt.toISOString().slice(0, 10)}`
  return { usd: amount, label, canonical, source: base.price_source, context_tokens: contextTokens, tier: price.selected_tier ?? null }
}

export function priceRunCost(cost, table = loadModelPrices()) {
  const priced = structuredClone(cost)
  const unknownModels = new Set()
  const runLabels = new Set()
  let runUsd = 0
  let runSubscription = false
  for (const phase of priced.phases ?? []) {
    let phaseUsd = 0
    let phaseUnknown = false
    let phaseSubscription = false
    const phaseLabels = new Set()
    for (const [model, tokens] of Object.entries(phase.models ?? {})) {
      const details = priceDetails(model, tokens, table)
      tokens.usd = details.usd
      tokens.price_label = details.label
      if (details.source) tokens.price_source = details.source
      tokens.input_context_tokens = details.context_tokens
      if (details.tier) tokens.price_tier = details.tier
      phaseLabels.add(details.label)
      runLabels.add(details.label)
      if (details.usd === PRICE_UNKNOWN) { phaseUnknown = true; unknownModels.add(model) }
      else if (details.usd === SUBSCRIPTION) phaseSubscription = true
      else phaseUsd += details.usd
    }
    phase.price_labels = [...phaseLabels]
    phase.usd = phaseUsd
    if (phaseSubscription && phaseUsd === 0) phase.usd = SUBSCRIPTION
    if (phaseUnknown) phase.usd = PRICE_UNKNOWN
    if (!phaseUnknown) runUsd += phaseUsd
    runSubscription ||= phaseSubscription
  }
  priced.price_table = { version: table.version, as_of: table.as_of, ...table.source, context_measure: 'reported input + cache_read + measured cache_write tokens for the priced model row' }
  priced.price_labels = [...runLabels]
  priced.price_unknown_models = [...unknownModels].sort()
  if (priced.totals && priced.totals !== 'unknown') {
    priced.totals.usd = runSubscription && runUsd === 0 ? SUBSCRIPTION : runUsd
    if (unknownModels.size) priced.totals.usd = PRICE_UNKNOWN
  }
  return priced
}
