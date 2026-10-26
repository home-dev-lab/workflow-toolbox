import path from 'node:path'
import { effectiveModel } from './pilot-model-config.mjs'
import { readText, readLines, entries } from './host/model-fallback-files.mjs'
import { scanFile } from './model-fallback-scan.mjs'
import { trackerState, snapshotTrackerState } from './model-fallback-state.mjs'

const normalize = (value) => typeof value === 'string' ? value.replace(/\[\d+m\]$/, '') : null
const family = (value) => /claude-(opus|sonnet|haiku|fable)-/i.exec(value ?? '')?.[1] ?? null
const aliases = new Set(['opus', 'sonnet', 'haiku', 'fable'])
const request = (value) => value === 'inherit' ? null : normalize(value)
const same = (requested, served, env) => {
  const resolved = normalize(effectiveModel(request(requested), { env }).effective)
  if (resolved === normalize(served)) return true
  return aliases.has(resolved) && new RegExp(`claude-${resolved}-`, 'i').test(normalize(served) ?? '')
}

function recordRun(state, message, model, time, position) {
  const id = message.id
  if (id && state.seenMessages.has(id)) return
  if (id) state.seenMessages.add(id)
  const last = state.runs.at(-1)
  if (last?.model === model) last.calls += 1
  else state.runs.push({ model, calls: 1, time, position })
  state.lastFromRun.set(model, position)
  state.lastServedPosition = position
}

function recordRefusal(state, record, message, model, time, position) {
  if (message?.stop_reason !== 'refusal') return
  if (message.id && state.seenRefusals.has(message.id)) return
  if (message.id) state.seenRefusals.add(message.id)
  state.refusals.push({ model, time, uuid: record.uuid, position })
}

// Informational safeguard text is the only classifier signal in some SDK streams and
// in transcripts without an assistant refusal. This text key is version-fragile.
function recordNotice(state, record, time, position) {
  if (record.type === 'system' && record.subtype === 'informational' && /safeguards stopped/i.test(record.content ?? '')) {
    state.notices.push({ time, parentUuid: record.parentUuid, position, lastServedPosition: state.lastServedPosition })
  }
}

// Both descriptions of a fallback: the structured system record and the assistant content item.
const fallbackItem = (message) => message?.content?.find?.((entry) => entry.type === 'fallback')
const itemEnds = (item) => [item.from?.model, item.to?.model]

function transition(record, message) {
  const structured = record.type === 'system' && record.subtype === 'model_refusal_fallback'
  const item = fallbackItem(message)
  if (!structured && !item) return null
  const [from, to] = (structured ? [record.originalModel, record.fallbackModel] : itemEnds(item)).map(normalize)
  return from && to ? { structured, item, from, to, source: structured ? 'system' : 'assistant' } : null
}

const describesPrevious = (state, previous, change) => previous?.from === change.from && previous?.to === change.to
  && previous.source !== change.source && (state.lastFromRun.get(change.from) ?? 0) <= previous.position

const fallbackEvent = (record, message, change, time, position) => ({ from: change.from, to: change.to, time,
  category: change.structured ? record.apiRefusalCategory ?? null : null, requestId: record.requestId ?? null, source: change.source, position, messageId: message?.id })

// Adjacent descriptions of one transition can have different requestIds. The
// structured record wins; distinct transitions without ids are not collapsed.
function recordFallback(state, record, message, change, time, position) {
  const previous = state.fallbacks.at(-1)
  if (describesPrevious(state, previous, change)) {
    if (change.structured) Object.assign(previous, { time, category: record.apiRefusalCategory ?? null, requestId: record.requestId ?? null, source: 'system' })
  } else if (!(change.item && message.id && state.fallbacks.some((event) => event.messageId === message.id))) state.fallbacks.push(fallbackEvent(record, message, change, time, position))
}

function observeRecord(state, record) {
  const position = ++state.position
  const time = record.timestamp ?? 'unknown time'
  if (record.type === 'system' && record.subtype === 'init') state.initialModel = normalize(record.model)
  const message = record.type === 'assistant' ? record.message : null
  const model = normalize(message?.model)
  if (model && model !== '<synthetic>') recordRun(state, message, model, time, position)
  recordRefusal(state, record, message, model, time, position)
  recordNotice(state, record, time, position)
  const change = transition(record, message)
  if (change) recordFallback(state, record, message, change, time, position)
}

function trackerResult(state, requested, env, unreadable) {
  const { runs, fallbacks, refusals, notices } = state
  const stops = [...refusals]
  for (const notice of notices) {
    const linked = stops.findLast((entry) => entry.position < notice.position && entry.position >= notice.lastServedPosition)
    if (linked) linked.notice = true
    else stops.push({ model: null, time: notice.time, notice: true })
  }
  return { requested, initialModel: state.initialModel, runs, fallbacks, refusals: stops, notices, unknown: unreadable || !(runs.length || stops.length || fallbacks.length), env }
}

