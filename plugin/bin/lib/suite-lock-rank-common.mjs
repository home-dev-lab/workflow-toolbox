export const normalizeSuiteLockProject = (project) => typeof project === 'string' && project.trim() ? project.trim() : 'unnamed'

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
