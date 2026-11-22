import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readTicket } from './suite-lock-queue.mjs'
import { ticketIsStale } from './suite-lock-liveness.mjs'

const refusal = (reason) => new Error(`cannot replace suite ticket: ${reason}`)
const revisionFile = (queueDir, token, revision) => path.join(queueDir, `replace-${token}-${revision}.json`)
export const replacementQueueFields = (options) => options.replaceable ? { replaceToken: randomUUID() } : {}

function readRevision(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// A complete inode is linked exclusively into the next slot. Replacement and start compete on the
// SAME slot: exactly one wins, so there is no check-then-spawn window accepting a lost replacement.
function publish(queueDir, token, entry) {
  const temporary = path.join(queueDir, `replace-${token}-${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
  try {
    for (let revision = 1; ; revision++) {
      const file = revisionFile(queueDir, token, revision)
      const previous = readRevision(file)
      if (previous?.closed) {
        if (entry.closed) return revision
        throw refusal('already started or no longer queued')
      }
      if (previous) continue
      try { linkSync(temporary, file); return revision } catch (error) {
        if (error.code !== 'EEXIST') throw error
        revision-- // Read the winning slot before advancing: it may be the terminal start record.
      }
    }
  } finally { rmSync(temporary, { force: true }) }
}

export function replaceQueuedCommand(root, number, argv) {
  const queueDir = path.join(root, 'queue.d')
  const ticket = readTicket(queueDir, number)
  if (!ticket || ticketIsStale(ticket)) throw refusal('not queued (missing, stale or already started)')
  const token = ticket.holder?.replaceToken
  if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) throw refusal('legacy ticket has no replacement support')
  const revision = publish(queueDir, token, { argv })
  return { ticket: number, revision }
}

export function closeQueuedReplacement(state) {
  const token = state.record.replaceToken
  if (!token) return
  const revision = publish(state.queueDir, token, { closed: true })
  if (revision > 1) {
    const latest = readRevision(revisionFile(state.queueDir, token, revision - 1))
    state.record.argv = latest.argv
  }
}

export function finishQueuedReplacement(state) {
  if (state.record.replaceToken) publish(state.queueDir, state.record.replaceToken, { closed: true })
}
