// Owns lifecycle phases, transitions, and MCP tool registration; it must not launch work or commit reports.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'
import { splitFrontmatter } from './frontmatter.mjs'
import { independentBrief, prospectivePatch, snapshotPatch } from './lifecycle-brief.mjs'
import { createLifecycleLaunch, MAX_LANE_REPORT_BYTES, readRegularFile, regularFile, sha256, writeRegularFile } from './lifecycle-launch.mjs'
import { acceptanceSection, planShapeProblem, planTaskIds, planTasks, PLAN_SHAPE_DESCRIPTION } from './lifecycle-plan-shape.mjs'
import { archiveLifecycle, assertArchiveOutsideWorktree, completeLifecycleReport, artefactIdentitiesAtStart } from './lifecycle-report-edge.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'
import { composeRules, loadRules } from './rules-manifest.mjs'
import { cardDefinitionOfDone } from './card-definition-of-done.mjs'
import { adaptiveRoundDecision, hasPerSectionAttackAccount, reviewConvergenceDecision, verdictFromReport } from './lifecycle-review-policy.mjs'
import { detectFailedTestFramework } from './host/test-framework-detection.mjs'
import { executorFamilyForModel } from './executor-defaults.mjs'
import { bindingDecisionsSection, createDodEscalation, criticFindingAfterNoReblock, DOD_DECISION_REQUEST_FILE, normalizedTerm, planReadingOfTerm, withDisputedDodTermsSection } from './lifecycle-dod-dispute.mjs'
import { pathWithin } from './host/path-within.mjs'
import { focusedLifecycleGateHint, resolveLifecycleGates } from './lifecycle-gates.mjs'
import { snapshotSelectedTree } from './lifecycle-selection.mjs'
import { declaredChecksForPhase } from './host/repo-instructions.mjs'
import { createLifecycleEvents } from './lifecycle-events.mjs'
import { createLaneTimelineRecorder } from './lifecycle-timeline-lanes.mjs'
import { recordedWorktreeIdentity } from './host/canonical-path.mjs'

const withLeadingBreak = (text) => (text ? `\n\n${text}` : '')

export const LIFECYCLE_SERVER_NAME = 'sdk-pilot-lifecycle'
export const LIFECYCLE_MCP_KEY = LIFECYCLE_SERVER_NAME
export const AWAITING_FIDELITY_RESULT = 'accepted phase=awaiting_fidelity'
const FIXED_CRITIC_ROUNDS = 3
export const MAX_CRITIC_ROUNDS = 6
export const MAX_REVIEW_ROUNDS = null
export const lifecycleToolName = (name) => `mcp__${LIFECYCLE_MCP_KEY}__${name}`

function lifecycleRound(state, phase) {
  if (phase === 'plan' || phase === 'critic') return state.planRound + 1
  if (phase === 'review' || phase === 'refutation') return state.reviewRound + 1
  if (phase === 'tdd' && state.reviewRound > 0) return state.reviewRound
  return null
}

export const PHASES = ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'report']
// Pilot rule triggers fired on a phase transition. critic->plan fires ONLY its own trigger: the plan
// sections were delivered at discovery->plan and stay in context, and the step-back rule injected on
// a revision round was measured to make the pilot rewrite its plan instead of fixing the finding.
export const phaseTransitionTriggers = (from, next) => (from === 'critic' && next === 'plan' ? ['critic->plan'] : [`phase:${next}`])
export { PLAN_SHAPE_DESCRIPTION } from './lifecycle-plan-shape.mjs'
const LANE_PHASES = new Set(['tdd', 'critic', 'review', 'refutation'])
const ARTIFACTS = {
  plan: ['plan', 'plan.md'],
  'critic-brief': ['critic', 'critic-brief.md'],
  brief: ['tdd', 'tdd-brief.md'],
  'review-brief': ['review', 'review-brief.md'],
  'refutation-brief': ['refutation', 'refutation-brief.md'],
  'pilot-report': ['report', 'pilot-report.md'],
}
const INDEPENDENT_ROLES = new Set(['critic', 'review', 'refutation'])
const removeFile = (file) => fs.rmSync(file, { force: true })
const NO_BOARD_CONTRACT_REASON = 'route_finding refused: no board contract; relaunch with --board-contract <json file>'
const ROUTING_IMPOSSIBLE_INSTRUCTION = (reason) =>
  `routing is impossible in this run; write the partial report with "Partial: ${reason}" as its first line`

function ownedLaneRefusal(state, refusal, laneDir) {
  return state.ownedLanes.size
    ? refusal(`${state.phase}->next`, 'owned lane must finish before transition', laneDir, 'ownership')
    : null
}

