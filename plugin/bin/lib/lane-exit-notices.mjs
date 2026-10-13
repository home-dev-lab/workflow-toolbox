import path from 'node:path'
import { laneHostStateRoot } from './host/lane-host-dir.mjs'
import { exitNoticeStore } from './host/lane-exit-store.mjs'
import { classifyLane as defaultClassifyLane, writeJsonAtomic } from './lane-supervisor-core.mjs'

// A day covers resumed sessions without scanning the machine's entire lane history.
const EXIT_NOTICE_LOOKBACK_MS = 24 * 60 * 60 * 1000
// Bound per-session archives even during unusually high launch volume.
const EXIT_NOTICE_MAX_ENTRIES = 10_000
const TERMINAL = new Set(['exited', 'abandoned', 'launch-failed'])
const singleLine = (value) => String(value).replace(/[\r\n\u2028\u2029]/g, ' ')
const order = (a, b) => a.at - b.at || a.runId.localeCompare(b.runId)

const ownedRecord = (record, sessionId) => record?.ownerSessionId === sessionId
  && typeof record.runId === 'string' && typeof record.worktree === 'string'

function completedEntry(record, modifiedAt, settings, now) {
  if (!ownedRecord(record, settings.sessionId)) return null
  if (!TERMINAL.has(record.state)) {
    const verdict = settings.classifyLane(record)
    if (verdict.worker !== 'gone' || verdict.child !== 'gone') return null
  }
  const parsed = Date.parse(record.exitedAt)
  const at = Number.isFinite(parsed) ? parsed : modifiedAt
  return at >= now - settings.lookbackMs ? { runId: record.runId, at } : null
}

function completionLine(record, store) {
  const report = path.join(record.worktree, '.lane', 'report.md')
  const exit = Number.isFinite(record.exit) ? record.exit : 'unknown'
  const fields = `owner=${record.owner ?? 'unknown'} worktree=${record.worktree} runId=${record.runId} state=${record.state} exit=${exit} at=${record.exitedAt ?? 'unknown'}`
  return singleLine(`LANE exited: ${fields} report=${report} ${store.reportPresent(report) ? 'present' : 'absent'}`)
}

function boundedArchive(archive, now, settings) {
  const entries = [...archive.entries.values()].filter((entry) => entry.at >= now - settings.lookbackMs).sort(order)
  const dropped = entries.splice(0, Math.max(0, entries.length - settings.maxEntries))
  // Retain an eviction watermark so a capped archive cannot reannounce its dropped runs.
  const previous = archive.through?.at >= now - settings.lookbackMs ? archive.through : null
  const through = dropped.at(-1) ?? previous
  return { version: 1, entries, through }
}

function scanCompletions(settings, archive) {
  const now = settings.clock(); const lines = []; let found = 0
  const pending = { ...archive, entries: new Map(archive.entries) }
  for (const { record, modifiedAt } of settings.store.records(settings.stateRoot, now - settings.lookbackMs)) {
    const entry = completedEntry(record, modifiedAt, settings, now)
    if (!entry || pending.entries.has(entry.runId) || (pending.through && order(entry, pending.through) <= 0)) continue
    pending.entries.set(entry.runId, entry); found += 1
    if (!archive.baseline) lines.push(completionLine(record, settings.store))
  }
  const persisted = boundedArchive(pending, now, settings)
  settings.write(settings.file, persisted)
  archive.entries = new Map(persisted.entries.map((entry) => [entry.runId, entry])); archive.through = persisted.through
  if (archive.baseline) settings.stdout(`LANE exit-watch baseline: ${found} finished lanes recorded, not announced`)
  else for (const line of lines) settings.stdout(line)
  archive.baseline = false
}

function noticeSettings(options) {
  const stateRoot = options.stateRoot ?? laneHostStateRoot()
  const dataDir = options.dataDir ?? path.join(path.dirname(stateRoot), 'wt-lane-exit-notices')
  return { stateRoot, file: path.join(dataDir, `${options.sessionId}.json`), sessionId: options.sessionId,
    clock: options.clock ?? Date.now, classifyLane: options.classifyLane ?? defaultClassifyLane,
    lookbackMs: options.lookbackMs ?? EXIT_NOTICE_LOOKBACK_MS, maxEntries: options.maxEntries ?? EXIT_NOTICE_MAX_ENTRIES,
    store: options.store ?? exitNoticeStore, write: options.write ?? writeJsonAtomic,
    stdout: options.stdout ?? ((line) => process.stdout.write(`${line}\n`)) }
}

export function createLaneExitNotices(options = {}) {
  const sessionId = options.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`))
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    stderr('wt-lane-orphan-watch: completion notices disabled: CLAUDE_CODE_SESSION_ID is missing or invalid')
    return () => {}
  }
  let reported = false; let settings; let archive
  const report = (error) => {
    if (!reported) stderr(`wt-lane-orphan-watch: completion scan failed; will retry: ${error instanceof Error ? error.message : String(error)}`)
    reported = true
  }
  return () => {
    try {
      settings ??= noticeSettings({ ...options, sessionId })
      archive ??= settings.store.load(settings.file, report)
      scanCompletions(settings, archive)
    } catch (error) { report(error) }
  }
}
