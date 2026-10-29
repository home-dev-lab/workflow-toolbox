import { appendSuiteLockJournal, suiteJournalLines, warnSuiteLockJournal } from './host/suite-lock-journal-append.mjs'
import { displayArgv } from './suite-lock-display.mjs'

export function journalCommand(argv) {
  const args = Array.isArray(argv) ? argv : []
  if (args.some((arg) => typeof arg === 'string' && /(?:^|[/\\])lint-gate\.mjs$/.test(arg))) return 'lint'
  for (const cmd of ['typecheck', 'lint', 'quality', 'test']) {
    if (args.some((arg) => typeof arg === 'string' && (arg === cmd || arg.startsWith(`${cmd}:`)))) return cmd
  }
  return 'other'
}

export function suiteJournalRequest(root, ticket, record, priority, options) {
  try { return journalRequest(root, ticket, record, priority, options) } catch (error) {
    warnSuiteLockJournal(error)
    return undefined
  }
}

function journalRequest(root, ticket, record, priority, options) {
  const kind = journalKind(options, priority)
  const base = { ticket, leaseId: record.leaseId, root: options.journalRoot ?? root, kind,
    cmd: journalCommand(options.commandArgv ?? record.argv), priority: options.journalPriority ?? priority, light: options.light === true,
    pid: record.pid, cwd: record.cwd, argv: displayArgv(record.argv), route: options.route ?? 'direct' }
  const journal = { base, now: options.now?.bind(options) }
  suiteJournalEvent(journal, 'request')
  return journal
}

function journalKind(options, priority) {
  const configured = options.journalKind
  if (configured !== undefined && configured !== null) return configured
  if (priority === 'release') return 'release'
  return options.light === true ? 'light' : 'exclusive'
}

export function suiteJournalEvent(journal, event, fields = {}) {
  if (!journal) return
  try {
    appendSuiteLockJournal(journal.base.root, { ...journal.base, ts: new Date(journal.now?.() ?? Date.now()).toISOString(), event, ...fields })
  } catch (error) { warnSuiteLockJournal(error) }
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
}

const distribution = (values) => ({ count: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) })
const seconds = (end, start) => end && start ? Math.max(0, (Date.parse(end.ts) - Date.parse(start.ts)) / 1000) : null

function parseJournalEvent(line) {
  const event = JSON.parse(line)
  if (typeof event?.leaseId !== 'string' || !event.leaseId || !['exclusive', 'light', 'static', 'release'].includes(event.kind)
    || !['request', 'grant', 'release', 'timeout', 'abort'].includes(event.event) || !Number.isFinite(Date.parse(event.ts))) throw new Error('invalid event')
  return event
}

function journalWindow(since, until) {
  const start = since === undefined ? -Infinity : Date.parse(since)
  const end = until === undefined ? Infinity : Date.parse(until)
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) throw new Error('journal window requires ordered ISO timestamps')
  return { start, end }
}

function joinedTicket(events) {
  const request = events.find((event) => event.event === 'request')
  const grant = events.find((event) => event.event === 'grant')
  const release = events.find((event) => event.event === 'release')
  const timeout = events.find((event) => event.event === 'timeout')
  const abort = events.find((event) => event.event === 'abort')
  return { ...(request ?? grant ?? events[0]), request, grant, release, timeout, abort,
    waitS: seconds(grant, request), holdS: seconds(release, grant), censored: !release && !timeout && !abort }
}

function journalSummary(tickets) {
  const summary = {}
  for (const kind of new Set(tickets.map((ticket) => ticket.kind))) {
    const group = tickets.filter((ticket) => ticket.kind === kind)
    summary[kind] = { count: group.length, censored: group.filter((ticket) => ticket.censored).length,
      wait: distribution(group.flatMap((ticket) => ticket.waitS === null ? [] : [ticket.waitS])),
      hold: distribution(group.flatMap((ticket) => ticket.holdS === null ? [] : [ticket.holdS])) }
  }
  return summary
}

/** Read both generations before filtering joined lifecycles by their first retained timestamp. */
export function readSuiteLockJournal(root, { since, until } = {}) {
  const window = journalWindow(since, until)
  const groups = new Map()
  let invalidLines = 0
  for (const line of suiteJournalLines(root)) {
    try {
      const event = parseJournalEvent(line)
      if (Date.parse(event.ts) > window.end) continue
      if (!groups.has(event.leaseId)) groups.set(event.leaseId, [])
      groups.get(event.leaseId).push(event)
    } catch { invalidLines += 1 }
  }
  const tickets = [...groups.values()].map(joinedTicket).filter((ticket) => Date.parse(ticket.ts) >= window.start)
  return { tickets, summary: journalSummary(tickets), invalidLines,
    censored: tickets.filter((ticket) => ticket.censored).length,
    grantsWithoutRequest: tickets.filter((ticket) => ticket.grant && !ticket.request).length }
}

export function suiteLockJournalCli(args, root) {
  if (root.startsWith('broker:')) throw new Error('journal reader requires the host lock root; run wt-suite-lock journal --json on the host')
  let since
  const flags = [...args]
  const index = flags.indexOf('--since')
  if (index >= 0) {
    since = flags[index + 1]
    if (!since || !Number.isFinite(Date.parse(since))) throw new Error('--since requires an ISO timestamp')
    flags.splice(index, 2)
  }
  if (flags.some((flag) => flag !== '--json')) throw new Error('journal accepts only --json and --since <ISO>')
  const result = readSuiteLockJournal(root, { since })
  process.stdout.write(`${JSON.stringify(flags.includes('--json') ? result : result.summary, null, flags.includes('--json') ? 0 : 2)}\n`)
  return 0
}
