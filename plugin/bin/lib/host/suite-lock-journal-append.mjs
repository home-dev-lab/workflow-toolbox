import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { claimJournalRotation } from './suite-lock-journal-rotation.mjs'

export const SUITE_JOURNAL_ROTATE_BYTES = 4 * 1024 * 1024
let warned = false
const APPEND_OPTIONS = { flag: 'a', mode: 0o600 }
const ROTATION_SLACK_BYTES = 64 * 1024
const TERMINAL_EVENTS = new Set(['release', 'timeout', 'abort'])
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000

function warn(error) {
  if (warned) return
  warned = true
  process.stderr.write(`wt-suite-lock: journal unavailable (${error?.code ?? 'unknown'}); event unknown; lock operation continues\n`)
}
export { warn as warnSuiteLockJournal }

function claimTerminal(root, event) {
  if (!TERMINAL_EVENTS.has(event.event) || typeof event.leaseId !== 'string' || !LEASE_ID.test(event.leaseId)) return true
  const directory = path.join(root, 'terminal.d')
  try { mkdirSync(directory, { recursive: true }) } catch (error) { warn(error); return true }
  try {
    // Exclusive create serialises all terminal writers, including separate processes.
    writeFileSync(path.join(directory, event.leaseId), '', { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    warn(error)
    return true
  }
}

function pruneTerminalMarker(file, now) {
  try {
    if (now - statSync(file).mtimeMs > TERMINAL_RETENTION_MS) unlinkSync(file)
  } catch (error) { if (error?.code !== 'ENOENT') warn(error) }
}

function pruneTerminalMarkers(root) {
  const directory = path.join(root, 'terminal.d')
  try {
    const now = Date.now()
    for (const name of readdirSync(directory).filter((entry) => LEASE_ID.test(entry))) pruneTerminalMarker(path.join(directory, name), now)
  } catch (error) { if (error?.code !== 'ENOENT') warn(error) }
}

function rotate(root, file) {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  const exceedsBound = size > SUITE_JOURNAL_ROTATE_BYTES
  if (!exceedsBound) return
  const release = claimJournalRotation(root)
  if (!release) throw Object.assign(new Error('journal rotation busy; event unknown'), { code: 'ROTATION_BUSY' })
  try {
    if (statSync(file, { throwIfNoEntry: false })?.size > SUITE_JOURNAL_ROTATE_BYTES) {
      renameSync(file, path.join(root, 'journal.1.jsonl'))
      pruneTerminalMarkers(root)
    }
  } finally { release() }
}

function rotateBeforeAppend(root, file) {
  try { rotate(root, file) } catch (error) {
    if (error?.code !== 'ROTATION_BUSY') throw error
    // An in-flight rotator may rename after our open: O_APPEND still targets that generation.
    // Permit bounded contention slack, but never grow indefinitely behind a suspended rotator.
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (size > SUITE_JOURNAL_ROTATE_BYTES + ROTATION_SLACK_BYTES) throw error
  }
}

/** One short O_APPEND operation per event, never a retry or a lock-operation failure. */
export function appendSuiteLockJournal(root, event) {
  try {
    const line = Buffer.from(`${JSON.stringify(event)}\n`)
    if (line.length >= 4096) throw new Error('journal line too large')
    if (!claimTerminal(root, event)) return
    const file = path.join(root, 'journal.jsonl')
    rotateBeforeAppend(root, file)
    const fd = openSync(file, APPEND_OPTIONS.flag, APPEND_OPTIONS.mode)
    try {
      if (writeSync(fd, line) !== line.length) throw Object.assign(new Error('short journal write; event unknown'), { code: 'SHORT_WRITE' })
    } finally { closeSync(fd) }
  } catch (error) { warn(error) }
}

export function suiteJournalLines(root) {
  return ['journal.1.jsonl', 'journal.jsonl'].flatMap((name) => {
    try { return readFileSync(path.join(root, name), 'utf8').split('\n').filter(Boolean) } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  })
}
