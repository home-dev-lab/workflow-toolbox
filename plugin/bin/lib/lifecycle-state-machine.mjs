// Owns lifecycle phases, transitions, and MCP tool registration; it must not launch work or commit reports.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'
import { independentBrief, prospectivePatch, snapshotPatch } from './lifecycle-brief.mjs'
import { createLifecycleLaunch, MAX_LANE_REPORT_BYTES, readRegularFile, regularFile, sha256, writeRegularFile } from './lifecycle-launch.mjs'
import { acceptanceSection, containsPlanShape, PLAN_SHAPE_DESCRIPTION } from './lifecycle-plan-shape.mjs'
import { archiveLifecycle, assertArchiveOutsideWorktree, completeLifecycleReport } from './lifecycle-report-edge.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'
import { composeRules, loadRules } from './rules-manifest.mjs'
import { cardDefinitionOfDone } from './card-definition-of-done.mjs'
import { adaptiveRoundDecision, hasPerSectionAttackAccount, reviewConvergenceDecision, verdictFromReport } from './lifecycle-review-policy.mjs'
import { detectFailedTestFramework } from './host/test-framework-detection.mjs'

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
export { PLAN_SHAPE_DESCRIPTION } from './lifecycle-plan-shape.mjs'
const LANE_PHASES = new Set(['tdd', 'critic', 'review', 'refutation'])
const GATES = new Set(['typecheck', 'lint', 'test'])
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
// Refuses route_finding when no board contract was supplied, and ends the run at `report` from inside
// the tool call — no phase transition carries it there, so the timeline is advanced here.
function partialForMissingBoardContract({ state, timeline, root, audit, persistTimeline, now }) {
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
const planAcceptanceProblem = (content, dodBullets) => acceptanceProblem(
  content,
  dodBullets,
  (line) => /^Proof:\s*\S/i.test(line) && /\b(?:tasks?|tests?|e2e|typecheck|lint)\b|(?:^|[/\\])\S+\.(?:test|spec)\.[A-Za-z0-9]+/i.test(line),
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
    const lines = entries.get(bullet)?.[index] ?? []
    used.set(bullet, index + 1)
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
function classifyReportDelivery(content, dodBullets, routedCards, state, reportProblem) {
  if (reportProblem && !reportProblem.startsWith('pilot-report: missing expected')) return
  const { unmet, deferred } = reportDeliveryClassification(content, dodBullets, routedCards)
  if (unmet.length > 0 && !state.partial) {
    state.partial = { phase: 'report', round: null, reason: `delivered partially: ${unmet.length} unmet criteria`, findings: unmet }
  } else if (deferred.length > 0 && !state.deferred) {
    state.deferred = { phase: 'report', round: null, reason: `delivery deferred: ${deferred.length} ${deferred.length === 1 ? 'criterion' : 'criteria'}`, findings: deferred }
  }
}
function deferredHeadlineProblem(content, deferred) {
  if (!deferred) return null
  const headline = `Deferred: ${deferred.findings.join('; ')}`
  return content.split(/\r?\n/)[0] === headline ? null : `pilot-report: deferred delivery, make "${headline}" the first line`
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
      if (path.relative(root, resolved).startsWith('..')) {
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
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(content)
  if (!match) throw new Error(`changelog skill unavailable at ${file}: YAML frontmatter is missing`)
  return match[1].trim()
}
function tasksBlock(content) {
  return /(?:^|\n)## Tasks\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? null
}
function validFindingAnchors(dodBullets, planContent) {
  const planDodCount = [...(tasksBlock(planContent ?? '') ?? '').matchAll(/\bDoD:\s*\S/gi)].length
  const criterionCount = dodBullets?.length ?? planDodCount
  const anchors = Array.from({ length: criterionCount }, (_unused, index) => `DoD ${index + 1}`)
  for (const match of (tasksBlock(planContent ?? '') ?? '').matchAll(/^\s*-\s+([A-Za-z]+\d+)\b/gm)) anchors.push(`plan task ${match[1]}`)
  return anchors
}
function findingPolicyOptions(phase, state, dodBullets, laneDir, readRegularFile) {
  const priorRounds = phase === 'critic' ? state.priorCriticRounds : state.priorReviewReports
  return {
    validAnchors: validFindingAnchors(dodBullets, readRegularFile(path.join(laneDir, 'plan.md'))),
    priorFindingCount: priorRounds.reduce((total, round) => total + round.findings.length, 0),
  }
}
function refusal(edge, missing, file) {
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
  const rows = verdict.findingDetails.filter((finding) => finding.blocks).map((finding) => `- ${finding.raw}`)
  writeRegularFile(path.join(laneDir, 'review-findings.md'), `# Review findings for TDD fix round ${state.reviewRound}\n\nSource: ${phase}\n\n${rows.join('\n')}\n`)
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
      return { refused: refusal('verify->tdd', 'failing test names in findings', laneDir) }
    }
    const receipt = verifyFailedSnapshot('verify->tdd', event.findings)
    if (receipt) return { refused: receipt }
    const findingDetails = event.findings.map((finding) => ({ raw: finding, text: finding, severity: 'high', anchor: 'verify', location: 'test', extendsPrior: null, blocks: true }))
    const verdict = { outcome: 'changes-requested', findings: [...event.findings], findingDetails }
    const decision = recordReviewDecision(state, 'verify', verdict, event.findings, [])
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
  let inputs = [`${phase}-input.diff`, 'typecheck.log', 'lint.log', 'test.log', 'review-findings.md']
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
    handled: new Map(), lastLaneMtime: 0, verifySnapshot: null, pendingControl: null, reportParseRetries: {},
    resolvedRoutedCards: new Set(), report: { stage: 'idle', base: null, head: null, tree: null, delivery: null },
    pendingStop: null, stopped: false,
  }
}

function snapshotWorkingTree(root, laneDir, git) {
  const index = path.join(laneDir, 'review-base.index')
  const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_INDEX_FILE: index } }
  try {
    removeFile(index)
    git('git', ['read-tree', 'HEAD'], options)
    git('git', ['add', '-A', '--', '.'], options)
    const tree = git('git', ['write-tree'], options).trim()
    if (!tree) throw new Error('git write-tree returned an empty tree id')
    return tree
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))
    throw new Error(`review snapshot failed: ${detail}`, { cause: error })
  } finally {
    removeFile(index)
    removeFile(`${index}.lock`)
  }
}

