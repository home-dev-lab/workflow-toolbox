import path from 'node:path'
import * as io from './host/work-journal-io.mjs'
import { appendJournal, appendLockedActs, dayFile, dayOf, readChain, recoverJournal, verifyJournal, withJournalLock } from './work-journal.mjs'
import { refuseRepository, sha256 } from './work-journal-paths.mjs'
import { createBoardClient, resolveBoardPointer } from './board-http-client.mjs'
import { resolveWorkflowToolboxOption } from './plugin-options.mjs'

const taskFilePath = (ctx) => path.join(ctx.root, '.claude', 'progress.md')
function boardPointer(ctx) {
  const pointer = resolveBoardPointer(ctx.root)
  if (!pointer?.boardId) return null
  return { ...io.json(pointer.path), boardId: pointer.boardId }
}
export function openUnsynced(ctx) {
  const chain = readChain(ctx.store)
  if (chain.errors.length) throw new Error('unsynced reader refused: live chain broken')
  const resolved = new Set(chain.lines.filter((line) => line.kind === 'synced').map((line) => line.link.replace(/^journal:/, '')))
  return chain.lines.filter((line) => line.kind === 'unsynced' && !resolved.has(line.hash))
}
function archivedCopy(file, bytes) {
  const hash = sha256(bytes)
  if (!io.exists(file)) io.atomicWrite(file, bytes)
  if (sha256(io.readBytes(file)) !== hash) throw new Error('archive SHA-256 verification failed')
  return hash
}
export function addUnsynced(ctx, text, detail) {
  if (!String(detail).trim()) throw new Error('unsynced requires non-empty full detail')
  const hash = sha256(detail)
  archivedCopy(path.join(ctx.archive, 'details', `${hash.slice(0, 12)}.md`), detail)
  return appendJournal(ctx, { kind: 'unsynced', subject: path.basename(ctx.root), text, link: `detail:${hash.slice(0, 12)}` })
}
export function unsyncedDetail(ctx, line) {
  if (!/^detail:[a-f0-9]{12}$/.test(line.link)) throw new Error('invalid unsynced detail link')
  const detail = io.read(path.join(ctx.archive, 'details', `${line.link.slice(7)}.md`))
  if (!sha256(detail).startsWith(line.link.slice(7))) throw new Error('unsynced detail SHA-256 verification failed')
  return detail
}
export function resolveUnsynced(ctx, hash) {
  const matches = openUnsynced(ctx).filter((line) => line.hash.startsWith(hash))
  if (!hash || matches.length !== 1) throw new Error('resolve needs one unambiguous open unsynced hash')
  return appendJournal(ctx, { kind: 'synced', subject: matches[0].subject, text: `Synced ${matches[0].text}`, link: `journal:${matches[0].hash}` })
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function sectionDate(text) {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1]
  if (iso) return iso
  const natural = /\b(\d{1,2}) ([A-Za-z]+) (\d{4})\b/.exec(text)
  const month = natural ? MONTHS.indexOf(natural[2].toLowerCase()) + 1 : 0
  return month ? `${natural[3]}-${String(month).padStart(2, '0')}-${natural[1].padStart(2, '0')}` : null
}
function historyActs(ctx, text, hash) {
  const lines = text.split(/\r?\n/)
  const acts = []
  for (let index = 0; index < lines.length; index++) {
    if (!/^#{1,3} /.test(lines[index])) continue
    const date = sectionDate(`${lines[index]} ${lines[index + 1] || ''}`)
    if (date) acts.push({ kind: 'history', at: date, subject: path.basename(ctx.root), text: `Archived history: ${lines[index].replace(/^#+\s+/, '')}`, link: `retired:${hash.slice(0, 12)}#L${index + 1}` })
  }
  return acts
}
function swapTaskFile(file, hash, options) {
  options.beforeSwap?.()
  const moved = `${file}.retiring-${io.nonce()}`
  io.rename(file, moved)
  options.afterSwap?.()
  if (sha256(io.readBytes(moved)) !== hash) {
    if (!io.exists(file)) io.rename(moved, file)
    throw new Error(`file changed during retirement; re-run; preserved ${file} and ${moved}`)
  }
  try { io.exclusiveWrite(file, '') } catch (error) {
    if (error.code !== 'EEXIST' && !io.exists(file)) io.rename(moved, file)
    throw new Error(`retirement refused; both paths preserved: ${file} and ${moved}`)
  }
  if (sha256(io.readBytes(moved)) !== hash) throw new Error(`file changed during retirement; re-run; preserved ${file} and ${moved}`)
  io.remove(moved)
  io.syncDir(path.dirname(file))
}
export function retireProgress(ctx, options = {}) {
  if (!options.archiveOnly && !boardPointer(ctx)) throw new Error('retire-progress requires a parsed board pointer with boardId')
  const file = taskFilePath(ctx)
  if (!io.exists(file)) return { empty: true }
  const bytes = io.readBytes(file)
  if (!bytes.length) return { empty: true }
  const hash = sha256(bytes)
  const archive = path.join(ctx.archive, 'retired', `progress-${dayOf(ctx.now)}-${hash.slice(0, 12)}.md`)
  // Existing copies are re-verified, never trusted by name. This happens before a destructive step.
  archivedCopy(archive, bytes)
  return withJournalLock(ctx, () => {
    const history = historyActs(ctx, bytes.toString('utf8'), hash)
    const chain = readChain(ctx.store)
    if (chain.errors.length) throw new Error('retirement refused: live chain broken')
    if (!chain.lines.some((line) => line.kind === 'retired-progress' && line.text.includes(hash))) {
      const recorded = new Set(chain.lines.filter((line) => line.kind === 'history').map((line) => line.link))
      appendLockedActs(ctx, [...history.filter((act) => !recorded.has(act.link)), { kind: 'retired-progress', subject: path.basename(ctx.root), text: `Archived ${Buffer.byteLength(bytes)} bytes for retirement; sha256 ${hash}; ${history.length} dated sections`, link: `retired:${hash.slice(0, 12)}` }])
    }
    const verified = verifyJournal(ctx)
    if (!verified.ok) throw new Error('retirement refused: journal or mirror did not verify')
    if (sha256(io.readBytes(archive)) !== hash) throw new Error('archive SHA-256 verification failed')
    if (!options.archiveOnly) swapTaskFile(file, hash, options)
    return { archive, hash, sections: history.length, archiveOnly: Boolean(options.archiveOnly) }
  })
}
export function exportClosed(ctx, destination) {
  if (!destination || !path.isAbsolute(destination)) throw new Error('export-closed requires an absolute --to directory')
  const target = refuseRepository(destination, ctx.root)
  return withJournalLock(ctx, () => {
    recoverJournal(ctx)
    const verified = verifyJournal(ctx)
    if (!verified.ok) throw new Error('export refused: journal did not verify')
    const newest = verified.days.at(-1)
    const closed = verified.days.filter((day) => day < newest || day < dayOf(ctx.now))
    for (const day of closed) archivedCopy(path.join(target, `${day}.ndjson`), io.readBytes(dayFile(ctx.store, day)))
    return closed
  })
}
export async function setupBoard(ctx, injectedClient) {
  const pointer = boardPointer(ctx)
  if (!pointer) throw new Error('setup-board requires a parsed board pointer')
  const url = injectedClient ? null : pointer.mcpUrl || resolveWorkflowToolboxOption('planka_mcp_url', { env: ctx.env }).value
  if (!injectedClient && !url) throw new Error('setup-board requires planka_mcp_url or the pointer mcpUrl')
  const client = injectedClient || createBoardClient({ url, boardId: pointer.boardId })
  const doneId = await client.listIdOf('Done')
  if (!doneId) throw new Error('board has no Done list')
  return withJournalLock(ctx, () => {
    const board = { boardId: pointer.boardId, doneId: String(doneId), baseUrl: pointer.baseUrl || null }
    io.atomicJson(path.join(ctx.store, 'board.json'), board)
    return board
  })
}
