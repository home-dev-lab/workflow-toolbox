// A saved cursor avoids rediscovering previously consumed records on every poll.
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { cacheTtl, contextTokens, retainEvidence } from '../cache-keepalive-policy.mjs'

const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const DISCOVERY_BYTES = 4 * 1024 * 1024
const HISTORY_MS = 120 * 60_000
const FINGERPRINT_BYTES = 4096
const MAX_MODELS = 32

function recordTimeMs(record) {
  const value = record?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function finiteUsage(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parsedLine(line) {
  if (!line.length || line.length > MAX_RECORD_BYTES) return null
  try { return JSON.parse(line.toString('utf8')) } catch { return null }
}

function usableAssistant(record) {
  if (record?.type !== 'assistant' || !record.message || typeof record.message !== 'object') return null
  const usage = record.message.usage
  return usage && typeof usage === 'object' ? record : null
}

// A native compaction writes this record; its time tells the monitor the cached prefix was replaced.
function noteBoundary(scan, record) {
  if (record?.type !== 'system' || record.subtype !== 'compact_boundary') return false
  const atMs = recordTimeMs(record)
  if (atMs !== null && (scan.compactedAtMs === null || atMs > scan.compactedAtMs)) scan.compactedAtMs = atMs
  return true
}

function assistantCall(parsed, sequence) {
  const record = usableAssistant(parsed)
  if (!record) return null
  const usage = record.message.usage
  const model = typeof record.message.model === 'string' ? record.message.model : ''
  const atMs = recordTimeMs(record)
  const id = typeof record.message.id === 'string' && record.message.id
    ? record.message.id : `missing-id:${atMs ?? sequence}`
  return { atMs, id, model, synthetic: model === '<synthetic>', contextTokens: contextTokens(usage),
    usage: { input: finiteUsage(usage.input_tokens), output: finiteUsage(usage.output_tokens),
      cacheRead: finiteUsage(usage.cache_read_input_tokens), cacheCreation: finiteUsage(usage.cache_creation_input_tokens) },
    cacheTtl: cacheTtl(usage) }
}

function newScan(stopId, ownerIds, backward) {
  return { stopId, backward, ownerIds, owners: {}, calls: new Map(), evidenceByModel: new Map(), model: null,
    baselineFound: false, stoppedAtId: false, newestAtMs: null, done: false, compactedAtMs: null,
    carry: Buffer.alloc(0), skipLarge: false, trailing: true, tail: '', offset: 0, tailSkipped: false }
}

function collectEvidence(scan, call) {
  if (call.synthetic) return
  if (!scan.backward || scan.model === null) scan.model = call.model
  if (scan.ownerIds.includes(call.id) && !Object.hasOwn(scan.owners, call.id)) scan.owners[call.id] = call.model
  collectModelEvidence(scan, call)
}

function collectModelEvidence(scan, call) {
  const models = scan.evidenceByModel
  if (scan.backward && !models.has(call.model) && models.size >= MAX_MODELS) return
  const evidence = models.get(call.model) ?? {}
  if (scan.backward) retainEvidence(evidence, call)
  else mergeForwardEvidence(evidence, call)
  if (!scan.backward) models.delete(call.model)
  models.set(call.model, evidence)
  if (models.size > MAX_MODELS) models.delete(models.keys().next().value)
}

function mergeForwardEvidence(evidence, call) {
  const incoming = {}
  retainEvidence(incoming, call)
  for (const [key, value] of Object.entries(incoming)) {
    if (!evidence[key] || value.atMs >= evidence[key].atMs) evidence[key] = value
  }
}

function acceptBackward(scan, line, position) {
  const record = parsedLine(line)
  if (noteBoundary(scan, record)) return
  const call = assistantCall(record, position)
  if (!call) return
  if (beyondHistory(scan, call)) { scan.done = true; return }
  collectEvidence(scan, call)
  selectBackwardCall(scan, call)
  if (!call.synthetic) scan.baselineFound = true
  if (call.id === scan.stopId) scan.stoppedAtId = true
  scan.done = discoveryDecided(scan)
}

function selectBackwardCall(scan, call) {
  if (scan.stoppedAtId || (!scan.stopId && scan.baselineFound) || scan.calls.has(call.id)) return
  scan.calls.set(call.id, call)
}

function discoveryDecided(scan) {
  const boundaryFound = scan.stopId && scan.stoppedAtId
  return Boolean(boundaryFound && scan.evidenceByModel.get(scan.model)?.oneHour
    && scan.ownerIds.every((id) => Object.hasOwn(scan.owners, id)))
}

function beyondHistory(scan, call) {
  if (call.synthetic || call.atMs === null) return false
  if (scan.newestAtMs === null) scan.newestAtMs = call.atMs
  return call.atMs < scan.newestAtMs - HISTORY_MS
}

function acceptForward(scan, line, position) {
  const record = parsedLine(line)
  if (noteBoundary(scan, record)) return
  const call = assistantCall(record, position)
  if (!call) return
  collectEvidence(scan, call)
  // Reinsert so each call's newest record supplies both its fields and its order.
  scan.calls.delete(call.id)
  scan.calls.set(call.id, call)
}

function addCarry(scan, bytes) {
  if (scan.skipLarge) return
  scan.carry = Buffer.concat([bytes, scan.carry])
  if (scan.carry.length <= MAX_RECORD_BYTES) return
  scan.carry = Buffer.alloc(0)
  scan.skipLarge = true
}

function reverseChunk(scan, buffer, position) {
  let end = buffer.length
  for (let boundary = buffer.lastIndexOf(10); boundary >= 0; boundary = buffer.lastIndexOf(10, boundary - 1)) {
    addCarry(scan, buffer.subarray(boundary + 1, end))
    if (scan.trailing) {
      scan.offset = position + boundary + 1
      scan.tail = scan.carry.toString('base64')
      scan.tailSkipped = scan.skipLarge
      scan.trailing = false
    } else if (!scan.skipLarge) acceptBackward(scan, scan.carry, position + boundary + 1)
    scan.carry = Buffer.alloc(0)
    scan.skipLarge = false
    if (scan.done || boundary === 0) { end = boundary; break }
    end = boundary
  }
  if (!scan.done) addCarry(scan, buffer.subarray(0, end))
}

async function readChunk(file, position, length) {
  const buffer = Buffer.allocUnsafe(length)
  let consumed = 0
  while (consumed < length) {
    const { bytesRead } = await file.read(buffer, consumed, length - consumed, position + consumed)
    if (!bytesRead) throw new Error('transcript changed during read')
    consumed += bytesRead
  }
  return buffer
}

function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}`
}

function cursorShape(cursor, stat) {
  if (!cursor || !validPositions(cursor, stat.size)) return false
  if (cursor.identity !== identity(stat) || typeof cursor.tail !== 'string') return false
  return validTail(cursor) && (stat.size !== cursor.size || stat.mtimeMs === cursor.mtimeMs)
}

function validPositions(cursor, size) {
  return Number.isSafeInteger(cursor.size) && Number.isSafeInteger(cursor.offset)
    && cursor.offset >= 0 && cursor.size >= cursor.offset && size >= cursor.size
}

function validTail(cursor) {
  if (cursor.tail.length > Math.ceil(MAX_RECORD_BYTES / 3) * 4) return false
  if (!cursor.skipLarge && Buffer.from(cursor.tail, 'base64').length !== cursor.size - cursor.offset) return false
  return true
}

async function validatedPrefix(file, stat, cursor) {
  if (!cursorShape(cursor, stat)) return null
  const length = Math.min(FINGERPRINT_BYTES, cursor.size)
  const bytes = await readChunk(file, cursor.size - length, length)
  return fingerprint(bytes) === cursor.fingerprint ? bytes : null
}

function savedCursor(stat, scan, lastBytes) {
  return { size: stat.size, offset: scan.offset, tail: scan.tail, skipLarge: scan.tailSkipped,
    identity: identity(stat), mtimeMs: stat.mtimeMs, fingerprint: fingerprint(lastBytes) }
}

function scanResult(scan, cursor, mode, reset = false) {
  const calls = [...scan.calls.values()]
  if (scan.backward) calls.reverse()
  return { calls, evidence: scan.evidenceByModel.get(scan.model) ?? {}, model: scan.model,
    evidenceByModel: Object.fromEntries(scan.evidenceByModel), owners: scan.owners, cursor, mode, reset,
    compactedAtMs: scan.compactedAtMs }
}

async function discovery(file, stat, stopId, options) {
  const scan = newScan(stopId, options.ownerIds ?? [], true)
  let position = stat.size, remaining = DISCOVERY_BYTES, lastBytes = Buffer.alloc(0)
  while (position > 0 && remaining > 0 && !scan.done) {
    const length = Math.min(CHUNK_BYTES, position, remaining)
    position -= length
    remaining -= length
    const bytes = await readChunk(file, position, length)
    if (!lastBytes.length) lastBytes = bytes.subarray(-FINGERPRINT_BYTES)
    reverseChunk(scan, bytes, position)
  }
  if (!position && !scan.done && !scan.trailing && !scan.skipLarge) acceptBackward(scan, scan.carry, 0)
  finishDiscovery(scan, position)
  return scanResult(scan, savedCursor(stat, scan, lastBytes), 'discovery', Boolean(options.cursor))
}

function finishDiscovery(scan, position) {
  if (scan.trailing) {
    scan.tail = scan.carry.toString('base64')
    scan.tailSkipped = scan.skipLarge
  }
  if (!position || scan.done) return
  // Reaching the byte budget cannot establish that a five-minute write was the only TTL.
  for (const evidence of scan.evidenceByModel.values()) {
    if (!evidence.oneHour) delete evidence.fiveMinute
  }
}

function forwardChunk(scan, bytes, position) {
  const combined = scan.skipLarge ? bytes : Buffer.concat([scan.carry, bytes])
  const startPosition = position - scan.carry.length
  let start = 0
  for (let boundary = combined.indexOf(10); boundary >= 0; boundary = combined.indexOf(10, start)) {
    if (!scan.skipLarge) acceptForward(scan, combined.subarray(start, boundary), startPosition + start)
    scan.skipLarge = false
    start = boundary + 1
    scan.offset = startPosition + start
  }
  scan.carry = scan.skipLarge ? Buffer.alloc(0) : Buffer.from(combined.subarray(start))
  if (scan.carry.length > MAX_RECORD_BYTES) { scan.carry = Buffer.alloc(0); scan.skipLarge = true }
}

async function incremental(file, stat, stopId, options, prefix) {
  const scan = newScan(stopId, options.ownerIds ?? [], false)
  scan.offset = options.cursor.offset
  scan.carry = Buffer.from(options.cursor.tail, 'base64')
  scan.skipLarge = options.cursor.skipLarge
  let position = options.cursor.size, lastBytes = prefix
  while (position < stat.size) {
    const bytes = await readChunk(file, position, Math.min(CHUNK_BYTES, stat.size - position))
    forwardChunk(scan, bytes, position)
    lastBytes = Buffer.concat([lastBytes, bytes]).subarray(-FINGERPRINT_BYTES)
    position += bytes.length
  }
  scan.tail = scan.carry.toString('base64')
  scan.tailSkipped = scan.skipLarge
  return scanResult(scan, savedCursor(stat, scan, lastBytes), 'incremental')
}

// Discovery is bounded backward work; subsequent polls consume appended bytes forward.
export async function callsSince(transcriptPath, stopId, options = {}) {
  const settings = options && typeof options === 'object' ? options : {}
  const file = await open(transcriptPath, 'r')
  try {
    const stat = await file.stat()
    const prefix = await validatedPrefix(file, stat, settings.cursor)
    if (prefix !== null) return await incremental(file, stat, stopId, settings, prefix)
    // A saved cursor that no longer validates means a different transcript: its old stop id must not end discovery early.
    return await discovery(file, stat, settings.cursor ? null : stopId, settings)
  } finally {
    await file.close()
  }
}
