// Host file access for wt-cancelled-call-relay-guard-hook.mjs, kept behind the host adapter so the
// hook itself holds no raw fs/os access. The readers degrade to a stated value rather than
// throwing (false, `{ error }`, []); appendJsonl and claimOnce throw, and the hook's fail-open
// wrapper owns those failures.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export function isRegularFile(file) {
  try { return statSync(file).isFile() } catch { return false }
}

// Lenient JSONL parse: a torn or foreign line is skipped. Pure; kept here beside its two readers.
export function parseJsonl(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* lenient: a torn or foreign line is skipped */ }
  }
  return records
}

// The last `maxBytes` of a file as text, with the file's byte size; `{ error: <code> }` when the
// file cannot be read. A cut first line (the tail started mid-line) is dropped.
export function readTailText(file, maxBytes) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read)
      if (n <= 0) break
      read += n
    }
    let text = buffer.subarray(0, read).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { size, text }
  } catch (error) {
    return { error: typeof error?.code === 'string' ? error.code : 'unknown' }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* nothing left to release */ }
  }
}

// A whole JSONL log, parsed leniently; [] when absent or unreadable.
export function readJsonl(file) {
  try { return parseJsonl(readFileSync(file, 'utf8')) } catch { return [] }
}

export function appendJsonl(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`)
}

// Exclusive create: true for the one caller that creates the file, false when it already exists.
export function claimOnce(file) {
  mkdirSync(dirname(file), { recursive: true })
  try {
    closeSync(openSync(file, 'wx'))
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}
