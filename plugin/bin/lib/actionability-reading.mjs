function abandonedRead(producer, now) {
  return producer.lastOutcome === 'reading' && Number.isFinite(producer.deadlineAt) && now > producer.deadlineAt
}

// Startup can fail before the producer writes anything. The launch itself is then its heartbeat.
export function withAbandonedRefresh(snapshot, launch, now) {
  if (!Number.isFinite(launch?.launchedAt) || !Number.isFinite(launch.deadlineAt) || now <= launch.deadlineAt) return snapshot
  const heartbeatAt = snapshot?.producer?.heartbeatAt
  if (Number.isFinite(heartbeatAt) && heartbeatAt >= launch.launchedAt) return snapshot
  return { ...snapshot, status: snapshot.status === 'never' ? 'missing' : snapshot.status,
    producer: { ...snapshot.producer, heartbeatAt: launch.launchedAt, deadlineAt: launch.deadlineAt,
      lastOutcome: 'reading', lastReason: 'auto-refresh-abandoned' } }
}

// A newer failure discredits old evidence, not a still-current proposal. Supersession is success.
export function isUnrefreshable(snapshot, now, proposalMaxAgeMs) {
  const producer = snapshot?.producer
  if (!Number.isFinite(producer?.heartbeatAt)) return false
  const outcome = producer.lastOutcome
  const abandoned = abandonedRead(producer, now)
  const failed = Boolean(outcome) && !['reading', 'snapshot-written', 'superseded'].includes(outcome)
  if (!failed && !abandoned) return false
  if (snapshot.status === 'missing') return true
  return snapshot.status === 'present' && producer.heartbeatAt > snapshot.at && now - snapshot.at > proposalMaxAgeMs
}