export function createModelTracker(requested = null, env = process.env, snapshot = null) {
  const state = trackerState(snapshot)
  let unreadable = false
  function observe(record) {
    if (!record || typeof record !== 'object') return
    if (record.parent_tool_use_id != null) return
    observeRecord(state, record)
  }
  // snapshot(): plain JSON of every observation-derived field; taken before result(), which marks
  // refusal entries. A transcript read failure (markUnknown) is deliberately not part of it.
  return {
    observe,
    result: () => trackerResult(state, requested, env, unreadable),
    snapshot: () => snapshotTrackerState(state),
    restored: Boolean(snapshot),
    markUnknown() { unreadable = true },
  }
}

// The one matching rule for targets-only reads: a line can describe a fallback only if it contains this.
export const TARGET_NEEDLE = 'fallback'

const observeLine = (tracker) => (line) => {
  try { tracker.observe(JSON.parse(line)) } catch { /* corrupt lines do not mask good observations */ }
}

export function analyseTranscript(file, { requested = null, env = process.env, targetsOnly = false, chunkSize, io } = {}) {
  const tracker = createModelTracker(requested, env)
  const onLine = observeLine(tracker)
  try {
    if (targetsOnly) scanFile(file, TARGET_NEEDLE, { io, chunkSize, onLine })
    else for (const line of readLines(file, chunkSize)) if (line.trim()) onLine(line)
  } catch { tracker.markUnknown() }
  return tracker.result()
}

export function requestedFromMeta(transcript) {
  try {
    const basename = path.basename(transcript)
    if (!/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(basename)) return null
    return JSON.parse(readText(path.join(path.dirname(transcript), basename.replace(/\.jsonl$/, '.meta.json')))).model ?? null
  } catch { return null }
}

export function modelWarnings(result, { name = 'session', fallbacks = result.fallbacks } = {}) {
  if (result.unknown) return []
  const warnings = []
  const usedFallbacks = new Set()
  const add = (time, text) => warnings.push(`WARN model-fallback: ${name} ${text} at ${time}`)
  if (result.initialModel && result.runs[0] && result.initialModel !== result.runs[0].model && !result.fallbacks.length)
    add(result.runs[0].time, `model changed ${result.initialModel} -> ${result.runs[0].model}`)
  for (let i = 1; i < result.runs.length; i++) {
    const match = result.fallbacks.find((event) => event.from === result.runs[i - 1].model && event.to === result.runs[i].model && !usedFallbacks.has(event) && (event.position ?? 0) >= (result.runs[i - 1].position ?? 0))
    if (match) usedFallbacks.add(match)
    else
      add(result.runs[i].time, `${result.refusals.length ? 'classifier-associated ' : ''}model changed ${result.runs[i - 1].model} -> ${result.runs[i].model}`)
  }
  for (const run of result.runs) {
    const requested = request(result.requested)
    if (requested && !same(requested, run.model, result.env)) add(run.time, `requested ${requested} served ${run.model}`)
    const remapped = requested ? effectiveModel(requested, { env: result.env }) : null
    const target = fallbacks.find((event) => !result.fallbacks.includes(event) && normalize(event.to) === run.model && (run.time === 'unknown time' || event.time === 'unknown time' || run.time >= event.time) && (!requested || aliases.has(requested) && family(event.from) === requested && !remapped.remappedBy)
      && !(requested && !aliases.has(requested) && normalize(requested) === run.model))
    if (target) add(run.time, requested ? `requested ${requested} served ${run.model} is session fallback target from ${target.from}` : `no model requested; served ${run.model}, the session's fallback target after ${target.time} — verify it was not pinned deliberately`)
  }
  for (const event of result.fallbacks) {
    const category = event.category ? ` category=${event.category}` : ''
    add(event.time, `fallback model changed ${event.from} -> ${event.to}${category}`)
  }
  for (const stop of result.refusals) add(stop.time, `${stop.notice ? 'classifier notice' : 'refusal'} model=${stop.model ?? 'unknown'}`)
  return warnings
}

export function analyseSession(file, { env = process.env } = {}) {
  const parent = analyseTranscript(file, { env })
  const agents = []
  try {
    const directory = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents')
    for (const entry of entries(directory)) {
      if (!/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(entry)) continue
      const transcript = path.join(directory, entry)
      agents.push({ name: entry.slice(0, -6), result: analyseTranscript(transcript, { requested: requestedFromMeta(transcript), env }) })
    }
  } catch { /* sessions without agents are normal */ }
  return { file, parent, agents, fallbacks: parent.fallbacks }
}

export function classifyProviderRefusal(text) {
  return /(?:^|\n)\[codex\] Codex error:[^\n]*flagged for possible cybersecurity risk/i.test(text)
    ? { provider: 'openai', category: 'cyber' } : null
}
