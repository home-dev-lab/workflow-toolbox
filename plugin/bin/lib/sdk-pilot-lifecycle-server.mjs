import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'

const PHASES = ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'harden', 'report']
const LANE_PHASES = new Set(['tdd', 'critic', 'review', 'refutation', 'harden'])
const GATES = new Set(['typecheck', 'lint', 'test'])
const ARTIFACTS = {
  plan: ['plan', 'plan.md'],
  'critic-brief': ['plan', 'critic-brief.md'],
  brief: ['tdd', 'brief.md'],
  'review-brief': ['review', 'review-brief.md'],
  'refutation-brief': ['refutation', 'refutation-brief.md'],
  'harden-brief': ['harden', 'harden-brief.md'],
  'pilot-report': ['report', 'pilot-report.md'],
}

function sha256(content) { return createHash('sha256').update(content).digest('hex') }
function terminalExit(content) { return /(?:^|\n)EXIT=([^\s\n]+)\s*$/.exec(content)?.[1] ?? null }
function readAttestation(file) {
  if (!fs.existsSync(file)) return null
  const content = fs.readFileSync(file, 'utf8')
  return { path: file, size: Buffer.byteLength(content), sha256: sha256(content), mtime: fs.statSync(file).mtimeMs, exit: terminalExit(content) }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function containsPlanShape(content) {
  const adr = /## ADR\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? ''
  const tasks = /## Tasks\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? ''
  return /decision/i.test(adr) && /rejected/i.test(adr) && /DoD:/i.test(tasks) && /## Gates\b/i.test(content)
}
function tasksBlock(content) { return /## Tasks\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? null }
function promiseSpawn(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, shell: false })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(signal ? 124 : (code ?? 1)))
  })
}
function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function refusal(edge, missing, file) { return `edge refused: ${edge}; missing ${missing}: ${file}` }

