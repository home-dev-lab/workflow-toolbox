// Native idle compaction and prompt-cache freshness are independent of wake cadence.
export const NATIVE_SKIP_REASON = 'native idle compaction applies'

export function contextTokens(usage) {
  const values = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isFinite(total) ? total : null
}

export function cacheTtl(usage) {
  const creation = usage.cache_creation
  return {
    oneHour: positiveCounter(creation?.ephemeral_1h_input_tokens),
    fiveMinute: positiveCounter(creation?.ephemeral_5m_input_tokens),
  }
}

function positiveCounter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function retainEvidence(evidence, call) {
  if (call.synthetic) return
  const provenance = { callId: call.id, atMs: call.atMs }
  for (const key of ['oneHour', 'fiveMinute']) {
    if (call.cacheTtl[key] && (!evidence[key] || call.atMs > evidence[key].atMs)) evidence[key] = provenance
  }
}

export function rememberContext(state, call) {
  state.lastContext = { tokens: call.contextTokens, callId: call.id, atMs: call.atMs }
}

function effectiveFloor(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !/[1-9]/.test(value)) return 200_000
  return Math.max(100_000, Number(value))
}

// Native idle compaction fires at 0.9 of the one-hour TTL (54 min) but can refuse at fire time
// (rate-limit status, lapsed timer, changed prefix). The two-minute grace covers a compaction that
// is still writing its boundary; a warm emitted by the next 60 s poll still lands before 60 min.
const NATIVE_FALLBACK_MS = 56 * 60_000

function nativeEligible(state, settings) {
  if (settings.enabled !== true || settings.fetching !== true || settings.interactive === false || !state.cacheEvidence?.oneHour) return false
  const tokens = state.lastContext?.tokens
  return typeof tokens === 'number' && tokens >= effectiveFloor(settings.floor)
}

function freshnessAtMs(state) {
  return state.lastRealAtMs === null ? null : Math.max(state.lastRealAtMs, state.lastRefreshedAtMs ?? 0)
}

export function nativeFallbackDue(state, settings, nowMs) {
  const freshness = freshnessAtMs(state)
  if (freshness === null || !nativeEligible(state, settings)) return false
  if (state.lastCompactedAtMs !== null && state.lastCompactedAtMs !== undefined && state.lastCompactedAtMs >= freshness) return false
  return nowMs - freshness >= NATIVE_FALLBACK_MS
}

function nativeApplies(state, settings, nowMs) {
  return nativeEligible(state, settings) && !nativeFallbackDue(state, settings, nowMs)
}

function knownTtlMs(evidence) {
  if (evidence?.oneHour) return 60 * 60_000
  return evidence?.fiveMinute ? 5 * 60_000 : null
}

export function skipReason(state, settings, nowMs) {
  if (nativeApplies(state, settings, nowMs)) return NATIVE_SKIP_REASON
  const freshnessMs = freshnessAtMs(state)
  if (freshnessMs === null) return ''
  const ttlMs = knownTtlMs(state.cacheEvidence)
  return ttlMs !== null && nowMs - freshnessMs > ttlMs ? 'prompt cache freshness expired' : ''
}
