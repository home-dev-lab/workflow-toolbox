// Owns lifecycle phases, transitions, and MCP tool registration; it must not launch work or commit reports.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'
import { independentBrief, prospectivePatch } from './lifecycle-brief.mjs'
import { createLifecycleLaunch, MAX_LANE_REPORT_BYTES, readRegularFile, regularFile, sha256, writeRegularFile } from './lifecycle-launch.mjs'
import { acceptanceSection, containsPlanShape, PLAN_SHAPE_DESCRIPTION } from './lifecycle-plan-shape.mjs'
import { archiveLifecycle, assertArchiveOutsideWorktree, completeLifecycleReport } from './lifecycle-report-edge.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'
import { composeRules, loadRules } from './rules-manifest.mjs'
import { cardDefinitionOfDone } from './card-definition-of-done.mjs'

export const LIFECYCLE_SERVER_NAME = 'sdk-pilot-lifecycle'
export const LIFECYCLE_MCP_KEY = LIFECYCLE_SERVER_NAME
export const AWAITING_FIDELITY_RESULT = 'accepted phase=awaiting_fidelity'
// Owner rule: a loop gets three passes in all, never a fourth. The third refusal ends the run as a partial
// report; whoever reads that report escalates. One number for both loops, so they cannot drift apart again.
export const MAX_CRITIC_ROUNDS = 3
export const MAX_REVIEW_ROUNDS = 3
export const lifecycleToolName = (name) => `mcp__${LIFECYCLE_MCP_KEY}__${name}`

