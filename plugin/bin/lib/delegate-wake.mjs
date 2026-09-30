// Session-scoped transcript observer. Neither a queue entry nor a file's existence alone
// proves that a delegate is asleep: the owner's own assistant records decide that.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { appendRecord, readAgents as readAgentFiles, readJsonl, readNewMain as readMainFile } from './host/delegate-wake-files.mjs'
export { readJsonl, readThrottle, writeThrottle } from './host/delegate-wake-files.mjs'

const ID = /^a[a-z0-9-]{6,80}$/
const TASK = /^[a-zA-Z0-9-]{4,80}$/
const tag = (body, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? null
const time = (record) => Date.parse(record?.timestamp ?? record?.at ?? '')
const inbound = (record) => (record?.type === 'user'
  && !(Array.isArray(record?.message?.content) && record.message.content.every((part) => part?.type === 'tool_result')))
  || (record?.type === 'attachment' && record?.attachment?.type === 'queued_command')
const text = (record) => {
  const content = record?.content ?? record?.message?.content ?? record?.attachment?.prompt ?? record?.attachment?.content ?? ''
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map((part) => part?.text ?? (typeof part?.content === 'string' ? part.content : '')).join(' ') : ''
}
const clean = (value, limit = 180) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
  .replace(/"/g, "'").replace(/(bearer|token|authorization|api[-_ ]?key|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>').slice(0, limit)
const relayText = (value) => String(value).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/"/g, "'")

// Retained-memory bound: transcripts are hundreds of megabytes, the detectors read a few fields.
// Every record kept is projected to those fields (same shape, so one code path serves live
// records and projections); text is capped, and a tool_result keeps only a background-launch
// fragment. Part TYPES survive whole, because `inbound` reads the shape of the parts.
const TEXT_CAP = 64 * 1024
const LAUNCH = /Command running in background with ID: ([a-zA-Z0-9-]+)/
const cap = (value) => typeof value === 'string' ? value.slice(0, TEXT_CAP) : value
const slimPart = (part) => {
  const out = { type: part?.type }
  if (part?.type === 'tool_result') {
    if (part.tool_use_id !== undefined) out.tool_use_id = part.tool_use_id
    out.content = typeof part.content === 'string' ? (LAUNCH.exec(part.content)?.[0] ?? '') : ''
    return out
  }
  if (typeof part?.text === 'string') out.text = cap(part.text)
  if (typeof part?.content === 'string') out.content = cap(part.content)
  return out
}
function slimContent(content) {
  if (Array.isArray(content)) return content.map(slimPart)
  if (typeof content === 'string') return cap(content)
  return content ?? undefined
}
const slimRecord = (record) => {
  const out = { type: record.type, timestamp: record.timestamp }
  if (record.content !== undefined) out.content = slimContent(record.content)
  if (record.message) out.message = { role: record.message.role, content: slimContent(record.message.content) }
  if (typeof record.toolUseResult?.backgroundTaskId === 'string') out.toolUseResult = { backgroundTaskId: record.toolUseResult.backgroundTaskId }
  if (record.attachment) out.attachment = { type: record.attachment.type, prompt: cap(record.attachment.prompt), content: slimContent(record.attachment.content) }
  return out
}
const launchTask = (record, part) => {
  const receipt = record?.toolUseResult?.backgroundTaskId
  if (typeof receipt !== 'string' || !TASK.test(receipt) || part?.type !== 'tool_result' || typeof part.content !== 'string') return null
  return LAUNCH.exec(part.content)?.[1] === receipt ? receipt : null
}
const launchesIn = (record) => Array.isArray(record?.message?.content)
  && record.message.content.some((part) => launchTask(record, part))

/** Main transcript: only queue notices and inbound records can matter; everything else is dropped. */
export function slimMain(record) {
  if (record?.type === 'queue-operation') {
    return typeof record.content === 'string' && record.content.includes('<task-notification>')
      ? { type: record.type, operation: record.operation, timestamp: record.timestamp, content: record.content } : null
  }
  return inbound(record) ? slimRecord(record) : null
}

/** Subagent transcript: assistant turn markers, inbound records and background launches. */
export function slimAgent(record) {
  if (record?.type === 'assistant') return { type: 'assistant', timestamp: record.timestamp, message: { stop_reason: record.message?.stop_reason } }
  return inbound(record) || launchesIn(record) ? slimRecord(record) : null
}

const NOTICE_LINE = 'task-notification'
export const readNewMain = (file, cursor) => readMainFile(file, cursor, slimMain, (line) => line.includes(NOTICE_LINE))
/** One-shot read of a whole main transcript, streamed and projected the same way. */
export const readMainTranscript = (file) => readNewMain(file, { offset: 0, tailBytes: Buffer.alloc(0), records: [] })
export const readAgents = (sessionDir, cache) => readAgentFiles(sessionDir, cache, slimAgent)

// A notice is one of: a delegate/task completion (parseable), something with no delegate owner to
// wake (skipped SILENTLY), or malformed (degraded). Real shapes: agent notices of resumed agents have
// no tool-use-id; monitor events have no status or output-file; orphan summaries name several tasks.
const IGNORED_SUMMARIES = [/^Monitor\b/, /didn't finish before the previous session ended/]
export function classifyNotice(body) {
  if (typeof body !== 'string' || !body.includes('<task-notification>')) return null
  const header = body.slice(0, Math.min(...['<status>', '<summary>'].map((mark) => { const at = body.indexOf(mark); return at < 0 ? body.length : at })))
  const taskId = tag(body, 'task-id')
  const status = tag(body, 'status')
  const summary = tag(body, 'summary')
  if ((header.match(/<task-id>/g) ?? []).length > 1 || body.split('<result>')[0].includes('<event>') || IGNORED_SUMMARIES.some((pattern) => pattern.test(summary ?? ''))) return { skip: true }
  const toolUseId = tag(body, 'tool-use-id')
  const outputFile = tag(body, 'output-file')
  if (!taskId || !TASK.test(taskId) || !status || !summary || (toolUseId && !/^toolu_[a-zA-Z0-9]+$/.test(toolUseId))
    || (outputFile && !path.isAbsolute(outputFile))) return { malformed: true }
  return { notice: { taskId, toolUseId: toolUseId || null, status, summary, outputFile: outputFile || null } }
}
export const parseTaskNotification = (body) => classifyNotice(body)?.notice ?? null

export function pendingQueueNotifications(records) {
  const pending = []
  for (const r of records) {
    if (r.type !== 'queue-operation' || !parseTaskNotification(r.content)) continue
    if (r.operation === 'enqueue') pending.push({ ...parseTaskNotification(r.content), body: r.content, at: r.timestamp })
    if (r.operation === 'remove') {
      const index = pending.findIndex((p) => p.body === r.content)
      if (index >= 0) pending.splice(index, 1)
    }
  }
  return pending
}

export function backgroundLaunchOwner(byId) {
  const launches = []
  for (const [id, records] of Object.entries(byId)) for (const r of records) {
    if (!Array.isArray(r?.message?.content)) continue
    for (const part of r?.message?.content ?? []) {
      const taskId = launchTask(r, part)
      if (taskId) launches.push({ id, taskId, toolUseId: part.tool_use_id })
    }
  }
  return launches
}

export const resumedSince = (records, at) => records.some((r) => r.type === 'assistant' && time(r) > at)

// Position, not timestamp: a queued prompt is appended when the next turn starts but carries its
// ENQUEUE time, which can predate the wait declaration. Start at the first record dated after the
// wait and take everything that follows in file order.
export function resumedInbound(records, waitingAt) {
  const start = records.findIndex((r) => Number.isFinite(time(r)) && time(r) > waitingAt)
  if (start < 0) return null
  let ended = false
  let incoming = null
  for (const r of records.slice(start)) {
    if (!Number.isFinite(time(r))) continue
    if (r.type === 'assistant' && r.message?.stop_reason === 'end_turn') {
      if (incoming) return incoming
      ended = true
    } else if (ended && inbound(r) && !/^Stop hook feedback:/i.test(text(r).trim())
      && !/^(SubagentStop|Stop) hook/i.test(text(r).trim())) {
      incoming = r.timestamp
    } else if (incoming && r.type === 'assistant') return incoming
  }
  return null
}

const sameWait = (a, b) => a?.at === b?.at && a?.artifact === b?.artifact

export function unresolvedWaits(records) {
  const waits = new Map()
  for (const r of records) {
    if (!r.agentId) continue
    if (r.t === 'waiting') waits.set(r.agentId, r)
    // Old resumed records retain their clearing semantics; new evidence is occurrence-scoped.
    if (r.t === 'out' || (r.t === 'resumed' && (r.waitingAt === undefined
      || sameWait(waits.get(r.agentId), { at: r.waitingAt, artifact: r.waitingArtifact })))) waits.delete(r.agentId)
  }
  return waits
}

export function writeResumed(registryFile, subagentDir, now = Date.now()) {
  let records
  try { records = readJsonl(registryFile) } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  let count = 0
  for (const [agentId, waiting] of unresolvedWaits(records)) {
    if (!ID.test(agentId)) continue
    if (Date.parse(waiting.at) > now) continue
    let transcript
    try { transcript = readJsonl(path.join(subagentDir, `agent-${agentId}.jsonl`), true, slimAgent) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!Number.isFinite(Date.parse(waiting.at))) throw new Error('invalid waiting timestamp')
    const at = resumedInbound(transcript.filter((r) => time(r) <= now), Date.parse(waiting.at))
    if (!at) continue
    // Re-read before append: two observers of the same session must not normally write twice.
    if (!sameWait(unresolvedWaits(readJsonl(registryFile)).get(agentId), waiting)) continue
    // The proving inbound can carry an ENQUEUE time older than the wait; never date a resume before it.
    appendRecord(registryFile, { t: 'resumed', agentId, at: Date.parse(at) >= Date.parse(waiting.at) ? at : waiting.at,
      waitingAt: waiting.at, waitingArtifact: waiting.artifact, evidence: 'transcript' })
    count++
  }
  return count
}

const bodyOf = (s) => /<task-notification>[\s\S]*?<\/task-notification>/.exec(s)?.[0]?.replace(/\s+/g, ' ').trim()
function eventId(session, kind, p) {
  return createHash('sha256').update(JSON.stringify([session, kind, p.taskId, p.toolUseId, p.at])).digest('hex').slice(0, 12)
}
function relayLine(kind, target, label, p, session, message, now) {
  const marker = `[wt-relay ${eventId(session, kind, p)}]`
  const detail = kind === 'WAKE'
    ? `its background task ${p.taskId} finished at ${p.at.slice(11, 19)} and it has not resumed for ${Math.floor((now - Date.parse(p.at)) / 1000)}s`
    : `delegate ${p.taskId} finished (${clean(p.status)}) but its notice has not reached the agent that spawned it`
  return { kind, key: `${kind}:${eventId(session, kind, p)}`, at: Date.parse(p.at),
    line: `${kind}: ${target} (${clean(label)}) — ${detail}. Relay one line: SendMessage to "${target}": "${relayText(message)} ${marker}"` }
}

// A completion older than this is never relayed: waking an agent days later points it at stale work.
export const WAKE_MAX_AGE_MS = 24 * 3_600_000

export function detectRelays({ sessionId, main, agents, meta, now = Date.now(), grace = 90_000, maxAge = WAKE_MAX_AGE_MS }) {
  const lines = []
  const degraded = []
  const stale = []
  // Ownership and liveness must see the same historical slice, including launch receipts.
  const agentView = Object.fromEntries(Object.entries(agents).map(([id, records]) => [id, records.filter((r) => time(r) <= now)]))
  const launches = backgroundLaunchOwner(agentView)
  const queue = []
  for (const r of main) {
    if (time(r) > now) continue
    if (r.type !== 'queue-operation' || typeof r.content !== 'string' || !r.content.includes('<task-notification>')) continue
    const { notice, malformed } = classifyNotice(r.content)
    if (malformed) { degraded.push('task notification malformed; attribution unavailable'); continue }
    if (!notice) continue
    if (r.operation === 'enqueue') queue.push({ ...notice, body: r.content, at: r.timestamp })
    if (r.operation === 'remove') {
      const i = queue.findIndex((p) => p.body === r.content)
      if (i >= 0) queue.splice(i, 1)
    }
  }
  for (const p of queue) {
    // A known subagent's own completion is a FORWARD matter, never a background-command wake.
    if (meta[p.taskId]) continue
    const at = Date.parse(p.at)
    if (!Number.isFinite(at)) { degraded.push(`completion time unknown for task ${clean(p.taskId)}`); continue }
    if (now - at < grace) continue
    const matched = launches.filter((l) => p.toolUseId ? l.toolUseId === p.toolUseId : l.taskId === p.taskId)
    const owners = [...new Set(matched.map((launch) => launch.id))]
    // No subagent of this session launched it: main's own background command, nothing to relay.
    if (owners.length === 0) continue
    if (owners.length > 1 || !ID.test(owners[0])) { degraded.push(`background owner ambiguous for task ${clean(p.taskId)}`); continue }
    const owner = owners[0]
    const records = agentView[owner] ?? []
    if (agents[owner].some((r) => r.type === 'assistant' && !Number.isFinite(time(r)))) {
      degraded.push(`owner time unknown for task ${clean(p.taskId)}`)
      continue
    }
    if (resumedSince(records, at)) continue
    const last = records.filter((r) => r.type === 'assistant' && time(r) <= at).at(-1)
    if (last?.message?.stop_reason !== 'end_turn') continue
    if (now - at > maxAge) { stale.push({ owner, taskId: p.taskId, at: p.at }); continue }
    const parent = meta[owner]?.parentAgentId
    const message = `Your background task ${p.taskId} finished (${clean(p.status)}); ` +
      (p.outputFile ? `read ${clean(p.outputFile, 2048)}` : `check the result of task ${p.taskId}`) + ' and continue.' +
      (parent && ID.test(parent) && agentView[parent] ? ` Send your report to ${parent} with SendMessage.` : '')
    lines.push(relayLine('WAKE', owner, meta[owner]?.name ?? meta[owner]?.agentType ?? 'delegate', p, sessionId, message, now))
  }
  // A nested agent's completion may be routed to main after main resumes it. A parent
  // mentioning the id outbound is not delivery; match only full inbound notices or relays.
  const occurrences = new Map()
  for (const r of main) {
    if (time(r) > now || !inbound(r)) continue
    const body = bodyOf(text(r))
    const { notice, malformed } = classifyNotice(body) ?? {}
    if (!notice) {
      if (malformed) degraded.push('inbound task notification malformed; attribution unavailable')
      continue
    }
    if (!Number.isFinite(time(r))) { degraded.push(`notice time unknown for task ${clean(notice.taskId)}`); continue }
    const p = { ...notice, body, at: r.timestamp }
    const child = notice.taskId
    if (!ID.test(child)) continue
    const info = meta[child]
    if (!info) { degraded.push(`meta unknown for delegate ${child}`); continue }
    const parent = info.parentAgentId
    if (!parent || parent === sessionId) continue
    if (!agentView[parent]) {
      if (info.spawnDepth > 1) degraded.push(`parent unknown for delegate ${child}`)
      continue
    }
    if (!ID.test(parent)) { degraded.push(`parent unknown for delegate ${child}`); continue }
    if (now - time(r) < grace) continue
    const key = `${parent}:${body}`
    const ordinal = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, ordinal)
    const parentRecords = agentView[parent]
    if (agents[parent].some((entry) => inbound(entry) && !Number.isFinite(time(entry)))) {
      degraded.push(`parent time unknown for delegate ${child}`)
      continue
    }
    const marker = `[wt-relay ${eventId(sessionId, 'FORWARD', p)}]`
    if (parentRecords.some((entry) => inbound(entry) && time(entry) >= time(r) && text(entry).includes(marker))) continue
    const receipts = parentRecords.filter((entry) => inbound(entry) && time(entry) >= time(r)
      && bodyOf(text(entry)) === body).length
    if (receipts >= ordinal) continue
    lines.push(relayLine('FORWARD', parent, meta[parent]?.name ?? meta[parent]?.agentType ?? 'delegate', p, sessionId,
      `Your delegate ${child} (${clean(info.name ?? info.agentType ?? 'delegate')}) finished (${clean(p.status)}); ` +
      (p.outputFile ? `its result is in ${clean(p.outputFile, 2048)}.` : `its result is under task ${child}.`), now))
  }
  return { lines, degraded, stale }
}

// FORWARD infers "the parent has not received the notice" from the ABSENCE of a matching record;
// every definition tried was refuted on real transcripts, so its precision is unmeasured. The live
// watcher therefore announces WAKE (directly evidenced) only; FORWARD stays a scanner diagnostic.
export const announceable = (lines) => lines.filter((entry) => entry.kind === 'WAKE')

export function dueRelays(candidates, state, now, limit = 20, repeat = 600_000) {
  const delay = (count) => count <= 3 ? repeat * (2 ** (count - 1)) : 60 * 60_000
  return candidates.filter((p) => !state[p.key] || now - state[p.key].lastEmittedAt >= delay(state[p.key].count))
    .sort((a, b) => (state[a.key] ? 1 : 0) - (state[b.key] ? 1 : 0)
      || (state[a.key]?.lastEmittedAt ?? a.at) - (state[b.key]?.lastEmittedAt ?? b.at)
      || a.key.localeCompare(b.key)).slice(0, limit)
}

export function eventBudget(write, limit = 20) {
  let spent = 0
  let suppressed = 0
  return {
    emit(line) {
      if (spent >= limit) { suppressed++; return false }
      spent++
      write(line)
      return true
    },
    close() {
      if (suppressed && spent < limit) write(`ARC WATCH TRUNCATED: ${suppressed} further event(s) this poll were counted, not listed`)
    },
  }
}
