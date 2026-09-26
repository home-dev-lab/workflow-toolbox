// Owns the disputed Definition-of-done term escalation: the mechanical trigger, the upward request
// text, the parent's decision grammar, the deterministic timeout fallback, and the runner-owned text that
// carries a resolution to the critic and the pilot report. It performs no I/O: callers read and write.
import { randomBytes } from 'node:crypto'
import { CARD_TERMS_HEADING } from './lifecycle-plan-shape.mjs'

export const DOD_DECISION_REQUEST_FILE = 'dod-decision-request.md'
// A run is automated and its parent is a session watching the run log, never a person: the wait is
// bounded, and silence resolves through FALLBACK_RULE instead of stalling the plan loop.
export const DOD_DECISION_WAIT_MS = 15 * 60_000
const DOD_DECISION_POLL_MS = 1_000
const DOD_ANCHOR = /^dod(?:\s+(?:criterion|item))?\s*#?(\d+)$/i
// Matched on a whitespace-collapsed line, so the pattern needs no backtracking quantifier.
const DECISION_LINE = /^DECISION (\S+) DoD (\d+) ?:(.*)$/i
const DECISION_SHAPED = /^DECISION\b/i
const DECISION_GRAMMAR = 'DECISION <request-id> DoD <n>: <reading>'
const DISPUTES_SECTION = '## Disputed Definition-of-done terms'
const CARD_TERMS_SECTION = CARD_TERMS_HEADING
// No model chooses the fallback: the critic's own direction tags decide which recorded reading binds.
const FALLBACK_RULE = "every disputed critic finding tagged [missing] binds the plan's recorded reading; every one tagged [overbuild] binds the critic's reading; anything else binds the card's literal words only"
const CARD_TERMS_LINE = /^(?:#{1,6}[ \t]*)?(?:\*\*)?Card terms:[ \t]*reading chosen(?:\*\*)?:?$/i

// A request id is unguessable, so a mailbox line quoting it can only have been written after the request.
function newDodRequestId() {
  return `dodreq-${randomBytes(12).toString('hex')}`
}

// Whitespace, case, quotes and trailing punctuation never distinguish two statements of one term.
export function normalizedTerm(text) {
  let term = String(text ?? '').replace(/[`"“”]/g, '').replace(/\s+/g, ' ').trim()
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

function readingAfterLabel(entry, label) {
  const collapsed = entry.replace(/[`"“”]/g, '').replace(/\s+/g, ' ').trim()
  // The label must end on a word boundary: `dod 1` never matches an entry for `DoD 10`.
  if (!collapsed.toLowerCase().startsWith(label) || /\w/.test(collapsed.charAt(label.length))) return null
  return collapsed.slice(label.length).replace(/^[\s.,;:=>→—–-]+/, '').replace(/^reading(?: chosen)?:\s*/i, '').trim() || null
}

// The plan's reading of a disputed term comes from its "Card terms: reading chosen" section. Only a
// plan without that section falls back to the term's Acceptance entry, and the request says which.
export function planReadingOfTerm({ plan, term, criterion, acceptanceReading }) {
  const entries = cardTermsEntries(plan)
  if (entries === null) {
    const reading = term === null ? null : acceptanceReading(term)
    return { source: reading ? 'acceptance' : 'none', section: false, reading }
  }
  const labels = [term === null ? null : normalizedTerm(term), `dod ${criterion}`].filter(Boolean)
  for (const entry of entries) {
    for (const label of labels) {
      const reading = readingAfterLabel(entry, label)
      if (reading) return { source: 'card-terms', section: true, reading }
    }
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
function newDodDisputes({ rounds, known, dodBullets, planReading, requestedAt, requestId, mailboxOffset }) {
  if (rounds.length < 2) return []
  const previousRound = rounds.at(-2)
  const latestRound = rounds.at(-1)
  const previous = blockingDodFindings(previousRound)
  const latest = blockingDodFindings(latestRound)
  return [...latest.keys()]
    .filter((criterion) => previous.has(criterion) && !known.some((dispute) => dispute.criterion === criterion))
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
        mailboxOffset,
        resolution: null,
      }
    })
}

function parentDecision(line) {
  const match = DECISION_LINE.exec(String(line).trim().replace(/\s+/g, ' '))
  const reading = match?.[3].trim()
  return reading ? { requestId: match[1], criterion: Number(match[2]), reading } : null
}

// A mailbox line binds only when it answers a request of this run: it quotes that request's id and one
// of its criteria. Any other DECISION-shaped line is ignored with the reason, which the caller logs.
export function decisionVerdict(line, disputes) {
  if (!DECISION_SHAPED.test(String(line).trim())) return null
  const decision = parentDecision(line)
  if (!decision) return { ignored: `it quotes no request id; the grammar is "${DECISION_GRAMMAR}"` }
  const requested = disputes.filter((dispute) => dispute.requestId === decision.requestId)
  if (requested.length === 0) return { ignored: `it names request ${decision.requestId}, which is not a decision request of this run` }
  const dispute = requested.find((candidate) => candidate.criterion === decision.criterion)
  if (!dispute) return { ignored: `request ${decision.requestId} does not dispute DoD ${decision.criterion}` }
  return { decision, dispute }
}

function mailboxLines(text) {
  const lines = []
  let start = 0
  for (const raw of String(text ?? '').split('\n')) {
    lines.push({ line: raw.replace(/\r$/, ''), start })
    start += Buffer.byteLength(raw) + 1
  }
  return lines
}

// Reads the whole mailbox and keeps, per dispute, the LATEST line that answers it and was appended after
// its request. A mailbox shorter than it was at request time has been replaced: the request id alone
// then ties a line to the request, since nothing written before the request can quote it.
function parentDecisions(text, disputes, onIgnored) {
  const total = Buffer.byteLength(String(text ?? ''))
  const decisions = new Map()
  for (const { line, start } of mailboxLines(text)) {
    const verdict = decisionVerdict(line, disputes)
    if (!verdict) continue
    const earliest = Math.min(...disputes.map((dispute) => (total >= dispute.mailboxOffset ? dispute.mailboxOffset : 0)))
    if (verdict.ignored) {
      onIgnored({ line, start, reason: start < earliest ? 'it was written before the decision request' : verdict.ignored })
      continue
    }
    const since = total >= verdict.dispute.mailboxOffset ? verdict.dispute.mailboxOffset : 0
    if (start < since) onIgnored({ line, start, reason: `it was written before request ${verdict.dispute.requestId}` })
    else decisions.set(verdict.dispute, verdict.decision)
  }
  return decisions
}

function cardWordsFallback(dispute, because) {
  const words = dispute.term ? `"${dispute.term}"` : '(the card text was not given to the lifecycle)'
  return { rule: 'card-words', why: `${because}, so the card's literal words apply`, reading: `the card's literal words ${words} only; no wider reading may be demanded` }
}

// The plan's reading counts as recorded only when it comes from its Card terms section: an Acceptance
// entry is a proof line, not a reading. The critic's reading is its latest round's findings, verbatim.
function fallbackResolution(dispute) {
  const categories = [...new Set(dispute.criticReadings.map((reading) => reading.category ?? 'untagged'))].sort()
  const only = categories.length === 1 ? categories[0] : null
  if (only === 'missing') {
    if (dispute.planReading?.source === 'card-terms') return { rule: 'plan-reading', why: "every disputed critic finding is [missing], so the plan's recorded reading applies", reading: dispute.planReading.reading }
    return cardWordsFallback(dispute, `every disputed critic finding is [missing] but the plan records no reading for this term in its "${CARD_TERMS_SECTION}" section`)
  }
  if (only === 'overbuild') {
    const latestRound = Math.max(...dispute.criticReadings.map((reading) => reading.round))
    const findings = dispute.criticReadings.filter((reading) => reading.round === latestRound && reading.finding).map((reading) => reading.finding)
    if (findings.length > 0) return { rule: 'critic-reading', why: "every disputed critic finding is [overbuild], so the critic's reading, the narrower side, applies", reading: findings.join('; ') }
    return cardWordsFallback(dispute, 'every disputed critic finding is [overbuild] but the critic records no reading')
  }
  if (only === null) return cardWordsFallback(dispute, `the disputed critic findings mix directions (${categories.join(', ')})`)
  const direction = only === 'untagged' ? 'untagged' : `[${only}]`
  return cardWordsFallback(dispute, `the disputed critic findings are ${direction}`)
}

// The latest answer binds, even one that arrives after the bound replaced a silent parent's fallback.
function resolveDodDisputes({ disputes, decisionsText, now, waitMs, onIgnored }) {
  const decisions = parentDecisions(decisionsText, disputes, onIgnored)
  let changed = false
  for (const dispute of disputes) {
    const decision = decisions.get(dispute)
    if (decision) {
      if (dispute.resolution?.source === 'parent' && dispute.resolution.reading === decision.reading) continue
      dispute.resolution = { source: 'parent', reading: decision.reading, requestId: decision.requestId, at: new Date(now).toISOString() }
    } else if (!dispute.resolution && now - dispute.requestedAt >= waitMs) dispute.resolution = { source: 'fallback', ...fallbackResolution(dispute), at: new Date(now).toISOString() }
    else continue
    changed = true
  }
  return changed
}

function statusLine(dispute) {
  if (!dispute.resolution) return "awaiting the run's parent"
  return dispute.resolution.source === 'parent'
    ? `decided by the run's parent: ${dispute.resolution.reading}`
    : `parent silent, rule ${dispute.resolution.rule} (${dispute.resolution.why}): ${dispute.resolution.reading}`
}

function dodDecisionRequest({ disputes, mailbox, waitMs }) {
  const blocks = disputes.map((dispute) => [
    `## DoD ${dispute.criterion}`,
    `- Request id: ${dispute.requestId}`,
    `- Answer with: DECISION ${dispute.requestId} DoD ${dispute.criterion}: <reading>`,
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
    `Answer by appending one line per criterion to the runner mailbox \`${mailbox ?? '(no mailbox configured)'}\`, quoting the request id of that criterion's block below:`,
    '',
    `    ${DECISION_GRAMMAR}`,
    '',
    'Only a line appended to the mailbox after this request was written, quoting its request id and one of its criteria, is a decision. The runner ignores, and logs as `decision ignored:`, every other `DECISION` line: one from an earlier run, one written before this request, one without a request id or naming another request. When several lines answer the same criterion, the latest one binds. The decision binds every later critic round. Without an answer by the time below, the runner applies its fixed fallback rule, continues, and quotes the applied reading in the pilot report: ' + FALLBACK_RULE + '; no wider reading may then be demanded.',
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
    : `- DoD ${dispute.criterion}, parent silent, rule ${dispute.resolution.rule} (${dispute.resolution.why}): ${dispute.resolution.reading}`)
  return `
## Binding decisions on disputed Definition-of-done terms (runner-owned, trusted)

These readings settle a criterion the plan and earlier critic rounds read differently. Judge that criterion against its binding reading only: a finding that demands more than the binding reading is not blocking. You may still block when the plan fails the binding reading itself.

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
export function createDodEscalation({ state, dodBullets, requestPath, planReading, writeRequest, now }, { readDecisions = null, onDecisionRequest = null, onIgnoredDecision = null, mailbox = null, waitMs = DOD_DECISION_WAIT_MS, pollMs = DOD_DECISION_POLL_MS, newRequestId = newDodRequestId } = {}) {
  // No decision channel, or a stop already requested, leaves nobody to wait for: resolve at once.
  const effectiveWaitMs = () => (typeof readDecisions === 'function' && !state.pendingStop ? waitMs : 0)
  const write = () => writeRequest(requestPath, dodDecisionRequest({ disputes: state.dodDisputes, mailbox, waitMs: effectiveWaitMs() }))
  const readMailbox = () => (typeof readDecisions === 'function' ? String(readDecisions() ?? '') : '')
  const reported = new Set()
  const onIgnored = ({ line, start, reason }) => {
    const key = `${start}\u0000${line}`
    if (reported.has(key)) return
    reported.add(key)
    if (typeof onIgnoredDecision === 'function') onIgnoredDecision({ line, reason })
  }
  function escalate() {
    const requestId = newRequestId()
    const mailboxOffset = Buffer.byteLength(readMailbox())
    const disputes = newDodDisputes({ rounds: state.priorCriticRounds, known: state.dodDisputes, dodBullets, planReading, requestedAt: now(), requestId, mailboxOffset })
    if (disputes.length === 0) return ''
    state.dodDisputes.push(...disputes)
    write()
    const criteria = disputes.map((dispute) => dispute.criterion)
    if (typeof onDecisionRequest === 'function') onDecisionRequest({ file: requestPath, criteria, requestId })
    const named = criteria.map((criterion) => `DoD ${criterion}`).join(', ')
    const minutes = Math.ceil(effectiveWaitMs() / 60_000)
    return ` (disputed Definition-of-done term escalated to the run's parent: ${named}; request .lane/${DOD_DECISION_REQUEST_FILE}; the next critic round waits up to ${minutes} min for the parent's decision, then applies the fallback rule: ${FALLBACK_RULE})`
  }
  // Reads the mailbox at every critic launch, so a later answer replaces an earlier one.
  async function awaitDecisions() {
    if (state.dodDisputes.length === 0) return
    for (;;) {
      if (resolveDodDisputes({ disputes: state.dodDisputes, decisionsText: readMailbox(), now: now(), waitMs: effectiveWaitMs(), onIgnored })) write()
      if (state.dodDisputes.every((dispute) => dispute.resolution)) return
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  // Only a critic launch in the critic phase waits; every other lane, gate or inspection runs at once.
  async function beforeLane(args) {
    if (args?.kind === 'lane' && args.phase === 'critic' && state.phase === 'critic') await awaitDecisions()
  }
  return { escalate, beforeLane }
}
