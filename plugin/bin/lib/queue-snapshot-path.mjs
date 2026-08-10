import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function queueSnapshotSlug(cwd) {
  // The readable slug is lossy and length-capped. Keep the hash so two distinct working
  // directories cannot share a snapshot and turn one project's missing tracker into a false block.
  const value = String(cwd || 'unknown')
  const readable = value.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)
  const hash = createHash('sha1').update(value).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

export function queueSnapshotFileName(cwd) {
  return `queue-${queueSnapshotSlug(cwd)}.json`
}

export function resolveQueueSnapshotPath(stateDir, cwd) {
  const exact = join(stateDir, queueSnapshotFileName(cwd))
  if (existsSync(exact)) return { path: exact, ancestor: '' }

  const entries = new Set(readdirSync(stateDir))
  let ancestor = dirname(String(cwd))
  while (true) {
    const name = queueSnapshotFileName(ancestor)
    if (entries.has(name)) return { path: join(stateDir, name), ancestor }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }

  return null
}