function transitionEntryRefusal(state, refusal, laneDir, stoppedRefusal) {
  return ownedLaneRefusal(state, refusal, laneDir) ?? (state.stopped ? stoppedRefusal() : null)
}
// Refuses route_finding when no board contract was supplied, and ends the run at `report` from inside
// the tool call — no phase transition carries it there, so the timeline is advanced here.
function partialForMissingBoardContract({ state, timeline, root, audit, persistTimeline, now, refusal, laneDir }) {
  const owned = ownedLaneRefusal(state, refusal, laneDir)
  if (owned) return owned
  const reason = NO_BOARD_CONTRACT_REASON
  if (state.phase !== 'report' && state.phase !== 'awaiting_fidelity') {
    state.partial = { phase: state.phase, round: null, reason, findings: [] }
    state.verifySnapshot = { tree: treeSignature(root), gates: {} }
    audit()
    const transitionedAt = now()
    timeline.phases.at(-1).exited_at = transitionedAt
    timeline.phases.push({ phase: 'report', round: null, entered_at: transitionedAt, exited_at: null, transition_id: null })
    state.phase = 'report'
    persistTimeline()
  }
  return `${reason}\n${ROUTING_IMPOSSIBLE_INSTRUCTION(reason)}`
}
function acceptanceEntries(content) {
  const section = acceptanceSection(content)
  const lines = section.split(/\r?\n/)
  const entries = new Map()
  let entry = null
  const finish = () => {
    if (!entry) return
    const criterion = entry.criterion.join(' ')
    const matching = entries.get(criterion) ?? []
    matching.push(entry.details)
    entries.set(criterion, matching)
    entry = null
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    const topLevel = /^-\s+(.*?)\s*$/.exec(line)
    if (topLevel && !/^(?:Proof|Outcome):/i.test(topLevel[1])) {
      finish()
      entry = { criterion: [topLevel[1]], details: [], detail: -1 }
      continue
    }
    if (!entry) continue
    const folded = line.trim()
    const detail = folded.replace(/^-\s+/, '')
    if (!folded) continue
    if (/^(?:Proof|Outcome):/i.test(detail)) {
      entry.details.push(detail)
      entry.detail = entry.details.length - 1
    } else if (/^[ \t]+/.test(line) && entry.detail >= 0) {
      entry.details[entry.detail] += ` ${folded}`
    } else if (/^[ \t]+/.test(line)) {
      entry.criterion.push(folded)
    }
  }
  finish()
  return entries
}
function acceptanceProblem(content, dodBullets, validDetail, expectedDetail, exampleDetail) {
  const entries = acceptanceEntries(content)
  const used = new Map()
  for (const bullet of dodBullets) {
    const index = used.get(bullet) ?? 0
    const lines = entries.get(bullet)?.[index]
    if (!lines) return `expected \`- ${bullet}\` followed by ${expectedDetail}; example: \`- ${bullet}\` then ${exampleDetail}`
    used.set(bullet, index + 1)
    if (!lines.some(validDetail)) return `expected ${expectedDetail} after \`- ${bullet}\`; example: \`- ${bullet}\` then ${exampleDetail}`
  }
  return null
}
function planProof(line, root) {
  if (!/^Proof:\s*\S/i.test(line)) return false
  if (/\b(?:tasks?|tests?|e2e)\b|(?:^|[/\\])\S+\.(?:test|spec)\.[A-Za-z0-9]+/i.test(line)) return true
  return [...resolveLifecycleGates(root)].some((name) => new RegExp(`\\b${name}\\b`, 'i').test(line))
}
const planAcceptanceProblem = (content, dodBullets, root) => acceptanceProblem(
  content,
  dodBullets,
  (line) => planProof(line, root),
  '`Proof: <task, test, e2e, test file, or gate>`',
  '`Proof: tests/unit.test.ts`',
)
const reportAcceptanceProblem = (content, dodBullets) => acceptanceProblem(
  content,
  dodBullets,
  (line) => /^Outcome:\s*(?:proven(?:\s*(?:[:—–-]\s*|by\s+)?\S.*)?|not done:\s*\S.*|deferred:\s*card\s+\S+\s+[—–-]\s+\S.*)\s*$/i.test(line),
  '`Outcome: proven`, `Outcome: not done: <reason>`, or `Outcome: deferred: card <id> — <L4 reason>`',
  '`Outcome: proven by tests/unit.test.ts`',
)
function reportDeliveryClassification(content, dodBullets, routedCards) {
  const entries = acceptanceEntries(content)
  const used = new Map()
  const unmet = []
  const deferred = []
  for (const bullet of dodBullets ?? []) {
    const index = used.get(bullet) ?? 0
    const lines = entries.get(bullet)?.[index]
    used.set(bullet, index + 1)
    // A criterion the parser could not find is a schema refusal, never an unmet delivery.
    if (!lines) continue
    const outcomes = lines.filter((line) => /^Outcome:/i.test(line))
    const deferredCards = outcomes.flatMap((line) => {
      const match = /^Outcome:\s*deferred:\s*card\s+([^\s]+)/i.exec(line)
      return match && routedCards.some((card) => card.id === match[1]) ? [match[1]] : []
    })
    const delivered = outcomes.length > 0 && outcomes.every((line) =>
      /^Outcome:\s*proven(?:\s*(?:[:—–-]\s*|by\s+)?\S.*)?\s*$/i.test(line) ||
      /^Outcome:\s*deferred:/i.test(line) && deferredCards.length > 0,
    )
    if (!delivered) unmet.push(bullet)
    else for (const card of new Set(deferredCards)) deferred.push(`${bullet} (card ${card})`)
  }
  const e2e = /(?:^|\n)## E2E\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/i.exec(content)?.[1].trim() ?? ''
  if (/^e2e not run: \S[^\r\n]*$/i.test(e2e)) unmet.push(`E2E: ${e2e}`)
  return { unmet, deferred }
}
// The partial or deferred verdicts this classifier produced. They describe one report draft, so each
// report edge drops them and re-derives them from the draft it is judging: a refused draft never
// leaves a verdict the corrected draft has to carry.
const deliveryVerdicts = new WeakSet()
const deliveryVerdict = (verdict) => {
  deliveryVerdicts.add(verdict)
  return verdict
}
const isDeliveryVerdict = (verdict) => Boolean(verdict) && deliveryVerdicts.has(verdict)
function dropDeliveryVerdicts(state) {
  if (isDeliveryVerdict(state.partial)) state.partial = null
  if (isDeliveryVerdict(state.deferred)) state.deferred = null
}
function classifyReportDelivery(content, dodBullets, routedCards, state, schemaProblem) {
  // Once the report stage has staged or committed, the delivery verdict is the one that commit carries.
  if (state.report.stage !== 'idle') return
  dropDeliveryVerdicts(state)
  if (schemaProblem && !schemaProblem.startsWith('pilot-report: missing expected')) return
  const { unmet, deferred } = reportDeliveryClassification(content, dodBullets, routedCards)
  if (unmet.length > 0 && !state.partial) {
    state.partial = deliveryVerdict({ phase: 'report', round: null, reason: `delivered partially: ${unmet.length} unmet criteria`, findings: unmet })
  } else if (deferred.length > 0 && !state.deferred) {
    state.deferred = deliveryVerdict({ phase: 'report', round: null, reason: `delivery deferred: ${deferred.length} ${deferred.length === 1 ? 'criterion' : 'criteria'}`, findings: deferred })
  }
}
function deferredHeadlineProblem(content, deferred) {
  if (!deferred) return null
  const headline = `Deferred: ${deferred.findings.join('; ')}`
  return content.split(/\r?\n/)[0] === headline ? null : `pilot-report: deferred delivery, make "${headline}" the first line`
}
const NO_BOARD_CONTRACT_HEADLINE = 'Partial: route_finding refused: no board contract;'
function boardContractHeadlineProblem(lines, partialLine) {
  if (!partialLine?.startsWith(NO_BOARD_CONTRACT_HEADLINE) || lines[0] === partialLine) return null
  return `pilot-report: partial run, make "${partialLine}" the first line`
}
function partialHeadlineProblem(lines, partialLine, required) {
  if (partialLine && required && !lines.includes(partialLine)) return `pilot-report: partial run, add the line "${partialLine}"`
  if (!partialLine && lines.some((line) => line.startsWith('Partial:'))) return 'pilot-report: this run is not partial'
  return null
}
const notDeferredProblem = (lines, deferred) => (!deferred && lines[0].startsWith('Deferred:') ? 'pilot-report: this run is not deferred' : null)
// At write_artifact (atEdge false) a verdict classified on the previous draft is not required: the
// written draft is re-classified right after it is written, and again at the report edge.
function reportHeadlineProblem(content, state, atEdge) {
  const lines = content.split(/\r?\n/)
  const partialLine = state.partial ? `Partial: ${state.partial.reason}` : null
  const requiredDeferred = atEdge || !isDeliveryVerdict(state.deferred) ? state.deferred : null
  return deferredHeadlineProblem(content, requiredDeferred) ??
    notDeferredProblem(lines, state.deferred) ??
    boardContractHeadlineProblem(lines, partialLine) ??
    partialHeadlineProblem(lines, partialLine, atEdge || !isDeliveryVerdict(state.partial))
}
const frozenDelivery = (delivery) => delivery ? Object.freeze({ ...delivery, findings: Object.freeze([...delivery.findings]) }) : null
function uiOnlyE2eReason(reason) {
  if (/\b(?:tried|attempted)\b/i.test(reason)) return false
  const ui = '(?:(?:user-facing|graphical|visible|web|front-end)\\s+)?(?:uis?|guis?|user interfaces?|screens?|frontends?|front-ends?|pages?|browsers?|displays?)'
  const absent = `\\b(?:no|without(?:\\s+(?:a|an))?|lacks?(?:\\s+(?:a|an))?|has\\s+no|there\\s+is\\s+no|not\\s+(?:a|an)|absence\\s+of(?:\\s+(?:a|an))?)\\s+${ui}\\b`
  return new RegExp(absent, 'i').test(reason) || /\b(?:headless|not user-facing|nothing visual)\b/i.test(reason)
}
function deferredOutcomeProblem(content, routedCards) {
  for (const line of content.split(/\r?\n/)) {
    if (!/^\s*(?:[-*+]\s+)?(?:Outcome|Status):\s*deferred:/i.test(line)) continue
    const match = /^\s*(?:[-*+]\s+)?(?:Outcome|Status):\s*deferred:\s*card\s+([^\s]+)\s+[—–-]\s+(\S.*)\s*$/i.exec(line)
    if (!match) return 'deferred outcome must be `Outcome: deferred: card <id> — <L4 reason>`'
    if (!routedCards.some((card) => card.id === match[1])) return `deferred outcome card ${match[1]} is not in lifecycle routed_cards`
  }
  return null
}
function withRoutedCardsSection(content, cards) {
  const without = content.replace(/(?:^|\n)## Routed cards\s*\r?\n[\s\S]*?(?=\r?\n## |$)/i, '').replace(/\s*$/, '')
  if (cards.length === 0) return `${without}\n`
  const rows = cards.map((card) => `- card ${card.id} — ${card.title} — ${card.l4Reason}${card.contested ? ` — critic position: in scope; pilot position: maintains L4 (${card.l4Reason}); order-giver decides` : ''}`)
  return `${without}\n\n## Routed cards\n${rows.join('\n')}\n`
}
const routedFindingRow = (finding) => `- ${finding.text} — ${finding.location ?? 'location not supplied'} — ${finding.routeReason}`
function withFindingsToRouteSection(content, findings) {
  if (findings.length === 0) return content.endsWith('\n') ? content : `${content}\n`
  const rows = findings.map(routedFindingRow)
  // Bounded pilot reports make these section-preserving scans safe.
  // eslint-disable-next-line sonarjs/super-linear-regex
  const match = /(?:^|\n)## Findings to route\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/i.exec(content)
  // eslint-disable-next-line sonarjs/super-linear-regex
  if (!match) return `${content.replace(/\s*$/, '')}\n\n## Findings to route\n${rows.join('\n')}\n`
  const additions = rows.filter((row) => !match[1].split(/\r?\n/).includes(row))
  if (additions.length === 0) return content.endsWith('\n') ? content : `${content}\n`
  const insertAt = match.index + match[0].length
  // eslint-disable-next-line sonarjs/super-linear-regex
  return `${content.slice(0, insertAt).replace(/\s*$/, '')}\n${additions.join('\n')}\n${content.slice(insertAt).replace(/^\s*/, '')}`
}
// Every section the runner appends to a pilot report, in one place: the pilot never authors these.
function withRunnerOwnedReportSections(content, routedCards, state) {
  const routed = withFindingsToRouteSection(withRoutedCardsSection(content, routedCards), state.findingsToRoute)
  const questioned = state.partial?.question ? withQuestionForParent(routed, state.partial.question) : routed
  return withDisputedDodTermsSection(questioned, state.dodDisputes)
}
function planReadingOfDisputedTerm(laneDir, term, criterion) {
  const plan = readRegularFile(path.join(laneDir, 'plan.md')) ?? ''
  const acceptanceReading = (wanted) => {
    const entries = acceptanceEntries(plan)
    const key = [...entries.keys()].find((criterionText) => normalizedTerm(criterionText) === normalizedTerm(wanted))
    return key === undefined ? null : entries.get(key)[0]?.join(' ') || null
  }
  return planReadingOfTerm({ plan, term, criterion, acceptanceReading })
}
function withQuestionForParent(content, question) {
  // eslint-disable-next-line sonarjs/super-linear-regex
  const match = /(?:^|\n)## Question for parent\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/i.exec(content)
  // eslint-disable-next-line sonarjs/super-linear-regex
  if (!match) return `${content.replace(/\s*$/, '')}\n\n## Question for parent\n${question}\n`
  if (match[1].split(/\r?\n/).includes(question)) return content
  const insertAt = match.index + match[0].length
  // eslint-disable-next-line sonarjs/super-linear-regex
  return `${content.slice(0, insertAt).replace(/\s*$/, '')}\n${question}\n${content.slice(insertAt).replace(/^\s*/, '')}`
}
function planCoverageCitationResult(content, root) {
  const sentences = []
  let fenced = false
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced || /^\s*#/.test(line)) continue
    const prose = line.replace(/^\s*(?:[-*+] |\d+\. )/, '').trim()
    if (prose) sentences.push(...prose.split(/(?<=[.!?])\s+/))
  }

  const existingReference = /(?:\b(?:existing|current|present|already(?:[- ]implemented)?)\b[^.!?]{0,100}\b(?:tests?|locks?|guards?|behaviou?rs?|checks?|assertions?|coverage)\b|\b(?:this|these|the)\b[^.!?]{0,100}\b(?:tests?|locks?|guards?|checks?)\b)/i
  const coverageAssertion = /\b(?:proves?|covers?|verifies?|ensures?|guards?|enforces?|prevents?|demonstrates?|exercises?|confirms?|remains?|keeps?|is|are)\b/i
  const futureWork = /\b(?:will|shall|would|is going to|are going to|plans? to|planned to)\b|^(?:add|create|write|implement|update|extend)\b/i
  const claims = sentences.filter((sentence) => {
    const assertion = coverageAssertion.exec(sentence)
    if (!assertion || !existingReference.test(sentence)) return false
    const future = futureWork.exec(sentence)
    return !future || future.index > assertion.index
  })
  if (claims.length === 0) {
    return 'Coverage citation check: no existing-coverage claims detected; coverage was not verified.'
  }

  const warnings = []
  const citationPattern = /(?:^|[\s([`])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*):(\d+)(?:-(\d+))?/g
  for (const claim of claims) {
    const citations = [...claim.matchAll(citationPattern)]
    if (citations.length === 0) {
      warnings.push(`"${claim}" must carry a repo-relative \`path:line\` citation for the existing coverage it claims.`)
      continue
    }
    for (const citation of citations) {
      const citedPath = citation[1]
      const startLine = Number(citation[2])
      const endLine = Number(citation[3] ?? citation[2])
      const absolute = path.resolve(root, citedPath)
      let resolved = absolute
      try { resolved = fs.realpathSync(absolute) } catch {}
      if (!pathWithin(root, resolved)) {
        warnings.push(`"${claim}" cites \`${citedPath}:${citation[2]}\`, which is outside the worktree.`)
        continue
      }
      let citedContent
      try {
        if (!fs.statSync(absolute).isFile()) throw new Error('not a file')
        citedContent = fs.readFileSync(absolute, 'utf8')
      } catch {
        warnings.push(`"${claim}" cites \`${citedPath}:${citation[2]}\`, but \`${citedPath}\` does not exist as a file.`)
        continue
      }
      const splitLines = citedContent.split(/\r?\n/)
      const lineCount = citedContent.endsWith('\n') ? splitLines.length - 1 : splitLines.length
      if (startLine < 1 || endLine < startLine || endLine > lineCount) {
        warnings.push(`"${claim}" cites \`${citedPath}:${citation[2]}${citation[3] ? `-${citation[3]}` : ''}\`, but \`${citedPath}\` has only ${lineCount} lines.`)
      }
    }
  }
  if (warnings.length > 0) {
    return `Coverage citation check — WARN ONLY (the heuristic is not precise enough to refuse plans):\n- ${warnings.join('\n- ')}\nWhether cited text supports the claim was not verified mechanically.`
  }
  return 'Coverage citation check: citation files and line bounds exist; whether the cited text supports the claim was not verified mechanically.'
}
function changelogSkillBody(file) {
  let content
  try { content = fs.readFileSync(file, 'utf8') } catch (error) { throw new Error(`changelog skill unavailable at ${file}: ${error instanceof Error ? error.message : String(error)}`) }
  const split = splitFrontmatter(content)
  if (!split.ok) throw new Error(`changelog skill unavailable at ${file}: YAML frontmatter is missing`)
  return split.body.trim()
}
function tasksBlock(content) {
  return /(?:^|\n)## Tasks\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? null
}
function validFindingAnchors(dodBullets, planContent) {
  const criterionCount = dodBullets?.length ?? planTasks(planContent ?? '').length
  const anchors = Array.from({ length: criterionCount }, (_unused, index) => `DoD ${index + 1}`)
  for (const id of planTaskIds(planContent ?? '')) anchors.push(`plan task ${id}`)
  return anchors
}
function findingPolicyOptions(phase, state, dodBullets, laneDir, readRegularFile) {
  const priorRounds = phase === 'critic' ? state.priorCriticRounds : state.priorReviewReports
  return {
    validAnchors: validFindingAnchors(dodBullets, readRegularFile(path.join(laneDir, 'plan.md'))),
    priorFindingCount: priorRounds.reduce((total, round) => total + round.findings.length, 0),
  }
}
function briefAnchorOptions(dodBullets, laneDir, readRegularFile) {
  return {
    validAnchors: validFindingAnchors(dodBullets, readRegularFile(path.join(laneDir, 'plan.md'))),
    planDodFallback: dodBullets == null,
  }
}
function artifactRefusal(edge, missing, file) {
  return `edge refused: ${edge}; missing ${missing}: ${file}`
}
function discoveryField(block, field) {
  const prefix = `${field}:`
  const line = block.split('\n').map((candidate) => candidate.trim()).find((candidate) => candidate.startsWith(prefix))
  return line?.slice(prefix.length).trim()
}
const DISCOVERY_GROUNDING_FORMAT = `required format:
## External-source ledger
- Claim: <claim>
  Source: <source>
  Fetched content: <stored content, not a URL>
  Verdict: confirmed|refuted|undecidable
or use \`Fetched SHA-256: <64 hex characters>\`; when no claim can be recorded use \`- Outcome: refused-by-classifier: <why>\` or \`- Outcome: unreachable-source: <why>\`
Grounding route: CANCEL|REFRAME|proceed`
function discoveryGroundingProblem(content) {
  const lines = content.split(/\r?\n/)
  const heading = lines.findIndex((line) => /^## External-source ledger\s*$/.test(line))
  if (heading < 0) return 'external-source ledger headed `## External-source ledger`'
  const end = lines.findIndex((line, index) => index > heading && /^##\s+/.test(line))
  const ledger = lines.slice(heading + 1, end < 0 ? lines.length : end)
  const route = /^Grounding route:\s*(CANCEL|REFRAME|proceed)\s*$/im.exec(content)?.[1]
  if (!route) return 'grounding route `Grounding route: CANCEL|REFRAME|proceed`'

  const claimStarts = ledger.flatMap((line, index) => (/^- Claim:\s*\S/.test(line) ? [index] : []))
  const namedOutcome = ledger.some((line) => /^- Outcome:\s*(?:refused-by-classifier|unreachable-source):\s*\S/i.test(line))
  if (claimStarts.length === 0 && !namedOutcome) return 'external claim or named outcome `refused-by-classifier` or `unreachable-source`'
  for (let index = 0; index < claimStarts.length; index += 1) {
    const start = claimStarts[index]
    const nextClaim = claimStarts[index + 1] ?? ledger.length
    const nextOutcome = ledger.findIndex((line, lineIndex) => lineIndex > start && /^- Outcome:/.test(line))
    const block = ledger.slice(start, nextOutcome >= 0 && nextOutcome < nextClaim ? nextOutcome : nextClaim).join('\n')
    if (!discoveryField(block, 'Source')) return 'source beside each external claim'
    const fetchedContent = discoveryField(block, 'Fetched content')
    const fetchedDigest = /^[a-f0-9]{64}$/i.test(discoveryField(block, 'Fetched SHA-256') ?? '')
    if (!fetchedContent && !fetchedDigest) return 'fetched content or SHA-256 beside each external claim'
    if (fetchedContent && /^https?:\/\/\S+$/i.test(fetchedContent)) return 'fetched content cannot be only a URL'
    if (!new Set(['confirmed', 'refuted', 'undecidable']).has(discoveryField(block, 'Verdict')?.toLowerCase())) return 'verdict confirmed, refuted, or undecidable beside each external claim'
  }
  if (route !== 'proceed') return `grounding route ${route} does not proceed to planning`
  return null
}
function reviewFindingGroups(verdict) {
  return {
    blocking: verdict.findingDetails.filter((finding) => finding.blocks).map((finding) => finding.text),
    routed: verdict.findingDetails.filter((finding) => !finding.blocks),
  }
}
function findingsMatchReport(declared, verdict) {
  if (!declared) return true
  const dropped = verdict.droppedFindings ?? []
  const retained = declared.filter((finding) => !dropped.some((detail) => {
    const withoutMetadata = detail.raw.replace(/\[(?:anchor|location):[^\]]*\]\s*/gi, '').trim()
    return [detail.raw, detail.text, withoutMetadata, `[${detail.severity}] ${detail.text}`].includes(finding)
  }))
  if (retained.length !== verdict.findingDetails.length) return false
  return retained.every((finding, index) => {
    const detail = verdict.findingDetails[index]
    const withoutMetadata = detail.raw.replace(/\[(?:anchor|location):[^\]]*\]\s*/gi, '').trim()
    const severityText = `[${detail.severity}] ${detail.text}`
    return [detail.raw, detail.text, withoutMetadata, severityText].includes(finding)
  })
}

function routedDependencyEvidence(created) {
  if (created.dependencyVerified === true) return { dependencyVerified: true }
  return { dependencyVerified: false, dependencyVerificationReason: created.dependencyVerificationReason ?? 'board adapter supplied no dependency verification evidence' }
}

function routedDependencySuffix(record) {
  return record.dependencyVerified ? '' : ` (dependency unverified: ${record.dependencyVerificationReason})`
}

function recordReviewDecision(state, phase, verdict, blockingFindings, routedFindings) {
  for (const finding of routedFindings) {
    if (!state.findingsToRoute.some((item) => item.text === finding.text)) state.findingsToRoute.push(finding)
  }
  if (verdict.findings.length > 0) state.priorReviewReports.push({ round: state.priorReviewReports.length + 1, findings: [...verdict.findings] })
  const changesRequested = verdict.outcome === 'changes-requested' && blockingFindings.length > 0
  state.unresolvedFindings = changesRequested ? [...blockingFindings] : []
  if (changesRequested) {
    state.reviewRound += 1
  }
  state.priorReviewRounds.push({ round: state.priorReviewRounds.length + 1, findings: [...verdict.findings], blockingFindings, findingDetails: verdict.findingDetails })
  const decision = changesRequested ? reviewConvergenceDecision(state.priorReviewRounds) : null
  if (!decision || decision.continue) return { changesRequested, reason: null }
  const reason = `${phase} non-convergence: ${decision.signal}`
  state.partial = { phase, round: state.reviewRound, reason, findings: blockingFindings, question: `The ${phase} loop stopped because ${decision.signal}. The unresolved findings are: ${blockingFindings.join('; ')}. How should the run parent resolve them?` }
  return { changesRequested, reason }
}

function applyCriticEmptyPolicy(state, verdict, reportContent, root, audit) {
  const hasAccount = hasPerSectionAttackAccount(reportContent)
  if (verdict.findings.length > 0 || hasAccount) { state.criticEmptyRetries = 0; return null }
  if (state.criticEmptyRetries === 0) { state.criticEmptyRetries = 1; return { retry: true } }
  const reason = 'critic failed twice with zero findings and no per-section attack account'
  state.partial = { phase: 'critic', round: state.planRound + 1, reason, findings: [] }
  state.verifySnapshot = { tree: treeSignature(root), gates: {} }
  audit()
  return { retry: false, reason }
}

function reviewNextPhase(phase, changesRequested) {
  if (changesRequested) return 'tdd'
  return phase === 'review' ? 'refutation' : 'report'
}

function writeReviewFindings(laneDir, state, phase, verdict, writeRegularFile) {
  const rows = verdict.findingDetails.filter((finding) => phase === 'verify' || finding.blocks).map((finding) => `- ${finding.raw}${finding.log ? ' — receipt: ' + finding.log : ''}`)
  writeRegularFile(reviewFindingsFile(laneDir), `# Review findings for TDD fix round ${state.reviewRound}\n\nSource: ${phase}\n\n${rows.join('\n')}\n`)
}

function reviewFindingsFile(laneDir) {
  return path.join(laneDir, 'review-findings.md')
}

function readReviewFindings(laneDir) {
  return readRegularFile(reviewFindingsFile(laneDir)) ?? ''
}

function prepareReviewFix(laneDir, state, phase, verdict, writeRegularFile, invalidateLaneEvidence, laneBriefContexts) {
  writeReviewFindings(laneDir, state, phase, verdict, writeRegularFile)
  for (const invalidated of ['tdd', 'review', 'refutation']) {
    invalidateLaneEvidence(invalidated)
    laneBriefContexts.delete(invalidated)
  }
}

function finalizedPartial(state, phase, reason) {
  return state.partial
    ? { ...state.partial, findings: state.unresolvedFindings.length > 0 ? [...state.unresolvedFindings] : state.partial.findings, finalizationReason: reason }
    : { phase, reason, findings: [...state.unresolvedFindings] }
}

function verifyTransition({ event, state, laneDir, frozenRoute, refusal, verifyFailedSnapshot, verifySnapshot, writeRegularFile, invalidateLaneEvidence, laneBriefContexts }) {
  if (event.outcome === 'failed') {
    if (!Array.isArray(event.findings) || event.findings.length === 0 || event.findings.some((finding) => typeof finding !== 'string' || !finding.trim())) {
      return { refused: refusal('verify->tdd', 'canonical red gate markers or failing test names in findings', laneDir) }
    }
    const receipt = verifyFailedSnapshot('verify->tdd', event.findings)
    if (typeof receipt === 'string') return { refused: receipt }
    const findingDetails = receipt.findings.map((finding) => ({ ...finding, raw: finding.text, severity: 'high', anchor: 'verify', extendsPrior: null, blocks: !finding.convergenceSummary }))
    const findings = findingDetails.map((finding) => finding.text)
    const blockingFindings = findingDetails.filter((finding) => finding.blocks).map((finding) => finding.text)
    const verdict = { outcome: 'changes-requested', findings, findingDetails }
    const decision = recordReviewDecision(state, 'verify', verdict, blockingFindings, [])
    if (decision.reason) return { next: 'report', resultDetail: ` (non-convergence: partial run, ${decision.reason})` }
    prepareReviewFix(laneDir, state, 'verify', verdict, writeRegularFile, invalidateLaneEvidence, laneBriefContexts)
    return { next: 'tdd', resultDetail: '' }
  }
  if (event.outcome !== 'passed') return { refused: refusal('verify->next', 'outcome passed', laneDir) }
  const receipt = verifySnapshot('verify->next')
  return receipt ? { refused: receipt } : { next: frozenRoute === 'LITE' ? 'report' : 'review', resultDetail: '' }
}

function recordReviewWarnings(state, verdict, laneDir, writeRegularFile) {
  if (verdict.warnings.length === 0) return
  state.reviewWarnings.push(...verdict.warnings)
  writeRegularFile(path.join(laneDir, 'review-warnings.md'), `${state.reviewWarnings.map((warning) => `- ${warning}`).join('\n')}\n`)
}

function laneBriefIdentity(phase, content, artifactContent, laneDir, readRegularFile, sha256) {
  let inputs = [`${phase}-input.diff`, ...[...resolveLifecycleGates(path.dirname(laneDir))].map((name) => `${name}.log`), 'review-findings.md']
  if (phase === 'critic') inputs = ['plan.md', 'card.md', 'discovery.md']
  if (phase === 'tdd') inputs = ['plan.md', 'review-findings.md']
  return sha256(JSON.stringify([content, artifactContent, ...inputs.map((name) => readRegularFile(path.join(laneDir, name)))]))
}

function sameLaneBrief(laneBriefContexts, laneBriefIdentities, phase, identity) {
  return laneBriefContexts.has(phase) && laneBriefIdentities.get(phase) === identity
}

function initialLifecycleState() {
  return {
    phase: 'discovery', partial: null, deferred: null, pilotReportDigest: null,
    planRound: 0, priorCriticRounds: [], criticPlateauUsed: false, nonBlockingFindings: [],
    reviewRound: 0, priorReviewRounds: [], priorReviewReports: [], reviewBase: null, pendingReviewBase: null, findingsToRoute: [], reviewWarnings: [], unresolvedFindings: [], criticEmptyRetries: 0,
    handled: new Map(), laneReceiptSeq: 0, verifySnapshot: null, ownedLanes: new Map(), reportParseRetries: {},
    resolvedRoutedCards: new Set(), report: { stage: 'idle', base: null, head: null, tree: null, delivery: null },
    pendingStop: null, stopped: false, dodDisputes: [],
  }
}

// What a later phase session is primed with: copies of the lifecycle's own records, never live references.
function defineSessionAccessors(server, { sessionServer, state, timeline, route }) {
  Object.defineProperties(server, {
    sessionServer: { value: sessionServer },
    ledger: { value: () => structuredClone({ planRound: state.planRound, reviewRound: state.reviewRound, priorCriticRounds: state.priorCriticRounds, nonBlockingFindings: state.nonBlockingFindings, priorReviewRounds: state.priorReviewRounds, unresolvedFindings: state.unresolvedFindings, dodDisputes: state.dodDisputes }) },
    timeline: { value: () => structuredClone({ route, phases: timeline.phases, lanes: timeline.lanes, routed_cards: timeline.routed_cards }) },
    acceptedTransitions: { value: () => [...state.handled.values()].filter((entry) => entry.result.startsWith('accepted phase=')).map((entry) => ({ from: JSON.parse(entry.shape).phase, next: /^accepted phase=(\w+)/.exec(entry.result)[1], result: entry.result })) },
  })
}

function freezeLifecycleModels(models, executor) {
  const frozenModels = Object.freeze(models.code
    ? { critic: models.review, ...models }
    : { critic: models.review, code: models.lane, review: models.review, refutation: models.refutation ?? models.review })
  const executors = Object.freeze(Object.fromEntries(Object.entries(frozenModels).map(([role, model]) => [role, executorFamilyForModel(model) ?? executor])))
  return { frozenModels, executors }
}

function defaultTimelineWriter(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try { writeRegularFile(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file) } finally { removeFile(temporary) }
}

function createLaneDirAssertion({ laneDir, root, archiveRoot }) {
  return (archive = false) => {
    const required = [laneDir]
    if (archive) {
      if (typeof archiveRoot !== 'string' || !path.isAbsolute(archiveRoot)) throw new Error('lifecycle archiveRoot must be an absolute path')
      fs.mkdirSync(path.join(archiveRoot, '.claude', 'reports'), { recursive: true })
      required.push(archiveRoot, path.join(archiveRoot, '.claude'), path.join(archiveRoot, '.claude', 'reports'))
    }
    for (const directory of required) {
      let stat; try { stat = fs.lstatSync(directory) } catch { throw new Error(`lane directory replaced: ${directory}`) }
      const expectedRoot = directory === laneDir ? root : archiveRoot
      let resolvedDirectory; let resolvedRoot
      try { [resolvedDirectory, resolvedRoot] = [fs.realpathSync(directory), fs.realpathSync(expectedRoot)] } catch { throw new Error(`lane directory replaced: ${directory}`) }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !pathWithin(resolvedRoot, resolvedDirectory)) throw new Error(`lane directory replaced: ${directory}`)
    }
    if (archive) {
      try {
        execFileSync('git', ['check-ignore', '--no-index', '.claude/reports/archive'], { cwd: archiveRoot, stdio: 'ignore' })
      } catch {
        throw new Error('lifecycle archiveRoot .claude/reports must be git-ignored')
      }
    }
  }
}

