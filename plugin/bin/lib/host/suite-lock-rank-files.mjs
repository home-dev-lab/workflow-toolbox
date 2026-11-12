import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Release-time maintenance only; polling never enumerates rank-state directories. */
export function pruneSuiteLockRankState(root, now = Date.now()) {
  for (const kind of ['project-turns', 'size-history', 'precedence']) {
    for (const file of rankFiles(root, kind)) {
      try {
        const expired = kind === 'precedence' ? !(Date.parse(readRankJson(file)?.until) > now) : statSync(file).mtimeMs < now - 30 * 86400_000
        if (expired) rmSync(file, { force: true })
      } catch { /* Maintenance is advisory, including a concurrent operator publication. */ }
    }
  }
}
