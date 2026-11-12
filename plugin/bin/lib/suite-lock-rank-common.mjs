export const normalizeSuiteLockProject = (project) => typeof project === 'string' && project.trim() ? project.trim() : 'unnamed'

export function suiteLockIsoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return NaN
  const date = value.slice(0, 10)
  return new Date(`${date}T00:00:00Z`).toISOString().startsWith(date) ? parsed : NaN
}

export function validSuiteLockName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value)
}

export function parseSuiteLockProject(value) {
  if (validSuiteLockName(value)) return value.trim()
  const error = new Error('suite lock project must be a nonempty name of at most 120 characters without controls')
  error.exitCode = 64
  throw error
}

export function ticketPassable(record, counter, maximum) {
  return typeof record.lightGrantsGeneration === 'string' && record.lightGrantsGeneration === counter?.generation
    && Number.isSafeInteger(record.lightGrantsAtQueue) && counter.grants >= record.lightGrantsAtQueue
    && counter.grants - record.lightGrantsAtQueue < maximum
}

export function compareKeys(left, right) {
  for (let index = 0; index < left.key.length; index += 1) {
    const difference = left.key[index] - right.key[index]
    if (difference !== 0) return difference
  }
  return 0
}
