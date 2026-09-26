// Owns the disputed Definition-of-done term escalation: the mechanical trigger, the upward request
// text, the parent's decision grammar, the narrowest-reading fallback, and the runner-owned text that
// carries a resolution to the critic and the pilot report. It performs no I/O: callers read and write.
export const DOD_DECISION_REQUEST_FILE = 'dod-decision-request.md'
// A run is automated and its parent is a session watching the run log, never a person: the wait is
// bounded, and silence resolves to the narrowest reading instead of stalling the plan loop.
export const DOD_DECISION_WAIT_MS = 15 * 60_000
const DOD_DECISION_POLL_MS = 1_000
const DOD_ANCHOR = /^dod(?:\s+(?:criterion|item))?\s*#?(\d+)$/i
// Matched on a whitespace-collapsed line, so the pattern needs no backtracking quantifier.
const DECISION_LINE = /^DECISION DoD (\d+) ?:(.*)$/i
const DISPUTES_SECTION = '## Disputed Definition-of-done terms'

function blockingDodFindings(round) {
  const byCriterion = new Map()
  for (const finding of round?.findingDetails ?? []) {
    const criterion = finding.blocks ? Number(DOD_ANCHOR.exec(String(finding.anchor ?? '').trim())?.[1]) : Number.NaN
    if (!Number.isSafeInteger(criterion)) continue
    byCriterion.set(criterion, [...(byCriterion.get(criterion) ?? []), finding.text])
  }
  return byCriterion
}

// The trigger: a blocking critic finding anchored to the same DoD criterion in the latest round and
// the round before it. A criterion already escalated in this run is never escalated again.
function newDodDisputes({ rounds, known, dodBullets, planReading, requestedAt }) {
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
        planReading: planReading(term),
        criticReadings: [
          ...previous.get(criterion).map((finding) => ({ round: previousRound.round, finding })),
          ...latest.get(criterion).map((finding) => ({ round: latestRound.round, finding })),
        ],
        requestedAt,
        resolution: null,
      }
    })
}

export function parentDecision(line) {
  const match = DECISION_LINE.exec(String(line).trim().replace(/\s+/g, ' '))
  const reading = match?.[2].trim()
  return reading ? { criterion: Number(match[1]), reading } : null
}

// The first decision written for a criterion binds; a later line cannot silently replace it.
function parentDecisions(text) {
  const decisions = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const decision = parentDecision(line)
    if (decision && !decisions.has(decision.criterion)) decisions.set(decision.criterion, decision.reading)
  }
  return decisions
}

function narrowestReading(term) {
  const words = term ? ` "${term}"` : ''
  return `the narrowest reading that satisfies the card's literal words${words}; nothing beyond what those words require`
}

function resolveDodDisputes({ disputes, decisionsText, now, waitMs }) {
  const decisions = parentDecisions(decisionsText)
  let changed = false
  for (const dispute of disputes) {
    if (dispute.resolution) continue
    if (decisions.has(dispute.criterion)) dispute.resolution = { source: 'parent', reading: decisions.get(dispute.criterion), at: new Date(now).toISOString() }
    else if (now - dispute.requestedAt >= waitMs) dispute.resolution = { source: 'narrowest', reading: narrowestReading(dispute.term), at: new Date(now).toISOString() }
    else continue
    changed = true
  }
  return changed
}

function statusLine(dispute) {
  if (!dispute.resolution) return "awaiting the run's parent"
  return dispute.resolution.source === 'parent'
    ? `decided by the run's parent: ${dispute.resolution.reading}`
    : 'parent silent, narrowest reading applied'
}

function dodDecisionRequest({ disputes, mailbox, waitMs }) {
  const blocks = disputes.map((dispute) => [
    `## DoD ${dispute.criterion}`,
    `- Term (card, verbatim): ${dispute.term ?? '(the card text was not given to the lifecycle)'}`,
    `- Critic rounds: ${dispute.rounds.join(', ')}`,
    `- Plan's reading (its Acceptance entry): ${dispute.planReading ?? '(the plan quotes no Acceptance entry for this criterion)'}`,
    "- Critic's reading:",
    ...dispute.criticReadings.map(({ round, finding }) => `  - round ${round}: ${finding}`),
    `- Answer by: ${new Date(dispute.requestedAt + waitMs).toISOString()}`,
    `- Status: ${statusLine(dispute)}`,
  ].join('\n'))
  return [
    '# Decision request: disputed Definition-of-done term',
    '',
    "The plan and the critic have read the same Definition-of-done criterion differently in two consecutive critic rounds. The run's parent (the orchestrator, or the session that launched the run) decides the reading; the run never waits for anyone else.",
    '',
    `Answer by appending one line per criterion to the runner mailbox \`${mailbox ?? '(no mailbox configured)'}\`:`,
    '',
    '    DECISION DoD <n>: <reading>',
    '',
    'For example `DECISION DoD 1: <reading>`. The decision binds every later critic round. Without an answer by the time below, the runner applies the narrowest reading that satisfies the card\'s words, continues, and records it in the pilot report.',
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
    : `- DoD ${dispute.criterion}, parent silent, narrowest reading applied: ${dispute.resolution.reading}`)
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
export function createDodEscalation({ state, dodBullets, requestPath, planReading, writeRequest, now }, { readDecisions = null, onDecisionRequest = null, mailbox = null, waitMs = DOD_DECISION_WAIT_MS, pollMs = DOD_DECISION_POLL_MS } = {}) {
  // No decision channel, or a stop already requested, leaves nobody to wait for: resolve at once.
  const effectiveWaitMs = () => (typeof readDecisions === 'function' && !state.pendingStop ? waitMs : 0)
  const write = () => writeRequest(requestPath, dodDecisionRequest({ disputes: state.dodDisputes, mailbox, waitMs: effectiveWaitMs() }))
  function escalate() {
    const disputes = newDodDisputes({ rounds: state.priorCriticRounds, known: state.dodDisputes, dodBullets, planReading, requestedAt: now() })
    if (disputes.length === 0) return ''
    state.dodDisputes.push(...disputes)
    write()
    const criteria = disputes.map((dispute) => dispute.criterion)
    if (typeof onDecisionRequest === 'function') onDecisionRequest({ file: requestPath, criteria })
    const named = criteria.map((criterion) => `DoD ${criterion}`).join(', ')
    const minutes = Math.ceil(effectiveWaitMs() / 60_000)
    return ` (disputed Definition-of-done term escalated to the run's parent: ${named}; request .lane/${DOD_DECISION_REQUEST_FILE}; the next critic round waits up to ${minutes} min for the parent's decision, then applies the narrowest reading that satisfies the card's words)`
  }
  async function awaitDecisions() {
    while (state.dodDisputes.some((dispute) => !dispute.resolution)) {
      const decisionsText = typeof readDecisions === 'function' ? readDecisions() : ''
      if (resolveDodDisputes({ disputes: state.dodDisputes, decisionsText, now: now(), waitMs: effectiveWaitMs() })) write()
      if (state.dodDisputes.some((dispute) => !dispute.resolution)) await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  // Only a critic launch in the critic phase waits; every other lane, gate or inspection runs at once.
  async function beforeLane(args) {
    if (args?.kind === 'lane' && args.phase === 'critic' && state.phase === 'critic') await awaitDecisions()
  }
  return { escalate, beforeLane }
}
