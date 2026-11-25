import { writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const MEMORY_REQUEUE_LIMIT = 3

// The CLI only requests a retry after positively confirming its group stopped.
export function reservationRetryOutcome(lease, timing) {
  if (!timing.requeue || timing.stopUnconfirmed) return {}
  if ((lease.record.memoryRetries ?? 0) < MEMORY_REQUEUE_LIMIT) return { requeue: true }
  timing.requeue = false
  process.stderr.write(`wt-suite-lock: memory retry limit reached (${MEMORY_REQUEUE_LIMIT} requeues); command stopped; inspect wt-suite-lock status --json\n`)
  return { retryExhausted: true }
}

// Called inside the reservation writer section, before relinquishing capacity.
// The original launcher owns this fresh attempt; there is no new queue number,
// turn, priority, size, timestamp, or bypass-counter snapshot.
export function stageReservationRetry(lease) {
  if (!lease.retryRecord) {
    const leaseId = randomUUID()
    lease.retryRecord = { ...lease.record, leaseId, memoryRetries: (lease.record.memoryRetries ?? 0) + 1,
      retryOf: lease.holder.leaseId,
      ...(lease.record.journal ? { journal: { ...lease.record.journal, leaseId } } : {}) }
  }
  publishReservationRetry(path.join(lease.root, 'queue.d'), lease.ticket, lease.retryRecord)
}

export function publishReservationRetry(queueDir, ticket, record) {
  const file = path.join(queueDir, `${String(ticket).padStart(16, '0')}.json`)
  const temporary = `${file}.${process.pid}.retry.tmp`
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
  renameSync(temporary, file)
}