export const PHASES = ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'harden', 'report']
export { PLAN_SHAPE_DESCRIPTION } from './lifecycle-plan-shape.mjs'
const LANE_PHASES = new Set(['tdd', 'critic', 'review', 'refutation', 'harden'])
const GATES = new Set(['typecheck', 'lint', 'test'])
const ARTIFACTS = {
  plan: ['plan', 'plan.md'],
  'critic-brief': ['critic', 'critic-brief.md'],
  brief: ['tdd', 'tdd-brief.md'],
  'review-brief': ['review', 'review-brief.md'],
  'refutation-brief': ['refutation', 'refutation-brief.md'],
  'harden-brief': ['harden', 'harden-brief.md'],
  'pilot-report': ['report', 'pilot-report.md'],
}
const INDEPENDENT_ROLES = new Set(['critic', 'review', 'refutation'])
const MAX_REPORT_FINDINGS = 50
const MAX_FINDING_CHARACTERS = 2000
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
function reportDeliveryUnmet(content, dodBullets) {
  const entries = acceptanceEntries(content)
  const used = new Map()
  const unmet = []
  for (const bullet of dodBullets ?? []) {
    const index = used.get(bullet) ?? 0
    const lines = entries.get(bullet)?.[index] ?? []
    used.set(bullet, index + 1)
    const outcomes = lines.filter((line) => /^Outcome:/i.test(line))
    if (!outcomes.every((line) => /^Outcome:\s*proven(?:\s*(?:[:—–-]\s*|by\s+)?\S.*)?\s*$/i.test(line))) unmet.push(bullet)
  }
  const e2e = /(?:^|\n)## E2E\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/i.exec(content)?.[1].trim() ?? ''
  if (/^e2e not run: \S[^\r\n]*$/i.test(e2e)) unmet.push(`E2E: ${e2e}`)
  return unmet
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
function refusal(edge, missing, file) {
  return `edge refused: ${edge}; missing ${missing}: ${file}`
}
function verdictFromReport(phase, content) {
  const expected = phase === 'critic' ? ['approved', 'changes-requested'] : ['clear', 'changes-requested']
  const match = new RegExp(`^VERDICT:\\s*(${expected.join('|')})\\s*$`, 'mi').exec(content)
  if (!match) return null
  const findingsStart = content.slice(match.index + match[0].length).match(/^FINDINGS:\s*$/im)
  if (!findingsStart) return null
  const afterFindings = content.slice(match.index + match[0].length + findingsStart.index + findingsStart[0].length)
  const lines = afterFindings.split(/\r?\n/)
  const sectionEnd = lines.findIndex((line, index) => index > 0 && (/^#/.test(line) || (line === '' && /^## /.test(lines[index + 1] ?? ''))))
  const findings = (sectionEnd < 0 ? lines : lines.slice(0, sectionEnd))
    .filter((line) => /^[-*+]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, '').trim())
  if (findings.length > MAX_REPORT_FINDINGS) return { problem: `finding count exceeds ${MAX_REPORT_FINDINGS}` }
  if (findings.some((finding) => [...finding].length > MAX_FINDING_CHARACTERS)) {
    return { problem: `finding exceeds ${MAX_FINDING_CHARACTERS}-character limit` }
  }
  if (match[1] === 'changes-requested' && findings.length === 0) return null
  const severities = phase === 'critic'
    ? findings.map((finding) => {
        const match = /^\[(blocking|non-blocking)\]\s+(.+)$/i.exec(finding)
        const tagCount = [...finding.matchAll(/\[(?:blocking|non-blocking)\]/gi)].length
        return match && tagCount === 1 ? match[1].toLowerCase() : 'blocking'
      })
    : []
  return { outcome: match[1], findings, severities }
}

function createBoundaryStop({ state, laneDir, timeline, now, writeRegularFile, sha256, persistTimeline, onBoundaryStop }) {
  const stoppedRefusal = () => `edge refused: ${state.phase}->next; ${state.partial?.reason ?? 'runner'} already stopped the lifecycle: ${laneDir}`
  const stopAtBoundary = (event) => {
    const reason = state.pendingStop
    const phase = state.phase
    const result = `stopped phase=${phase} reason=${reason}`
    state.partial = { phase, reason, findings: [] }
    state.stopped = true
    state.handled.set(event.tool_use_id, { shape: JSON.stringify(event), result })
    const endedAt = now()
    const currentPhase = timeline.phases.at(-1)
    currentPhase.exited_at ??= endedAt
    currentPhase.transition_id ??= event.tool_use_id
    timeline.ended_at = endedAt
    const report = `# SDK pilot partial report\n\nPartial: ${reason}\nPhase reached: ${phase}\nReason: ${reason}\n`
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
    state.partial = { phase: state.phase, reason, findings: [] }
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
  lanePollMs = 25,
  laneWaitMs = null,
  lanePlatform = process.platform,
  gateRunner = null,
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
    `${JSON.stringify({ cardId, route: frozenRoute, reasons, executor, models: frozenModels, base: constructionBase }, null, 2)}\n`,
    { flag: 'wx' },
  )
  let state = {
    phase: 'discovery',
    partial: null,
    pilotReportDigest: null,
    planRound: 0,
    priorCriticRounds: [],
    nonBlockingFindings: [],
    reviewRound: 0,
    handled: new Map(),
    lastLaneMtime: 0,
    verifySnapshot: null,
    pendingControl: null,
    resolvedRoutedCards: new Set(),
    report: { stage: 'idle', base: null, head: null, tree: null },
    pendingStop: null,
    stopped: false,
  }
  const timelinePath = path.join(laneDir, 'lifecycle.json')
  const lifecycleStartedAt = now()
  const timeline = { version: 2, started_at: lifecycleStartedAt, ended_at: null, lsp, phases: [{ phase: 'discovery', round: null, entered_at: lifecycleStartedAt, exited_at: null, transition_id: null }], lanes: [], routed_cards: [] }
  const atomicTimelineWriter = timelineWriter ?? ((file, content) => {
    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    try { writeRegularFile(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file) } finally { fs.rmSync(temporary, { force: true }) }
  })
  const persistTimeline = () => {
    try { atomicTimelineWriter(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`) } catch { /* Cost evidence is best-effort and cannot alter lifecycle acceptance. */ }
  }
  persistTimeline()
  const laneBriefContexts = new Map()
  let serial = Promise.resolve()
  function prepareLaneBrief(phase, context, reportPath, snapshotDir = null) {
    const roleRules = composeRules(activeRules, { recipient: phase, trigger: `lane:${phase}` })
    if (!INDEPENDENT_ROLES.has(phase)) {
      const changelogInstructions = ['tdd', 'harden'].includes(phase) ? changelogSkillBody(changelogSkillPath) : ''
      const authoritative = `${roleRules ? `## Rules that apply to this role (authoritative)\n\n${roleRules}\n\n` : ''}${changelogInstructions ? `## Changelog instructions (authoritative)\n\n${changelogInstructions}\n\n` : ''}`
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
      const diff = prospectivePatch(root, constructionBase, git, prospectivePatchMaxBuffer)
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
    const options = { phase, context, reportPath, discovery, planDigest, constructionBase: phase === 'critic' ? null : constructionBase, priorRounds: phase === 'critic' ? state.priorCriticRounds : [], rules: roleRules, knowledgeBaseLine }
    return snapshotDir
      ? {
          canonical: independentBrief({ ...options, artifacts: canonicalArtifacts }),
          launch: independentBrief({ ...options, artifacts, snapshotDir }),
        }
      : independentBrief({ ...options, artifacts })
  }
  const { audit, evidencePath, laneEvidence, run: lifecycleRun, snapshotEvidence, verifySnapshot } = createLifecycleLaunch({
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
    gateRunner,
    now,
    recordLaneStart: ({ phase, model, startedAt, usageFile }) => {
      const record = { phase, round: phase === 'critic' ? state.priorCriticRounds.length + 1 : null, executor, model, started_at: startedAt, ended_at: null, usage_file: usageFile }
      timeline.lanes.push(record)
      persistTimeline()
      return record
    },
    recordLaneEnd: (record, endedAt) => {
      record.ended_at = endedAt
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
      const verdict = verdictFromReport('critic', reportContent)
      if (!verdict) return refusal('critic->next', 'VERDICT block', report)
      if (verdict.problem) return refusal('critic->next', verdict.problem, report)
      if (event.outcome && event.outcome !== verdict.outcome) {
        return refusal('critic->next', 'outcome does not match the lane report', report)
      }
      if (event.findings && JSON.stringify(event.findings) !== JSON.stringify(verdict.findings)) {
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
      const effectiveSeverities = verdict.severities.filter((_severity, index) => {
        const id = /\bCONTEST\s+routed\s+card\s+([A-Za-z0-9._-]+)\b/i.exec(verdict.findings[index])?.[1]
        return !id || !repeatedContests.has(id)
      })
      if (repeatedContests.size > 0 && !/(?:^|\s)(?:\.?\.?[/\\])?[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)*:\d+(?:-\d+)?\b/.test(laneBriefContexts.get('critic') ?? '')) {
        return refusal('critic->next', 'pilot citation supporting maintained L4 reason', path.join(laneDir, 'critic-brief.md'))
      }
      const allNonBlocking = verdict.outcome === 'changes-requested' && effectiveSeverities.every((severity) => severity === 'non-blocking')
      const receipt = laneEvidence('critic', verdict.outcome === 'changes-requested' && !allNonBlocking)
      if (receipt) return receipt
      if (contestedThisRound.size > 0) {
        for (const id of contestedThisRound) timeline.routed_cards.find((card) => card.id === id).contested = true
        persistTimeline()
      }
      const newNonBlockingFindings = verdict.findings.filter((_finding, index) => verdict.severities[index] === 'non-blocking')
      for (const finding of newNonBlockingFindings) {
        if (!state.nonBlockingFindings.includes(finding)) state.nonBlockingFindings.push(finding)
      }
      if (newNonBlockingFindings.length > 0) {
        writeRegularFile(
          path.join(laneDir, 'plan-non-blocking-findings.md'),
          `## Non-blocking critic findings (runner-owned, trusted)\n${state.nonBlockingFindings.map((finding) => `- ${finding}`).join('\n')}\n`,
        )
      }
      if (verdict.outcome === 'approved' || allNonBlocking) {
        const digest = sha256(readRegularFile(path.join(laneDir, 'plan.md')) ?? '')
        if (!reportContent.includes(digest)) {
          return refusal('critic->tdd', 'plan sha256', path.join(laneDir, 'critic-report.md'))
        }
        state.priorCriticRounds.push({ round: state.priorCriticRounds.length + 1, findings: [...verdict.findings] })
        next = 'tdd'
      } else if (verdict.outcome === 'changes-requested') {
        state.priorCriticRounds.push({ round: state.priorCriticRounds.length + 1, findings: [...verdict.findings] })
        state.planRound += 1
        if (state.planRound < MAX_CRITIC_ROUNDS) next = 'plan'
        else {
          const reason = `plan not approved after ${state.planRound} critic rounds`
          state.partial = { phase: 'critic', round: state.planRound, reason, findings: verdict.findings }
          state.verifySnapshot = { tree: treeSignature(root), gates: {} }
          audit()
          next = 'report'
          resultDetail = ` (round bound reached: partial run, ${reason})`
        }
      } else {
        return refusal('critic->next', 'admissible outcome', path.join(laneDir, 'critic-report.md'))
      }
    } else if (state.phase === 'tdd' || state.phase === 'harden') {
      const receipt = laneEvidence(state.phase)
      if (receipt) return receipt
      if (state.phase === 'tdd' && frozenRoute === 'FULL') {
        const planTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8'))
        const briefTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'tdd-brief.md'), 'utf8'))
        if (!planTasks || planTasks !== briefTasks) {
          return refusal('tdd->verify', 'byte-identical plan Tasks block', path.join(laneDir, 'tdd-brief.md'))
        }
      }
      next = 'verify'
    } else if (state.phase === 'verify') {
      if (event.outcome !== 'passed') {
        return refusal('verify->next', 'outcome passed', laneDir)
      }
      const receipt = verifySnapshot('verify->next')
      if (receipt) return receipt
      next = frozenRoute === 'LITE' ? 'report' : 'review'
    } else if (state.phase === 'review' || state.phase === 'refutation') {
      const report = path.join(laneDir, `${state.phase}-report.md`)
      if ((regularFile(report)?.size ?? 0) > MAX_LANE_REPORT_BYTES) {
        return refusal(`${state.phase}->next`, `lane report exceeds ${MAX_LANE_REPORT_BYTES}-byte limit`, report)
      }
      const verdict = verdictFromReport(state.phase, readRegularFile(report) ?? '')
      if (!verdict) return refusal(`${state.phase}->next`, 'VERDICT block', report)
      if (verdict.problem) return refusal(`${state.phase}->next`, verdict.problem, report)
      if (event.outcome && event.outcome !== verdict.outcome) {
        return refusal(`${state.phase}->next`, 'outcome does not match the lane report', report)
      }
      if (event.findings && JSON.stringify(event.findings) !== JSON.stringify(verdict.findings)) {
        return refusal(`${state.phase}->next`, 'findings do not match the lane report', report)
      }
      const receipt = laneEvidence(state.phase, verdict.outcome === 'changes-requested')
      if (receipt) return receipt
      if (verdict.outcome === 'changes-requested' && verdict.findings.length === 0) {
        return refusal(`${state.phase}->harden`, 'findings', path.join(laneDir, `${state.phase}-report.md`))
      }
      if (verdict.outcome === 'changes-requested' && ++state.reviewRound >= MAX_REVIEW_ROUNDS) {
        const phase = state.phase
        const reason = `${phase} still requests changes after ${MAX_REVIEW_ROUNDS - 1} harden rounds`
        state.partial = { phase, round: state.reviewRound, reason, findings: verdict.findings }
        next = 'report'
        resultDetail = ` (round bound reached: partial run, ${reason})`
      }
      if (!next) {
        next =
          state.phase === 'review' && verdict.outcome === 'clear'
            ? 'refutation'
            : state.phase === 'refutation' && verdict.outcome === 'clear'
              ? 'report'
              : 'harden'
      }
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
      if (reportProblem) return refusal('report->awaiting_fidelity', reportProblem, pilotReportPath)
      const unmet = reportDeliveryUnmet(pilotReport, dodBullets)
      if (unmet.length > 0 && !state.partial) {
        state.partial = { phase: 'report', round: null, reason: `delivered partially: ${unmet.length} unmet criteria`, findings: unmet }
        const partialProblem = pilotReportProblem(pilotReport, true)
        if (partialProblem) return refusal('report->awaiting_fidelity', partialProblem, pilotReportPath)
      }
      const receipt = snapshotEvidence('report->awaiting_fidelity')
      if (receipt) return receipt
      const reportReceipt = completeLifecycleReport({
        root,
        archiveRoot,
        laneDir,
        cardId,
        sessionTag,
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
          triggers: [`phase:${next}`, ...(next === 'critic' && state.priorCriticRounds.length > 0 ? ['critic-round>=2'] : [])],
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
      if (next !== 'awaiting_fidelity') timeline.phases.push({ phase: next, round: next === 'critic' ? state.priorCriticRounds.length + 1 : null, entered_at: transitionedAt, exited_at: null, transition_id: null })
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
    if (kind === 'brief' && frozenRoute === 'FULL') {
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
    }
    const briefPhase = kind === 'brief' ? 'tdd' : kind.replace('-brief', '')
    let laneContext = content
    if (kind === 'brief' && state.nonBlockingFindings.length > 0) {
      laneContext = `${content.replace(/\s*$/, '')}\n\n## Non-blocking critic findings (runner-owned, trusted)\n${state.nonBlockingFindings.map((finding) => `- ${finding}`).join('\n')}\n`
    }
    let artifactContent = laneContext
    if (LANE_PHASES.has(briefPhase)) {
      laneBriefContexts.delete(briefPhase)
      try {
        artifactContent = prepareLaneBrief(briefPhase, laneContext, `.lane/${briefPhase}-report.<launch-nonce>.md`)
      } catch (error) {
        fs.rmSync(path.join(laneDir, `${briefPhase}-input.diff`), { force: true })
        fs.rmSync(path.join(laneDir, spec[1]), { force: true })
        return `review input unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    writeRegularFile(
      path.join(laneDir, spec[1]),
      artifactContent,
    )
    if (LANE_PHASES.has(briefPhase)) laneBriefContexts.set(briefPhase, laneContext)
    if (kind === 'pilot-report') state.pilotReportDigest = sha256(artifactContent)
    return `wrote ${kind}`
  }
  // The pilot report's partial/full contract, checked on the exact bytes given: at write_artifact
  // and again at the report edge on the file about to be committed (Sol round 14: a stale or
  // edited pilot-report.md used to satisfy the edge by merely existing).
  function pilotReportProblem(content, enforceSchema = false) {
    const partialLine = state.partial ? `Partial: ${state.partial.reason}` : null
    const lines = content.split(/\r?\n/)
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
    if (!boardContract || typeof routeFinding !== 'function') return 'route_finding refused: no board contract; relaunch with --board-contract <json file>'
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
      return `routed card ${id} — ${record.title}${failure ? ` (label failure: ${failure})` : ''}`
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
        'Write a phase-bound lifecycle artifact.',
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
      partial: state.partial
        ? Object.freeze({ ...state.partial, findings: Object.freeze([...state.partial.findings]) })
        : null,
    }),
  })
  Object.defineProperty(server, 'finalizePartial', { value: finalizePartial })
  Object.defineProperty(server, 'requestStop', { value: requestStop })
  return server
}
