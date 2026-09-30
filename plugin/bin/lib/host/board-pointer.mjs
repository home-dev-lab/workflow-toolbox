import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The nearest `.claude/planka.json` at or above `start`: `{ boardId, path }`, where boardId is a non-blank
// string or null when the file is present but unusable (unreadable, malformed, or no string boardId).
// Null when no pointer exists up to the filesystem root.
export function resolveBoardPointer(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const file = join(dir, '.claude', 'planka.json')
    if (existsSync(file)) {
      let boardId = null
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'))?.boardId
        if (typeof value === 'string' && value.trim()) boardId = value
      } catch { /* An unreadable or malformed pointer is present but unusable. */ }
      return { boardId, path: file }
    }
    if (dirname(dir) === dir) return null
  }
}

// The canonical path of an existing directory (symlinks and junctions resolved); throws when it does not exist.
export function canonicalPath(target) {
  return realpathSync(target)
}
