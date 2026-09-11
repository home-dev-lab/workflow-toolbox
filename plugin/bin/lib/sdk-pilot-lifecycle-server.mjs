import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'

export const LIFECYCLE_SERVER_NAME = 'sdk-pilot-lifecycle'
export const LIFECYCLE_MCP_KEY = LIFECYCLE_SERVER_NAME
export const AWAITING_FIDELITY_RESULT = 'accepted phase=awaiting_fidelity'
export const lifecycleToolName = (name) => `mcp__${LIFECYCLE_MCP_KEY}__${name}`

const PHASES = ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'harden', 'report']
const LANE_PHASES = new Set(['tdd', 'critic', 'review', 'refutation', 'harden'])
const GATES = new Set(['typecheck', 'lint', 'test'])
const ARTIFACTS = {
  plan: ['plan', 'plan.md'], 'critic-brief': ['plan', 'critic-brief.md'], brief: ['tdd', 'tdd-brief.md'],
  'review-brief': ['review', 'review-brief.md'], 'refutation-brief': ['refutation', 'refutation-brief.md'],
  'harden-brief': ['harden', 'harden-brief.md'], 'pilot-report': ['report', 'pilot-report.md'],
}

function sha256(content) { return createHash('sha256').update(content).digest('hex') }
function terminalExit(content) { return /(?:^|\n)EXIT=([^\s\n]+)\s*$/.exec(content)?.[1] ?? null }
function readAttestation(file) {
  if (!fs.existsSync(file)) return null
  const content = fs.readFileSync(file, 'utf8'); const stat = fs.statSync(file)
  return { path: file, size: Buffer.byteLength(content), sha256: sha256(content), mtime: stat.mtimeMs, exit: terminalExit(content) }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function containsPlanShape(content) {
  const adr = /## ADR\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? ''
  const tasks = /## Tasks\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? ''
  const lines = tasks.split(/\r?\n/)
  const taskIndexes = lines.map((line, index) => /^\s*(?:- |\d+\. )/.test(line) ? index : -1).filter((index) => index >= 0)
  return /decision/i.test(adr) && /rejected/i.test(adr) && taskIndexes.length > 0 && taskIndexes.every((start, i) => lines.slice(start + 1, taskIndexes[i + 1] ?? lines.length).some((line) => /^\s*DoD:/i.test(line))) && /## Gates\b/i.test(content)
}
function tasksBlock(content) { return /## Tasks\b[\s\S]*?(?=\n## |$)/i.exec(content)?.[0] ?? null }
function promiseSpawn(program, args, options) {
  return new Promise((resolve, reject) => { const child = spawn(program, args, { ...options, shell: false }); child.once('error', reject); child.once('close', (code, signal) => resolve(signal ? 124 : (code ?? 1))) })
}
function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function refusal(edge, missing, file) { return `edge refused: ${edge}; missing ${missing}: ${file}` }

export function createLifecycleServer({ worktree, route, reasons = [], models, cardId, sessionTag, sdk = null, laneLauncher = null, lanePollMs = 25, laneWaitMs = null, gateRunner = null, git = execFileSync, copy = fs.cpSync }) {
  if (!path.isAbsolute(worktree)) throw new Error('lifecycle worktree must be absolute')
  if (!/^[A-Za-z0-9._-]+$/.test(String(cardId))) throw new Error('lifecycle cardId must match [A-Za-z0-9._-]+')
  const root = fs.realpathSync(worktree); const laneDir = path.join(root, '.lane'); const evidencePath = path.join(laneDir, 'evidence.json'); const summaryPath = path.join(laneDir, 'summary.json')
  const frozenRoute = String(route); const frozenModels = Object.freeze({ ...models }); const lifecycle = Object.freeze({ route: frozenRoute, models: frozenModels, cardId: String(cardId), sessionTag: String(sessionTag) })
  const bundledToolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../toolkit/package.json')
  const require = createRequire(fs.existsSync(path.join(root, 'toolkit/package.json')) ? path.join(root, 'toolkit/package.json') : bundledToolkit)
  const { createSdkMcpServer, tool } = sdk ?? require('@anthropic-ai/claude-agent-sdk'); const { z } = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  fs.mkdirSync(laneDir, { recursive: true }); fs.writeFileSync(path.join(laneDir, 'route.json'), `${JSON.stringify({ cardId, route: frozenRoute, reasons, models: frozenModels }, null, 2)}\n`, { flag: 'wx' })
  let state = { phase: 'discovery', planRound: 0, reviewRound: 0, handled: new Map(), lastLaneMtime: 0, verifySnapshot: null, commitDone: null }
  const attestations = new Map(); let serial = Promise.resolve()
  function audit() { fs.writeFileSync(evidencePath, `${JSON.stringify({ version: 1, entries: Object.fromEntries(attestations), verify_snapshot: state.verifySnapshot }, null, 2)}\n`) }
  function attest(file, extra = {}) { const entry = readAttestation(file); if (entry) { const saved = { ...entry, ...extra }; attestations.set(file, saved); audit(); return saved } return null }
  function verified(file) { const saved = attestations.get(file); const current = readAttestation(file); return saved && current && saved.size === current.size && saved.sha256 === current.sha256 && saved.mtime === current.mtime ? saved : null }
  function laneEvidence(phase, allowFailed = false) {
    const log = path.join(laneDir, `${phase}-run.log`); const report = path.join(laneDir, `${phase}-report.md`); const logEntry = verified(log)
    if (!logEntry) return refusal(`${phase}->next`, 'lane receipt unchanged', log)
    if (logEntry.exit !== '0' && !allowFailed) return refusal(`${phase}->next`, `lane receipt EXIT=${logEntry.exit ?? 'missing'}`, log)
    const reportEntry = verified(report); if (!reportEntry || reportEntry.size === 0) return refusal(`${phase}->next`, 'non-empty unchanged lane report', report)
    return null
  }
  function gatesEvidence(edge) {
    const currentTree = treeSignature(root)
    for (const name of GATES) { const file = path.join(laneDir, `${name}.log`); const item = verified(file); if (!item) return refusal(edge, 'unchanged gate receipt', file); if (item.exit !== '0') return refusal(edge, `gate receipt EXIT=${item.exit ?? 'missing'}`, file); if (item.tree !== currentTree) return refusal(edge, 'current tree signature', file); if (item.mtime < state.lastLaneMtime) return refusal(edge, 'gate newer than lane receipt', file) }
    return null
  }
  function verifySnapshot(edge) { const receipt = gatesEvidence(edge); if (receipt) return receipt; const gates = {}; for (const name of GATES) { const item = attestations.get(path.join(laneDir, `${name}.log`)); gates[name] = { path: item.path, sha256: item.sha256 } }; state.verifySnapshot = { tree: treeSignature(root), gates }; audit(); return null }
  function snapshotEvidence(edge) { const snapshot = state.verifySnapshot; if (!snapshot) return refusal(edge, 'verify digest snapshot', evidencePath); if (treeSignature(root) !== snapshot.tree) return refusal(edge, 'tree signature unchanged since verify', root); for (const saved of Object.values(snapshot.gates)) { const current = readAttestation(saved.path); if (!current || current.sha256 !== saved.sha256) return refusal(edge, `gate digest changed (${saved.sha256} != ${current?.sha256 ?? 'missing'})`, saved.path) } return null }
  function archive(head) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const target = path.join(root, '.claude', 'reports', `${cardId}-${stamp}`); const temporary = `${target}.tmp-${randomUUID()}`
    const manifest = { cardId, route: frozenRoute, commit: head, phases: [...state.handled.values()].map((item) => item.result).concat(AWAITING_FIDELITY_RESULT), evidence: sha256(fs.readFileSync(evidencePath)) }
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`; const summary = { commit: head, archive: { path: target, manifest_sha256: sha256(manifestContent) }, lifecycle_implementation: { name: LIFECYCLE_SERVER_NAME, version: '1.0.0' } }
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`); fs.mkdirSync(path.dirname(target), { recursive: true }); copy(laneDir, temporary, { recursive: true, dereference: false }); fs.writeFileSync(path.join(temporary, 'manifest.json'), manifestContent); fs.renameSync(temporary, target); return summary
  }
  function transition(event) {
    if (!event || typeof event !== 'object' || !PHASES.includes(event.phase)) return refusal('unknown->next', 'valid phase', laneDir)
    if (!event.tool_use_id) return refusal(`${state.phase}->next`, 'tool_use_id', laneDir)
    const shape = JSON.stringify(event); const previous = state.handled.get(event.tool_use_id); if (previous) return previous.shape === shape ? previous.result : refusal(`${state.phase}->next`, 'unique tool_use_id', laneDir)
    if (event.phase !== state.phase) return refusal(`${state.phase}->next`, `current phase ${state.phase}`, laneDir)
    let next = null
    if (state.phase === 'discovery') { if (event.route && event.route !== frozenRoute) return refusal('discovery->next', `runner route ${frozenRoute} (${reasons.join(', ')})`, path.join(laneDir, 'route.json')); next = frozenRoute === 'LITE' ? 'tdd' : 'plan' }
    else if (state.phase === 'plan') { const plan = path.join(laneDir, 'plan.md'); if (!fs.existsSync(plan) || !containsPlanShape(fs.readFileSync(plan, 'utf8'))) return refusal('plan->critic', 'valid plan artifact', plan); next = 'critic' }
    else if (state.phase === 'critic') { const receipt = laneEvidence('critic', event.outcome === 'changes-requested'); if (receipt) return receipt; if (event.outcome === 'approved') { const digest = sha256(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8')); if (!fs.readFileSync(path.join(laneDir, 'critic-report.md'), 'utf8').includes(digest)) return refusal('critic->tdd', 'plan sha256', path.join(laneDir, 'critic-report.md')); next = 'tdd' } else if (event.outcome === 'changes-requested' && ++state.planRound <= 3) next = 'plan'; else return refusal('critic->next', 'admissible outcome', path.join(laneDir, 'critic-report.md')) }
    else if (state.phase === 'tdd' || state.phase === 'harden') { const receipt = laneEvidence(state.phase); if (receipt) return receipt; if (state.phase === 'tdd' && frozenRoute === 'FULL') { const planTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8')); const briefTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'tdd-brief.md'), 'utf8')); if (!planTasks || planTasks !== briefTasks) return refusal('tdd->verify', 'byte-identical plan Tasks block', path.join(laneDir, 'tdd-brief.md')) } next = 'verify' }
    else if (state.phase === 'verify') { if (event.outcome !== 'passed') return refusal('verify->next', 'outcome passed', laneDir); const receipt = verifySnapshot('verify->next'); if (receipt) return receipt; next = frozenRoute === 'LITE' ? 'report' : 'review' }
    else if (state.phase === 'review' || state.phase === 'refutation') { const receipt = laneEvidence(state.phase, event.outcome === 'changes-requested'); if (receipt) return receipt; if (!['clear', 'changes-requested'].includes(event.outcome)) return refusal(`${state.phase}->next`, 'outcome clear or changes-requested', path.join(laneDir, `${state.phase}-report.md`)); if (event.outcome === 'changes-requested' && (!Array.isArray(event.findings) || !event.findings.some((x) => String(x).trim()))) return refusal(`${state.phase}->harden`, 'findings', path.join(laneDir, `${state.phase}-report.md`)); if (event.outcome === 'changes-requested' && ++state.reviewRound > 3) return refusal(`${state.phase}->harden`, 'available review round', path.join(laneDir, `${state.phase}-report.md`)); next = state.phase === 'review' && event.outcome === 'clear' ? 'refutation' : state.phase === 'refutation' && event.outcome === 'clear' ? 'report' : 'harden' }
    else if (state.phase === 'report') {
      if (!fs.existsSync(path.join(laneDir, 'pilot-report.md'))) return refusal('report->awaiting_fidelity', 'pilot report', path.join(laneDir, 'pilot-report.md')); const receipt = snapshotEvidence('report->awaiting_fidelity'); if (receipt) return receipt
      try { if (!state.commitDone) { const base = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); git('git', ['add', '-A'], { cwd: root }); if (treeSignature(root) !== state.verifySnapshot.tree) { git('git', ['reset'], { cwd: root }); return refusal('report->awaiting_fidelity', 'tree signature unchanged after staging', root) }; const report = fs.readFileSync(path.join(laneDir, 'pilot-report.md'), 'utf8'); git('git', ['commit', '-m', (report.split(/\r?\n/).find(Boolean) ?? `pilot lifecycle ${cardId}`).replace(/^#\s*/, ''), '-m', `card: ${cardId}\nsession: ${sessionTag}\ntree: ${treeSignature(root)}\nevidence: ${sha256(fs.readFileSync(evidencePath))}`], { cwd: root }); const head = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); if (head === base) return refusal('report->awaiting_fidelity', 'changed HEAD', root); if (git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) return refusal('report->awaiting_fidelity', 'clean tree', root); state.commitDone = head } archive(state.commitDone) } catch (error) { return refusal('report->awaiting_fidelity', `${state.commitDone ? 'archive' : 'commit'} (${error instanceof Error ? error.message : String(error)})`, root) }
      next = 'awaiting_fidelity'
    }
    if (!next) return refusal(`${state.phase}->next`, 'outcome', laneDir); state.phase = next; const result = next === 'awaiting_fidelity' ? AWAITING_FIDELITY_RESULT : `accepted phase=${next}`; state.handled.set(event.tool_use_id, { shape, result }); return result
  }
  async function waitForLaneReceipt(log, timeoutMs, launchedAt) { const deadline = Date.now() + timeoutMs; while (Date.now() <= deadline) { const entry = readAttestation(log); if (entry?.exit && entry.mtime >= launchedAt && entry.size > 0) return entry; await pause(lanePollMs) } return null }
  async function run(args) {
    if (!args || typeof args !== 'object') return refusal(`${state.phase}->next`, 'run arguments object', laneDir)
    if (args.kind === 'lane') {
      if (!LANE_PHASES.has(state.phase) || args.phase !== state.phase) return refusal(`${state.phase}->next`, 'lane for current admitted phase', path.join(laneDir, `${args.phase ?? 'unknown'}-run.log`))
      const phase = args.phase; const brief = path.join(laneDir, `${phase}-brief.md`); const log = path.join(laneDir, `${phase}-run.log`); const report = path.join(laneDir, `${phase}-report.md`); const launch = path.join(laneDir, `${phase}-launch.json`); const timeout = Math.min(args.timeout ?? 5400, 5400); const launchedAt = Date.now()
      fs.rmSync(log, { force: true }); fs.rmSync(report, { force: true }); fs.writeFileSync(launch, `${JSON.stringify({ nonce: randomUUID(), started: launchedAt })}\n`)
      try { await promiseSpawn(process.execPath, [laneLauncher ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wt-lane.mjs'), '--dir', root, '--model', (phase === 'tdd' || phase === 'harden' ? frozenModels.lane : frozenModels.review), '--brief', brief, '--log', log, '--timeout', String(timeout)], { cwd: root }) } catch (error) { return refusal(`${state.phase}->next`, `lane spawn (${error instanceof Error ? error.message : String(error)})`, log) }
      const logEntry = await waitForLaneReceipt(log, (laneWaitMs ?? timeout * 1000), launchedAt); if (!logEntry) return `lane ${phase} EXIT=missing`; const reportEntry = attest(report); attest(log); state.lastLaneMtime = logEntry.mtime; return `lane ${phase} EXIT=${logEntry.exit}`
    }
    if (args.kind === 'gate') { if (!GATES.has(args.name)) return refusal(`${state.phase}->next`, 'gate typecheck|lint|test', path.join(laneDir, `${args.name ?? 'unknown'}.log`)); const log = path.join(laneDir, `${args.name}.log`); let code; try { if (gateRunner) code = await gateRunner({ name: args.name, log, root }); else { const out = fs.openSync(log, 'w'); const err = fs.openSync(log, 'a'); try { code = await promiseSpawn('pnpm', [args.name], { cwd: path.join(root, 'toolkit'), stdio: ['ignore', out, err] }) } finally { fs.closeSync(out); fs.closeSync(err) } } } catch (error) { return refusal(`${state.phase}->next`, `gate spawn (${error instanceof Error ? error.message : String(error)})`, log) } fs.appendFileSync(log, `\nEXIT=${code}\n`); attest(log, { tree: treeSignature(root) }); return `gate ${args.name} EXIT=${code}` }
    if (args.kind === 'inspect') { const allowed = [...GATES].map((name) => `${name}.log`).concat(PHASES.filter((phase) => LANE_PHASES.has(phase)).flatMap((phase) => [`${phase}-run.log`, `${phase}-report.md`])); if (!['diff', 'status', 'log'].includes(args.what)) return refusal(`${state.phase}->next`, 'inspect diff|status|log', laneDir); if (args.what === 'log' && !allowed.includes(args.name)) return refusal(`${state.phase}->next`, `log name ${allowed.join('|')}`, laneDir); return execFileSync(args.what === 'log' ? 'tail' : 'git', args.what === 'log' ? ['-n', '1', path.join(laneDir, args.name)] : args.what === 'diff' ? ['diff', '--stat'] : ['status', '--short'], { cwd: root, encoding: 'utf8' }) }
    return refusal(`${state.phase}->next`, 'run kind lane|gate|inspect', laneDir)
  }
  async function artifact({ kind, content }) { const spec = ARTIFACTS[kind]; if (!spec) return refusal(`${state.phase}->next`, 'known artifact kind', laneDir); if (state.phase !== spec[0]) return refusal(`${state.phase}->next`, `${kind} in phase ${spec[0]}`, path.join(laneDir, spec[1])); if (kind === 'critic-brief' && !fs.existsSync(path.join(laneDir, 'plan.md'))) return refusal('plan->critic', 'plan artifact', path.join(laneDir, 'plan.md')); if (kind === 'brief' && frozenRoute === 'FULL') { const planTasks = tasksBlock(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8')); if (!planTasks || tasksBlock(content) !== planTasks) return refusal('critic->tdd', 'byte-identical plan Tasks block', path.join(laneDir, spec[1])) } fs.writeFileSync(path.join(laneDir, spec[1]), kind === 'critic-brief' ? `${content.replace(/\s*$/, '')}\nplan sha256: ${sha256(fs.readFileSync(path.join(laneDir, 'plan.md'), 'utf8'))}\n` : content); return `wrote ${kind}` }
  async function queued(work) { const prior = serial; let release; serial = new Promise((resolve) => { release = resolve }); await prior; try { return await work() } finally { release() } }
  const server = createSdkMcpServer({ name: LIFECYCLE_SERVER_NAME, version: '1.0.0', tools: [
    tool('transition', 'Advance the runner-owned lifecycle.', { phase: z.string(), route: z.string().optional(), outcome: z.string().optional(), findings: z.array(z.string()).optional(), tool_use_id: z.string() }, async (args) => ({ content: [{ type: 'text', text: await queued(() => transition(args)) }] })),
    tool('write_artifact', 'Write a phase-bound lifecycle artifact.', { kind: z.string(), content: z.string() }, async (args) => ({ content: [{ type: 'text', text: await queued(() => artifact(args)) }] })),
    tool('run', 'Run a fixed lane, gate, or inspection command.', { kind: z.string(), phase: z.string().optional(), name: z.string().optional(), what: z.string().optional(), timeout: z.number().int().positive().optional() }, async (args) => ({ content: [{ type: 'text', text: await queued(() => run(args)) }] })),
  ] })
  Object.defineProperty(server, 'lifecycle', { value: lifecycle }); return server
}
