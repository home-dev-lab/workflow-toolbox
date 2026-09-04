// Bounded, opportunistic expiry for records sharing wt-queue-gate.
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const MARKER_SCAN_LIMIT = 100

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function sessionFrom(name, prefix) {
  const value = name.slice(prefix.length, -'.json'.length)
  return value && /^[A-Za-z0-9._-]+$/.test(value) ? value : null
}

export function readMarker(file) {
  const name = file.split(/[\\/]/).pop() || ''
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { kind: 'unknown', name }
  }
  if (/^queue-.+\.json$/.test(name) && finite(record?.at) && finite(record?.open) && record.open >= 0 && typeof record.next === 'string') {
    return { kind: 'queue', name, record }
  }
  if (/^engine-.+\.json$/.test(name) && finite(record?.declaredAtMs) && typeof record.sessionId === 'string' && record.sessionId) {
    return { kind: 'mandate', name, record }
  }
  const watchSession = name.startsWith('autonomy-watch-') ? sessionFrom(name, 'autonomy-watch-') : null
  if (watchSession && finite(record?.transcriptMtimeMs) && finite(record?.mandateDeclaredAtMs)) {
    return { kind: 'watch-emission', name, sessionId: watchSession, record }
  }
  const stateSession = name.startsWith('autonomy-watch-mandate-') ? sessionFrom(name, 'autonomy-watch-mandate-') : null
  if (stateSession && typeof record?.lastMandateKind === 'string' && finite(record?.observedAtMs ?? Date.parse(record?.observedAt))) {
    return { kind: 'watch-mandate-state', name, sessionId: stateSession, record }
  }
  if (/^.+-[a-f0-9]{12}\.json$/.test(name) && finite(record?.lastBlockedAt)) {
    return { kind: 'cooldown', name, record }
  }
  return { kind: 'unknown', name }
}

// `file` is deliberately reread here: callers use this as the single expiry verdict.
export function expired(kind, file, now, options = {}) {
  const marker = readMarker(file)
  if (marker.kind !== kind) return false
  if (kind === 'queue') return now - marker.record.at > (options.queueFreshnessMs ?? 120 * 60_000)
  if (kind === 'mandate') return now - marker.record.declaredAtMs > (options.mandateFreshnessMs ?? 480 * 60_000)
  if (kind === 'cooldown') return now - marker.record.lastBlockedAt > (options.cooldownMs ?? 45 * 60_000)
  if (kind === 'watch-emission' || kind === 'watch-mandate-state') {
    return !options.sessionTranscriptDir || !existsSync(join(options.sessionTranscriptDir, `${marker.sessionId}.jsonl`))
  }
  return false
}

// A failed unlink never changes the reader's expiry verdict. The caller receives the failure to
// surface in its existing diagnostic channel when it has one.
export function expireMarker(kind, file, now, options = {}) {
  if (!expired(kind, file, now, options)) return { expired: false, removed: false }
  try {
    const remove = options.unlinkSync || unlinkSync
    remove(file)
    return { expired: true, removed: true }
  } catch (error) {
    try {
      process.stderr.write(`WT queue-gate marker expiry: could not remove expired ${kind} marker ${file}: ${String(error?.message || error)}\n`)
    } catch {
      // The expiry verdict still reaches the caller even when stderr is unavailable.
    }
    return { expired: true, removed: false, error }
  }
}

export function expireOwnedMarkers(dir, kinds, now, options = {}) {
  const owned = new Set(kinds)
  const result = { scanned: 0, expired: 0, removed: 0, unknown: [] }
  let names
  try {
    names = readdirSync(dir).slice(0, MARKER_SCAN_LIMIT)
  } catch {
    return result
  }
  for (const name of names) {
    result.scanned += 1
    const file = join(dir, name)
    const marker = readMarker(file)
    if (marker.kind === 'unknown') {
      result.unknown.push(name)
      continue
    }
    if (!owned.has(marker.kind)) continue
    const outcome = expireMarker(marker.kind, file, now, options)
    if (outcome.expired) result.expired += 1
    if (outcome.removed) result.removed += 1
  }
  return result
}
