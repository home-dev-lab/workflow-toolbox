// Resolve the session route before selecting a quota source. A non-direct route
// must never receive a Claude subscription reading.

const DEFAULT_PROXY_ORIGINS = ['http://127.0.0.1:8317', 'http://localhost:8317']

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function resolveRoute(env = process.env) {
  const base = String(env.ANTHROPIC_BASE_URL ?? '').trim()
  if (!base) return { route: 'direct' }
  const origin = originOf(base)
  if (!origin) return { route: 'unknown', base, reason: 'ANTHROPIC_BASE_URL is not a URL' }
  if (/(^|\.)anthropic\.com$/i.test(new URL(origin).hostname)) return { route: 'direct' }
  const origins = String(env.WT_QUOTA_PROXY_ORIGINS ?? DEFAULT_PROXY_ORIGINS.join(','))
    .split(',')
    .map((entry) => originOf(entry.trim()))
    .filter(Boolean)
  if (!origins.includes(origin)) return { route: 'unknown', base: origin, reason: `route ${origin} has no quota source` }
  const token = String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '').trim()
  if (!token) return { route: 'unknown', base: origin, reason: `route ${origin}: no gateway key in the session env` }
  return { route: 'proxy', adapter: 'cli-proxy', base: origin, token }
}

export function effectiveModel({ transcriptTail = '', env = process.env } = {}) {
  const lines = transcriptTail.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index])
      const model = entry?.type === 'assistant' ? entry?.message?.model : null
      if (typeof model === 'string' && model && model !== '<synthetic>') return model
    } catch {
      // A truncated first tail line is expected; earlier complete lines remain usable.
    }
  }
  for (const key of ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL']) {
    const value = String(env[key] ?? '').trim()
    if (value) return value
  }
  return null
}

const STATE_REASONS = {
  unbound: 'session not bound to an account yet',
  ambiguous: 'session bound to several accounts',
  unavailable: 'provider usage unavailable',
  circuit_open: 'provider circuit open (recent error)',
  unsupported: 'provider does not expose usage',
}

export async function fetchProxyUsage({ base, token, sessionId, model, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (!sessionId) return { ok: false, family: null, reason: 'no session id' }
  if (!model) return { ok: false, family: null, reason: 'effective model not known yet' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(`${base}/v1/internal/selected-usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, model }),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const detail = error?.name === 'AbortError' ? `no answer in ${timeoutMs} ms` : `unreachable (${error?.code ?? error?.message ?? 'error'})`
    return { ok: false, family: null, reason: `${base} ${detail}` }
  }
  clearTimeout(timer)
  let body = null
  try { body = await response.json() } catch { /* guard errors need no JSON body */ }
  if (response.status === 401) return { ok: false, family: null, reason: 'gateway key refused (401)' }
  if (response.status === 403) return { ok: false, family: null, reason: 'origin forbidden (403)' }
  if (response.status === 400) return { ok: false, family: null, reason: 'bad request (400)' }
  const state = String(body?.state ?? '')
  const family = String(body?.family ?? '') || null
  if (response.status !== 200 && !(state in STATE_REASONS)) return { ok: false, family, reason: `HTTP ${response.status}` }
  if (state !== 'ok') return { ok: false, family, reason: STATE_REASONS[state] ?? (state ? `state=${state}` : `no state in answer (HTTP ${response.status})`) }
  // A window counts only when used_percent is a real number within 0–100: null, '', a numeric string or an
  // out-of-range value would otherwise render as a plausible figure (0 %, -1 %) — measured by claude-mem-cc-1, 2026-09-09.
  const windows = Array.isArray(body?.windows) ? body.windows.filter((window) => window && typeof window === 'object' && typeof window.used_percent === 'number' && Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100).map((window) => ({ name: String(window.name ?? 'window'), pct: window.used_percent, minutes: Number(window.window_minutes) || null, resetsAt: window.resets_at ?? null })) : []
  if (Array.isArray(body?.windows) && body.windows.length > 0 && windows.length === 0) return { ok: false, family, reason: 'malformed used_percent in every window' }
  return { ok: true, family, source: body?.source ?? null, state, windows }
}

export function windowLabel(window) {
  if (window.minutes === 300) return '5h'
  if (window.minutes === 10080) return '7d'
  if (window.minutes === 1440) return '24h'
  if (window.minutes && window.minutes % 60 === 0) return `${window.minutes / 60}h`
  return window.minutes ? `${window.minutes}min` : window.name
}

function resetFields(resetsAt) {
  if (!resetsAt || Number.isNaN(new Date(resetsAt).getTime())) return { resetLocal: null, resetIn: null }
  const time = new Date(resetsAt)
  const minutes = Math.max(0, Math.round((time.getTime() - Date.now()) / 60000))
  const resetIn = minutes >= 1440 ? `${Math.floor(minutes / 1440)}j${Math.round((minutes % 1440) / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}min`
  const resetLocal = time.toDateString() === new Date().toDateString() ? time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : `${time.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
  return { resetLocal, resetIn }
}

export function normalizeProxyUsage(result) {
  return { family: result.family ?? 'account', source: result.source ?? 'cli-proxy', state: result.ok ? 'ok' : 'degraded', windows: (result.windows ?? []).map((window) => ({ key: window.name, label: windowLabel(window), minutes: window.minutes, pct: window.pct, resetsAt: window.resetsAt, ...resetFields(window.resetsAt) })) }
}

export function normalizeLegacyUsage(source) {
  const windows = []
  for (const [key, label, minutes] of [['five_hour', '5h', 300], ['seven_day', '7d', 10080]]) {
    const value = source?.[key]
    if (!value || !Number.isFinite(value.pct)) continue
    windows.push({ key, label, minutes, pct: value.pct, resetsAt: value.resets_at ?? null, resetLocal: value.reset_local || null, resetIn: value.reset_in || null })
  }
  return { family: 'claude', source: source?.source ?? 'probe', state: 'ok', windows }
}
