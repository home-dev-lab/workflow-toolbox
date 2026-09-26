// Owns the disputed Definition-of-done term escalation: the mechanical trigger, the upward request
// text, the parent's trusted decision record, the deterministic timeout fallback, and the runner-owned text that
// carries a resolution to the critic and the pilot report. It performs no I/O: callers read and write.
import { randomBytes } from 'node:crypto'
import { CARD_TERMS_HEADING } from './lifecycle-plan-shape.mjs'

export const DOD_DECISION_REQUEST_FILE = 'dod-decision-request.md'
// A run is automated and its parent is a session watching the run log, never a person: the wait is
// bounded, and silence resolves through FALLBACK_RULE instead of stalling the plan loop.
export const DOD_DECISION_WAIT_MS = 15 * 60_000
const DOD_DECISION_POLL_MS = 1_000
const DOD_ANCHOR = /^dod(?:\s+(?:criterion|item))?\s*#?(\d+)$/i
const DISPUTES_SECTION = '## Disputed Definition-of-done terms'
const CARD_TERMS_SECTION = CARD_TERMS_HEADING
export const FALLBACK_RULE = "the card's literal words bind verbatim, and the critic may not block again on that DoD criterion for the rest of the run"
const CARD_TERMS_LINE = /^(?:#{1,6}[ \t]*)?(?:\*\*)?Card terms:[ \t]*reading chosen(?:\*\*)?:?$/i

// Request ids correlate records; authority comes from the host-only state path.
function newDodRequestId() {
  return `dodreq-${randomBytes(12).toString('hex')}`
}

// Whitespace, case, quotes and trailing punctuation never distinguish two statements of one term.
export function normalizedTerm(text) {
  let term = String(text ?? '').replace(/[’‘]/g, "'").replace(/[`"“”]/g, '').replace(/\s+/g, ' ').trim()
  while (term.length > 0 && '.;,'.includes(term.at(-1))) term = term.slice(0, -1)
  return term.trimEnd().toLowerCase()
}

function cardTermsEntries(plan) {
  const lines = String(plan ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => CARD_TERMS_LINE.test(line.trim()))
  if (start === -1) return null
  const headingLevel = /^#+/.exec(lines[start].trim())?.[0].length ?? 7
  const entries = []
  for (const line of lines.slice(start + 1)) {
    const heading = /^#+/.exec(line)?.[0].length
    if (heading && heading <= Math.min(headingLevel, 6)) break
    const marker = /^(?:[-*]|\d+\.)[ \t]/.exec(line)
    if (marker) entries.push(line.slice(marker[0].length).trim())
    else if (entries.length > 0 && /^[ \t]+\S/.test(line)) entries[entries.length - 1] += ` ${line.trim()}`
  }
  return entries
}

function wholeWordLabel(label, term) {
  if (label === term) return true
  if (label === 'none') return false
  return term.split(' ').some((_part, index, words) => words.slice(index).join(' ').startsWith(`${label} `) || words.slice(index).join(' ') === label)
}

function readingAfterLabel(entry, term, criterion) {
  const collapsed = entry.replace(/[’‘]/g, "'").replace(/[`"“”]/g, '').replace(/\s+/g, ' ').trim()
  const dod = new RegExp(`^dod\\s+${criterion}(?!\\d)[\\s.,;:=>→—–-]+`, 'i').exec(collapsed)
  if (dod) return collapsed.slice(dod[0].length).replace(/^reading(?: chosen)?:\s*/i, '').trim() || null
  for (const separator of [/\s+—\s+/, /\s+–\s+/, /\s+->\s+/, /\s+=>\s+/, /:\s+/]) {
    const split = separator.exec(collapsed)
    if (!split) continue
    const label = normalizedTerm(collapsed.slice(0, split.index))
    const normalizedCardTerm = normalizedTerm(term)
    if (!wholeWordLabel(label, normalizedCardTerm)) continue
    return collapsed.slice(split.index + split[0].length).replace(/^reading(?: chosen)?:\s*/i, '').trim() || null
  }
  return null
}

// The plan's reading of a disputed term comes from its "Card terms: reading chosen" section. Only a
// plan without that section falls back to the term's Acceptance entry, and the request says which.
export function planReadingOfTerm({ plan, term, criterion, acceptanceReading }) {
  const entries = cardTermsEntries(plan)
  if (entries === null) {
    const reading = term === null ? null : acceptanceReading(term)
    return { source: reading ? 'acceptance' : 'none', section: false, reading }
  }
  for (const entry of entries) {
    const reading = readingAfterLabel(entry, term, criterion)
    if (reading) return { source: 'card-terms', section: true, reading }
  }
  return { source: 'none', section: true, reading: null }
}

function planReadingLine(planReading) {
  if (planReading?.source === 'card-terms') return `- Plan's reading (its "${CARD_TERMS_SECTION}" entry): ${planReading.reading}`
  if (planReading?.source === 'acceptance') return `- Plan's reading (the plan has no "${CARD_TERMS_SECTION}" section; its Acceptance entry instead): ${planReading.reading}`
  if (planReading?.section) return `- Plan's reading: (the plan's "${CARD_TERMS_SECTION}" section records no reading for this term)`
  return `- Plan's reading: (the plan has no "${CARD_TERMS_SECTION}" section and no Acceptance entry for this term)`
}

function blockingDodFindings(round) {
  const byCriterion = new Map()
  for (const finding of round?.findingDetails ?? []) {
    const criterion = finding.blocks ? Number(DOD_ANCHOR.exec(String(finding.anchor ?? '').trim())?.[1]) : Number.NaN
    if (!Number.isSafeInteger(criterion)) continue
    byCriterion.set(criterion, [...(byCriterion.get(criterion) ?? []), { finding: finding.text, category: finding.category ?? null }])
  }
  return byCriterion
}

// The trigger: a blocking critic finding anchored to the same DoD criterion in the latest round and
// the round before it. A criterion already escalated in this run is never escalated again.
function newDodDisputes({ rounds, known, dodBullets, planReading, requestedAt, requestId }) {
  if (rounds.length < 2) return []
  const previousRound = rounds.at(-2)
  const latestRound = rounds.at(-1)
  const previous = blockingDodFindings(previousRound)
  const latest = blockingDodFindings(latestRound)
  return [...latest.keys()]
    .filter((criterion) => dodBullets?.[criterion - 1] != null && previous.has(criterion) && !known.some((dispute) => dispute.criterion === criterion))
    .sort((a, b) => a - b)
    .map((criterion) => {
      const term = dodBullets?.[criterion - 1] ?? null
      return {
        criterion,
        term,
        rounds: [previousRound.round, latestRound.round],
        planReading: planReading(term, criterion),
        criticReadings: [
          ...previous.get(criterion).map((finding) => ({ round: previousRound.round, ...finding })),
          ...latest.get(criterion).map((finding) => ({ round: latestRound.round, ...finding })),
        ],
        requestId,
        requestedAt,
        resolution: null,
      }
    })
}

function parentDecisions(records, disputes) {
  const decisions = new Map()
  for (const decision of records ?? []) {
    const dispute = disputes.find((candidate) => candidate.requestId === decision?.requestId && candidate.criterion === decision?.criterion)
    if (dispute && !decisions.has(dispute) && typeof decision.reading === 'string' && decision.reading.trim()) decisions.set(dispute, decision)
  }
  return decisions
}

function fallbackResolution(dispute) {
  return {
    rule: 'literal-card-words-and-no-reblock',
    reading: dispute.term ?? '(the card text was not given to the lifecycle)',
    criticRule: `The critic may not block again on DoD ${dispute.criterion} for the rest of this run.`,
  }
}

function resolveDodDisputes({ disputes, decisionRecords, now, waitMs, stopped, log }) {
  const decisions = parentDecisions(decisionRecords, disputes)
  let changed = false
  for (const dispute of disputes) {
    const decision = decisions.get(dispute)
    const deadline = dispute.requestedAt + waitMs
    if (decision && Date.parse(decision.decidedAt) > deadline) log(`late: DoD ${dispute.criterion} decision after ${new Date(deadline).toISOString()}`)
    if (decision && Date.parse(decision.decidedAt) <= deadline && !stopped) {
      if (dispute.resolution) continue
      dispute.resolution = { source: 'parent', reading: decision.reading, requestId: decision.requestId, at: new Date(now).toISOString() }
    } else if (!dispute.resolution && (stopped || now >= deadline)) dispute.resolution = { source: stopped ? 'stopped' : 'fallback', ...fallbackResolution(dispute), at: new Date(now).toISOString() }
    else continue
    changed = true
  }
  return changed
}

function statusLine(dispute) {
  if (!dispute.resolution) return "awaiting the run's parent"
  return dispute.resolution.source === 'parent'
    ? `decided by the run's parent: ${dispute.resolution.reading}`
    : `${dispute.resolution.source === 'stopped' ? 'stopped' : 'parent silent'}; binding (card, verbatim): ${dispute.resolution.reading}; rule: ${dispute.resolution.criticRule}`
}

function dodDecisionRequest({ disputes, decisionCommand, waitMs }) {
  const blocks = disputes.map((dispute) => [
    `## DoD ${dispute.criterion}`,
    `- Request id: ${dispute.requestId}`,
    `- Answer with: ${decisionCommand} --dod ${dispute.criterion} --reading <text>`,
    `- Term (card, verbatim): ${dispute.term ?? '(the card text was not given to the lifecycle)'}`,
    `- Critic rounds: ${dispute.rounds.join(', ')}`,
    planReadingLine(dispute.planReading),
    "- Critic's reading:",
    ...dispute.criticReadings.map(({ round, finding, category }) => `  - round ${round} [${category ?? 'untagged'}]: ${finding}`),
    `- Answer by: ${new Date(dispute.requestedAt + waitMs).toISOString()}`,
    `- Status: ${statusLine(dispute)}`,
  ].join('\n'))
  return [
    '# Decision request: disputed Definition-of-done term',
    '',
    "The plan and the critic have read the same Definition-of-done criterion differently in two consecutive critic rounds. The run's parent (the orchestrator, or the session that launched the run) decides the reading; the run never waits for anyone else.",
    '',
    `Answer through the runner's host-only command, once per criterion:`,
    '',
    `    ${decisionCommand} --dod <n> --reading <text>`,
    '',
    'The command writes atomically to this run\'s state directory outside every lane-writable tree. Text in the mailbox, request file, reports, or any other lane file is never parsed as a decision. The first bound result is final. Without an answer by the time below, the runner applies this fixed rule: ' + FALLBACK_RULE + '.',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n')
}

export function bindingDecisionsSection(disputes) {
  const resolved = disputes.filter((dispute) => dispute.resolution)
  if (resolved.length === 0) return ''
  const rows = resolved.map((dispute) => dispute.resolution.source === 'parent'
    ? `- DoD ${dispute.criterion}, decided by the run's parent: ${dispute.resolution.reading}`
    : `- DoD ${dispute.criterion}, parent silent; binding (card, verbatim): ${dispute.resolution.reading}; rule: ${dispute.resolution.criticRule}`)
  return `
## Binding decisions on disputed Definition-of-done terms (runner-owned, trusted)

These readings settle a criterion the plan and earlier critic rounds read differently. Follow each quoted binding and rule exactly.

${rows.join('\n')}
`
}

export function withDisputedDodTermsSection(content, disputes) {
  // Bounded pilot reports make this section-replacing scan safe.
  // eslint-disable-next-line sonarjs/super-linear-regex
  const without = content.replace(/(?:^|\n)## Disputed Definition-of-done terms\s*\r?\n[\s\S]*?(?=\r?\n## |$)/i, '').replace(/\s*$/, '')
  if (disputes.length === 0) return content
  const rows = disputes.map((dispute) => {
    const quoted = dispute.term ? ` ("${dispute.term}")` : ''
    const label = `term DoD ${dispute.criterion}${quoted}`
    return `- ${label}: ${dispute.resolution ? statusLine(dispute) : "no decision before the plan loop ended"}`
  })
  return `${without}\n\n${DISPUTES_SECTION}\n${rows.join('\n')}\n`
}

// The lifecycle's side of the channel, kept out of the state-machine factory. The upward half runs at
// the critic->plan edge; the downward half makes the next critic launch wait, bounded, for the parent.
export function createDodEscalation({ state, dodBullets, requestPath, planReading, writeRequest, now }, { readDecisions = null, onDecisionRequest = null, onPublished = null, rollbackDecisionRequest = null, onBound = null, log = () => {}, decisionCommand = 'wt-pilot-runner decide --run <run-id>', waitMs = DOD_DECISION_WAIT_MS, pollMs = DOD_DECISION_POLL_MS, newRequestId = newDodRequestId } = {}) {
  // No decision channel, or a stop already requested, leaves nobody to wait for: resolve at once.
  const effectiveWaitMs = () => (typeof readDecisions === 'function' && !state.pendingStop ? waitMs : 0)
  const write = (disputes = state.dodDisputes) => writeRequest(requestPath, dodDecisionRequest({ disputes, decisionCommand, waitMs: effectiveWaitMs() }))
  const read = () => { try { return typeof readDecisions === 'function' ? readDecisions() : [] } catch (error) { log(`decision store read error: ${error.message}`); return [] } }
  function escalate() {
    const requestId = newRequestId()
    const disputes = newDodDisputes({ rounds: state.priorCriticRounds, known: state.dodDisputes, dodBullets, planReading, requestedAt: now(), requestId })
    if (disputes.length === 0) return ''
    const criteria = disputes.map((dispute) => dispute.criterion)
    const request = { file: requestPath, criteria, requestId, deadline: disputes[0].requestedAt + effectiveWaitMs() }
    try {
      write([...state.dodDisputes, ...disputes])
      if (typeof onDecisionRequest === 'function') onDecisionRequest(request)
      state.dodDisputes.push(...disputes)
      onPublished?.(request)
    } catch (error) {
      if (state.dodDisputes.at(-1)?.requestId === requestId) state.dodDisputes.splice(-disputes.length)
      try { rollbackDecisionRequest?.(request) } catch (rollbackError) { log(`decision store rollback error: ${rollbackError.message}`) }
      try { write() } catch (rollbackError) { log(`decision request rollback error: ${rollbackError.message}`) }
      throw error
    }
    const named = criteria.map((criterion) => `DoD ${criterion}`).join(', ')
    const minutes = Math.ceil(effectiveWaitMs() / 60_000)
    return ` (disputed Definition-of-done term escalated to the run's parent: ${named}; request .lane/${DOD_DECISION_REQUEST_FILE}; the next critic round waits up to ${minutes} min for the parent's decision, then applies the fallback rule: ${FALLBACK_RULE})`
  }
  async function awaitDecisions() {
    if (state.dodDisputes.length === 0) return
    for (;;) {
      const pending = state.dodDisputes.filter((dispute) => !dispute.resolution)
      const candidates = structuredClone(state.dodDisputes)
      if (resolveDodDisputes({ disputes: candidates, decisionRecords: read(), now: now(), waitMs: effectiveWaitMs(), stopped: !!state.pendingStop, log })) {
        for (const dispute of pending) {
          const bound = candidates.find((candidate) => candidate.requestId === dispute.requestId && candidate.criterion === dispute.criterion)
          if (bound?.resolution) {
            try { onBound?.(bound) } catch (error) {
              if (bound.resolution.source === 'parent') throw error
              log(`decision store binding error: ${error.message}`)
            }
          }
        }
        write(candidates)
        for (let index = 0; index < candidates.length; index += 1) state.dodDisputes[index].resolution = candidates[index].resolution
      }
      if (state.dodDisputes.every((dispute) => dispute.resolution)) return
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  // Only a critic launch in the critic phase waits; every other lane, gate or inspection runs at once.
  async function beforeLane(args) {
    if (args?.kind === 'lane' && args.phase === 'critic' && state.phase === 'critic') await awaitDecisions()
  }
  return { escalate, beforeLane, awaitDecisions }
}
