export function positiveMilliseconds(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function proposalAge(at, now, maxAgeMs) {
  if (!Number.isFinite(at)) return { ageMs: null, usable: false, reason: 'unknown' }
  const ageMs = now - at
  if (ageMs < 0) return { ageMs, usable: false, reason: 'future' }
  if (ageMs > maxAgeMs) return { ageMs, usable: false, reason: 'stale' }
  return { ageMs, usable: true, reason: null }
}