function guardedLaneRun(state, stoppedRefusal, dodEscalation, lifecycleRun) {
  return (args) => {
    if (state.stopped) return stoppedRefusal()
    return dodEscalation.beforeLane(args).then(() => state.stopped || state.pendingStop ? stoppedRefusal() : lifecycleRun(args))
  }
}

async function holdPlanForBoundDecision(state, dodEscalation) {
  if (state.phase !== 'plan' || !state.dodDisputes.some((dispute) => !dispute.resolution)) return null
  await dodEscalation.awaitDecisions()
  return `plan revision held for bound DoD decision: ${bindingDecisionsSection(state.dodDisputes)}. Revise the plan to that binding before asking for the next critic.`
}

function snapshotWorkingTree(root, laneDir, git, baseline) {
  const index = path.join(laneDir, 'review-base.index')
  try {
    return snapshotSelectedTree(root, index, baseline, git)
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))
    throw new Error(`review snapshot failed: ${detail}`, { cause: error })
  } finally {
    removeFile(index)
    removeFile(`${index}.lock`)
  }
}

function reviewInputDiff({ phase, snapshotDir, inputPath, patchBase, constructionBase, state, root, laneDir, git, maxBuffer, baseline }) {
  if (snapshotDir) {
    const saved = readRegularFile(inputPath)
    if (saved === null) throw new Error(`${path.basename(inputPath)} unavailable`)
    return saved
  }
  if (phase === 'review' && state.reviewBase) {
    state.pendingReviewBase = snapshotWorkingTree(root, laneDir, git, baseline)
    return snapshotPatch(root, state.reviewBase, state.pendingReviewBase, git, maxBuffer)
  }
  const diff = prospectivePatch(root, patchBase ?? constructionBase, git, maxBuffer, baseline)
  if (phase === 'review') state.pendingReviewBase = snapshotWorkingTree(root, laneDir, git, baseline)
  return diff
}

