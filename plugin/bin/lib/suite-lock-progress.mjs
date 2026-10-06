// Renew only on service evidence, never on arrivals or mere placement changes.
export function suiteQueueAdvanced(previous, place) {
  if (!previous) return false
  const before = previous.admissions
  return before.generation !== null && before.generation === place.admissions.generation && place.admissions.grants > before.grants
}

export const isBrokerQueueEvent = (line) => /^(progress|renew) /.test(line)

export function brokerProgressPlace(line) {
  const fields = line.split(' ').map((field) => (/^(0|[1-9]\d{0,8})$/.test(field) ? Number(field) : Number.NaN))
  const [aheadExcludingRelease, total, actualAhead] = fields
  const ahead = Number.isSafeInteger(actualAhead) ? actualAhead : aheadExcludingRelease
  if (!(aheadExcludingRelease < total && ahead >= aheadExcludingRelease && ahead < total)) return null
  return { ahead, aheadExcludingRelease, total }
}
