// Only this run's broker owns queue membership. No process census or ticket reads.
import { randomUUID } from 'node:crypto'
const QUEUE_FRESH_MS = 5000

export function createBrokerQueueState(runId) {
  const requests = new Set()
  let status = 'running', since = Date.now(), checkedAt = performance.now(), queuedMs = 0, validUntil = checkedAt, fenced = false
  const snapshot = () => {
    const now = performance.now(), rows = [...requests]
    if (status === 'queued') queuedMs += Math.max(0, Math.min(now, validUntil) - checkedAt)
    checkedAt = now
    const queued = rows.length > 0 && rows.every((row) => row.phase === 'waiting' && now - row.at <= QUEUE_FRESH_MS)
    const next = queued ? 'queued' : 'running'
    if (next !== status) { since = Date.now() - (queued ? 0 : Math.max(0, now - validUntil)); status = next }
    validUntil = rows.length ? Math.min(...rows.map((row) => row.at + QUEUE_FRESH_MS)) : now
    const renewalAgeMs = queued ? Math.max(0, now - validUntil + QUEUE_FRESH_MS) : 0
    return { runId, status, since, queuedMs, renewalAgeMs, observedAt: Date.now() - renewalAgeMs }
  }
  const track = () => {
    if (fenced) throw new Error('lane timeout authorized; further suite-lock admission refused')
    const row = { phase: 'acquiring', at: performance.now() }
    requests.add(row); snapshot()
    const update = (phase) => { snapshot(); row.phase = phase; row.at = performance.now(); snapshot() }
    return {
      waiting: () => { if (row.phase === 'acquiring' || row.phase === 'waiting') update('waiting') }, holding: () => update('holding'),
      requeued: () => { if (row.phase === 'holding') update('waiting') },
      releasing: () => update('releasing'),
      done: () => { snapshot(); row.phase = 'done'; requests.delete(row); snapshot() },
    }
  }
  // Serialized with track(): a negative verdict reserves non-admission through
  // termination. No renewal age or observation can override an admitted request.
  const decide = (id) => {
    if (id !== runId) return null
    if (requests.size) return { terminate: false, reason: 'admitted' }
    fenced = true
    return { terminate: true, reason: 'admission-fenced' }
  }
  const cancel = (id) => {
    if (id !== runId) return null
    fenced = false
    return { cancelled: true }
  }
  return { snapshot: (id) => id === runId ? snapshot() : null, decide, cancel, track, register: (id) => { runId ??= id } }
}

export function queryBrokerQueue(relay, runId, timeoutDecision = false) {
  return new Promise((resolve) => {
    if (timeoutDecision === 'cancel' && brokerExited(relay)) { resolve({ cancelled: true }); return }
    if (!relay?.connected) { resolve(null); return }
    const requestId = randomUUID()
    const finish = (value) => { clearTimeout(timer); relay.removeListener('message', receive); resolve(value) }
    const receive = (message) => { if (message?.requestId === requestId) finish(timeoutDecision ? message.verdict : message.queue) }
    const timer = setTimeout(() => finish(null), 250)
    timer.unref?.()
    relay.on('message', receive)
    let field = 'queueRunId'
    if (timeoutDecision === 'cancel') field = 'cancelTimeoutRunId'
    else if (timeoutDecision) field = 'timeoutRunId'
    try { relay.send({ [field]: runId, requestId }, (error) => { if (error) finish(null) }) } catch { finish(null) }
  })
}

export async function authorizeBrokerTimeout(relay, runId) {
  // No broker means no lease admitted by this run's broker. An installed broker
  // that is unreachable within 250 ms may still hold a lease: fail protected,
  // never infer no lease from IPC failure. Confirmed helper exit ends its live
  // admissions; its existing wait/hold bounds otherwise remain responsible.
  if (!relay) return { terminate: true, reason: 'no-broker' }
  if (brokerExited(relay)) return { terminate: true, reason: 'broker-exited' }
  return await queryBrokerQueue(relay, runId, true) ?? { terminate: false, reason: 'broker-unavailable-lease-unknown' }
}

function brokerExited(relay) { return Number.isInteger(relay?.exitCode) || typeof relay?.signalCode === 'string' }

export async function readLaneQueue(ctx) {
  try {
    const started = ctx.monotonicNow()
    const record = await ctx.readSuiteQueue?.(ctx.runId)
    if (record?.runId !== ctx.runId || !['queued', 'running'].includes(record.status)) return null
    if (!freshQueueRecord(record, Math.max(0, ctx.monotonicNow() - started))) return null
    return record
  } catch { return null }
}

function freshQueueRecord(record, transitMs) {
  const age = record.renewalAgeMs ?? Date.now() - record.observedAt
  return Number.isFinite(record.since) && Number.isFinite(record.observedAt) && Number.isFinite(age) && age >= 0 && age + transitMs <= QUEUE_FRESH_MS
}

export function accountQueueTime(ctx, queue) {
  const now = Date.now(), monotonic = ctx.monotonicNow()
  ctx.deadlineAtMs += confirmedQueueMs(ctx, queue, monotonic)
  // Keep a live grace decision's identity stable until its work budget resumes.
  if (ctx.phase === 'running' || ctx.deadlineAtMs > monotonic) ctx.timeoutAt = new Date(now + ctx.deadlineAtMs - monotonic).toISOString()
  ctx.queue = queue
}

function confirmedQueueMs(ctx, queue, monotonic) {
  if (!Number.isFinite(queue?.queuedMs)) return 0
  // Cap cumulatively from arming, not per reply interval: transport latency must
  // not discard confirmed time. Missing evidence alone still grants no credit.
  const sample = ctx.queueSample
  // An unobserved extension cannot distinguish pre-arm history; anchor on recovery.
  if (sample.queuedMs === null) sample.queuedMs = queue.queuedMs
  const total = Math.min(Math.max(0, monotonic - sample.at), Math.max(0, queue.queuedMs - sample.queuedMs))
  const credit = Math.max(0, total - sample.creditedMs)
  sample.creditedMs += credit
  return credit
}
