// Byte-level scan of a transcript for the lines that contain a needle. Only matching lines are
// decoded; the rest of the file is searched with Buffer.indexOf on raw bytes. An ASCII needle found
// in a line's UTF-8 bytes is the same test as String.includes on the decoded line: ASCII bytes are
// never part of a multi-byte sequence, so decoding neither creates nor removes them.
import { transcriptIo } from './host/model-fallback-cache-files.mjs'

export const WINDOW = 4096
const DEFAULT_CHUNK = 64 * 1024
const NEWLINE = 10
const EMPTY = Buffer.alloc(0)

// The last `size` bytes of previous + part, always a buffer the caller's read buffer cannot overwrite.
function lastBytes(previous, part, size = WINDOW) {
  if (part.length >= size) return Buffer.from(part.subarray(part.length - size))
  const joined = Buffer.concat([previous, part])
  return joined.length > size ? joined.subarray(joined.length - size) : joined
}

const decode = (bytes) => bytes.toString('utf8').replace(/\r$/, '')

function pieceMatches(line, piece) {
  if (piece.indexOf(line.needle) >= 0) return true
  if (!line.edge.length) return false
  return Buffer.concat([line.edge, piece.subarray(0, line.needle.length - 1)]).indexOf(line.needle) >= 0
}

// A line that continues into the next chunk: keep its bytes (it may match later) and the needle-length
// edge so a needle split across the chunk boundary is still found.
function holdPiece(line, piece) {
  line.matched ||= pieceMatches(line, piece)
  line.parts.push(Buffer.from(piece))
  line.edge = lastBytes(line.edge, piece, line.needle.length - 1)
}

function finishLine(line, piece) {
  if (line.matched || pieceMatches(line, piece)) line.onLine(decode(line.parts.length ? Buffer.concat([...line.parts, piece]) : piece))
  line.parts = []
  line.edge = EMPTY
  line.matched = false
}

function scanChunk(line, chunk) {
  let start = 0
  let lastNewline = -1
  for (let newline = chunk.indexOf(NEWLINE); newline >= 0; newline = chunk.indexOf(NEWLINE, start)) {
    finishLine(line, chunk.subarray(start, newline))
    lastNewline = newline
    start = newline + 1
  }
  if (start < chunk.length) holdPiece(line, chunk.subarray(start))
  return lastNewline
}

function collectHead(head, chunk, position) {
  return position < WINDOW ? Buffer.concat([head, chunk.subarray(0, WINDOW - position)]) : head
}

function advance(scan, chunk) {
  const lastNewline = scanChunk(scan.line, chunk)
  scan.head = collectHead(scan.head, chunk, scan.position)
  if (lastNewline >= 0) {
    scan.committedEnd = scan.position + lastNewline + 1
    scan.window = lastBytes(scan.rolling, chunk.subarray(0, lastNewline + 1))
  }
  scan.rolling = lastBytes(scan.rolling, chunk)
  scan.position += chunk.length
}

/**
 * Scan [start, end) of an open descriptor. onLine receives every newline-terminated line containing
 * the needle, in file order, as it is found (nothing is accumulated). Returns:
 * - committedEnd: the offset just after the last newline in range (start when the range holds none);
 * - tail: the unterminated last line when it contains the needle, else null (never passed to onLine);
 * - window: the WINDOW bytes ending at committedEnd, seeded by `recent` (the bytes ending at start);
 * - head: the bytes of the range that lie before absolute offset WINDOW.
 */
export function scanRange({ io = transcriptIo, fd, needle, start = 0, end = Infinity, chunkSize = DEFAULT_CHUNK, onLine, recent = EMPTY }) {
  const line = { needle: Buffer.from(needle), onLine, parts: [], edge: EMPTY, matched: false }
  const scan = { line, position: start, committedEnd: start, window: recent, rolling: recent, head: EMPTY }
  const buffer = Buffer.allocUnsafe(chunkSize)
  while (scan.position < end) {
    const count = io.read(fd, buffer, 0, Math.min(chunkSize, end - scan.position), scan.position)
    if (count <= 0) break
    advance(scan, buffer.subarray(0, count))
  }
  const tail = line.parts.length && line.matched ? decode(Buffer.concat(line.parts)) : null
  return { committedEnd: scan.committedEnd, end: scan.position, tail, window: scan.window, head: scan.head }
}

// Whole-file form used by the plain targets-only analysis: the unterminated last line is reported
// through onLine too, as the line reader always did.
export function scanFile(file, needle, { io = transcriptIo, chunkSize, onLine }) {
  const fd = io.open(file)
  try {
    const { tail } = scanRange({ io, fd, needle, chunkSize, onLine })
    if (tail !== null) onLine(tail)
  } finally { io.close(fd) }
}
