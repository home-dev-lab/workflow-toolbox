export const DEFAULT_REFRESH_TIMEOUT_MS = 90_000

export class RefreshTimeout extends Error {
  constructor(phase) {
    super(`refresh-timeout (${phase})`)
    this.phase = phase
  }
}

export function remainingMilliseconds(deadlineAt, phase) {
  if (!Number.isFinite(deadlineAt)) return Infinity
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new RefreshTimeout(phase)
  return Math.ceil(remaining)
}

export function isRefreshTimeout(error, deadlineAt) {
  return error instanceof RefreshTimeout || (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt)
}