function handleReportProblem({ phase, problem, report, state, refusal, root, audit, now, event, shape, timeline, persistTimeline }) {
  const owned = ownedLaneRefusal(state, refusal, path.dirname(report))
  if (owned) return owned
  const retries = state.reportParseRetries[phase] ?? 0
  if (retries === 0) {
    state.reportParseRetries[phase] = 1
    return refusal(`${phase}->next`, `failed ${phase} report: ${problem}; re-run once`, report)
  }
  const reason = `${phase} report failed twice: ${problem}`
  state.partial = { phase, round: lifecycleRound(state, phase), reason, findings: [], question: `How should the run parent resolve this repeated ${phase} report parse failure: ${problem}?` }
  state.verifySnapshot = { tree: treeSignature(root), gates: {} }
  audit()
  const result = `accepted phase=report (failed report retry: partial run, ${reason})`
  const transitionedAt = now()
  state.phase = 'report'
  state.handled.set(event.tool_use_id, { shape, result })
  const currentPhase = timeline.phases.at(-1)
  currentPhase.exited_at = transitionedAt
  currentPhase.transition_id = event.tool_use_id
  timeline.phases.push({ phase: 'report', round: null, entered_at: transitionedAt, exited_at: null, transition_id: null })
  persistTimeline()
  return result
}

function createBoundaryStop({ state, laneDir, timeline, now, writeRegularFile, sha256, persistTimeline, onBoundaryStop, refusal }) {
  const stoppedRefusal = () => `edge refused: ${state.phase}->next; ${state.partial?.reason ?? 'runner'} already stopped the lifecycle: ${laneDir}`
  const stopAtBoundary = (event) => {
    const owned = ownedLaneRefusal(state, refusal, laneDir)
    if (owned) return owned
    const reason = state.pendingStop
    const phase = state.phase
    const result = `stopped phase=${phase} reason=${reason}`
    state.partial = finalizedPartial(state, phase, reason)
    state.stopped = true
    state.handled.set(event.tool_use_id, { shape: JSON.stringify(event), result })
    const endedAt = now()
    const currentPhase = timeline.phases.at(-1)
    currentPhase.exited_at ??= endedAt
    currentPhase.transition_id ??= event.tool_use_id
    timeline.ended_at = endedAt
    const routed = state.findingsToRoute.length > 0 ? `\n## Findings to route\n${state.findingsToRoute.map(routedFindingRow).join('\n')}\n` : ''
    const unresolved = state.partial.findings.length > 0 ? `Unresolved findings: ${state.partial.findings.join('; ')}\n` : ''
    const partialReport = `# SDK pilot partial report\n\nPartial: ${state.partial.reason}\nPhase reached: ${phase}\nReason: ${state.partial.reason}\nFinalization: ${reason}\n${unresolved}${routed}`
    const report = withDisputedDodTermsSection(partialReport, state.dodDisputes)
    writeRegularFile(path.join(laneDir, 'pilot-report.md'), report)
    state.pilotReportDigest = sha256(report)
    persistTimeline()
    if (typeof onBoundaryStop === 'function') onBoundaryStop({ phase, reason })
    return result
  }
  const requestStop = (reason) => {
    if (state.stopped || state.phase === 'awaiting_fidelity') return false
    state.pendingStop ??= String(reason)
    return true
  }
  return { requestStop, stopAtBoundary, stoppedRefusal }
}

// The stream has ended, so nothing can wait for or control an owned lane any more: finalize anyway and
// name every lane still running, so the partial record never hides a lane that outlives the run.
function withOwnedLanesAtFinalization(state, partial) {
  if (!state.ownedLanes.size) return partial
  const owned = [...state.ownedLanes.values()].map((record) => ({ phase: record.phase, slot: record.slot ?? null, pid: record.pid ?? null, runId: record.runId ?? null }))
  return { ...partial, ownedLanesAtFinalization: owned }
}

function createPartialFinalizer({ state, laneDir, timeline, now, persistTimeline, audit, constructionBase, git, root, archiveRoot, cardId, frozenRoute, evidencePath, sha256, assertLaneDir, copy, writeRegularFile, readRegularFile }) {
  return (reason) => {
    if (state.phase === 'awaiting_fidelity') return JSON.parse(readRegularFile(path.join(laneDir, 'summary.json')) ?? '{}')
    state.partial = withOwnedLanesAtFinalization(state, finalizedPartial(state, state.phase, reason))
    const endedAt = now()
    timeline.phases.at(-1).exited_at ??= endedAt
    timeline.ended_at = endedAt
    persistTimeline()
    audit()
    let head = constructionBase
    try { head = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {}
    return archiveLifecycle({
      root, archiveRoot, laneDir, cardId, route: frozenRoute, head,
      phases: [...state.handled.values()].map((item) => item.result).concat(`partial: ${reason}`),
      evidence: sha256(readRegularFile(evidencePath) ?? ''), partial: state.partial,
      implementation: { name: LIFECYCLE_SERVER_NAME, version: '1.0.0' }, routedCards: timeline.routed_cards,
      assertDirectories: () => assertLaneDir(true), copy, git, sha256, writeRegularFile,
    })
  }
}


function lifecycleTransitionDefinition(tool, z, queued, transition, session) {
  return tool(
    'transition',
    'Advance the runner-owned lifecycle. Failed VERIFY findings accept canonical gate <name> EXIT=<actual exit> markers for required red gates, or exact extracted failed-test names. Run every required gate first; every red gate and available failed-test name is carried to TDD with log references. When test names cannot be extracted, use gate test EXIT=<actual exit>.',
    {
      phase: z.string(),
      route: z.string().optional(),
      record: z.string().optional(),
      outcome: z.string().optional(),
      findings: z.array(z.string()).optional(),
      tool_use_id: z.string(),
    },
    async (args) => ({ content: [{ type: 'text', text: await queued(() => transition(session > 1 && typeof args.tool_use_id === 'string' && args.tool_use_id ? { ...args, tool_use_id: `s${session}:${args.tool_use_id}` } : args)) }] }),
  )
}

function lifecycleArtifactDefinition(tool, z, queued, artifact) {
  return tool(
    'write_artifact',
    'Write a phase-bound lifecycle artifact. For a gitignored pilot-report delivery, add the exact line "- Delivered artefact: `relative/path`" under `## Implemented`; the edge confines and reads each regular file, refuses files unchanged since lifecycle creation, and records path, size, SHA-256, mtime, and `modified_after_started` in the summary and manifest. File identity bounds recency, not authorship.',
    { kind: z.string(), content: z.string() },
    async (args) => ({ content: [{ type: 'text', text: await queued(() => artifact(args)) }] }),
  )
}

function lifecycleFindingDefinition(tool, z, queued, routeFindingTool) {
  return tool(
    'route_finding',
    'Route a genuinely L4 finding to a runner-created board card.',
    {
      title: z.string().min(1),
      l4Reason: z.string().min(1),
      risk: z.enum(['P0', 'P1', 'P2']),
      effort: z.enum(['S', 'M', 'L']),
      type: z.enum(['bug', 'chore', 'feature', 'research']).optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await queued(() => routeFindingTool(args)) }] }),
  )
}

function lifecycleRunDefinition(tool, z, queued, run) {
  // The SDK factory passes this schema through to MCP; strictness rejects removed selectors.
  return tool(
    'run',
    'Run a fixed lane, gate, or inspection command.',
    z.object({
        kind: z.string(),
        phase: z.string().optional(),
        name: z.string().optional(),
        what: z.string().optional(),
        decision: z.string().optional(),
        extendSeconds: z.number().int().positive().optional(),
        timeout: z.number().int().positive().optional(),
    }).strict(),
    async (args) => ({ content: [{ type: 'text', text: await queued(() => run(args)) }] }),
  )
}

function createLifecycleSessionServer({ createSdkMcpServer, tool, z, queued, transition, artifact, routeFindingTool, run }, session) {
  return createSdkMcpServer({
    name: LIFECYCLE_SERVER_NAME,
    version: '1.0.0',
    tools: [
      lifecycleTransitionDefinition(tool, z, queued, transition, session),
      lifecycleArtifactDefinition(tool, z, queued, artifact),
      lifecycleFindingDefinition(tool, z, queued, routeFindingTool),
      lifecycleRunDefinition(tool, z, queued, run),
    ],
  })
}

