// Owns lifecycle phases, transitions, and MCP tool registration; it must not launch work or commit reports.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { treeSignature } from './gate-evidence.mjs'
import { independentBrief, prospectivePatch } from './lifecycle-brief.mjs'
import { createLifecycleLaunch, MAX_LANE_REPORT_BYTES, readRegularFile, regularFile, sha256, writeRegularFile } from './lifecycle-launch.mjs'
import { completeLifecycleReport } from './lifecycle-report-edge.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'

export const LIFECYCLE_SERVER_NAME = 'sdk-pilot-lifecycle'
export const LIFECYCLE_MCP_KEY = LIFECYCLE_SERVER_NAME
export const AWAITING_FIDELITY_RESULT = 'accepted phase=awaiting_fidelity'
export const MAX_CRITIC_ROUNDS = 4
export const lifecycleToolName = (name) => `mcp__${LIFECYCLE_MCP_KEY}__${name}`

const PHASES = ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'harden', 'report']
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
const PLAN_SHAPE = Object.freeze({
  adrHeading: 'ADR',
  adrTerms: Object.freeze(['Decision', 'Rejected']),
  tasksHeading: 'Tasks',
  taskDodLabels: Object.freeze(['DoD', 'Definition of done']),
  gatesHeading: 'Gates',
})
export const PLAN_SHAPE_DESCRIPTION = `a \`## ${PLAN_SHAPE.adrHeading}\` section containing ${PLAN_SHAPE.adrTerms.join(' and ')}, a \`## ${PLAN_SHAPE.tasksHeading}\` section whose every item has ${PLAN_SHAPE.taskDodLabels.map((label) => `\`${label}:\``).join(' or ')}, and a \`## ${PLAN_SHAPE.gatesHeading}\` section`

function planSection(content, heading) {
  return new RegExp(`(?:^|\\n)## ${heading}\\b[\\s\\S]*?(?=\\n## |$)`, 'i').exec(content)?.[0] ?? ''
}

