// Read-only projection. The core binds its readers and preserves the digestJournal export.

const DIGEST_MAX_CHARS = 7000
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
// Code-unit order, never locale order: the digest must be identical on every host.
function compare(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function field(value, max) {
  const text = String(value ?? '').toWellFormed().replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
  return Array.from(text).slice(0, max).join('').trim()
}
function selectedChain(ctx, windowStart, readers) {
  const inventory = readers.journalDays(ctx.store)
  let start = inventory.length
  let worked = 0
  // Empty day boundaries do not displace worked days. Read through the newest FILE,
  // including future file dates: rollback timestamps can live in those later files.
  for (let index = inventory.length - 1; index >= 0; index--) {
    start = index
    const day = readers.readChain(ctx.store, [inventory[index]], true)
    if (day.lines.some((line) => TIMESTAMP.test(field(line.ts, 64)))) worked++
    if (worked >= 2 && (index === 0 || inventory[index - 1] < windowStart)) break
  }
  return readers.readChain(ctx.store, inventory.slice(start), start > 0)
}
const CARD = /^card:(\d+)$/
// Fold card subjects by their first ten digits only when the prefix names ONE full id:
// two distinct full ids sharing a prefix are different cards and stay apart.
function folding(lines) {
  const fullIds = new Map()
  for (const line of lines) {
    const card = CARD.exec(String(line.subject ?? ''))
    if (!card || card[1].length <= 10) continue
    const prefix = card[1].slice(0, 10)
    fullIds.set(prefix, (fullIds.get(prefix) || new Set()).add(card[1]))
  }
  return function subjectKey(subject) {
    const text = String(subject ?? '')
    const card = CARD.exec(text)
    if (!card) return text
    const prefix = card[1].slice(0, 10)
    return (fullIds.get(prefix)?.size ?? 0) > 1 ? text : `card:${prefix}`
  }
}
function subjectNames(lines, subjectKey) {
  const names = new Map()
  for (const line of lines) {
    const subject = String(line.subject ?? '')
    const key = subjectKey(subject)
    const prior = names.get(key)
    if (prior === undefined || subject.length > prior.length || (subject.length === prior.length && subject < prior)) names.set(key, subject)
  }
  return names
}
function groupedDays(lines) {
  const subjectKey = folding(lines)
  const names = subjectNames(lines, subjectKey)
  const days = new Map()
  for (const line of lines) {
    const day = line.ts.slice(0, 10)
    const subjects = days.get(day) || new Map()
    const key = subjectKey(line.subject)
    const group = subjects.get(key) || { subject: names.get(key), count: 0, kinds: new Set(), last: line }
    group.count++
    group.kinds.add(field(line.kind, 24))
    // The last stored act remains authoritative even when its timestamp rolls back.
    group.last = line
    subjects.set(key, group)
    days.set(day, subjects)
  }
  return days
}
const recentFirst = (a, b) => compare(b.last.ts, a.last.ts) || compare(a.subject, b.subject)
function detailLine(group) {
  const kinds = [...group.kinds].sort(compare)
  const extra = kinds.length > 3 ? ` +${kinds.length - 3}` : ''
  return `${field(group.subject, 48)} — ${group.count} acts (${kinds.slice(0, 3).join(', ')}${extra}), last ${field(group.last.ts, 64).slice(11, 16)} ${field(group.last.text, 100)}`
}
function detailDay(days, day) {
  const groups = [...days.get(day).values()].sort(recentFirst)
  return { day, rows: groups.slice(0, 12).map(detailLine), omitted: Math.max(0, groups.length - 12) }
}
function condensedDay(days, day) {
  const groups = [...days.get(day).values()].sort((a, b) => b.count - a.count || recentFirst(a, b))
  const count = groups.reduce((total, group) => total + group.count, 0)
  const top = groups.slice(0, 3).map((group) => `${field(group.subject, 32)} ${group.count}`).join(', ')
  const extra = groups.length > 3 ? ` (+${groups.length - 3} subjects)` : ''
  return `${day} · ${count} acts · ${top}${extra}`
}
function renderDigest(state) {
  const output = [state.header]
  if (state.condensed.length) output.push('Earlier:', ...state.condensed)
  for (const detail of state.details) {
    output.push(`Work journal ${detail.day}`, ...detail.rows)
    if (detail.omitted) output.push(`+${detail.omitted} more subjects — show --date ${detail.day}`)
  }
  return output.join('\n')
}
function dropLine(state) {
  if (state.condensed.length) { state.condensed.shift(); return true }
  for (const detail of state.details) {
    if (detail.rows.length) { detail.rows.pop(); detail.omitted++; return true }
  }
  // Very small explicit budgets may retain only the header and the on-demand marker.
  if (state.details.length) { state.details.shift(); return true }
  return false
}
function fitDigest(state, budget, day) {
  let text = renderDigest(state)
  if (text.length <= budget) return text
  const marker = `digest trimmed to fit — wt-work-journal.mjs show --date ${day} for any day above`
  const limit = budget - marker.length - 1
  if (limit < state.header.length) throw new RangeError('digest budget cannot fit its header and trim marker')
  while (text.length > limit && dropLine(state)) text = renderDigest(state)
  return `${text}\n${marker}`
}
export function createDigest(readers) {
  return function digestJournal(ctx, { budget = DIGEST_MAX_CHARS } = {}) {
    const now = ctx.now
    const today = readers.dayOf(now)
    const since = new Date(now); since.setDate(since.getDate() - 13)
    const windowStart = readers.dayOf(since)
    const chain = selectedChain(ctx, windowStart, readers)
    if (chain.errors.length) throw new Error('digest refused: live chain broken')
    const lines = chain.lines.map((line) => ({ ...line, ts: field(line.ts, 64) })).filter((line) => TIMESTAMP.test(line.ts))
    if (!lines.length) return 'Work journal: no acts recorded yet.'
    const days = groupedDays(lines)
    const dates = [...days.keys()].sort(compare)
    const detailDates = dates.slice(-2)
    const earlier = dates.filter((day) => day >= windowStart && day <= today && !detailDates.includes(day))
    const state = {
      header: `Work journal — detail ${detailDates.join(', ')}; earlier days of the last 14 condensed (full day: wt-work-journal.mjs show --date YYYY-MM-DD)`,
      condensed: earlier.map((day) => condensedDay(days, day)),
      details: detailDates.map((day) => detailDay(days, day)),
    }
    return fitDigest(state, Math.min(DIGEST_MAX_CHARS, budget), detailDates.at(-1))
  }
}