export function createLifecycleServer({ worktree, route, reasons = [], models, cardId, sessionTag, sdk = null, laneLauncher = null, lanePollMs = 25, laneWaitMs = null, git = execFileSync, copy = fs.cpSync }) {
  if (!path.isAbsolute(worktree)) throw new Error('lifecycle worktree must be absolute')
  const frozenRoute = Object.freeze(String(route))
  const frozenModels = Object.freeze({ ...models })
  const root = fs.realpathSync(worktree)
  const laneDir = path.join(root, '.lane')
  const evidencePath = path.join(laneDir, 'evidence.json')
  const summaryPath = path.join(laneDir, 'summary.json')
  const bundledToolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../toolkit/package.json')
  const require = createRequire(fs.existsSync(path.join(root, 'toolkit/package.json')) ? path.join(root, 'toolkit/package.json') : bundledToolkit)
  const loaded = sdk ?? require('@anthropic-ai/claude-agent-sdk')
  const { createSdkMcpServer, tool } = loaded
  const { z } = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  const lifecycle = { route: frozenRoute, models: frozenModels, cardId: String(cardId), sessionTag: String(sessionTag) }
  Object.freeze(lifecycle)
  fs.mkdirSync(laneDir, { recursive: true })
  fs.writeFileSync(path.join(laneDir, 'route.json'), `${JSON.stringify({ cardId, route: frozenRoute, reasons, models: frozenModels }, null, 2)}\n`, { flag: 'wx' })
  let state = { phase: 'discovery', planRound: 0, reviewRound: 0, handled: new Map(), lastLaneMtime: 0, verifySnapshot: null }
  let serial = Promise.resolve()

  function saveEvidence(entry) {
    const evidence = readJson(evidencePath, { version: 1, entries: {} })
    evidence.entries[entry.path] = entry
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    return entry
  }
  function evidence(file) { return readJson(evidencePath, { entries: {} }).entries[file] ?? null }
  function laneEvidence(phase, allowFailed = false) {
    const log = path.join(laneDir, `${phase}-run.log`)
    const report = path.join(laneDir, `${phase}-report.md`)
    const attested = evidence(log)
    if (!attested) return refusal(`${phase}->next`, 'lane receipt', log)
    if (attested.exit !== '0' && !allowFailed) return refusal(`${phase}->next`, `lane receipt EXIT=${attested.exit ?? 'missing'}`, log)
    const reportEntry = evidence(report)
    if (!reportEntry || reportEntry.size === 0) return refusal(`${phase}->next`, 'non-empty lane report', report)
    return null
  }
  function gatesEvidence(edge) {
    const current = treeSignature(root)
    for (const name of GATES) {
      const file = path.join(laneDir, `${name}.log`)
      const item = evidence(file)
      if (!item) return refusal(edge, 'gate receipt', file)
      if (item.exit !== '0') return refusal(edge, `gate receipt EXIT=${item.exit ?? 'missing'}`, file)
      if (item.tree !== current) return refusal(edge, 'current tree signature', file)
      if (item.mtime < state.lastLaneMtime) return refusal(edge, 'gate newer than lane receipt', file)
    }
    return null
  }
  function verifySnapshot(edge) {
    const receipt = gatesEvidence(edge)
    if (receipt) return receipt
    const tree = treeSignature(root)
    const gates = {}
    for (const name of GATES) {
      const file = path.join(laneDir, `${name}.log`)
      const item = evidence(file)
      gates[name] = { path: file, sha256: item.sha256 }
    }
    state.verifySnapshot = { tree, gates }
    const stored = readJson(evidencePath, { version: 1, entries: {} })
    stored.verify_snapshot = state.verifySnapshot
    fs.writeFileSync(evidencePath, `${JSON.stringify(stored, null, 2)}\n`)
    return null
  }
  function snapshotEvidence(edge) {
    const snapshot = state.verifySnapshot
    if (!snapshot) return refusal(edge, 'verify digest snapshot', evidencePath)
    const currentTree = treeSignature(root)
    if (currentTree !== snapshot.tree) return refusal(edge, `tree signature changed (${snapshot.tree} != ${currentTree})`, root)
    for (const name of GATES) {
      const saved = snapshot.gates[name]
      const current = readAttestation(saved.path)
      if (!current || current.sha256 !== saved.sha256) return refusal(edge, `gate digest changed (${saved.sha256} != ${current?.sha256 ?? 'missing'})`, saved.path)
    }
    return null
  }
  function transition(event) {
    if (!PHASES.includes(event.phase)) return refusal('unknown->next', 'valid phase', laneDir)
    if (!event.tool_use_id) return refusal(`${state.phase}->next`, 'tool_use_id', laneDir)
    const shape = JSON.stringify(event)
    const previous = state.handled.get(event.tool_use_id)
    if (previous) return previous.shape === shape ? previous.result : refusal(`${state.phase}->next`, 'unique tool_use_id', laneDir)
    if (event.phase !== state.phase) return refusal(`${state.phase}->next`, `current phase ${state.phase}`, laneDir)
    let next = null
    if (state.phase === 'discovery') {
      if (event.route && event.route !== frozenRoute) return refusal('discovery->next', `runner route ${frozenRoute} (${reasons.join(', ')})`, path.join(laneDir, 'route.json'))
      next = frozenRoute === 'LITE' ? 'tdd' : 'plan'
    } else if (state.phase === 'plan') {
      const plan = path.join(laneDir, 'plan.md')
      if (!fs.existsSync(plan) || !containsPlanShape(fs.readFileSync(plan, 'utf8'))) return refusal('plan->critic', 'valid plan artifact', plan)
      next = 'critic'
    } else if (state.phase === 'critic') {
      const receipt = laneEvidence('critic', event.outcome === 'changes-requested'); if (receipt) return receipt
      if (event.outcome === 'approved') {
        const digest = sha256(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8'))
        const report = fs.readFileSync(path.join(laneDir, 'critic-report.md'), 'utf8')
        if (!report.includes(digest)) return refusal('critic->tdd', 'plan sha256', path.join(laneDir, 'critic-report.md'))
        next = 'tdd'
      } else if (event.outcome === 'changes-requested' && ++state.planRound <= 3) next = 'plan'
      else return refusal('critic->next', 'admissible outcome', path.join(laneDir, 'critic-report.md'))
    } else if (state.phase === 'tdd' || state.phase === 'harden') {
      const receipt = laneEvidence(state.phase); if (receipt) return receipt
      if (state.phase === 'tdd' && frozenRoute === 'FULL') {
        const planTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8'))
        const briefTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'brief.md'), 'utf8'))
        if (!planTasks || planTasks !== briefTasks) return refusal('tdd->verify', 'byte-identical plan Tasks block', path.join(laneDir, 'brief.md'))
      }
      next = 'verify'
    } else if (state.phase === 'verify') {
      if (event.outcome !== 'passed') return refusal('verify->next', 'outcome passed', laneDir)
      const receipt = verifySnapshot('verify->next'); if (receipt) return receipt
      next = frozenRoute === 'LITE' ? 'report' : 'review'
    } else if (state.phase === 'review' || state.phase === 'refutation') {
      const receipt = laneEvidence(state.phase, event.outcome === 'changes-requested'); if (receipt) return receipt
      if (!['clear', 'changes-requested'].includes(event.outcome)) return refusal(`${state.phase}->next`, 'outcome clear or changes-requested', path.join(laneDir, `${state.phase}-report.md`))
      if (event.outcome === 'changes-requested' && (!Array.isArray(event.findings) || !event.findings.some((x) => String(x).trim()))) return refusal(`${state.phase}->harden`, 'findings', path.join(laneDir, `${state.phase}-report.md`))
      if (event.outcome === 'changes-requested' && ++state.reviewRound > 3) return refusal(`${state.phase}->harden`, 'available review round', path.join(laneDir, `${state.phase}-report.md`))
      next = state.phase === 'review' && event.outcome === 'clear' ? 'refutation' : state.phase === 'refutation' && event.outcome === 'clear' ? 'report' : 'harden'
    } else if (state.phase === 'report') {
      if (!fs.existsSync(path.join(laneDir, 'pilot-report.md'))) return refusal('report->awaiting_fidelity', 'pilot report', path.join(laneDir, 'pilot-report.md'))
      const receipt = snapshotEvidence('report->awaiting_fidelity'); if (receipt) return receipt
      const base = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      try {
        git('git', ['add', '-A'], { cwd: root })
        const report = fs.readFileSync(path.join(laneDir, 'pilot-report.md'), 'utf8')
        const subject = report.split(/\r?\n/).find(Boolean) ?? `pilot lifecycle ${cardId}`
        const body = `card: ${cardId}\nsession: ${sessionTag}\ntree: ${treeSignature(root)}\nevidence: ${sha256(fs.readFileSync(evidencePath))}`
        git('git', ['commit', '-m', subject.replace(/^#\s*/, ''), '-m', body], { cwd: root })
      } catch (error) { return refusal('report->awaiting_fidelity', `commit (${error instanceof Error ? error.message : String(error)})`, root) }
      const head = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      if (head === base) return refusal('report->awaiting_fidelity', 'changed HEAD', root)
      if (git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) return refusal('report->awaiting_fidelity', 'clean tree', root)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const archive = path.join(root, '.claude', 'reports', `${cardId}-${stamp}`)
      try {
        fs.mkdirSync(path.dirname(archive), { recursive: true })
        copy(laneDir, archive, { recursive: true, dereference: false })
        const manifest = { cardId, route: frozenRoute, commit: head, phases: [...state.handled.values()].map((item) => item.result), evidence: sha256(fs.readFileSync(evidencePath)) }
        const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`
        fs.writeFileSync(path.join(archive, 'manifest.json'), manifestContent)
        fs.writeFileSync(summaryPath, `${JSON.stringify({ commit: head, archive: { path: archive, manifest_sha256: sha256(manifestContent) }, lifecycle_implementation: { name: 'sdk-pilot-lifecycle', version: '1.0.0' } }, null, 2)}\n`)
      } catch (error) { return refusal('report->awaiting_fidelity', `archive (${error instanceof Error ? error.message : String(error)})`, archive) }
      next = 'awaiting_fidelity'
    }
    if (!next) return refusal(`${state.phase}->next`, 'outcome', laneDir)
    state.phase = next
    const result = `accepted phase=${next}`
    state.handled.set(event.tool_use_id, { shape, result })
    return result
  }
  async function waitForLaneReceipt(log, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      const entry = readAttestation(log)
      if (entry?.exit) return entry
      await pause(lanePollMs)
    }
    return null
  }
  async function run(args) {
    if (args.kind === 'lane') {
      if (!LANE_PHASES.has(state.phase) || args.phase !== state.phase) return refusal(`${state.phase}->next`, 'lane for current admitted phase', path.join(laneDir, `${args.phase ?? 'unknown'}-run.log`))
      const brief = path.join(laneDir, `${args.phase}-brief.md`)
      const log = path.join(laneDir, `${args.phase}-run.log`)
      const report = path.join(laneDir, `${args.phase}-report.md`)
      const launcher = laneLauncher ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wt-lane.mjs')
      const code = await promiseSpawn(process.execPath, [launcher, '--dir', root, '--model', frozenModels.review ?? frozenModels.lane, '--brief', brief, '--log', log, '--timeout', String(args.timeout ?? 5400)], { cwd: root })
      const logEntry = await waitForLaneReceipt(log, laneWaitMs ?? (args.timeout ?? 5400) * 1000)
      if (!logEntry) {
        saveEvidence({ path: log, size: 0, sha256: null, mtime: Date.now(), exit: 'missing' })
        return `lane ${args.phase} EXIT=missing`
      }
      const reportEntry = readAttestation(report)
      saveEvidence(logEntry); if (reportEntry) saveEvidence(reportEntry)
      state.lastLaneMtime = logEntry.mtime
      return `lane ${args.phase} EXIT=${code}`
    }
    if (args.kind === 'gate') {
      if (!GATES.has(args.name)) return refusal(`${state.phase}->next`, 'gate typecheck|lint|test', path.join(laneDir, `${args.name ?? 'unknown'}.log`))
      const log = path.join(laneDir, `${args.name}.log`)
      const code = await promiseSpawn('pnpm', [args.name], { cwd: path.join(root, 'toolkit'), stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')] })
      fs.appendFileSync(log, `\nEXIT=${code}\n`)
      saveEvidence({ ...readAttestation(log), tree: treeSignature(root) })
      return `gate ${args.name} EXIT=${code}`
    }
    if (args.kind === 'inspect') {
      const commands = { diff: ['diff', '--stat'], status: ['status', '--short'], log: ['-n', '1', path.join(laneDir, args.name ?? 'test.log')] }
      if (!Object.hasOwn(commands, args.what)) return refusal(`${state.phase}->next`, 'inspect diff|status|log', laneDir)
      return execFileSync(args.what === 'log' ? 'tail' : 'git', commands[args.what], { cwd: root, encoding: 'utf8' })
    }
    return refusal(`${state.phase}->next`, 'run kind lane|gate|inspect', laneDir)
  }
  async function artifact({ kind, content }) {
    const spec = ARTIFACTS[kind]
    if (!spec) return refusal(`${state.phase}->next`, 'known artifact kind', laneDir)
    if (state.phase !== spec[0]) return refusal(`${state.phase}->next`, `${kind} in phase ${spec[0]}`, path.join(laneDir, spec[1]))
    if (kind === 'critic-brief' && !fs.existsSync(path.join(laneDir, 'plan.md'))) return refusal('plan->critic', 'plan artifact', path.join(laneDir, 'plan.md'))
    if (kind === 'brief' && frozenRoute === 'FULL') {
      const planTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8'))
      if (!planTasks || tasksBlock(content) !== planTasks) return refusal('critic->tdd', 'byte-identical plan Tasks block', path.join(laneDir, 'brief.md'))
    }
    fs.writeFileSync(path.join(laneDir, spec[1]), content)
    return `wrote ${kind}`
  }
  const server = createSdkMcpServer({ name: 'sdk-pilot-lifecycle', version: '1.0.0', tools: [
    tool('transition', 'Advance the runner-owned lifecycle.', { phase: z.string(), route: z.string().optional(), outcome: z.string().optional(), findings: z.array(z.string()).optional(), tool_use_id: z.string() }, async (args) => {
      const prior = serial; let release; serial = new Promise((resolve) => { release = resolve }); await prior
      try { return { content: [{ type: 'text', text: transition(args) }] } } finally { release() }
    }),
    tool('write_artifact', 'Write a phase-bound lifecycle artifact.', { kind: z.string(), content: z.string() }, async (args) => ({ content: [{ type: 'text', text: await artifact(args) }] })),
    tool('run', 'Run a fixed lane, gate, or inspection command.', { kind: z.string(), phase: z.string().optional(), name: z.string().optional(), what: z.string().optional(), timeout: z.number().int().positive().optional() }, async (args) => ({ content: [{ type: 'text', text: await run(args) }] })),
  ] })
  Object.defineProperty(server, 'lifecycle', { value: lifecycle })
  return server
}
