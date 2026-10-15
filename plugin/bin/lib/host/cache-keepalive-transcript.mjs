import { open } from 'node:fs/promises'
import { cacheTtl, contextTokens, retainEvidence } from '../cache-keepalive-policy.mjs'

const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 1024 * 1024

function recordTimeMs(record) {
  const value = record?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function usageCounters(usage) {
  const raw = {}
  const counters = { input: Number(raw.input_tokens = usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0,
    cacheRead: Number(raw.cache_read_input_tokens = usage.cache_read_input_tokens) || 0,
    cacheCreation: Number(raw.cache_creation_input_tokens = usage.cache_creation_input_tokens) || 0 }
  return { usage: counters, contextTokens: contextTokens(raw) }
}

function callId(record, sequence) {
  return typeof record.message.id === 'string' && record.message.id
    ? record.message.id : `missing-id:${recordTimeMs(record) ?? sequence}`
}

function assistantCall(record, sequence) {
  if (record?.type !== 'assistant' || !record.message || typeof record.message !== 'object') return null
  const usage = record.message.usage
  if (!usage || typeof usage !== 'object') return null
  const model = typeof record.message.model === 'string' ? record.message.model : ''
  const id = callId(record, sequence)
  return { atMs: recordTimeMs(record), id, model, synthetic: model === '<synthetic>',
    ...usageCounters(usage), cacheTtl: cacheTtl(usage) }
}

function acceptLine(scan, line) {
  if (!line.trim() || Buffer.byteLength(line) > MAX_RECORD_BYTES) return false
  let record
  try { record = JSON.parse(line) } catch { return false }
  const call = assistantCall(record, scan.sequence--)
  if (!call) return false
  retainEvidence(scan.evidence, call)
  if (scan.seen.has(call.id)) return false
  collectCall(scan, call)
  if (!call.synthetic) scan.baselineFound = true
  if (!scan.stopId || call.id !== scan.stopId) return false
  scan.stoppedAtId = true
  return !scan.scanHistory
}

function collectCall(scan, call) {
  if (scan.stoppedAtId || (!scan.stopId && scan.baselineFound)) return
  scan.seen.add(call.id)
  scan.calls.push(call)
}

function acceptLines(scan, lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (acceptLine(scan, lines[index])) return true
  }
  return false
}

function chunkLines(scan, buffer) {
  let chunk = buffer
  if (scan.skipOversizedRecord) {
    const boundary = chunk.lastIndexOf(10)
    if (boundary < 0) return []
    chunk = chunk.subarray(0, boundary + 1)
    scan.skipOversizedRecord = false
  }
  const combined = Buffer.concat([chunk, scan.carry])
  const firstBoundary = combined.indexOf(10)
  const lines = []
  if (firstBoundary < 0) scan.carry = combined
  else {
    scan.carry = Buffer.from(combined.subarray(0, firstBoundary))
    let start = firstBoundary + 1
    for (;;) {
      const boundary = combined.indexOf(10, start)
      if (boundary < 0) { lines.push(combined.subarray(start).toString('utf8')); break }
      lines.push(combined.subarray(start, boundary).toString('utf8'))
      start = boundary + 1
    }
  }
  if (scan.carry.length > MAX_RECORD_BYTES) {
    scan.carry = Buffer.alloc(0)
    scan.skipOversizedRecord = true
  }
  return lines
}

// Keep only the latest provenance per TTL; initial discovery scans history in bounded chunks.
export async function callsSince(transcriptPath, stopId, scanHistory = false) {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    const scan = { baselineFound: false, calls: [], carry: Buffer.alloc(0), evidence: {},
      seen: new Set(), sequence: size, skipOversizedRecord: false, stopId, stoppedAtId: false, scanHistory }
    let position = size, foundStop = false
    while (position > 0 && !foundStop) {
      const length = Math.min(CHUNK_BYTES, position)
      position -= length
      const buffer = Buffer.allocUnsafe(length)
      await file.read(buffer, 0, length, position)
      const lines = chunkLines(scan, buffer)
      foundStop = acceptLines(scan, lines)
    }
    if (position === 0 && !foundStop) acceptLine(scan, scan.carry.toString('utf8'))
    return { calls: scan.calls.reverse(), evidence: scan.evidence }
  } finally {
    await file.close()
  }
}
