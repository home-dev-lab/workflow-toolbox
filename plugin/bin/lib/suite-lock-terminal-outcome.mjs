export const SUITE_TERMINAL_EVENTS = new Set(['release', 'timeout', 'abort'])

/** Retain append order and record identity; count later terminal lines per lease. */
export function firstTerminalPerLease(input) {
  const seen = new Set()
  const records = []
  let ignoredDuplicateTerminals = 0
  for (const record of input) {
    if (typeof record?.leaseId === 'string' && SUITE_TERMINAL_EVENTS.has(record.event)) {
      if (seen.has(record.leaseId)) { ignoredDuplicateTerminals += 1; continue }
      seen.add(record.leaseId)
    }
    records.push(record)
  }
  return { records, ignoredDuplicateTerminals }
}