function reviewInputDiff({ phase, snapshotDir, inputPath, patchBase, constructionBase, state, root, laneDir, git, maxBuffer }) {
  if (snapshotDir) {
    const saved = readRegularFile(inputPath)
    if (saved === null) throw new Error(`${path.basename(inputPath)} unavailable`)
    return saved
  }
  if (phase === 'review' && state.reviewBase) {
    state.pendingReviewBase = snapshotWorkingTree(root, laneDir, git)
    return snapshotPatch(root, state.reviewBase, state.pendingReviewBase, git, maxBuffer)
  }
  const diff = prospectivePatch(root, patchBase ?? constructionBase, git, maxBuffer)
  if (phase === 'review') state.pendingReviewBase = snapshotWorkingTree(root, laneDir, git)
  return diff
}

function handleReportProblem({ phase, problem, report, state, refusal, root, audit, now, event, shape, timeline, persistTimeline }) {
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

function createBoundaryStop({ state, laneDir, timeline, now, writeRegularFile, sha256, persistTimeline, onBoundaryStop }) {
  const stoppedRefusal = () => `edge refused: ${state.phase}->next; ${state.partial?.reason ?? 'runner'} already stopped the lifecycle: ${laneDir}`
  const stopAtBoundary = (event) => {
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
    const report = `# SDK pilot partial report\n\nPartial: ${state.partial.reason}\nPhase reached: ${phase}\nReason: ${state.partial.reason}\nFinalization: ${reason}\n${unresolved}${routed}`
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

function createPartialFinalizer({ state, laneDir, timeline, now, persistTimeline, audit, constructionBase, git, root, archiveRoot, cardId, frozenRoute, evidencePath, sha256, assertLaneDir, copy, writeRegularFile, readRegularFile }) {
  return (reason) => {
    if (state.phase === 'awaiting_fidelity') return JSON.parse(readRegularFile(path.join(laneDir, 'summary.json')) ?? '{}')
    state.partial = finalizedPartial(state, state.phase, reason)
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


export function createLifecycleStateMachine({
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
  sdk = null,
  sdkRequire = null,
  laneLauncher = null,
  lanePollMs = 25, laneWaitMs = null,
  lanePlatform = process.platform, laneProcessReader = null,
  gateRunner = null, testFramework = detectFailedTestFramework(worktree),
  git = execFileSync,
  copy = fs.cpSync,
  prospectivePatchMaxBuffer = 64 * 1024 * 1024,
  rules = null,
  cardText = null, lsp = { available: false, reason: 'not prepared' },
  now = () => Date.now(),
  timelineWriter = null,
  boardContract = null,
  routeFinding = null,
  resolveRoutedFinding = null,
  onBoundaryStop = null,
  changelogSkillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/changelog/SKILL.md'),
}) {
  if (!path.isAbsolute(worktree)) {
    throw new Error('lifecycle worktree must be absolute')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(String(cardId))) {
    throw new Error('lifecycle cardId must match [A-Za-z0-9._-]+')
  }
  const root = fs.realpathSync(worktree)
  const dodBullets = typeof cardText === 'string' ? cardDefinitionOfDone(cardText) : undefined
  const activeRules = rules ?? loadRules({ projectRoot: root })
  let constructionBase = 'HEAD'
  try { constructionBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  const laneDir = path.join(root, '.lane')
  if (fs.existsSync(laneDir)) {
    const laneStat = fs.lstatSync(laneDir)
    if (!laneStat.isDirectory() || laneStat.isSymbolicLink()) {
      throw new Error('lifecycle .lane must be a real directory')
    }
  } else {
    fs.mkdirSync(laneDir, { recursive: true })
  }
  function assertLaneDir(archive = false) {
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
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(resolvedRoot, resolvedDirectory).startsWith('..')) throw new Error(`lane directory replaced: ${directory}`)
    }
    if (archive) {
      try {
        execFileSync('git', ['check-ignore', '--no-index', '.claude/reports/archive'], { cwd: archiveRoot, stdio: 'ignore' })
      } catch {
        throw new Error('lifecycle archiveRoot .claude/reports must be git-ignored')
      }
    }
  }
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
  if (typeof cardText === 'string') {
    const cardPath = path.join(laneDir, 'card.md')
    const existingCard = readRegularFile(cardPath)
    if (existingCard === null) writeRegularFile(cardPath, cardText, { flag: 'wx' })
    else if (existingCard !== cardText) throw new Error(`lifecycle card snapshot ${JSON.stringify(existingCard)} differs from runner card text ${JSON.stringify(cardText)}; remove ${cardPath} to restart the lifecycle on the new card`)
  }
  const frozenRoute = String(route)
  const frozenModels = Object.freeze(models.code
    ? { critic: models.review, ...models }
    : { critic: models.review, code: models.lane, review: models.review, refutation: models.refutation ?? models.review })
  const lifecycle = Object.freeze({
    route: frozenRoute,
    executor,
    models: frozenModels,
    cardId: String(cardId),
    sessionTag: String(sessionTag),
  })
  const require = sdkRequire ?? resolveAgentSdkRequire({ projectDir: root })
  const { createSdkMcpServer, tool } = sdk ?? require('@anthropic-ai/claude-agent-sdk')
  const { z } = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  writeRegularFile(
    routePath,
    `${JSON.stringify({ cardId, route: frozenRoute, reasons, executor, models: frozenModels, base: constructionBase, testFramework }, null, 2)}\n`,
    { flag: 'wx' },
  )
  const state = initialLifecycleState()
  const timelinePath = path.join(laneDir, 'lifecycle.json')
  const lifecycleStartedAt = now()
  const timeline = { version: 2, started_at: lifecycleStartedAt, ended_at: null, lsp, phases: [{ phase: 'discovery', round: null, entered_at: lifecycleStartedAt, exited_at: null, transition_id: null }], lanes: [], routed_cards: [] }
  const atomicTimelineWriter = timelineWriter ?? ((file, content) => {
    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    try { writeRegularFile(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file) } finally { removeFile(temporary) }
  })
  const persistTimeline = () => {
    try { atomicTimelineWriter(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`) } catch { /* Cost evidence is best-effort and cannot alter lifecycle acceptance. */ }
  }
  persistTimeline()
  const laneBriefContexts = new Map()
  const laneBriefIdentities = new Map()
  let serial = Promise.resolve()
  function prepareLaneBrief(phase, context, reportPath, snapshotDir = null) {
    const roleRules = composeRules(activeRules, { recipient: phase, trigger: `lane:${phase}` })
    if (!INDEPENDENT_ROLES.has(phase)) {
      const changelogInstructions = phase === 'tdd' ? changelogSkillBody(changelogSkillPath) : ''
      const fixInstructions = phase === 'tdd' && state.reviewRound > 0 ? `## Review fix round ${state.reviewRound} (authoritative)\n\nRead the exact runner-owned findings in \`.lane/review-findings.md\`. Fix every in-scope finding red-first; route only genuine L4 work. Run targeted tests, typecheck, and lint, and leave zero warnings in touched files. Do not run the full suite in this lane; the lifecycle runs it once in VERIFY after this fix round.\n\n` : ''
      const authoritative = `${roleRules ? `## Rules that apply to this role (authoritative)\n\n${roleRules}\n\n` : ''}${fixInstructions}${changelogInstructions ? `## Changelog instructions (authoritative)\n\n${changelogInstructions}\n\n` : ''}`
      const content = `${authoritative}${authoritative ? '## Pilot instructions\n\n' : ''}${context.replace(/\s*$/, '')}\n\nWrite the report to \`${reportPath}\`.\n`
      return snapshotDir
        ? { canonical: content, launch: `${content}\nThis brief is the read-only launch snapshot at \`${snapshotDir}\`; if another lane is started after this one ends, resume from the existing worktree state and preserve the same report and receipt contract. Do not rely on other background processes surviving the lane.\n` }
        : content
    }
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
      const inputName = `.lane/${phase}-input.diff`
      const inputPath = path.join(root, inputName)
      const patchBase = phase === 'review' && state.reviewBase ? state.reviewBase : constructionBase
      const diff = reviewInputDiff({ phase, snapshotDir, inputPath, patchBase, constructionBase, state, root, laneDir, git, maxBuffer: prospectivePatchMaxBuffer })
      writeRegularFile(inputPath, diff)
      canonicalArtifacts.push(inputName)
      artifacts.push(snapshotDir ? snapshotFile(`${phase}-input.diff`, diff) : inputName)
      for (const gate of GATES) {
        const gateName = `${gate}.log`
        const gateContent = readRegularFile(path.join(laneDir, gateName))
        if (snapshotDir && gateContent === null) throw new Error(`${gateName} unavailable`)
        canonicalArtifacts.push(`.lane/${gateName}`)
        artifacts.push(snapshotDir ? snapshotFile(gateName, gateContent) : `.lane/${gateName}`)
      }
    }
    const discovery = phase === 'critic' ? readRegularFile(path.join(laneDir, 'discovery.md')) : null
    if (phase === 'critic' && discovery === null) throw new Error('discovery record unavailable')
    if (phase === 'critic') {
      canonicalArtifacts.push('.lane/discovery.md')
      artifacts.push(snapshotDir ? snapshotFile('discovery.md', discovery) : canonicalArtifacts.at(-1))
    }
    const knowledgeBaseLine = knowledgeBase.path
      ? executor === 'claude-sdk'
        ? `KNOWLEDGE_BASE_INDEX: ${knowledgeBase.path}`
        // OpenCode lanes run with --auto, which approves an external_directory read the user's opencode
        // config leaves on "ask" (measured 2026-09-14: a Luna run read this index). A config that DENIES it
        // wins, so the lane must report a refused read instead of claiming it read the fiches.
        : `KNOWLEDGE_BASE_INDEX: ${knowledgeBase.path} (outside the OpenCode working directory: read it with your read tool; if the read is refused, say so in your report and do not rely on the knowledge base)`
      : `KNOWLEDGE_BASE_INDEX: none${knowledgeBase.checkedPath ? ` (no index exists at ${knowledgeBase.checkedPath})` : ''}`
    const priorRounds = phase === 'critic' ? state.priorCriticRounds : state.priorReviewReports
    const briefBase = phase === 'review' && state.priorReviewReports.length > 0 && state.reviewBase ? state.reviewBase : constructionBase
    const options = { phase, context, reportPath, discovery, planDigest, constructionBase: phase === 'critic' ? null : briefBase, priorRounds, rules: roleRules, knowledgeBaseLine }
    return snapshotDir
      ? {
          canonical: independentBrief({ ...options, artifacts: canonicalArtifacts }),
          launch: independentBrief({ ...options, artifacts, snapshotDir }),
        }
      : independentBrief({ ...options, artifacts })
  }
  const { audit, evidencePath, invalidateLaneEvidence, laneEvidence, run: lifecycleRun, snapshotEvidence, verifyFailedSnapshot, verifySnapshot } = createLifecycleLaunch({
    root,
    laneDir,
    executor,
    executorEnv,
    knowledgeBaseIndex: knowledgeBase.path,
    frozenModels,
    state,
    laneBriefContexts,
    prepareLaneBrief,
    assertLaneDir,
    refusal,
    lanePhases: LANE_PHASES,
    phases: PHASES,
    gates: GATES,
    laneLauncher,
    lanePollMs,
    laneWaitMs,
    lanePlatform,
    laneProcessReader,
    gateRunner, testFramework,
    now,
    recordLaneStart: ({ phase, model, startedAt, usageFile, laneId }) => {
      const record = { phase, round: lifecycleRound(state, phase), ...(laneId ? { lane_id: laneId } : {}), state: 'running', executor, model, started_at: startedAt, ended_at: null, exit_code: null, usage_file: usageFile }
      timeline.lanes.push(record)
      persistTimeline()
      return record
    },
    recordLaneEnd: (record, endedAt, exitCode) => {
      record.ended_at = endedAt
      record.exit_code = exitCode ?? 'missing'
      record.state = record.exit_code === '0' ? 'completed' : 'failed'
      persistTimeline()
    },
  })
  const { requestStop, stopAtBoundary, stoppedRefusal } = createBoundaryStop({ state, laneDir, timeline, now, writeRegularFile, sha256, persistTimeline, onBoundaryStop })
  function run(args) {
    if (state.stopped) return stoppedRefusal()
    return lifecycleRun(args)
  }
  const finalizePartial = createPartialFinalizer({ state, laneDir, timeline, now, persistTimeline, audit, constructionBase, git, root, archiveRoot, cardId, frozenRoute, evidencePath, sha256, assertLaneDir, copy, writeRegularFile, readRegularFile })
  function transition(event) {
    if (state.stopped) return stoppedRefusal()
    try { assertLaneDir(state.phase === 'report' || state.report.stage === 'committed') } catch (error) { return refusal(`${state.phase}->next`, error.message, laneDir) }
    if (!event || typeof event !== 'object' || !PHASES.includes(event.phase)) {
      return refusal('unknown->next', 'valid phase', laneDir)
    }
    if (!event.tool_use_id) {
      return refusal(`${state.phase}->next`, 'tool_use_id', laneDir)
    }
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
    let next = null
    let resultDetail = ''
    if (state.phase === 'discovery') {
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
    } else if (state.phase === 'plan') {
      const plan = path.join(laneDir, 'plan.md')
      const planContent = readRegularFile(plan)
      if (!planContent || !containsPlanShape(planContent, dodBullets !== undefined))
        return refusal('plan->critic', `valid plan artifact matching ${PLAN_SHAPE_DESCRIPTION}`, plan)
      const deferredProblem = deferredOutcomeProblem(planContent, timeline.routed_cards)
      if (deferredProblem) return refusal('plan->critic', deferredProblem, plan)
      if (dodBullets !== undefined) {
        const acceptanceProblem = planAcceptanceProblem(planContent, dodBullets)
        if (acceptanceProblem) return refusal('plan->critic', acceptanceProblem, plan)
      }
      resultDetail = `\n\n${planCoverageCitationResult(planContent, root)}`
      next = 'critic'
    } else if (state.phase === 'critic') {
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
        return !id || !repeatedContests.has(id)
      })
      if (repeatedContests.size > 0 && !/(?:^|\s)(?:\.?\.?[/\\])?[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)*:\d+(?:-\d+)?\b/.test(laneBriefContexts.get('critic') ?? '')) {
        return refusal('critic->next', 'pilot citation supporting maintained L4 reason', path.join(laneDir, 'critic-brief.md'))
      }
      const allNonBlocking = verdict.outcome === 'changes-requested' && effectiveFindingDetails.every((finding) => !finding.blocks)
      const receipt = laneEvidence('critic', verdict.outcome === 'changes-requested' && !allNonBlocking)
      if (receipt) return receipt
      const emptyCritic = applyCriticEmptyPolicy(state, verdict, reportContent, root, audit)
      if (emptyCritic?.retry) return refusal('critic->next', 'failed critic round: zero findings without a per-section attack account; re-run once', report)
      if (emptyCritic?.reason) {
        next = 'report'
        resultDetail = ` (failed critic retry: partial run, ${emptyCritic.reason})`
      }
      if (contestedThisRound.size > 0) {
        for (const id of contestedThisRound) timeline.routed_cards.find((card) => card.id === id).contested = true
        persistTimeline()
      }
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
      if (!next && (verdict.outcome === 'approved' || allNonBlocking)) {
        const digest = sha256(readRegularFile(path.join(laneDir, 'plan.md')) ?? '')
        if (!reportContent.includes(digest)) {
          return refusal('critic->tdd', 'plan sha256', path.join(laneDir, 'critic-report.md'))
        }
        state.priorCriticRounds.push({ round: state.priorCriticRounds.length + 1, findings: [...verdict.findings], blockingFindings: [], findingDetails: verdict.findingDetails })
        next = 'tdd'
      } else if (!next && verdict.outcome === 'changes-requested') {
        const blockingFindings = verdict.findings.filter((finding, index) => {
          const id = /\bCONTEST\s+routed\s+card\s+([A-Za-z0-9._-]+)\b/i.exec(finding)?.[1]
          return (!id || !repeatedContests.has(id)) && verdict.findingDetails[index].blocks
        })
        const findingDetails = verdict.findingDetails.filter((_finding, index) => blockingFindings.includes(verdict.findings[index]))
        state.priorCriticRounds.push({ round: state.priorCriticRounds.length + 1, findings: [...verdict.findings], blockingFindings, findingDetails })
        state.planRound += 1
        const decision = adaptiveRoundDecision(state.priorCriticRounds, FIXED_CRITIC_ROUNDS, MAX_CRITIC_ROUNDS, state.criticPlateauUsed)
        state.criticPlateauUsed = decision.plateauUsed
        if (decision.continue) next = 'plan'
        else {
          const reason = `plan not approved after ${state.planRound} critic rounds`
          state.partial = { phase: 'critic', round: state.planRound, reason, findings: verdict.findings }
          state.verifySnapshot = { tree: treeSignature(root), gates: {} }
          audit()
          next = 'report'
          resultDetail = ` (round bound reached: partial run, ${reason})`
        }
      } else if (!next) {
        return refusal('critic->next', 'admissible outcome', path.join(laneDir, 'critic-report.md'))
      }
    } else if (state.phase === 'tdd') {
      const receipt = laneEvidence(state.phase)
      if (receipt) return receipt
      if (state.reviewRound === 0 && frozenRoute === 'FULL') {
        const planTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8'))
        const briefTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'tdd-brief.md'), 'utf8'))
        if (!planTasks || planTasks !== briefTasks) {
          return refusal('tdd->verify', 'byte-identical plan Tasks block', path.join(laneDir, 'tdd-brief.md'))
        }
      }
      next = 'verify'
    } else if (state.phase === 'verify') {
      const verification = verifyTransition({ event, state, laneDir, frozenRoute, refusal, verifyFailedSnapshot, verifySnapshot, writeRegularFile, invalidateLaneEvidence, laneBriefContexts })
      if (verification.refused) return verification.refused
      next = verification.next
      resultDetail = verification.resultDetail
    } else if (state.phase === 'review' || state.phase === 'refutation') {
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
    } else if (state.phase === 'report') {
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
      const reportProblem = pilotReportProblem(pilotReport, true)
      classifyReportDelivery(pilotReport, dodBullets, timeline.routed_cards, state, reportProblem)
      if (reportProblem) return refusal('report->awaiting_fidelity', reportProblem, pilotReportPath)
      const deliveryProblem = pilotReportProblem(pilotReport, true)
      if (deliveryProblem) return refusal('report->awaiting_fidelity', deliveryProblem, pilotReportPath)
      const receipt = snapshotEvidence('report->awaiting_fidelity')
      if (receipt) return receipt
      const reportReceipt = completeLifecycleReport({
        root,
        archiveRoot,
        laneDir,
        cardId,
        sessionTag,
        startedAt: lifecycleStartedAt,
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
      if (reportReceipt) return reportReceipt
      next = 'awaiting_fidelity'
    }
    if (!next) return refusal(`${state.phase}->next`, 'outcome', laneDir)
    if (state.pendingStop) return stopAtBoundary(event)
    const phaseRules = next === 'awaiting_fidelity'
      ? ''
      : composeRules(activeRules, {
          recipient: 'pilot',
          triggers: [`phase:${next}`, ...(state.phase === 'critic' && next === 'plan' ? ['critic->plan'] : [])],
        })
    const result = next === 'awaiting_fidelity'
      ? AWAITING_FIDELITY_RESULT
      : `accepted phase=${next}${resultDetail}${phaseRules ? `\n\n## Rules for phase ${next} (authoritative)\n\n${phaseRules}` : ''}`
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
  async function artifact({ kind, content }) {
    if (state.stopped) return stoppedRefusal()
    try { assertLaneDir() } catch (error) { return refusal(`${state.phase}->next`, error.message, laneDir) }
    const spec = ARTIFACTS[kind]
    if (!spec) {
      return refusal(`${state.phase}->next`, 'known artifact kind', laneDir)
    }
    if (state.phase !== spec[0]) {
      return refusal(`${state.phase}->next`, `${kind} in phase ${state.phase}: write it in phase ${spec[0]}`, path.join(laneDir, spec[1]))
    }
    if (kind === 'critic-brief' && !readRegularFile(path.join(laneDir, 'plan.md'))) {
      return refusal('critic->next', 'plan artifact', path.join(laneDir, 'plan.md'))
    }
    if (kind === 'brief' && frozenRoute === 'FULL' && state.reviewRound === 0) {
      const planTasks = tasksBlock(readRegularFile(path.join(laneDir, 'plan.md')))
      if (!planTasks || tasksBlock(content) !== planTasks) {
        return refusal('critic->tdd', 'byte-identical plan Tasks block', path.join(laneDir, spec[1]))
      }
    }
    if (kind === 'pilot-report') {
      const problem = pilotReportProblem(content)
      if (problem) return problem
      if (typeof resolveRoutedFinding === 'function') {
        for (const card of timeline.routed_cards.filter((item) => item.contested && !new RegExp(`Outcome:\\s*deferred:\\s*card\\s+${item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(content))) {
          if (!state.resolvedRoutedCards.has(card.id)) {
            await resolveRoutedFinding(card)
            state.resolvedRoutedCards.add(card.id)
          }
        }
      }
      content = withRoutedCardsSection(content, timeline.routed_cards)
      content = withFindingsToRouteSection(content, state.findingsToRoute)
      if (state.partial?.question) content = withQuestionForParent(content, state.partial.question)
    }
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
    if (kind === 'pilot-report') state.pilotReportDigest = sha256(artifactContent)
    return `wrote ${kind}`
  }
  // The pilot report's partial/full contract, checked on the exact bytes given: at write_artifact
  // and again at the report edge on the file about to be committed (Sol round 14: a stale or
  // edited pilot-report.md used to satisfy the edge by merely existing).
  function pilotReportProblem(content, enforceSchema = false) {
    const partialLine = state.partial ? `Partial: ${state.partial.reason}` : null
    const lines = content.split(/\r?\n/)
    const headlineProblem = deferredHeadlineProblem(content, state.deferred)
    if (headlineProblem) return headlineProblem
    if (partialLine?.startsWith('Partial: route_finding refused: no board contract;') && lines[0] !== partialLine) {
      return `pilot-report: partial run, make "${partialLine}" the first line`
    }
    if (partialLine && !lines.includes(partialLine)) {
      return `pilot-report: partial run, add the line "${partialLine}"`
    }
    if (!partialLine && lines.some((line) => line.startsWith('Partial:'))) {
      return 'pilot-report: this run is not partial'
    }
    const deferredProblem = deferredOutcomeProblem(content, timeline.routed_cards)
    if (deferredProblem) return `pilot-report: ${deferredProblem}`
    if (!enforceSchema) return null
    if (dodBullets !== undefined) {
      const acceptanceProblem = reportAcceptanceProblem(content, dodBullets)
      if (acceptanceProblem) return `pilot-report: missing ${acceptanceProblem}`
    }
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
  async function queued(work) {
    const prior = serial
    let release
    serial = new Promise((resolve) => {
      release = resolve
    })
    await prior
    try {
      return await work()
    } finally {
      release()
    }
  }
  async function routeFindingTool(args) {
    if (state.stopped) return stoppedRefusal()
    if (!boardContract || typeof routeFinding !== 'function') {
      return partialForMissingBoardContract({ state, timeline, root, audit, persistTimeline, now })
    }
    try {
      const created = await routeFinding({ ...args, type: args.type ?? 'chore', originCardId: String(cardId), sessionTag: String(sessionTag), boardContract, timestamp: new Date(now()).toISOString() })
      const id = String(created?.id ?? '')
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('board returned no valid card id')
      const record = { id, title: String(created.title ?? args.title), l4Reason: args.l4Reason }
      const failure = Array.isArray(created.labelFailures) && created.labelFailures.length > 0
        ? created.labelFailures.map((item) => `add_label_to_card ${item.labelId}: ${item.error}`).join('; ')
        : null
      if (failure) record.failure = failure
      timeline.routed_cards.push(record)
      if (state.phase === 'report' && state.pilotReportDigest) {
        const reportPath = path.join(laneDir, 'pilot-report.md')
        const report = readRegularFile(reportPath)
        if (report !== null) {
          const updated = withRoutedCardsSection(report, timeline.routed_cards)
          writeRegularFile(reportPath, updated)
          state.pilotReportDigest = sha256(updated)
        }
      }
      persistTimeline()
      const failureSuffix = failure ? ` (label failure: ${failure})` : ''
      return `routed card ${id} — ${record.title}${failureSuffix}`
    } catch (error) {
      return `route_finding refused: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const server = createSdkMcpServer({
    name: LIFECYCLE_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'transition',
        'Advance the runner-owned lifecycle.',
        {
          phase: z.string(),
          route: z.string().optional(),
          record: z.string().optional(),
          outcome: z.string().optional(),
          findings: z.array(z.string()).optional(),
          tool_use_id: z.string(),
        },
        async (args) => ({
          content: [
            {
              type: 'text',
              text: await queued(() => transition(args)),
            },
          ],
        }),
      ),
      tool(
        'write_artifact',
        'Write a phase-bound lifecycle artifact. For a gitignored pilot-report delivery, add the exact line "- Delivered artefact: `relative/path`" under `## Implemented`; the edge confines and reads each regular file, requires an mtime since the run started, and records path, size, SHA-256, mtime, and `modified_after_started` in the summary and manifest. Mtime bounds recency, not authorship.',
        {
          kind: z.string(),
          content: z.string(),
        },
        async (args) => ({
          content: [
            {
              type: 'text',
              text: await queued(() => artifact(args)),
            },
          ],
        }),
      ),
      tool(
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
      ),
      tool(
        'run',
        'Run a fixed lane, gate, or inspection command.',
        {
          kind: z.string(),
          phase: z.string().optional(),
          name: z.string().optional(),
          what: z.string().optional(),
          decision: z.string().optional(),
          extendSeconds: z.number().int().positive().optional(),
          timeout: z.number().int().positive().optional(),
        },
        async (args) => ({
          content: [
            {
              type: 'text',
              text: await queued(() => run(args)),
            },
          ],
        }),
      ),
    ],
  })
  Object.defineProperty(server, 'lifecycle', { value: lifecycle })
  Object.defineProperty(server, 'state', {
    value: () => Object.freeze({
      phase: state.phase,
      partial: frozenDelivery(state.partial),
      deferred: frozenDelivery(state.deferred),
    }),
  })
  Object.defineProperty(server, 'finalizePartial', { value: finalizePartial })
  Object.defineProperty(server, 'requestStop', { value: requestStop })
  return server
}