function containsPlanShape(content) {
  const adr = planSection(content, PLAN_SHAPE.adrHeading)
  const tasks = planSection(content, PLAN_SHAPE.tasksHeading)
  const lines = tasks.split(/\r?\n/)
  const taskIndexes = lines
    .map((line, index) => (/^(?:- |\d+\. )/.test(line) ? index : -1))
    .filter((index) => index >= 0)
  return (
    PLAN_SHAPE.adrTerms.every((term) => new RegExp(term, 'i').test(adr)) &&
    taskIndexes.length > 0 &&
    taskIndexes.every(
      (start, i) =>
        new RegExp(`\\b(?:${PLAN_SHAPE.taskDodLabels.join('|')}):`, 'i').test(lines[start]) ||
        lines
          .slice(start + 1, taskIndexes[i + 1] ?? lines.length)
          .some((line) => new RegExp(`^\\s*(?:${PLAN_SHAPE.taskDodLabels.join('|')}):`, 'i').test(line)),
    ) &&
    Boolean(planSection(content, PLAN_SHAPE.gatesHeading))
  )
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


export function createLifecycleStateMachine({
  worktree,
  route,
  reasons = [],
  executor = 'gpt-lane',
  executorEnv = process.env,
  models,
  cardId,
  sessionTag,
  sdk = null,
  sdkRequire = null,
  laneLauncher = null,
  lanePollMs = 25,
  laneWaitMs = null,
  gateRunner = null,
  git = execFileSync,
  copy = fs.cpSync,
  prospectivePatchMaxBuffer = 64 * 1024 * 1024,
}) {
  if (!path.isAbsolute(worktree)) {
    throw new Error('lifecycle worktree must be absolute')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(String(cardId))) {
    throw new Error('lifecycle cardId must match [A-Za-z0-9._-]+')
  }
  const root = fs.realpathSync(worktree)
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
    if (archive) required.push(path.join(root, '.claude'), path.join(root, '.claude', 'reports'))
    for (const directory of required) {
      let stat
      try { stat = fs.lstatSync(directory) } catch { throw new Error(`lane directory replaced: ${directory}`) }
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory || path.relative(root, directory).startsWith('..')) {
        throw new Error(`lane directory replaced: ${directory}`)
      }
    }
  }
  assertLaneDir()
  fs.mkdirSync(path.join(root, '.claude', 'reports'), { recursive: true })
  assertLaneDir(true)
  try {
    execFileSync('git', ['check-ignore', '--no-index', '.claude/reports/archive'], {
      cwd: root,
      stdio: 'ignore',
    })
  } catch {
    throw new Error('lifecycle .claude/reports must be git-ignored')
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
    path.join(laneDir, 'route.json'),
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
    report: { stage: 'idle', base: null, head: null, tree: null },
  }
  const laneBriefContexts = new Map()
  let serial = Promise.resolve()
  function prepareLaneBrief(phase, context, reportPath, snapshotDir = null) {
    if (!INDEPENDENT_ROLES.has(phase)) {
      const content = `${context.replace(/\s*$/, '')}\n\nWrite the report to \`${reportPath}\`.\n`
      return snapshotDir
        ? { canonical: content, launch: `${content}\nThis brief is the read-only launch snapshot at \`${snapshotDir}\`; do not rely on background processes surviving the lane.\n` }
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
    const options = { phase, context, reportPath, planDigest, constructionBase: phase === 'critic' ? null : constructionBase, priorRounds: phase === 'critic' ? state.priorCriticRounds : [] }
    return snapshotDir
      ? {
          canonical: independentBrief({ ...options, artifacts: canonicalArtifacts }),
          launch: independentBrief({ ...options, artifacts, snapshotDir }),
        }
      : independentBrief({ ...options, artifacts })
  }
  const { audit, evidencePath, laneEvidence, run, snapshotEvidence, verifySnapshot } = createLifecycleLaunch({
    root,
    laneDir,
    executor,
    executorEnv,
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
    gateRunner,
  })
  function transition(event) {
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
      return previous.shape === shape ? previous.result : refusal(`${state.phase}->next`, 'unique tool_use_id', laneDir)
    }
    if (event.phase !== state.phase) {
      return refusal(`${state.phase}->next`, `current phase ${state.phase}`, laneDir)
    }
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
      next = frozenRoute === 'LITE' ? 'tdd' : 'plan'
    } else if (state.phase === 'plan') {
      const plan = path.join(laneDir, 'plan.md')
      if (!readRegularFile(plan) || !containsPlanShape(readRegularFile(plan)))
        return refusal('plan->critic', `valid plan artifact matching ${PLAN_SHAPE_DESCRIPTION}`, plan)
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
      const allNonBlocking = verdict.outcome === 'changes-requested' && verdict.severities.every((severity) => severity === 'non-blocking')
      const receipt = laneEvidence('critic', verdict.outcome === 'changes-requested' && !allNonBlocking)
      if (receipt) return receipt
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
      if (verdict.outcome === 'changes-requested' && ++state.reviewRound > 3) {
        const phase = state.phase
        const reason = `${phase} still requests changes after 3 harden rounds`
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
      const reportProblem = pilotReportProblem(pilotReport)
      if (reportProblem) return refusal('report->awaiting_fidelity', reportProblem, pilotReportPath)
      const receipt = snapshotEvidence('report->awaiting_fidelity')
      if (receipt) return receipt
      const reportReceipt = completeLifecycleReport({
        root,
        laneDir,
        cardId,
        sessionTag,
        route: frozenRoute,
        state,
        evidencePath,
        phases: [...state.handled.values()].map((item) => item.result).concat(AWAITING_FIDELITY_RESULT),
        implementation: { name: LIFECYCLE_SERVER_NAME, version: '1.0.0' },
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
    state.phase = next
    const result = next === 'awaiting_fidelity' ? AWAITING_FIDELITY_RESULT : `accepted phase=${next}${resultDetail}`
    state.handled.set(event.tool_use_id, { shape, result })
    return result
  }
  async function artifact({ kind, content }) {
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
  function pilotReportProblem(content) {
    const partialLine = state.partial ? `Partial: ${state.partial.reason}` : null
    const lines = content.split(/\r?\n/)
    if (partialLine && !lines.includes(partialLine)) {
      return `pilot-report: partial run, add the line "${partialLine}"`
    }
    if (!partialLine && lines.some((line) => line.startsWith('Partial:'))) {
      return 'pilot-report: this run is not partial'
    }
    return null
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
        'run',
        'Run a fixed lane, gate, or inspection command.',
        {
          kind: z.string(),
          phase: z.string().optional(),
          name: z.string().optional(),
          what: z.string().optional(),
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
  return server
}
