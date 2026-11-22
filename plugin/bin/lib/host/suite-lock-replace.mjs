import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readTicket } from './suite-lock-queue.mjs'
import { ticketIsStale } from './suite-lock-liveness.mjs'

const refusal = (reason) => new Error(`cannot replace suite ticket: ${reason}`)
const revisionFile = (queueDir, token, revision) => path.join(queueDir, `replace-${token}-${revision}.json`)
export const replacementQueueFields = (options) => options.replaceable ? { replaceToken: randomUUID() } : {}
const validToken = (token) => typeof token === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token)

function warn(seams, message) {
  try { (seams.warn ?? ((line) => process.stderr.write(`${line}\n`)))(message) } catch { /* diagnostics never change publication */ }
}

function cleanup(temporary, seams) {
  try { (seams.remove ?? rmSync)(temporary, { force: true }) } catch (error) {
    warn(seams, `suite replacement cleanup warning: ${error.code ?? error.message}`)
  }
}

function linkRevision(temporary, file, seams) {
  try { (seams.link ?? linkSync)(temporary, file) } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
      throw refusal(`filesystem cannot publish atomic hard links (${error.code})`)
    }
    throw error
  }
}

function readRevision(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// A complete inode is linked exclusively into the next slot. Replacement and start compete on the
// SAME slot: exactly one wins, so there is no check-then-spawn window accepting a lost replacement.
function publish(queueDir, token, entry, seams = {}) {
  const temporary = path.join(queueDir, `replace-${token}-${randomUUID()}.tmp`)
  ;(seams.write ?? writeFileSync)(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
  try {
    for (let revision = 1; ; revision++) {
      const file = revisionFile(queueDir, token, revision)
      const previous = readRevision(file)
      if (previous?.closed) {
        if (entry.closed) return revision
        throw refusal('already started or no longer queued')
      }
      if (previous) continue
      try { linkRevision(temporary, file, seams); return revision } catch (error) {
        if (error.code !== 'EEXIST') throw error
        revision-- // Read the winning slot before advancing: it may be the terminal start record.
      }
    }
  } finally { cleanup(temporary, seams) }
}

export function replaceQueuedCommand(root, number, argv, seams = {}) {
  const queueDir = path.join(root, 'queue.d')
  const ticket = readTicket(queueDir, number)
  if (!ticket || ticketIsStale(ticket)) throw refusal('not queued (missing, stale or already started)')
  const token = ticket.holder?.replaceToken
  if (!validToken(token)) throw refusal('legacy ticket has no replacement support')
  const revision = publish(queueDir, token, { argv }, seams)
  const current = readTicket(queueDir, number)
  if (!current || current.holder?.replaceToken !== token || ticketIsStale(current)) throw refusal('not queued (missing, stale or already started after publication)')
  return { ticket: number, revision }
}

function selectLatest(state, revision) {
  if (revision <= 1) return
  const latest = readRevision(revisionFile(state.queueDir, state.record.replaceToken, revision - 1))
  state.record.argv = latest.argv
}

export function closeQueuedReplacement(state, seams = {}, onWarning) {
  const token = state.record.replaceToken
  if (!token || state.replacementFinished) return
  try {
    const revision = publish(state.queueDir, token, { closed: true }, seams)
    selectLatest(state, revision)
  } catch (error) {
    warn({ warn: onWarning ?? seams.warn }, `suite replacement disabled; starting original command: ${error.code ?? error.message}`)
  } finally {
    state.replacementFinished = true
  }
}

export function finishQueuedReplacement(state) {
  closeQueuedReplacement(state)
}
