// A RECORD, unlike the fail-open guard COUNT: ordering and integrity require one locked writer.
// The writer is always a hook process or CLI, never an agent composing lines. Done deliberately
// admits subagents. Fleet workers have no reliable main-session provenance signal; actor admission
// is a declared limit, not authentication. CLI CLAUDECODE proves the harness, not the main session.
import path from 'node:path'
import * as io from './host/work-journal-io.mjs'
import { resolveJournal, sha256 } from './work-journal-paths.mjs'
export { resolveJournal }

const GENESIS = '0'.repeat(64)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const COMMIT_INDEX = 'commits.idx'
const pad = (n) => String(n).padStart(2, '0')
export const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
function localTime(date) {
  const offset = -date.getTimezoneOffset()
  return `${dayOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export function hashLine(line) {
  const { hash: _hash, ...body } = line
  return sha256(`${body.prev}\n${canonical(body)}`)
}
export const dayFile = (root, day) => path.join(root, 'days', `${day}.ndjson`)
const journalDays = (root) => io.list(path.join(root, 'days')).filter((file) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)).map((file) => file.slice(0, -7))
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function readDayContent(root, day, errors) {
  try { return utf8.decode(io.readBytes(dayFile(root, day))) }
  catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error
    errors.push(`invalid UTF-8 ${day}`)
    return null
  }
}
function collectChainLine(raw, day, index, state, lines, errors) {
  let line
  try { line = JSON.parse(raw) } catch { errors.push(`unreadable line ${day}:${index + 1}`); return }
  if (state.prev === null) state.prev = line.prev
  if (line.prev !== state.prev || line.hash !== hashLine(line)) errors.push(`broken chain ${day}:${index + 1}`)
  if (line.v !== 1 || !/^[a-f0-9]{16}$/.test(line.id || '')) errors.push(`invalid line ${day}:${index + 1}`)
  state.prev = line.hash
  lines.push({ ...line, day })
}
function collectDayLines(content, day, state, lines, errors) {
  if (content && !content.endsWith('\n')) errors.push(`torn tail ${day}`)
  const rawLines = content.split('\n')
  for (const [index, raw] of rawLines.entries()) {
    if (!raw && index === rawLines.length - 1) continue
    collectChainLine(raw, day, index, state, lines, errors)
  }
}
export function readChain(root, days = journalDays(root), anchored = false) {
  const lines = []
  const errors = []
  const state = { prev: anchored ? null : GENESIS }
  for (const day of days) {
    const content = readDayContent(root, day, errors)
    if (content === null) continue
    collectDayLines(content, day, state, lines, errors)
  }
  return { days, lines, errors, countOffset: 0 }
}
function recentChain(ctx, head) {
  const inventory = journalDays(ctx.store)
  const days = [...new Set([...(head ? [head.day] : []), ...inventory.slice(-2)])].sort()
  if (days.some((day) => !inventory.includes(day))) throw new Error('head ahead of or unrelated to ledger; restore before appending')
  const chain = readChain(ctx.store, days, days[0] !== inventory[0])
  if (head) {
    const position = chain.lines.findIndex((line) => line.hash === head.hash && line.day === head.day)
    if (position < 0 || head.count <= position) throw new Error('head ahead of or unrelated to ledger; restore before appending')
    chain.countOffset = head.count - position - 1
  } else if (days.length !== inventory.length) throw new Error('missing journal head; run SessionStart recovery')
  return { ...chain, inventory }
}
const withoutDay = ({ day: _day, ...line }) => line
function chainHead(chain) {
  const last = chain.lines.at(-1)
  return last ? { day: last.day, hash: last.hash, count: chain.lines.length + chain.countOffset } : null
}
function checkHead(ctx, chain, errors) {
  const actual = io.json(path.join(ctx.store, 'head.json'))
  if (canonical(actual) !== canonical(chainHead(chain))) errors.push('head does not match ledger (tail deletion or interrupted append)')
}
export function verifyJournal(ctx) {
  const chain = readChain(ctx.store)
  const errors = [...chain.errors]
  checkHead(ctx, chain, errors)
  const archiveDays = journalDays(ctx.archive)
  for (const day of new Set([...chain.days, ...archiveDays])) {
    if (!chain.days.includes(day)) errors.push(`live day lost ${day}; run wt-work-journal.mjs restore ${day}`)
    else if (!archiveDays.includes(day)) errors.push(`mirror day missing ${day}`)
    else if (!io.readBytes(dayFile(ctx.store, day)).equals(io.readBytes(dayFile(ctx.archive, day)))) errors.push(`mirror differs ${day}`)
  }
  return { ...chain, errors, ok: errors.length === 0 }
}

export function initializeJournal(ctx) {
  io.mkdir(ctx.store)
  io.mkdir(ctx.archive)
  const metadata = path.join(ctx.store, 'project.json')
  if (!io.exists(metadata)) io.atomicJson(metadata, { root: ctx.root, config: ctx.config })
  for (const dir of ['pending', 'pre', 'outcomes', 'detections']) io.mkdir(path.join(ctx.store, dir))
}
export function withJournalLock(ctx, operation, { waitMs = 2000 } = {}) {
  initializeJournal(ctx)
  const lock = path.join(ctx.store, 'lock')
  const owner = { pid: process.pid, host: io.hostname(), nonce: io.nonce(), ts: new Date().toISOString() }
  const deadline = performance.now() + waitMs
  for (;;) {
    if (io.takeLock(lock, owner)) break
    if (performance.now() >= deadline) throw new Error('busy; act queued; inspect lock and run wt-work-journal.mjs unlock')
    io.pause(Math.min(25, Math.max(1, deadline - performance.now())))
  }
  try { return operation() } finally { io.releaseLock(lock, owner) }
}
export function lockNotice(ctx) {
  const lock = path.join(ctx.store, 'lock')
  if (!io.exists(lock)) return null
  const owner = io.json(path.join(lock, 'owner.json'))
  const state = io.ownerAlive(owner)
  if (state === 'dead' || (!owner && Date.now() - io.stat(lock).mtimeMs > 60000)) return 'journal lock needs inspection; run wt-work-journal.mjs unlock (no automatic reclaim)'
  return `journal busy: lock owner ${state}; acts remain pending`
}

function quarantineTail(ctx) {
  const newest = journalDays(ctx.store).at(-1)
  if (!newest) return
  const file = dayFile(ctx.store, newest)
  const data = io.readBytes(file)
  let end = data.lastIndexOf(0x0a) + 1
  if (end === data.length && end > 0) {
    const start = data.lastIndexOf(0x0a, end - 2) + 1
    try { JSON.parse(data.subarray(start, end - 1).toString('utf8')) } catch { end = start }
  }
  if (end === data.length) return
  io.atomicWrite(path.join(ctx.store, 'torn', `${Date.now()}-${io.nonce()}.bin`), data.subarray(end))
  io.truncate(file, end)
}
function repairDayMirror(ctx, day) {
  const live = io.readBytes(dayFile(ctx.store, day))
  const file = dayFile(ctx.archive, day)
  const mirror = io.exists(file) ? io.readBytes(file) : Buffer.alloc(0)
  if (!live.subarray(0, mirror.length).equals(mirror) || (mirror.length && mirror.at(-1) !== 0x0a)) throw new Error(`mirror differs ${day}; repair refused`)
  if (!mirror.equals(live)) io.append(file, live.subarray(mirror.length))
}
function repairMirror(ctx, chain) {
  if (chain.errors.length) throw new Error('live chain broken; mirror repair refused')
  for (const day of journalDays(ctx.archive)) if (!(chain.inventory || chain.days).includes(day)) throw new Error(`live day lost ${day}; restore before appending`)
  for (const day of chain.days) repairDayMirror(ctx, day)
}
function checkRecoveryPrefix(head, latest, chain) {
  if (head && canonical(head) !== canonical(latest)) {
    const prefix = chain.lines[head.count - chain.countOffset - 1]
    if (!prefix || prefix.hash !== head.hash || prefix.day !== head.day) throw new Error('head ahead of or unrelated to ledger; restore before appending')
  }
}
function rebuildCommitIndex(ctx, chain) {
  const commits = [...new Set(chain.lines.map(commitSha).filter(Boolean))]
  io.atomicWrite(path.join(ctx.store, COMMIT_INDEX), commits.length ? `${commits.join('\n')}\n` : '')
}
function advanceDayFloor(ctx, chain) {
  // An observed later calendar day closes the old day even if it has no acts yet.
  // Persist the floor in both inventories so an export followed by clock rollback cannot
  // reopen a closed file. Empty day files add no line and do not change the durable head.
  const today = dayOf(ctx.now)
  if (chain.days.length && chain.days.at(-1) < today) {
    io.append(dayFile(ctx.store, today), '')
    io.append(dayFile(ctx.archive, today), '')
    chain.days.push(today)
  }
}
export function recoverJournal(ctx, { recentOnly = false } = {}) {
  quarantineTail(ctx)
  const head = io.json(path.join(ctx.store, 'head.json'))
  const chain = recentOnly ? recentChain(ctx, head) : readChain(ctx.store)
  if (chain.errors.length) throw new Error(chain.errors.join('; '))
  const latest = chainHead(chain)
  checkRecoveryPrefix(head, latest, chain)
  repairMirror(ctx, chain)
  if (canonical(head) !== canonical(latest)) io.atomicJson(path.join(ctx.store, 'head.json'), latest)
  if (!recentOnly) rebuildCommitIndex(ctx, chain)
  const replayed = foldPending(ctx, chain)
  advanceDayFloor(ctx, chain)
  return { ...chain, replayed }
}

function checkActDetails(value, text) {
  if (!text || !value.link || !value.subject) throw new Error('journal act needs sentence, subject and detail link')
}
export function makeAct(ctx, value) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(value.kind || '')) throw new Error('invalid journal kind')
  const text = String(value.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  checkActDetails(value, text)
  return { id: value.id || io.nonce(), at: value.at || localTime(ctx.now), kind: value.kind, subject: String(value.subject), text,
    link: String(value.link), src: String(value.src || 'cli'), rec: String(value.rec || 'cli'), actor: value.actor || 'main' }
}
export function writeOutcome(ctx, act, outcome, hashes = []) {
  io.append(path.join(ctx.store, 'outcomes', `${dayOf(ctx.now)}.ndjson`), `${JSON.stringify({ src: act.src, rec: act.rec, actId: act.id, outcome, hashes })}\n`)
}
export function readOutcomes(ctx) {
  const yesterday = ctx.now
  yesterday.setDate(yesterday.getDate() - 1)
  return [dayOf(yesterday), dayOf(ctx.now)].flatMap((day) => (io.optionalRead(path.join(ctx.store, 'outcomes', `${day}.ndjson`)) || '').split('\n').filter(Boolean).map((raw) => JSON.parse(raw)))
}
function appendLocked(ctx, act, chain) {
  const prior = chain.lines.at(-1)
  const appendTime = ctx.now
  const day = [dayOf(appendTime), chain.days.at(-1) || ''].sort().at(-1)
  const line = { v: 1, ts: localTime(appendTime), ...act, prev: prior?.hash || GENESIS }
  if (line.at === line.ts) delete line.at
  line.hash = hashLine(line)
  const raw = `${JSON.stringify(line)}\n`
  io.append(dayFile(ctx.store, day), raw)
  try { io.append(dayFile(ctx.archive, day), raw) } catch { throw new Error('mirror') }
  chain.lines.push({ ...line, day })
  if (!chain.days.includes(day)) chain.days.push(day)
  io.atomicJson(path.join(ctx.store, 'head.json'), chainHead(chain))
  const sha = commitSha(line)
  if (sha) io.append(path.join(ctx.store, COMMIT_INDEX), `${sha}\n`)
  writeOutcome(ctx, act, 'recorded', [line.hash])
  return line
}
export function appendLockedActs(ctx, values) {
  const chain = recoverJournal(ctx)
  const recorded = []
  for (const value of values) recorded.push(appendLocked(ctx, makeAct(ctx, value), chain))
  return recorded
}
function commitSha(line) {
  if (!['commit', 'merge'].includes(line.kind)) return null
  const sha = /@([a-f0-9]{40,64})$/.exec(line.link)?.[1]
  if (!sha) return null
  return line.kind === 'merge' ? `merge:${sha}` : sha
}
function foldPending(ctx, chain) {
  const recentDays = new Set(chain.days.slice(-2))
  const seen = new Map(chain.lines.filter((line) => recentDays.has(line.day)).map((line) => [line.id, line]))
  const commits = new Map(chain.lines.filter((line) => commitSha(line)).map((line) => [commitSha(line), line]))
  const indexed = new Set((io.optionalRead(path.join(ctx.store, COMMIT_INDEX)) || '').split('\n'))
  const missing = [...commits.keys()].filter((sha) => !indexed.has(sha))
  if (missing.length) io.append(path.join(ctx.store, COMMIT_INDEX), `${missing.join('\n')}\n`)
  const files = io.list(path.join(ctx.store, 'pending')).filter((name) => name.endsWith('.json'))
  const pending = files.map((name) => {
    const file = path.join(ctx.store, 'pending', name)
    const act = io.json(file)
    return { file, act, queuedAt: act.queuedAt ?? io.stat(file).mtimeMs }
  }).sort((a, b) => String(a.act.at).localeCompare(String(b.act.at)) || a.queuedAt - b.queuedAt || (a.act.sequence || 0) - (b.act.sequence || 0) || a.file.localeCompare(b.file))
  for (const { file, act } of pending) {
    const existing = seen.get(act.id) || (commitSha(act) && commits.get(commitSha(act)))
    const line = existing || appendLocked(ctx, makeAct(ctx, act), chain)
    if (existing) writeOutcome(ctx, act, 'recorded', [line.hash])
    seen.set(act.id, line)
    if (commitSha(line)) commits.set(commitSha(line), line)
    io.remove(file)
    io.syncDir(path.dirname(file))
  }
  return seen
}
export function appendJournalActs(ctx, values, options = {}) {
  initializeJournal(ctx)
  const acts = values.map((value) => makeAct(ctx, value))
  const queued = acts.map((act) => ({ act, pending: path.join(ctx.store, 'pending', `${act.at.replace(/[^0-9]/g, '')}-${act.id}.json`) }))
  for (const [sequence, { act, pending }] of queued.entries()) io.atomicJson(pending, { ...act, queuedAt: Date.now(), sequence })
  try {
    return withJournalLock(ctx, () => {
      const chain = recoverJournal(ctx, { recentOnly: true })
      return acts.map((act) => ({ outcome: 'recorded', line: withoutDay(chain.replayed.get(act.id)) }))
    }, options)
  } catch (error) {
    const reason = error.message.startsWith('busy') ? 'busy' : error.message === 'mirror' ? 'mirror' : 'integrity'
    const landed = new Map(readChain(ctx.store, journalDays(ctx.store).slice(-2), true).lines.map((line) => [line.id, line]))
    return queued.map(({ act, pending }) => {
      if (!io.exists(pending) && landed.has(act.id)) return { outcome: 'recorded', line: withoutDay(landed.get(act.id)) }
      writeOutcome(ctx, act, `failed:${reason}`)
      return { outcome: `failed:${reason}`, error: error.message, pending, actId: act.id }
    })
  }
}
export function appendJournal(ctx, value, options = {}) { return appendJournalActs(ctx, [value], options)[0] }

function digestDay(chain, day, output) {
  output.push(`Work journal ${day}`)
  const subjects = new Map()
  let recent = 0
  for (const line of chain.lines.filter((item) => item.ts.slice(0, 10) === day)) {
    const group = subjects.get(line.subject) || { count: 0, kinds: new Set(), last: line }
    group.count++; group.kinds.add(line.kind); group.last = line; subjects.set(line.subject, group); recent++
  }
  const groups = [...subjects.entries()].sort((a, b) => b[1].last.ts.localeCompare(a[1].last.ts))
  for (const [subject, group] of groups.slice(0, 20)) output.push(`${subject} — ${group.count} acts (${[...group.kinds].join(', ')}), last ${group.last.ts.slice(11, 16)} ${group.last.text.slice(0, 100)}`)
  if (groups.length > 20) output.push(`+${groups.length - 20} more — wt-work-journal.mjs show --date ${day}`)
  if (!groups.length) output.push('No activity.')
  return recent
}
export function digestJournal(ctx) {
  const chain = readChain(ctx.store)
  if (chain.errors.length) throw new Error('digest refused: live chain broken')
  const today = ctx.now
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const dates = [dayOf(yesterday), dayOf(today)]
  const output = []
  let recent = 0
  for (const day of dates) recent += digestDay(chain, day, output)
  if (!recent && chain.lines.length) {
    const last = chain.lines.at(-1)?.ts.slice(0, 10)
    output.push(`last activity ${last}: ${chain.lines.filter((line) => line.ts.slice(0, 10) === last).length} acts`)
  }
  return output.join('\n')
}
export function restoreJournal(ctx, date) {
  if (!DATE.test(date)) throw new Error('restore needs YYYY-MM-DD')
  return withJournalLock(ctx, () => {
    const archive = readChain(ctx.archive)
    if (archive.errors.length || !archive.days.includes(date)) throw new Error('archive chain invalid or requested day missing')
    const head = io.json(path.join(ctx.store, 'head.json'))
    if (head && canonical(head) !== canonical(chainHead(archive))) throw new Error('archive does not match durable head')
    io.atomicWrite(dayFile(ctx.store, date), io.readBytes(dayFile(ctx.archive, date)))
    const verified = verifyJournal(ctx)
    if (!verified.ok) throw new Error(verified.errors.join('; '))
    return appendLockedActs(ctx, [{ kind: 'restored', subject: path.basename(ctx.root), text: `Restored journal day ${date}`, link: `journal:${date}` }])
  })
}
