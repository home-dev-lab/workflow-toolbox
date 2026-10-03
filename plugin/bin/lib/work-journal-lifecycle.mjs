import path from 'node:path'
import * as io from './host/work-journal-io.mjs'
import { digestJournal, lockNotice, readChain, readOutcomes, recoverJournal, verifyJournal, withJournalLock } from './work-journal.mjs'
import { boardPointer, openUnsynced, taskFilePath } from './work-journal-commands.mjs'
import { matchedRecorders, matchesOutward, outwardRecorders, sourceKey } from './work-journal-recorders.mjs'
import { sha256 } from './work-journal-paths.mjs'
import { parseTranscriptText } from './transcript-delta.mjs'
import { recordGuardEvent } from './guard-journal.mjs'

function attempt(messages, operation) {
  try { operation() } catch (error) { messages.push(`LOUD: work journal: ${error.message}`) }
}
export function sessionStart(ctx, input, config) {
  const messages = config.warnings.map((warning) => `LOUD: ${warning}`)
  attempt(messages, () => {
    const verified = verifyJournal(ctx)
    for (const error of verified.errors.slice(0, 8)) messages.push(`LOUD: work journal: ${error}`)
    if (verified.errors.length > 8) messages.push(`LOUD: ${verified.errors.length - 8} more integrity errors; run wt-work-journal.mjs verify`)
  })
  attempt(messages, () => {
    if (readChain(ctx.store).errors.length) return
    withJournalLock(ctx, () => {
      recoverJournal(ctx)
      if (!input.agent_id && input.session_id && input.transcript_path) io.atomicJson(path.join(ctx.store, 'sessions', `${sha256(input.session_id)}.json`), { transcript: io.canonical(input.transcript_path) })
    })
  })
  attempt(messages, () => { messages.push(digestJournal(ctx)) })
  attempt(messages, () => {
    const open = openUnsynced(ctx)
    if (open.length) messages.push(`LOUD: ${open.length} unsynced entries; run wt-work-journal.mjs unsynced --list and fold their full details into the board, then resolve each hash`)
  })
  attempt(messages, () => {
    const pointer = boardPointer(ctx)
    const task = io.optionalRead(taskFilePath(ctx))
    if (task?.trim()) messages.push(pointer ? 'Run wt-work-journal.mjs retire-progress once to archive and retire the Markdown task file.' : 'This project still tracks tasks in a Markdown file — onboard a board with the planka-tracking skill.')
    const cache = io.json(path.join(ctx.store, 'board.json'))
    if (pointer && (!cache?.doneId || cache.boardId !== pointer.boardId)) messages.push('Run wt-work-journal.mjs setup-board to cache the Done list (hooks never make network calls).')
  })
  attempt(messages, () => {
    const notice = lockNotice(ctx)
    if (notice) messages.push(`LOUD: ${notice}`)
    const pending = io.list(path.join(ctx.store, 'pending')).filter((name) => name.endsWith('.json'))
    if (pending.some((name) => Date.now() - io.stat(path.join(ctx.store, 'pending', name)).mtimeMs > 3600000)) messages.push('LOUD: pending journal acts are older than one hour; inspect the lock, run unlock if its owner is proven dead, then start a session to recover.')
  })
  return messages.join('\n')
}
function realUser(record) {
  const content = record.message?.content
  return record.type === 'user' && !record.isMeta && !record.isCompactSummary
    && (typeof content === 'string' || (Array.isArray(content) && content.some((item) => item.type === 'text')))
}
function currentTurnCalls(file) {
  const tail = io.readBackwardLines(file, (raw) => parseTranscriptText(raw).some(realUser))
  const calls = []
  for (const record of parseTranscriptText(tail.lines.join('\n'))) {
    const content = record.message?.content
    if (record.type !== 'assistant' || !Array.isArray(content)) continue
    for (const item of content) if (item.type === 'tool_use') calls.push(item)
  }
  return { calls, limited: tail.limited }
}
function missingForRecorder(ctx, input, recorder, outcomes) {
  const src = input.tool_use_id || sourceKey(input)
  const latest = new Map(outcomes.filter((item) => item.src === src && item.rec === recorder.id).map((item) => [item.actId, item]))
  const detections = io.json(path.join(ctx.store, 'detections', `${sourceKey(input)}-${recorder.id}.json`))
  const ids = detections?.map((item) => item.id) || [...latest.keys()]
  if (!ids.length) return [`${src}/${recorder.id}: missing outcome`]
  return ids.flatMap((id) => {
    const outcome = latest.get(id)?.outcome
    return outcome === 'recorded' || outcome === 'nothing-new' || outcome === 'not-confirmed' ? [] : [`${src}/${recorder.id}/${id}: ${outcome || 'missing outcome'}`]
  })
}
export function stopCheck(ctx, input, config) {
  if (!input.transcript_path) return ''
  const turn = currentTurnCalls(input.transcript_path)
  const outcomes = readOutcomes(ctx)
  const missing = []
  for (const call of turn.calls) {
    const payload = { ...input, tool_name: call.name, tool_use_id: call.id, tool_input: call.input }
    const active = matchedRecorders(config, payload, ctx)
    for (const id of outwardRecorders(config, payload, ctx)) {
      if (!active.some((recorder) => recorder.id === id)) missing.push(`${call.id}/${id}: outward act, recorder disabled by project`)
    }
    if (!active.length && matchesOutward(config, payload)) missing.push(`${call.id}: outward act has no recorder`)
    for (const recorder of active) missing.push(...missingForRecorder(ctx, payload, recorder, outcomes))
  }
  if (!missing.length && !turn.limited) return ''
  const overflow = missing.length > 10 ? `; +${missing.length - 10} more` : ''
  const window = turn.limited ? '\nLOUD: work journal turn exceeded the 16 MiB transcript window' : ''
  const warning = `LOUD: work journal unrecorded outward acts (warn-only probation): ${missing.slice(0, 10).join('; ')}${overflow}${window}`
  recordGuardEvent({ guard: 'wt-work-journal-hook.mjs', decision: 'warned', class: 'journal:unrecorded', reason: warning, cwd: ctx.root })
  return warning
}
