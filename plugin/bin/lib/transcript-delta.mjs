import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const LAST_RECORD_TAIL_BYTES = 64 * 1024

function normalizeLine(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function contentText(block) {
  if (typeof block?.text === 'string') return block.text
  if (typeof block?.content === 'string') return block.content
  return ''
}

export function summarizeTranscriptRecords(records) {
  const filtered = []
  let lastRealRecordType = null

  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    if (record.type === 'observer-ref') continue
    lastRealRecordType = typeof record.type === 'string' ? record.type : lastRealRecordType
    if (record.type !== 'user' && record.type !== 'assistant') continue

    const content = record?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.trim()) {
        filtered.push(`${record.type}: [tool ${block.name.trim()}]`)
        continue
      }
      if (block.type === 'tool_result') continue
      const text = normalizeLine(contentText(block))
      if (text) filtered.push(`${record.type}: ${text}`)
    }
  }

  return { filteredLines: filtered, lastRealRecordType }
}

export function parseTranscriptText(transcriptText) {
  const records = []
  for (const raw of String(transcriptText).split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // Ignore malformed lines rather than collapsing the whole read into silence.
    }
  }
  return records
}

function readRange(fd, start, length) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

function lastRecordTypeFromTail(fd, size) {
  if (size === 0) return { type: null, degradedReason: null }
  const start = Math.max(0, size - LAST_RECORD_TAIL_BYTES)
  let tail = readRange(fd, start, size - start)
  if (start > 0) {
    const firstNewline = tail.indexOf(0x0a)
    if (firstNewline === -1) {
      return { type: null, degradedReason: 'bounded transcript tail contains no complete record' }
    }
    tail = tail.subarray(firstNewline + 1)
  }

  const lines = tail.toString('utf8').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      return { type: null, degradedReason: 'bounded transcript tail ends with a malformed record' }
    }
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.type === 'observer-ref') continue
    if (typeof record.type === 'string') return { type: record.type, degradedReason: null }
  }

  return start > 0
    ? { type: null, degradedReason: 'bounded transcript tail contains no real record' }
    : { type: null, degradedReason: null }
}

export function boundDeltaLines(lines, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0
  const joined = lines.join('\n')
  if (limit === 0 || Buffer.byteLength(joined, 'utf8') <= limit) {
    return { text: joined, truncated: false }
  }

  const kept = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (kept.length > 0 && used + cost > limit) break
    if (kept.length === 0 && Buffer.byteLength(line, 'utf8') > limit) {
      const encoded = Buffer.from(line, 'utf8')
      let start = encoded.length - limit
      while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1
      kept.unshift(encoded.subarray(start).toString('utf8'))
      break
    }
    kept.unshift(line)
    used += cost
  }
  return { text: kept.join('\n'), truncated: true }
}

export function readTranscriptDelta(transcriptPath, watermark, maxBytes) {
  const fd = openSync(transcriptPath, 'r')
  try {
    const stat = fstatSync(fd)
    const start = Number.isFinite(watermark) && watermark >= 0 && watermark <= stat.size ? watermark : 0
    const delta = readRange(fd, start, stat.size - start)
    const lastRecord = lastRecordTypeFromTail(fd, stat.size)
    const deltaSummary = summarizeTranscriptRecords(parseTranscriptText(delta.toString('utf8')))
    const bounded = boundDeltaLines(deltaSummary.filteredLines, maxBytes)

    return {
      watermark: stat.size,
      deltaText: bounded.text,
      truncated: bounded.truncated,
      lastRealRecordType: lastRecord.type,
      lastRecordDegradedReason: lastRecord.degradedReason,
      transcriptMtimeMs: stat.mtimeMs,
    }
  } finally {
    closeSync(fd)
  }
}
