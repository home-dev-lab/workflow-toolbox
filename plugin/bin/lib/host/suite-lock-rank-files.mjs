import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readCounterText } from './suite-lock-queue.mjs'

export function readRankJson(file) {
  try { return JSON.parse(readCounterText(file)) } catch { return null }
}

export function rankFiles(root, kind, strict = false) {
  try { return readdirSync(path.join(root, kind)).filter((name) => /^[a-f0-9]{16}\.json$/.test(name)).map((name) => path.join(root, kind, name)) }
  catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error
    return []
  }
}

export function rankEntries(root, kind, strict = false) {
  return rankFiles(root, kind, strict).map((file) => {
    const entry = readRankJson(file)
    if (strict && entry === null) throw new Error('rank-state high-water mark unreadable')
    return entry
  }).filter((entry) => typeof entry?.project === 'string')
}

export function publishRankJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

function expiredPrecedence(entry, now) {
  const until = typeof entry?.until === 'string' ? Date.parse(entry.until) : NaN
  return Number.isFinite(until) && until < now
}

function prunePrecedence(file, now) {
  if (!expiredPrecedence(readRankJson(file), now)) return
  const aside = `${file}.${process.pid}.${randomUUID()}.prune`
  renameSync(file, aside)
  if (!expiredPrecedence(readRankJson(aside), now)) {
    // A renewal can win before the rename. Restore it without overwriting a
    // second publication at the original name; unexpected errors retain the aside.
    try { linkSync(aside, file) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  }
  rmSync(aside, { force: true })
}

function pruneOldRankFile(file, kind, now) {
  if (kind === 'size-history' && readRankJson(file)?.overran === true) return
  if (statSync(file).mtimeMs < now - 30 * 86400_000) rmSync(file, { force: true })
}

/** Release-time maintenance only; polling never enumerates rank-state directories. */
export function pruneSuiteLockRankState(root, now = Date.now()) {
  for (const kind of ['project-turns', 'size-history', 'precedence']) {
    for (const file of rankFiles(root, kind)) {
      try {
        if (kind === 'precedence') prunePrecedence(file, now)
        else pruneOldRankFile(file, kind, now)
      } catch { /* Maintenance is advisory, including a concurrent operator publication. */ }
    }
  }
}
