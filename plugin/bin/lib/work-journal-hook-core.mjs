import path from 'node:path'
import * as io from './host/work-journal-io.mjs'
import { appendJournalActs, initializeJournal, makeAct, readOutcomes, writeOutcome } from './work-journal.mjs'
import { actorOf, responseObject, sourceKey, subjectOf, template } from './work-journal-recorders.mjs'
import { captureGit, gitActs, pushActs, tagActs } from './work-journal-git.mjs'
import { commandHeads } from './command-invocation.mjs'
import { boardPointer } from './work-journal-commands.mjs'

const preFile = (ctx, input) => path.join(ctx.store, 'pre', `${sourceKey(input)}.json`)
const FAILED_RESPONSE = 'failed:tool-response'
export function preTool(ctx, input, recorders) {
  const actor = actorOf(ctx, input)
  if (!recorders.some((item) => item.actors.includes(actor) && ['git', 'push', 'release'].includes(item.kind))) return
  initializeJournal(ctx)
  try { io.atomicJson(preFile(ctx, input), { snapshot: captureGit({ ...input, projectRoot: ctx.root }, performance.now() + 5000) }) }
  catch (error) { io.atomicJson(preFile(ctx, input), { error: error.message }) }
}
function doneActs(ctx, input) {
  const board = io.json(path.join(ctx.store, 'board.json'))
  if (!board?.doneId || board.boardId !== boardPointer(ctx)?.boardId) return [{ outcome: 'failed:no-board-cache' }]
  const response = responseObject(input.tool_response)
  const card = response?.card || response
  if (!card?.id || typeof card.listId !== 'string') return [{ outcome: FAILED_RESPONSE }]
  if (String(card.listId) !== String(board.doneId)) return [{ outcome: 'nothing-new' }]
  if (String(card.id) !== String(input.tool_input?.cardId)) return [{ outcome: 'failed:card-mismatch' }]
  const id = String(card.id)
  return [{ kind: 'done', subject: `card:${id}`, text: `Completed ${card.name || 'card'}`,
    link: board.baseUrl ? `${board.baseUrl.replace(/\/$/, '')}/cards/${id}` : `card:${id}` }]
}
function prActs(ctx, input) {
  if (input.tool_response?.isError === true) return [{ outcome: FAILED_RESPONSE }]
  const stdout = input.tool_response?.stdout || input.tool_response?.content?.map((item) => item.text || '').join('\n') || ''
  const url = /https?:\/\/[^\s)]+\/pull\/\d+/.exec(stdout)?.[0]
  return url ? [{ kind: 'pr', subject: subjectOf(ctx, url), text: `Updated pull request ${url}`, link: url }] : [{ outcome: 'unknown' }]
}
function releaseActs(ctx, input, before, deadline) {
  const publishes = commandHeads(input.tool_input?.command || '').filter((head) => /^(?:npm|pnpm)\s+publish\b|^gh\s+release\s+create\b/.test(head))
  const tags = before?.snapshot ? tagActs(ctx, before.snapshot, deadline) : []
  if (!before && !publishes.length) return [{ outcome: 'failed:no-pre-snapshot' }]
  // No repository fixture establishes a real Bash success marker. Synthetic exitCode/success
  // fields are deliberately not accepted as proof of a publish or gh release.
  return [...tags, ...publishes.map(() => ({ outcome: 'unknown' }))]
}
function detect(ctx, input, recorder, actor, deadline) {
  if (!recorder.actors.includes(actor)) return [{ outcome: 'failed:actor' }]
  if (recorder.kind === 'done') return doneActs(ctx, input)
  if (recorder.kind === 'pr') return prActs(ctx, input)
  if (recorder.kind === 'tool') {
    if (input.tool_response?.isError === true) return [{ outcome: FAILED_RESPONSE }]
    return [{ kind: recorder.tag, subject: template(recorder.subject, input) || subjectOf(ctx, ''), text: template(recorder.sentence, input), link: template(recorder.link, input) }]
  }
  const before = io.json(preFile(ctx, input))
  if (before?.error) return [{ outcome: `failed:${before.error}` }]
  if (recorder.kind === 'release') return releaseActs(ctx, input, before, deadline)
  if (!before?.snapshot) return [{ outcome: 'failed:no-pre-snapshot' }]
  return recorder.kind === 'git' ? gitActs(ctx, before.snapshot, deadline) : pushActs(ctx, before.snapshot, deadline)
}
function detectedActs(ctx, input, recorder, actor, deadline) {
  const file = path.join(ctx.store, 'detections', `${sourceKey(input)}-${recorder.id}.json`)
  const existing = io.exists(file) ? readWinningDetection(file, deadline) : null
  if (existing) return existing
  let values
  try { values = detect(ctx, input, recorder, actor, deadline) } catch (error) { values = [{ outcome: `failed:${error.message}` }] }
  if (!values.length) values = [{ outcome: 'nothing-new' }]
  const acts = values.map((value) => ({ ...value, id: io.nonce(), src: input.tool_use_id || sourceKey(input), rec: recorder.id, actor }))
  try { io.exclusiveWrite(file, `${JSON.stringify(acts)}\n`) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return readWinningDetection(file, deadline)
  }
  return acts
}
function readWinningDetection(file, deadline) {
  for (;;) {
    try {
      const acts = io.json(file)
      if (acts) return acts
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    if (performance.now() >= deadline) throw new Error('concurrent journal detection did not finish; retry delivery')
    io.pause(10)
  }
}
export function postTool(ctx, input, recorders) {
  initializeJournal(ctx)
  const actor = actorOf(ctx, input)
  const messages = []
  const deadline = performance.now() + 5000
  const toAppend = []
  for (const recorder of recorders) {
    const acts = detectedActs(ctx, input, recorder, actor, deadline)
    const previous = new Map(readOutcomes(ctx).filter((item) => item.src === (input.tool_use_id || sourceKey(input)) && item.rec === recorder.id).map((item) => [item.actId, item]))
    for (const act of acts) {
      if (['recorded', 'nothing-new'].includes(previous.get(act.id)?.outcome)) continue
      if (act.outcome) { writeOutcome(ctx, act, act.outcome); continue }
      try { toAppend.push(makeAct(ctx, act)) } catch (error) { writeOutcome(ctx, act, 'failed:template'); messages.push(error.message) }
    }
  }
  if (toAppend.length) for (const result of appendJournalActs(ctx, toAppend)) if (result.outcome !== 'recorded') messages.push(result.error)
  return [...new Set(messages)]
}