function constructionCommit(root) {
  let constructionBase = 'HEAD'
  try { constructionBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  return constructionBase
}

// The piece-test stop: leaving the named phase requests the same boundary stop a timeout does.
function createPhaseStopRequest(stopAfterPhase, requestStop, state) {
  return (phase) => {
    if (stopAfterPhase === phase) requestStop(`stop-after ${phase}`)
    return Boolean(state.pendingStop)
  }
}

function phaseTransitionRules(activeRules, state, next) {
  return next === 'awaiting_fidelity'
    ? ''
    : composeRules(activeRules, {
        recipient: 'pilot',
        triggers: phaseTransitionTriggers(state.phase, next),
      })
}

function transitionRepositoryChecks(next, root, constructionBase) {
  return withLeadingBreak(declaredChecksForPhase(next, root, { commit: constructionBase, gateNames: next === 'plan' ? [...resolveLifecycleGates(root)] : [] }))
}

function lifecycleCoreOptions({
  worktree,
  archiveRoot,
  route,
  reasons = [],
  executor = 'gpt-lane',
  executorEnv = process.env,
  knowledgeBase = { path: null, checkedPath: null },
  models,
  cardId,
  sessionTag,
}) {
  return { worktree, archiveRoot, route, reasons, executor, executorEnv, knowledgeBase, models, cardId, sessionTag }
}

function lifecycleLaneOptions(worktree, {
  sdk = null,
  sdkRequire = null,
  laneLauncher = null,
  lanePollMs = 25, laneWaitMs = null,
   lanePlatform = process.platform, laneProcessReader = null,
   gateRunner = null, testFramework = detectFailedTestFramework(worktree),
}) {
  return { sdk, sdkRequire, laneLauncher, lanePollMs, laneWaitMs, lanePlatform, laneProcessReader, gateRunner, testFramework }
}

function lifecycleRepositoryOptions({
  git = execFileSync,
  copy = fs.cpSync,
  prospectivePatchMaxBuffer = 64 * 1024 * 1024,
   rules = null,
}) {
  return { git, copy, prospectivePatchMaxBuffer, rules }
}

function lifecycleReportOptions({
  cardText = null, lsp = { available: false, reason: 'not prepared' },
  now = () => Date.now(),
  timelineWriter = null,
  boardContract = null,
   routeFinding = null,
}) {
  return { cardText, lsp, now, timelineWriter, boardContract, routeFinding }
}

function lifecycleDecisionOptions({
  resolveRoutedFinding = null,
  onBoundaryStop = null,
  stopAfterPhase = null,
  dodDecisions = {},
  changelogSkillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/changelog/SKILL.md'),
}) {
  return { resolveRoutedFinding, onBoundaryStop, stopAfterPhase, dodDecisions, changelogSkillPath }
}

function lifecycleOptions(options) {
  const core = lifecycleCoreOptions(options)
  const lanes = lifecycleLaneOptions(core.worktree, options)
  return { ...core, ...lanes, ...lifecycleRepositoryOptions(options), ...lifecycleReportOptions(options), ...lifecycleDecisionOptions(options) }
}

function initializeLifecycleRoot(context) {
  const { worktree, cardId, git, cardText, rules, archiveRoot } = context
  if (!path.isAbsolute(worktree)) {
    throw new Error('lifecycle worktree must be absolute')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(String(cardId))) {
    throw new Error('lifecycle cardId must match [A-Za-z0-9._-]+')
  }
  const root = fs.realpathSync(worktree)
  // Capture pre-existing files before creating even the first lifecycle receipt or directory.
  const artefactsAtStart = artefactIdentitiesAtStart(root, git)
  const dodBullets = typeof cardText === 'string' ? cardDefinitionOfDone(cardText) : undefined
  const rawDodBullets = typeof cardText === 'string' ? cardDefinitionOfDone(cardText, { raw: true }) : undefined
  const activeRules = rules ?? loadRules({ projectRoot: root })
  const constructionBase = constructionCommit(root)
  const laneDir = path.join(root, '.lane')
  if (fs.existsSync(laneDir)) {
    const laneStat = fs.lstatSync(laneDir)
    if (!laneStat.isDirectory() || laneStat.isSymbolicLink()) {
      throw new Error('lifecycle .lane must be a real directory')
    }
  } else {
    fs.mkdirSync(laneDir, { recursive: true })
  }
  const assertLaneDir = createLaneDirAssertion({ laneDir, root, archiveRoot })
  assertLaneDir()
  // Preflight, before any phase runs: a misconfigured archive root must fail here, not after hours of work.
  assertArchiveOutsideWorktree({ root, archiveRoot })
  assertLaneDir(true)
  const routePath = path.join(laneDir, 'route.json')
  if (fs.existsSync(routePath)) {
    // The interrupted run's .lane is the ONLY evidence a crash left (no process ran the archive), so the remedy
    // moves it aside as a sibling — never deletes it — and recreates an empty .lane for the relaunch.
    const resetScript = "const fs=require('node:fs'),p=process.argv[1],k=p+'.interrupted-'+new Date().toISOString().replace(/[:.]/g,'-');fs.renameSync(p,k);fs.mkdirSync(p,{recursive:true});console.log('interrupted lifecycle kept at '+k)"
    throw new Error(`lifecycle startup refused: ${routePath} belongs to an interrupted lifecycle; keep its evidence aside and relaunch on a fresh .lane: node -e ${JSON.stringify(resetScript)} ${JSON.stringify(laneDir)}`)
  }
  Object.assign(context, { root, artefactsAtStart, dodBullets, rawDodBullets, activeRules, constructionBase, laneDir, assertLaneDir, routePath })
}

function initializeLifecycleIdentity(context) {
  const { cardText, laneDir, route, models, executor, cardId, sessionTag, sdkRequire, root, sdk, routePath,
    reasons, constructionBase, testFramework } = context
  if (typeof cardText === 'string') {
    const cardPath = path.join(laneDir, 'card.md')
    const existingCard = readRegularFile(cardPath)
    if (existingCard === null) writeRegularFile(cardPath, cardText, { flag: 'wx' })
    else if (existingCard !== cardText) throw new Error(`lifecycle card snapshot ${JSON.stringify(existingCard)} differs from runner card text ${JSON.stringify(cardText)}; remove ${cardPath} to restart the lifecycle on the new card`)
  }
  const frozenRoute = String(route)
  const { frozenModels, executors } = freezeLifecycleModels(models, executor)
  const lifecycle = Object.freeze({
    route: frozenRoute,
    executor,
    executors,
    models: frozenModels,
    cardId: String(cardId),
    sessionTag: String(sessionTag),
  })
  const require = sdkRequire ?? resolveAgentSdkRequire({ projectDir: root })
  const { createSdkMcpServer, tool } = sdk ?? require('@anthropic-ai/claude-agent-sdk')
  const { z } = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  writeRegularFile(
    routePath,
    `${JSON.stringify({ cardId, route: frozenRoute, reasons, executor, executors, models: frozenModels, base: constructionBase, testFramework }, null, 2)}\n`,
    { flag: 'wx' },
  )
  const state = initialLifecycleState()
  const events = createLifecycleEvents(state, (phase) => !state.stopped && !state.pendingStop && context.canLaunchLane(phase))
  const refusal = (edge, missing, file, code = 'other') => events.refused(artifactRefusal(edge, missing, file), code)
  Object.assign(context, { frozenRoute, frozenModels, executors, lifecycle, createSdkMcpServer, tool, z, state, events, refusal })
  initializeLifecycleTimeline(context)
}

function initializeLifecycleTimeline(context) {
  const { laneDir, now, root, lsp, timelineWriter } = context
  const timelinePath = path.join(laneDir, 'lifecycle.json')
  const lifecycleStartedAt = now()
  const timeline = { version: 2, ...recordedWorktreeIdentity(root), started_at: lifecycleStartedAt, ended_at: null, lsp, phases: [{ phase: 'discovery', round: null, entered_at: lifecycleStartedAt, exited_at: null, transition_id: null }], lanes: [], routed_cards: [] }
  const atomicTimelineWriter = timelineWriter ?? defaultTimelineWriter
  const persistTimeline = () => {
    try { atomicTimelineWriter(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`) } catch { /* Cost evidence is best-effort and cannot alter lifecycle acceptance. */ }
  }
  persistTimeline()
  const laneBriefContexts = new Map()
  const laneBriefIdentities = new Map()
  Object.assign(context, { timeline, persistTimeline, laneBriefContexts, laneBriefIdentities, serial: Promise.resolve() })
}

function prepareLifecycleLaneBrief(machine, phase, context, reportPath, snapshotDir = null) {
    const { activeRules } = machine
    const roleRules = composeRules(activeRules, { recipient: phase, trigger: `lane:${phase}` })
    if (!INDEPENDENT_ROLES.has(phase)) {
      return prepareAuthorLaneBrief(machine, phase, context, reportPath, snapshotDir, roleRules)
    }
    return prepareIndependentLaneBrief(machine, phase, context, reportPath, snapshotDir, roleRules)
}

function prepareAuthorLaneBrief(machine, phase, context, reportPath, snapshotDir, roleRules) {
       const { changelogSkillPath, state, root, laneDir } = machine
      const changelogInstructions = phase === 'tdd' ? changelogSkillBody(changelogSkillPath) : ''
      const fixInstructions = phase === 'tdd' && state.reviewRound > 0 ? `## Review fix round ${state.reviewRound} (authoritative)\n\nRead the exact runner-owned findings in \`.lane/review-findings.md\`. Fix every in-scope finding red-first; route only genuine L4 work. Run ${focusedLifecycleGateHint(root)}, and leave zero warnings in touched files. Do not run the full suite in this lane; the lifecycle runs it once in VERIFY after this fix round.\n\n${readReviewFindings(laneDir)}\n\n` : ''
      const authoritative = `${roleRules ? `## Rules that apply to this role (authoritative)\n\n${roleRules}\n\n` : ''}${fixInstructions}${changelogInstructions ? `## Changelog instructions (authoritative)\n\n${changelogInstructions}\n\n` : ''}`
      const content = `${authoritative}${authoritative ? '## Pilot instructions\n\n' : ''}${context.replace(/\s*$/, '')}\n\nWrite the report to \`${reportPath}\`.\n`
      return snapshotDir
        ? { canonical: content, launch: `${content}\nThis brief is the read-only launch snapshot at \`${snapshotDir}\`; if another lane is started after this one ends, resume from the existing worktree state and preserve the same report and receipt contract. Do not rely on other background processes surviving the lane.\n` }
        : content
}

function collectIndependentArtifacts(machine, phase, snapshotDir) {
    const { laneDir } = machine
    const artifacts = []
    const canonicalArtifacts = []
    let planDigest = null
    const snapshotFile = (name, content) => {
      const file = path.join(snapshotDir, name)
      fs.writeFileSync(file, content, { flag: 'wx', mode: 0o400 })
      return file
    }
    if (phase === 'critic') {
      const plan = readRegularFile(path.join(laneDir, 'plan.md'))
      if (plan === null) throw new Error('plan unavailable')
      canonicalArtifacts.push('.lane/plan.md')
      artifacts.push(snapshotDir ? snapshotFile('plan.md', plan) : canonicalArtifacts[0])
      const card = readRegularFile(path.join(laneDir, 'card.md'))
      if (card !== null) {
        canonicalArtifacts.push('.lane/card.md')
        artifacts.push(snapshotDir ? snapshotFile('card.md', card) : canonicalArtifacts.at(-1))
      }
      planDigest = sha256(plan)
    } else {
      collectReviewArtifacts(machine, phase, snapshotDir, snapshotFile, canonicalArtifacts, artifacts)
    }
    return { artifacts, canonicalArtifacts, planDigest, snapshotFile }
}

function collectReviewArtifacts(machine, phase, snapshotDir, snapshotFile, canonicalArtifacts, artifacts) {
       const { root, state, constructionBase, laneDir, git, prospectivePatchMaxBuffer, artefactsAtStart } = machine
      const inputName = `.lane/${phase}-input.diff`
      const inputPath = path.join(root, inputName)
      const patchBase = phase === 'review' && state.reviewBase ? state.reviewBase : constructionBase
      const diff = reviewInputDiff({ phase, snapshotDir, inputPath, patchBase, constructionBase, state, root, laneDir, git, maxBuffer: prospectivePatchMaxBuffer, baseline: artefactsAtStart.untracked })
      writeRegularFile(inputPath, diff)
      canonicalArtifacts.push(inputName)
      artifacts.push(snapshotDir ? snapshotFile(`${phase}-input.diff`, diff) : inputName)
      for (const gate of resolveLifecycleGates(root)) {
        const gateName = `${gate}.log`
        const gateContent = readRegularFile(path.join(laneDir, gateName))
        if (snapshotDir && gateContent === null) throw new Error(`${gateName} unavailable`)
        canonicalArtifacts.push(`.lane/${gateName}`)
        artifacts.push(snapshotDir ? snapshotFile(gateName, gateContent) : `.lane/${gateName}`)
      }
}

function knowledgeBaseBriefLine(knowledgeBase, executors, phase) {
    return knowledgeBase.path
      ? executors[phase] === 'claude-sdk'
        ? `KNOWLEDGE_BASE_INDEX: ${knowledgeBase.path}`
        : `KNOWLEDGE_BASE_INDEX: ${knowledgeBase.path} (outside the OpenCode working directory: read it with your read tool; if the read is refused, say so in your report and do not rely on the knowledge base)`
      : `KNOWLEDGE_BASE_INDEX: none${knowledgeBase.checkedPath ? ` (no index exists at ${knowledgeBase.checkedPath})` : ''}`
}

function prepareIndependentLaneBrief(machine, phase, context, reportPath, snapshotDir, roleRules) {
    const { laneDir, knowledgeBase, executors } = machine
    const { artifacts, canonicalArtifacts, planDigest, snapshotFile } = collectIndependentArtifacts(machine, phase, snapshotDir)
    const discovery = phase === 'critic' ? readRegularFile(path.join(laneDir, 'discovery.md')) : null
    if (phase === 'critic' && discovery === null) throw new Error('discovery record unavailable')
    if (phase === 'critic') {
      canonicalArtifacts.push('.lane/discovery.md')
      artifacts.push(snapshotDir ? snapshotFile('discovery.md', discovery) : canonicalArtifacts.at(-1))
    }
    const knowledgeBaseLine = knowledgeBaseBriefLine(knowledgeBase, executors, phase)
    const options = independentLaneOptions(machine, phase, { phase, context, reportPath, discovery, planDigest }, roleRules, knowledgeBaseLine)
    return snapshotDir
      ? {
          canonical: independentBrief({ ...options, artifacts: canonicalArtifacts }),
          launch: independentBrief({ ...options, artifacts, snapshotDir }),
        }
      : independentBrief({ ...options, artifacts })
}

function independentLaneOptions(machine, phase, fields, roleRules, knowledgeBaseLine) {
    const { state, constructionBase, dodBullets, laneDir } = machine
    const priorRounds = phase === 'critic' ? state.priorCriticRounds : state.priorReviewReports
    const briefBase = phase === 'review' && state.priorReviewReports.length > 0 && state.reviewBase ? state.reviewBase : constructionBase
    return { ...fields, constructionBase: phase === 'critic' ? null : briefBase, priorRounds, rules: roleRules, knowledgeBaseLine, bindingDecisions: phase === 'critic' ? bindingDecisionsSection(state.dodDisputes) : '', ...briefAnchorOptions(dodBullets, laneDir, readRegularFile) }
}

function initializeLifecycleLaunch(context) {
  const { root, laneDir, executor, executorEnv, knowledgeBase, constructionBase, frozenModels, state,
    laneBriefContexts, laneBriefIdentities, prepareLaneBrief, assertLaneDir, refusal, laneLauncher, lanePollMs,
    laneWaitMs, lanePlatform, laneProcessReader, gateRunner, testFramework, now, events, timeline, persistTimeline } = context
  const launch = createLifecycleLaunch({
    root,
    laneDir,
    executor,
    executorEnv,
    knowledgeBaseIndex: knowledgeBase.path,
    constructionBase,
    frozenModels,
    state,
    laneBriefContexts, laneBriefIdentities,
    prepareLaneBrief,
    assertLaneDir,
    refusal,
    lanePhases: LANE_PHASES,
    phases: PHASES,
    gates: () => resolveLifecycleGates(root),
    laneLauncher,
    lanePollMs,
    laneWaitMs,
    lanePlatform,
    laneProcessReader,
    gateRunner, testFramework,
    now,
    progress: events.progress,
    ...createLaneTimelineRecorder({ timeline, round: (phase) => lifecycleRound(state, phase), persistTimeline }),
  })
  const { run: lifecycleRun, ...evidence } = launch
  Object.assign(context, evidence, { lifecycleRun })
}

function initializeLifecycleControls(context) {
  const { state, laneDir, timeline, now, persistTimeline, onBoundaryStop, refusal, rawDodBullets, dodBullets,
    dodDecisions, lifecycleRun, audit, constructionBase, git, root, archiveRoot, cardId, frozenRoute, evidencePath,
    assertLaneDir, copy, stopAfterPhase } = context
  const { requestStop, stopAtBoundary, stoppedRefusal } = createBoundaryStop({ state, laneDir, timeline, now, writeRegularFile, sha256, persistTimeline, onBoundaryStop, refusal })
  const dodEscalation = createDodEscalation({ state, dodBullets: rawDodBullets, requestPath: path.join(laneDir, DOD_DECISION_REQUEST_FILE), planReading: (term, criterion) => planReadingOfDisputedTerm(laneDir, dodBullets?.[criterion - 1] ?? term, criterion), writeRequest: writeRegularFile, now }, dodDecisions)
  const run = guardedLaneRun(state, stoppedRefusal, dodEscalation, lifecycleRun)
  const finalizePartial = createPartialFinalizer({ state, laneDir, timeline, now, persistTimeline, audit, constructionBase, git, root, archiveRoot, cardId, frozenRoute, evidencePath, sha256, assertLaneDir, copy, writeRegularFile, readRegularFile })
  const stopRequestedAt = createPhaseStopRequest(stopAfterPhase, requestStop, state)
  Object.assign(context, { requestStop, stopAtBoundary, stoppedRefusal, dodEscalation, run, finalizePartial, stopRequestedAt })
}

function lifecycleTransition(context, event) {
    const entry = lifecycleTransitionEntry(context, event)
    if (entry !== null) return entry
    const { state, refusal, laneDir, persistTimeline, stopAtBoundary } = context
    const shape = JSON.stringify(event)
    const previous = state.handled.get(event.tool_use_id)
    if (previous) {
      if (previous.shape === shape) persistTimeline()
      return previous.shape === shape ? previous.result : refusal(`${state.phase}->next`, 'unique tool_use_id', laneDir)
    }
    if (event.phase !== state.phase) {
      return refusal(`${state.phase}->next`, `current phase ${state.phase}`, laneDir)
    }
    if (state.pendingStop && state.phase === 'report') return stopAtBoundary(event)
    const outcome = lifecyclePhaseTransition(context, event, shape)
    if (typeof outcome === 'string') return outcome
    return acceptLifecycleTransition(context, event, shape, outcome.next, outcome.resultDetail)
}

function lifecycleTransitionEntry(context, event) {
    const { state, refusal, laneDir, stoppedRefusal, assertLaneDir } = context
    const entry = transitionEntryRefusal(state, refusal, laneDir, stoppedRefusal); if (entry) return entry
    try { assertLaneDir(state.phase === 'report' || state.report.stage === 'committed') } catch (error) { return refusal(`${state.phase}->next`, error.message, laneDir) }
    if (!event || typeof event !== 'object' || !PHASES.includes(event.phase)) {
      return refusal('unknown->next', 'valid phase', laneDir)
    }
    if (!event.tool_use_id) {
      return refusal(`${state.phase}->next`, 'tool_use_id', laneDir)
    }
    return null
}

function lifecyclePhaseTransition(context, event, shape) {
    const { state } = context
    if (state.phase === 'discovery') return discoveryTransition(context, event)
    if (state.phase === 'plan') return planTransition(context)
    if (state.phase === 'critic') return criticTransition(context, event, shape)
    if (state.phase === 'tdd') return tddTransition(context)
    if (state.phase === 'verify') return lifecycleVerifyTransition(context, event)
    if (state.phase === 'review' || state.phase === 'refutation') return lifecycleReviewTransition(context, event, shape)
    if (state.phase === 'report') return lifecycleReportTransition(context)
    return { next: null, resultDetail: '' }
}

function discoveryTransition(context, event) {
    const { frozenRoute, reasons, laneDir, refusal } = context
    let next
    const resultDetail = ''
      if (event.route && event.route !== frozenRoute) {
        return refusal(
          'discovery->next',
          `runner route ${frozenRoute} (${reasons.join(', ')})`,
          path.join(laneDir, 'route.json'),
        )
      }
      if (typeof event.record !== 'string' || !event.record.trim()) {
        return refusal('discovery->next', 'non-empty discovery record', path.join(laneDir, 'discovery.md'))
      }
      const groundingProblem = discoveryGroundingProblem(event.record)
      if (groundingProblem) return refusal('discovery->next', `${groundingProblem}; ${DISCOVERY_GROUNDING_FORMAT}`, path.join(laneDir, 'discovery.md'))
      writeRegularFile(path.join(laneDir, 'discovery.md'), event.record)
      next = frozenRoute === 'LITE' ? 'tdd' : 'plan'
    return { next, resultDetail }
}

function planTransition(context) {
    const { state, laneDir, dodBullets, timeline, refusal, root } = context
    let next
    let resultDetail
      const plan = path.join(laneDir, 'plan.md')
      if (state.dodDisputes.some((dispute) => !dispute.resolution)) return refusal('plan->critic', 'bound DoD decision before revising the plan', plan)
      const planContent = readRegularFile(plan)
      const shapeProblem = planShapeProblem(planContent ?? '', dodBullets !== undefined)
      if (shapeProblem) return refusal('plan->critic', `valid plan artifact: ${shapeProblem} A valid plan artifact matching ${PLAN_SHAPE_DESCRIPTION}`, plan)
      const deferredProblem = deferredOutcomeProblem(planContent, timeline.routed_cards)
      if (deferredProblem) return refusal('plan->critic', deferredProblem, plan)
      if (dodBullets !== undefined) {
        const acceptanceProblem = planAcceptanceProblem(planContent, dodBullets, root)
        if (acceptanceProblem) return refusal('plan->critic', acceptanceProblem, plan)
      }
      resultDetail = `\n\n${planCoverageCitationResult(planContent, root)}`
      next = 'critic'
    return { next, resultDetail }
}

function criticTransition(context, event, shape) {
    const { timeline, persistTimeline, laneEvidence } = context
    const parsed = criticTransitionReport(context, event, shape)
    if (typeof parsed === 'string') return parsed
    const { report, reportContent, verdict } = parsed
    const contests = criticContests(context, verdict, report)
    if (typeof contests === 'string') return contests
    const { contestedThisRound, repeatedContests, effectiveFindingDetails } = contests
    const allNonBlocking = verdict.outcome === 'changes-requested' && effectiveFindingDetails.every((finding) => !finding.blocks)
    const receipt = laneEvidence('critic', verdict.outcome === 'changes-requested' && !allNonBlocking)
    if (receipt) return receipt
    const emptyDecision = criticEmptyTransition(context, verdict, reportContent, report)
    if (typeof emptyDecision === 'string') return emptyDecision
    const { next, resultDetail } = emptyDecision
    recordNonBlockingCriticFindings(context, verdict)
    const decision = decideCriticTransition(context, verdict, reportContent, allNonBlocking, repeatedContests, { next, resultDetail })
    if (typeof decision === 'string') return decision
    if (contestedThisRound.size > 0) {
      for (const id of contestedThisRound) timeline.routed_cards.find((card) => card.id === id).contested = true
      persistTimeline()
    }
    return decision
}

function criticEmptyTransition(context, verdict, reportContent, report) {
  const { state, root, audit, refusal } = context
  const emptyCritic = applyCriticEmptyPolicy(state, verdict, reportContent, root, audit)
  if (emptyCritic?.retry) return refusal('critic->next', 'failed critic round: zero findings without a per-section attack account; re-run once', report)
  let next = null
  let resultDetail = ''
  if (emptyCritic?.reason) {
    next = 'report'
    resultDetail = ` (failed critic retry: partial run, ${emptyCritic.reason})`
  }
  return { next, resultDetail }
}

function criticTransitionReport(context, event, shape) {
       const { laneDir, dodBullets, state, refusal, root, audit, now, timeline, persistTimeline } = context
      const report = path.join(laneDir, 'critic-report.md')
      if ((regularFile(report)?.size ?? 0) > MAX_LANE_REPORT_BYTES) {
        return refusal('critic->next', `lane report exceeds ${MAX_LANE_REPORT_BYTES}-byte limit`, report)
      }
      const reportContent = readRegularFile(report) ?? ''
      const verdict = verdictFromReport('critic', reportContent, findingPolicyOptions('critic', state, dodBullets, laneDir, readRegularFile))
      if (!verdict) return refusal('critic->next', 'VERDICT block', report)
      if (verdict.problem) return handleReportProblem({ phase: 'critic', problem: verdict.problem, report, state, refusal, root, audit, now, event, shape, timeline, persistTimeline })
      state.reportParseRetries.critic = 0
      if (event.outcome && event.outcome !== verdict.outcome) {
        return refusal('critic->next', 'outcome does not match the lane report', report)
      }
      if (!findingsMatchReport(event.findings, verdict)) {
        return refusal('critic->next', 'findings do not match the lane report', report)
      }
      return { report, reportContent, verdict }
}

function criticContests(context, verdict, report) {
       const { timeline, refusal, state, dodBullets, dodDecisions, laneDir, laneBriefContexts } = context
      const contestedThisRound = new Set()
      const repeatedContests = new Set()
      for (const finding of verdict.findings) {
        const id = /\bCONTEST\s+routed\s+card\s+([A-Za-z0-9._-]+)\b/i.exec(finding)?.[1]
        if (!id) continue
        const routed = timeline.routed_cards.find((card) => card.id === id)
        if (!routed) return refusal('critic->next', `contest names routed card ${id}`, report)
        if (routed.contested) repeatedContests.add(id)
        else contestedThisRound.add(id)
      }
      const effectiveFindingDetails = verdict.findingDetails.filter((_finding, index) => {
        const id = /\bCONTEST\s+routed\s+card\s+([A-Za-z0-9._-]+)\b/i.exec(verdict.findings[index])?.[1]
        if (id && repeatedContests.has(id)) return false
        criticFindingAfterNoReblock(verdict.findingDetails[index], state, dodBullets, dodDecisions.log, readRegularFile(path.join(laneDir, 'plan.md')))
        return true
      })
      if (repeatedContests.size > 0 && !/(?:^|\s)(?:\.?\.?[/\\])?[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)*:\d+(?:-\d+)?\b/.test(laneBriefContexts.get('critic') ?? '')) {
        return refusal('critic->next', 'pilot citation supporting maintained L4 reason', path.join(laneDir, 'critic-brief.md'))
      }
       return { contestedThisRound, repeatedContests, effectiveFindingDetails }
}

function recordNonBlockingCriticFindings(context, verdict) {
       const { state, laneDir } = context
      const newNonBlockingFindings = verdict.findings.filter((_finding, index) => !verdict.findingDetails[index].blocks)
      for (const finding of newNonBlockingFindings) {
        if (!state.nonBlockingFindings.includes(finding)) state.nonBlockingFindings.push(finding)
      }
      if (newNonBlockingFindings.length > 0) {
        writeRegularFile(
          path.join(laneDir, 'plan-non-blocking-findings.md'),
          `## Non-blocking critic findings (runner-owned, trusted)\n${state.nonBlockingFindings.map((finding) => `- ${finding}`).join('\n')}\n`,
        )
      }
}

function decideCriticTransition(context, verdict, reportContent, allNonBlocking, repeatedContests, decision) {
       let { next, resultDetail } = decision
       const { laneDir, refusal, state } = context
      if (!next && (verdict.outcome === 'approved' || allNonBlocking)) {
        const digest = sha256(readRegularFile(path.join(laneDir, 'plan.md')) ?? '')
        if (!reportContent.includes(digest)) {
          return refusal('critic->tdd', 'plan sha256', path.join(laneDir, 'critic-report.md'))
        }
        state.priorCriticRounds.push({ round: state.priorCriticRounds.length + 1, findings: [...verdict.findings], blockingFindings: [], findingDetails: verdict.findingDetails })
        next = 'tdd'
      } else if (!next && verdict.outcome === 'changes-requested') {
         return changedCriticTransition(context, verdict, repeatedContests)
       } else if (!next) {
         return refusal('critic->next', 'admissible outcome', path.join(laneDir, 'critic-report.md'))
       }
       return { next, resultDetail }
}

function changedCriticTransition(context, verdict, repeatedContests) {
        const blockingFindings = verdict.findings.filter((finding, index) => {
          const id = /\bCONTEST\s+routed\s+card\s+([A-Za-z0-9._-]+)\b/i.exec(finding)?.[1]
          return (!id || !repeatedContests.has(id)) && verdict.findingDetails[index].blocks
        })
        const findingDetails = verdict.findingDetails.filter((_finding, index) => blockingFindings.includes(verdict.findings[index]))
        return advanceCriticRound(context, verdict, blockingFindings, findingDetails)
}

function advanceCriticRound(context, verdict, blockingFindings, findingDetails) {
         const { state, dodEscalation, root, audit } = context
         let next
         let resultDetail
        const priorCriticRounds = structuredClone(state.priorCriticRounds)
        const priorPlanRound = state.planRound
        const priorPlateauUsed = state.criticPlateauUsed
        try {
          state.priorCriticRounds.push({ round: state.priorCriticRounds.length + 1, findings: [...verdict.findings], blockingFindings, findingDetails })
          state.planRound += 1
          const decision = adaptiveRoundDecision(state.priorCriticRounds, FIXED_CRITIC_ROUNDS, MAX_CRITIC_ROUNDS, state.criticPlateauUsed)
          state.criticPlateauUsed = decision.plateauUsed
          if (decision.continue) { next = 'plan'; resultDetail = dodEscalation.escalate() }
          else {
            const reason = `plan not approved after ${state.planRound} critic rounds`
            state.partial = { phase: 'critic', round: state.planRound, reason, findings: verdict.findings }
            state.verifySnapshot = { tree: treeSignature(root), gates: {} }
            audit()
            next = 'report'
            resultDetail = ` (round bound reached: partial run, ${reason})`
          }
        } catch (error) {
          state.priorCriticRounds = priorCriticRounds
          state.planRound = priorPlanRound
          state.criticPlateauUsed = priorPlateauUsed
          throw error
        }
         return { next, resultDetail }
}

function tddTransition(context) {
    const { state, laneEvidence, frozenRoute, laneDir, refusal } = context
    let next
    const resultDetail = ''
      const receipt = laneEvidence(state.phase)
      if (receipt) return receipt
      if (state.reviewRound === 0 && frozenRoute === 'FULL') {
        const planTasks = tasksBlock(readRegularFile(path.join(laneDir, 'plan.md')))
        const briefTasks = tasksBlock(readRegularFile(path.join(laneDir, 'tdd-brief.md')))
        if (!planTasks || planTasks !== briefTasks) {
          return refusal('tdd->verify', 'byte-identical plan Tasks block', path.join(laneDir, 'tdd-brief.md'))
        }
      }
      next = 'verify'
    return { next, resultDetail }
}

function lifecycleVerifyTransition(context, event) {
    const { state, laneDir, frozenRoute, refusal, verifyFailedSnapshot, verifySnapshot,
      invalidateLaneEvidence, laneBriefContexts } = context
       const verification = verifyTransition({ event, state, laneDir, frozenRoute, refusal, verifyFailedSnapshot, verifySnapshot, writeRegularFile, invalidateLaneEvidence, laneBriefContexts })
       if (verification.refused) return verification.refused
       return { next: verification.next, resultDetail: verification.resultDetail }
}

function lifecycleReviewTransition(context, event, shape) {
    const { state, laneDir, laneEvidence, invalidateLaneEvidence, laneBriefContexts } = context
    let next = null
    let resultDetail = ''
    const verdict = reviewTransitionReport(context, event, shape)
    if (typeof verdict === 'string') return verdict
    const { blocking: blockingFindings, routed: routedFindings } = reviewFindingGroups(verdict)
    const receipt = laneEvidence(state.phase, verdict.outcome === 'changes-requested' && blockingFindings.length > 0)
    if (receipt) return receipt
    recordReviewWarnings(state, verdict, laneDir, writeRegularFile)
    if (state.phase === 'review' && state.pendingReviewBase) state.reviewBase = state.pendingReviewBase
    const reviewDecision = recordReviewDecision(state, state.phase, verdict, blockingFindings, routedFindings)
    if (reviewDecision.reason) {
      next = 'report'
      resultDetail = ` (non-convergence: partial run, ${reviewDecision.reason})`
    }
    if (reviewDecision.changesRequested && !reviewDecision.reason) prepareReviewFix(laneDir, state, state.phase, verdict, writeRegularFile, invalidateLaneEvidence, laneBriefContexts)
    if (!next) next = reviewNextPhase(state.phase, reviewDecision.changesRequested)
    return { next, resultDetail }
}

function reviewTransitionReport(context, event, shape) {
       const { state, laneDir, dodBullets, refusal, root, audit, now, timeline, persistTimeline } = context
      const report = path.join(laneDir, `${state.phase}-report.md`)
      if ((regularFile(report)?.size ?? 0) > MAX_LANE_REPORT_BYTES) {
        return refusal(`${state.phase}->next`, `lane report exceeds ${MAX_LANE_REPORT_BYTES}-byte limit`, report)
      }
      const verdict = verdictFromReport(state.phase, readRegularFile(report) ?? '', findingPolicyOptions(state.phase, state, dodBullets, laneDir, readRegularFile))
      if (!verdict) return refusal(`${state.phase}->next`, 'VERDICT block', report)
      if (verdict.problem) return handleReportProblem({ phase: state.phase, problem: verdict.problem, report, state, refusal, root, audit, now, event, shape, timeline, persistTimeline })
      state.reportParseRetries[state.phase] = 0
      if (event.outcome && event.outcome !== verdict.outcome) {
        return refusal(`${state.phase}->next`, 'outcome does not match the lane report', report)
      }
      if (!findingsMatchReport(event.findings, verdict)) {
        return refusal(`${state.phase}->next`, 'findings do not match the lane report', report)
      }
       return verdict
}

function lifecycleReportTransition(context) {
    const { state, laneDir, refusal, dodBullets, timeline, snapshotEvidence, pilotReportProblem, reportProblemWithHeadline } = context
      const pilotReportPath = path.join(laneDir, 'pilot-report.md')
      const pilotReport = readRegularFile(pilotReportPath)
      if (!pilotReport) {
        return refusal('report->awaiting_fidelity', 'pilot report', pilotReportPath)
      }
      if (!state.pilotReportDigest) {
        return refusal('report->awaiting_fidelity', 'pilot report registered this run (write it with write_artifact)', pilotReportPath)
      }
      if (sha256(pilotReport) !== state.pilotReportDigest) {
        return refusal('report->awaiting_fidelity', 'pilot report unchanged since write_artifact', pilotReportPath)
      }
      // Classify the draft before judging its headline, so the verdict always belongs to these bytes.
      const schemaProblem = pilotReportProblem(pilotReport, true)
      classifyReportDelivery(pilotReport, dodBullets, timeline.routed_cards, state, schemaProblem)
      const reportProblem = schemaProblem ?? reportProblemWithHeadline(pilotReport, true)
      if (reportProblem) return refusal('report->awaiting_fidelity', reportProblem, pilotReportPath)
      const receipt = snapshotEvidence('report->awaiting_fidelity')
      if (receipt) return receipt
      const reportReceipt = completeLifecycleTransitionReport(context)
      if (reportReceipt) return reportReceipt
      return { next: 'awaiting_fidelity', resultDetail: '' }
}

function completeLifecycleTransitionReport(context) {
    const { root, archiveRoot, laneDir, cardId, sessionTag, artefactsAtStart, frozenRoute, state,
      evidencePath, timeline, assertLaneDir, copy, git, refusal } = context
       return completeLifecycleReport({
        root,
        archiveRoot,
        laneDir,
        cardId,
        sessionTag,
        artefactsAtStart,
        route: frozenRoute,
        state,
        evidencePath,
        phases: [...state.handled.values()].map((item) => item.result).concat(AWAITING_FIDELITY_RESULT),
        implementation: { name: LIFECYCLE_SERVER_NAME, version: '1.0.0' },
        routedCards: timeline.routed_cards,
        assertDirectories: () => assertLaneDir(true),
        copy,
        git,
        sha256,
        readRegularFile,
        writeRegularFile,
        refusal,
      })
}

function acceptLifecycleTransition(context, event, shape, next, resultDetail) {
    const { state, refusal, laneDir, stopRequestedAt, stopAtBoundary, activeRules, root, constructionBase,
      now, timeline, persistTimeline } = context
    if (!next) return refusal(`${state.phase}->next`, 'outcome', laneDir)
    if (stopRequestedAt(state.phase)) return stopAtBoundary(event)
    const phaseRules = phaseTransitionRules(activeRules, state, next)
    const result = next === 'awaiting_fidelity'
      ? AWAITING_FIDELITY_RESULT
      : `accepted phase=${next}${resultDetail}${phaseRules ? `\n\n## Rules for phase ${next} (authoritative)\n\n${phaseRules}` : ''}${transitionRepositoryChecks(next, root, constructionBase)}`
    const transitionedAt = now()
    state.phase = next
    state.handled.set(event.tool_use_id, { shape, result })
    const currentPhase = timeline.phases.at(-1)
    if (currentPhase?.transition_id !== event.tool_use_id) {
      currentPhase.exited_at = transitionedAt
      currentPhase.transition_id = event.tool_use_id
      if (next !== 'awaiting_fidelity') timeline.phases.push({ phase: next, round: lifecycleRound(state, next), entered_at: transitionedAt, exited_at: null, transition_id: null })
      else timeline.ended_at = transitionedAt
    }
    persistTimeline()
    return result
}

async function lifecycleArtifact(context, { kind, content }) {
    const { state, stoppedRefusal, dodEscalation, reportProblemWithHeadline, resolveRoutedFinding, timeline } = context
    if (state.stopped) return stoppedRefusal()
    if (kind === 'plan') {
      const held = await holdPlanForBoundDecision(state, dodEscalation)
      if (held) return held
    }
    const checked = lifecycleArtifactSpec(context, kind, content)
    if (typeof checked === 'string') return checked
    const spec = checked
    if (kind === 'pilot-report') {
      const problem = reportProblemWithHeadline(content)
      if (problem) return problem
      if (typeof resolveRoutedFinding === 'function') {
        for (const card of contestedReportCards(timeline, content)) {
          if (!state.resolvedRoutedCards.has(card.id)) {
            await resolveRoutedFinding(card)
            state.resolvedRoutedCards.add(card.id)
          }
        }
      }
      content = withRunnerOwnedReportSections(content, timeline.routed_cards, state)
    }
    return writeLifecycleArtifact(context, kind, content, spec)
}

function lifecycleArtifactSpec(context, kind, content) {
    const { assertLaneDir, state, laneDir } = context
    try { assertLaneDir() } catch (error) { return artifactRefusal(`${state.phase}->next`, error.message, laneDir) }
    const spec = ARTIFACTS[kind]
    if (!spec) {
      return artifactRefusal(`${state.phase}->next`, 'known artifact kind', laneDir)
    }
    if (state.phase !== spec[0]) {
      return artifactRefusal(`${state.phase}->next`, `${kind} in phase ${state.phase}: write it in phase ${spec[0]}`, path.join(laneDir, spec[1]))
    }
    if (kind === 'critic-brief' && !readRegularFile(path.join(laneDir, 'plan.md'))) {
      return artifactRefusal('critic->next', 'plan artifact', path.join(laneDir, 'plan.md'))
    }
    return lifecycleBriefSpec(context, kind, content, spec)
}

function lifecycleBriefSpec(context, kind, content, spec) {
    const { frozenRoute, state, laneDir } = context
    if (kind === 'brief' && frozenRoute === 'FULL' && state.reviewRound === 0) {
      const planTasks = tasksBlock(readRegularFile(path.join(laneDir, 'plan.md')))
      if (!planTasks || tasksBlock(content) !== planTasks) {
        return artifactRefusal('critic->tdd', 'byte-identical plan Tasks block', path.join(laneDir, spec[1]))
      }
    }
    return spec
}

function contestedReportCards(timeline, content) {
    return timeline.routed_cards.filter((item) => item.contested && !new RegExp(`Outcome:\\s*deferred:\\s*card\\s+${item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(content))
}

function writeLifecycleArtifact(context, kind, content, spec) {
    const { state, prepareLaneBrief, laneDir, laneBriefContexts, laneBriefIdentities, invalidateLaneEvidence,
      dodBullets, timeline, pilotReportProblem } = context
    const briefPhase = kind === 'brief' ? 'tdd' : kind.replace('-brief', '')
    let laneContext = content
    if (kind === 'brief' && state.nonBlockingFindings.length > 0) {
      laneContext = `${content.replace(/\s*$/, '')}\n\n## Non-blocking critic findings (runner-owned, trusted)\n${state.nonBlockingFindings.map((finding) => `- ${finding}`).join('\n')}\n`
    }
    let artifactContent = laneContext
    if (LANE_PHASES.has(briefPhase)) {
      try {
        artifactContent = prepareLaneBrief(briefPhase, laneContext, `.lane/${briefPhase}-report.<launch-nonce>.md`)
      } catch (error) {
        fs.rmSync(path.join(laneDir, `${briefPhase}-input.diff`), { force: true })
        fs.rmSync(path.join(laneDir, spec[1]), { force: true })
        return `review input unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
      const identity = laneBriefIdentity(briefPhase, laneContext, artifactContent, laneDir, readRegularFile, sha256)
      if (sameLaneBrief(laneBriefContexts, laneBriefIdentities, briefPhase, identity)) return `wrote ${kind}`
      laneBriefContexts.delete(briefPhase)
      laneBriefIdentities.set(briefPhase, identity)
    }
    writeRegularFile(
      path.join(laneDir, spec[1]),
      artifactContent,
    )
    if (LANE_PHASES.has(briefPhase)) { invalidateLaneEvidence(briefPhase); laneBriefContexts.set(briefPhase, laneContext) }
    if (kind === 'pilot-report') { state.pilotReportDigest = sha256(artifactContent); classifyReportDelivery(artifactContent, dodBullets, timeline.routed_cards, state, pilotReportProblem(artifactContent, true)) }
    return `wrote ${kind}`
}
  // The pilot report's partial/full contract, checked on the exact bytes given: at write_artifact
  // and again at the report edge on the file about to be committed (Sol round 14: a stale or
  // edited pilot-report.md used to satisfy the edge by merely existing).
function lifecycleReportProblemWithHeadline(context, content, enforceSchema = false) {
    return reportHeadlineProblem(content, context.state, enforceSchema) ?? context.pilotReportProblem(content, enforceSchema)
}
  // Content and schema checks; the headline checks live in reportHeadlineProblem.
function lifecyclePilotReportProblem(context, content, enforceSchema = false) {
    const { timeline, dodBullets, frozenRoute } = context
    const deferredProblem = deferredOutcomeProblem(content, timeline.routed_cards)
    if (deferredProblem) return `pilot-report: ${deferredProblem}`
    if (!enforceSchema) return null
    if (dodBullets !== undefined) {
      const acceptanceProblem = reportAcceptanceProblem(content, dodBullets)
      if (acceptanceProblem) return `pilot-report: missing ${acceptanceProblem}`
    }
    const e2eProblem = pilotReportE2eProblem(content)
    if (e2eProblem) return e2eProblem
    return pilotReportReviewProblem(content, frozenRoute)
}

function pilotReportE2eProblem(content) {
    const e2e = reportSection(content, 'E2E')
    if (!e2e) return 'pilot-report: missing or empty ## E2E section'
    const e2eNotRun = /^e2e not run: \S[^\r\n]*$/i.test(e2e)
    if (e2eNotRun && uiOnlyE2eReason(e2e.replace(/^e2e not run:\s*/i, ''))) {
      return 'pilot-report: ## E2E "e2e not run" cannot rest on the absence of a UI/screen; an E2E is owed whenever real processes, files or a host (CLI, hook, watcher, server, script) can exercise the change: run it, or name what was tried and why nothing on this machine can exercise it'
    }
    const hasProcedure = /^(?:command|procedure):\s+\S.+$/im.test(e2e)
    const hasOutput = /^(?:verbatim )?output:\s+\S.*$/im.test(e2e)
    const hasEvidenceLine = /^e2e evidence:\s+\S.+\s(?:=>|output:)\s\S.*$/im.test(e2e)
    if (!e2eNotRun && !(hasProcedure && hasOutput) && !hasEvidenceLine) {
      return 'pilot-report: ## E2E requires command/procedure and verbatim output, or exactly "e2e not run: <reason>"'
    }
    return null
}

function pilotReportReviewProblem(content, frozenRoute) {
    if (frozenRoute === 'FULL') {
      const review = reportSection(content, 'Independent Review')
      if (!review) return 'pilot-report: missing or empty ## Independent Review section on FULL route'
      if (!/\blens(?:es)?\b/i.test(review) || !/\bconfirmed\b/i.test(review) || !/\brefuted\b/i.test(review)) {
        return 'pilot-report: ## Independent Review on FULL requires lenses, confirmed findings, and refuted findings'
      }
    }
    return null
}
function reportSection(content, heading) {
    return new RegExp(`(?:^|\\n)## ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, 'i').exec(content)?.[1].trim() ?? ''
}
async function lifecycleQueued(context, work) {
    const prior = context.serial
    let release
    context.serial = new Promise((resolve) => {
      release = resolve
    })
    await prior
    try {
      return await work()
    } finally {
      release()
    }
}
async function lifecycleRouteFinding(context, args) {
    const { state, stoppedRefusal, boardContract, routeFinding, timeline, root, audit, persistTimeline, now,
      refusal, laneDir, cardId, sessionTag, events } = context
    if (state.stopped) return stoppedRefusal()
    if (!boardContract || typeof routeFinding !== 'function') {
      return partialForMissingBoardContract({ state, timeline, root, audit, persistTimeline, now, refusal, laneDir })
    }
    try {
      const created = await routeFinding({ ...args, type: args.type ?? 'chore', originCardId: String(cardId), sessionTag: String(sessionTag), boardContract, timestamp: new Date(now()).toISOString() })
      const id = routedCardId(created)
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('board returned no valid card id')
      const { record, failure } = routedFindingRecord(created, args, id)
      timeline.routed_cards.push(record)
      refreshRoutedReport(context)
      persistTimeline()
      const failureSuffix = failure ? ` (label failure: ${failure})` : ''
      events.route(id, record.title)
      return `routed card ${id} — ${record.title}${routedDependencySuffix(record)}${failureSuffix}`
    } catch (error) {
      return `route_finding refused: ${error instanceof Error ? error.message : String(error)}`
    }
}

function routedCardId(created) {
  return String(created?.id ?? '')
}

function routedFindingRecord(created, args, id) {
      const record = { id, title: String(created.title ?? args.title), l4Reason: args.l4Reason, ...routedDependencyEvidence(created) }
      const failure = Array.isArray(created.labelFailures) && created.labelFailures.length > 0
        ? created.labelFailures.map((item) => `add_label_to_card ${item.labelId}: ${item.error}`).join('; ')
        : null
      if (failure) record.failure = failure
      return { record, failure }
}

function refreshRoutedReport(context) {
      const { state, laneDir, timeline } = context
      if (state.phase === 'report' && state.pilotReportDigest) {
        const reportPath = path.join(laneDir, 'pilot-report.md')
        const report = readRegularFile(reportPath)
        if (report !== null) {
          const updated = withRoutedCardsSection(report, timeline.routed_cards)
          writeRegularFile(reportPath, updated)
          state.pilotReportDigest = sha256(updated)
        }
      }
}
  // One MCP instance per SDK query (phase session) over this one state: the SDK connects an instance per query and an
  // instance still attached to an ending query cannot connect again. A later session's transition ids are namespaced,
  // because a fresh session numbers its ids itself and must never replay an earlier session's transition.
function lifecycleServer(context) {
  const { createSdkMcpServer, tool, z, queued, transition, events, artifact, routeFindingTool, run,
    state, timeline, frozenRoute, lifecycle, finalizePartial, requestStop, dodEscalation } = context
  const sessionServer = (session = 1) => createLifecycleSessionServer({ createSdkMcpServer, tool, z, queued, transition: events.transition(transition), artifact, routeFindingTool, run }, session)
  const server = sessionServer()
  defineSessionAccessors(server, { sessionServer, state, timeline, route: frozenRoute })
  Object.defineProperty(server, 'lifecycle', { value: lifecycle })
  Object.defineProperty(server, 'state', {
    value: () => Object.freeze({
      phase: state.phase,
      partial: frozenDelivery(state.partial),
      deferred: frozenDelivery(state.deferred),
      blocked: events.blocked(),
    }),
  })
  Object.defineProperty(server, 'finalizePartial', { value: finalizePartial })
  Object.defineProperties(server, { requestStop: { value: requestStop }, dodDisputes: { value: () => structuredClone(state.dodDisputes) }, awaitDodDecisions: { value: dodEscalation.awaitDecisions } })
  return server
}

function bindLifecycleTools(context) {
  context.prepareLaneBrief = (...args) => prepareLifecycleLaneBrief(context, ...args)
  context.transition = (...args) => lifecycleTransition(context, ...args)
  context.artifact = (...args) => lifecycleArtifact(context, ...args)
  context.reportProblemWithHeadline = (...args) => lifecycleReportProblemWithHeadline(context, ...args)
  context.pilotReportProblem = (...args) => lifecyclePilotReportProblem(context, ...args)
  context.queued = (...args) => lifecycleQueued(context, ...args)
  context.routeFindingTool = (...args) => lifecycleRouteFinding(context, ...args)
}

export function createLifecycleStateMachine(options) {
  const context = lifecycleOptions(options)
  initializeLifecycleRoot(context)
  initializeLifecycleIdentity(context)
  bindLifecycleTools(context)
  initializeLifecycleLaunch(context)
  initializeLifecycleControls(context)
  return lifecycleServer(context)
}
