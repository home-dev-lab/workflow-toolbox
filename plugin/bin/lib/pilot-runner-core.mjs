import { resolveWorkflowToolboxOption } from './plugin-options.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AWAITING_FIDELITY_RESULT, createLifecycleServer, LIFECYCLE_MCP_KEY, lifecycleToolName } from './sdk-pilot-lifecycle-server.mjs'
import { MAX_CRITIC_ROUNDS, PHASES, PLAN_SHAPE_DESCRIPTION } from './lifecycle-state-machine.mjs'
import { deriveRoute } from './route-from-card.mjs'
import { cardDefinitionOfDone } from './card-definition-of-done.mjs'
import { resolveExecutorProfile as defaultResolveExecutorProfile } from './pilot-model-config.mjs'
import { resolveRoleVariant } from './lane-model-allowlist.mjs'
import { phaseLaunchPlan, readRegularFile } from './lifecycle-launch.mjs'
import { knowledgeBasePromptLine, knowledgeBaseReadAllowed, resolveKnowledgeBaseIndex } from './knowledge-base-index.mjs'
import { composeStandingPrompt, loadRules } from './rules-manifest.mjs'
import { appendCostReport, computeRunCost, unknownRunCost } from './run-cost-core.mjs'
import { createBoardClient } from './board-http-client.mjs'
import { assertSdkRoleReceipt, composeSdkRoleQueryOptions, isPreInitNotice, prepareSdkRole, withRepositoryInstructions } from './sdk-role-profile.mjs'
import { assertCostReportMatches, writeWorktreeRetentionMarker } from './lifecycle-report-edge.mjs'
import { DOD_DECISION_WAIT_MS, FALLBACK_RULE } from './lifecycle-dod-dispute.mjs'
import { bindPilotDecision, displayedDecisionStateRoot, initializePilotDecisionStore, pilotDecisionCli, pilotDecisionCommand, pilotDecisionStateRoot, readPilotBinding, readPilotDecisions, registerPilotDecisionRequest, unregisterPilotDecisionRequest } from './host/pilot-decision-store.mjs'
import { laneUnsandboxedAtStart } from './host/lane-sandbox.mjs'
import { sandboxWritablePaths } from './host/sandbox-extra-paths.mjs'
import { pathWithin } from './host/path-within.mjs'
import { createModelTracker, modelWarnings } from './model-fallback-core.mjs'
import { createAccountGate } from './sdk-account-check.mjs'
import { phaseManifest, phaseOpener, phaseRules } from './pilot-phase-session.mjs'
import { bindingDecisionsSection } from './lifecycle-dod-dispute.mjs'
import { assertCleanPilotStart } from './lifecycle-selection.mjs'
import { resolveLifecycleGates } from './lifecycle-gates.mjs'
import { createParentWakeManager, validateParentWakeOptions, wakeCommandLine } from './pilot-parent-wake.mjs'
import { hostAdapter } from './host/adapter.mjs'
import { finalizePilotLifecycle, observeBlockedRun } from './pilot-blocked-run.mjs'

export const ROUTE_TIMEOUTS = Object.freeze({ LITE: 5_400, FULL: 21_600 })
const ROUTE_EXPECTED_SECONDS = Object.freeze({ LITE: 5_400, FULL: 11_460 })
const POLL_MS = 250
const MAX_UNPRODUCTIVE_TURNS = 3
// After a boundary deny the CLI normally ends the turn at once; a session that produces no result within this bound
// is aborted alone, and the next phase still opens.
const NO_RESULT_AFTER_DENY_MS = 120_000
const PHASE_SESSION_FIELDS = ['phase', 'round', 'started_at', 'ended_at', 'ended_by', 'calls', 'first_call', 'last_call', 'late_turn_ends', 'calls_after_boundary', 'denied_after_boundary', 'permission_denials', 'terminal_reason', 'closing_error']
const MAILBOX_PREFIX = 'Unauthenticated mailbox note (lane-writable; not an owner decision): '
const GROUNDING_INITIAL_PROMPT = 'Before planning, ground external sources against the code and use small PoCs where sources do not settle. For a URL source, call `ctx_fetch_and_index`. Record confirmed / refuted / undecidable verdicts; treat `refused-by-classifier` and `unreachable-source` as named outcomes, then route CANCEL, REFRAME, or proceed.'
// A phase routinely runs for many minutes, so a 30-second grace would make the clean boundary stop dead code:
// ten minutes lets a phase that is about to finish reach its boundary, and still bounds a hung one.
export const TIMEOUT_BOUNDARY_GRACE_MS = 10 * 60_000
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const NEXT_BY_PHASE = {
  discovery: 'transition discovery using the frozen route',
  plan: `write the plan matching ${PLAN_SHAPE_DESCRIPTION}, then transition plan`,
  critic: `write the critic brief, run the critic lane, then transition critic; if critic round ${MAX_CRITIC_ROUNDS} requests blocking changes, transition with outcome changes-requested; the server routes a spent bound to report`,
  tdd: 'write the tdd brief, run the tdd lane, then transition tdd',
  review: 'write the review brief, run the review lane, then transition review; blocking findings return to a TDD fix round, while mechanical non-convergence escalates with the unresolved findings',
  refutation: 'write the refutation brief, run the refutation lane, then transition refutation; blocking findings return to a TDD fix round, while mechanical non-convergence escalates with the unresolved findings',
  report: 'write the pilot report, then transition report',
}
// The plan->critic edge refuses any other shape, so a route that plans learns it before its first plan, not from a refusal.
const planShapeLine = (route) => (route === 'FULL' ? ` When you write the plan, it must match ${PLAN_SHAPE_DESCRIPTION}.` : '')
const nextPhaseTask = (phase, root) => phase === 'verify'
  ? `run every required gate ${[...resolveLifecycleGates(root)].join('|')}, then transition verify with outcome passed only when all exits are 0; for outcome failed supply canonical findings gate <name> EXIT=<actual exit> for required red gates or exact extracted failed-test names. Adapter detection or empty extraction cannot block attested gate recovery: use gate test EXIT=<actual exit> when names are unavailable. The runner carries every red gate, available failed-test names, and receipt paths to the TDD fix context`
  : NEXT_BY_PHASE[phase] ?? 'continue the lifecycle'
const PLANKA_TOOLS = new Set([
  'mcp__planka__get_card',
  'mcp__planka__get_comments',
  'mcp__planka__add_comment',
  'mcp__planka__update_card',
  'mcp__planka__move_card',
  'mcp__planka__add_label_to_card',
])
const PILOT_VALUE_FLAGS = new Map([
  ['--card', 'card'], ['--card-file', 'cardFile'], ['--dir', 'dir'], ['--profile-env', 'profileEnv'],
  ['--contract', 'contract'], ['--board-contract', 'boardContract'], ['--mailbox', 'mailbox'],
  ['--knowledge-base-index', 'knowledgeBaseIndex'], ['--archive-root', 'archiveRoot'],
  ['--parent-session', 'parentSession'], ['--parent-mode', 'parentMode'],
])

// A piece-test option: the run ends at the boundary leaving this phase. `report` is the end already.
const STOP_AFTER_PHASES = PHASES.filter((phase) => phase !== 'report')

// LITE goes discovery -> tdd and verify -> report (lifecycle-state-machine.mjs), so plan, critic, review and
// refutation are never left: a stop there would let the whole run through without stopping.
const ROUTE_LEAVES = Object.freeze({ LITE: Object.freeze(['discovery', 'tdd', 'verify']), FULL: STOP_AFTER_PHASES })

function assertStopAfterReachable(route, stopAfter) {
  if (stopAfter && !ROUTE_LEAVES[route].includes(stopAfter)) throw new Error(`--stop-after ${stopAfter} is never reached on the ${route} route; it leaves only these phases: ${ROUTE_LEAVES[route].join(', ')}`)
}

function assignStopAfter(options, value) {
  options.stopAfter = value ?? null
  if (!STOP_AFTER_PHASES.includes(options.stopAfter)) return { error: `--stop-after must be one of: ${STOP_AFTER_PHASES.join(', ')}` }
}

function resolvePilotPaths(options) {
  options.dir = resolve(options.dir)
  options.contract = resolve(options.contract ?? join(MODULE_DIR, '../../autonomy/PILOT-CONTRACT.md'))
  options.mailbox = resolve(options.mailbox ?? join(options.dir, '.lane', 'pilot-mailbox.txt'))
  if (options.profileEnv) options.profileEnv = resolve(options.profileEnv)
  if (options.cardFile) options.cardFile = resolve(options.cardFile)
  if (options.archiveRoot) options.archiveRoot = resolve(options.archiveRoot)
  if (options.boardContract) options.boardContract = resolve(options.boardContract)
  return options
}

function derivePilotRoute(cardText, options) {
  const routing = deriveRoute(cardText)
  assertStopAfterReachable(routing.route, options.stopAfter)
  return routing
}

export function parsePilotRunnerArgs(argv) {
  const options = { card: null, cardFile: null, dir: null, profileEnv: null, expectAccount: null, contract: null, boardContract: null, hard: false, mailbox: null, knowledgeBaseIndex: null, archiveRoot: null, pluginDirs: [], timeout: null, timeoutExplicit: false, stopAfter: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const valueKey = PILOT_VALUE_FLAGS.get(arg)
    if (valueKey) options[valueKey] = argv[++i] ?? null
    else if (arg === '--expect-account') {
      options.expectAccount = argv[++i] ?? null
      if (!options.expectAccount?.trim() || options.expectAccount.startsWith('--')) return { error: '--expect-account requires an e-mail' }
    }
    else if (arg === '--plugin-dir') {
      const pluginDir = argv[++i] ?? ''
      if (!isAbsolute(pluginDir)) return { error: `--plugin-dir must be an absolute path: ${pluginDir}` }
      options.pluginDirs.push(resolve(pluginDir))
    }
    else if (arg === '--timeout') { options.timeout = Number(argv[++i]); options.timeoutExplicit = true }
    else if (arg === '--stop-after') {
      const error = assignStopAfter(options, argv[++i])
      if (error) return error
    }
    else if (arg === '--hard') options.hard = true
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  const parentError = validateParentWakeOptions(options)
  if (parentError) return { error: parentError }
  if (!options.card || !options.dir) return { error: 'missing required --card or --dir' }
  if (!options.cardFile) return { error: '--card-file is required: the route is derived from the card' }
  if (options.timeout !== null && (!Number.isFinite(options.timeout) || options.timeout <= 0)) return { error: '--timeout must be a positive number of seconds' }
  return resolvePilotPaths(options)
}

export function loadBoardContract(value, readFile = readFileSync) {
  if (!value) return null
  let contract = value
  if (typeof value === 'string') {
    try { contract = JSON.parse(readFile(value, 'utf8')) } catch (error) { throw new Error(`cannot read --board-contract: ${error.message}`) }
  }
  const fields = [
    ['boardId', contract?.boardId], ['listId', contract?.listId], ['labels.category', contract?.labels?.category],
    ...['P0', 'P1', 'P2'].map((key) => [`labels.priority.${key}`, contract?.labels?.priority?.[key]]),
    ...['bug', 'chore', 'feature', 'research'].map((key) => [`labels.type.${key}`, contract?.labels?.type?.[key]]),
    ...['S', 'M', 'L'].map((key) => [`labels.effort.${key}`, contract?.labels?.effort?.[key]]),
  ]
  const invalid = fields.find(([, field]) => typeof field !== 'string' || !field)
  if (invalid) throw new Error(`--board-contract requires non-empty ${invalid[0]}`)
  return contract
}

// Where a lifecycle archive lands when nothing names it: the project root when the caller resolved one,
// else the main checkout that OWNS the worktree (`--git-common-dir` is `<main>/.git` from any worktree).
// A plain repository resolves to itself and is refused at preflight — there is no outside to archive to.
export function defaultArchiveRoot({ dir, projectRoot = null }) {
  if (projectRoot) return resolve(projectRoot)
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (common) return dirname(common)
  } catch {}
  return resolve(dir)
}

export function loadProfileEnv(file) {
  if (!file) return {}
  let parsed
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { throw new Error(`cannot read --profile-env: ${error.message}`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
    throw new Error('--profile-env must be a settings JSON object with an env object')
  }
  for (const [key, value] of Object.entries(parsed.env)) if (typeof value !== 'string') throw new Error(`--profile-env env.${key} must be a string`)
  return parsed.env
}

// The real SDK stream delivers a tool result as content blocks (`[{ type: 'text', text }]`); a text
// block yields its text alone — concatenating every object value put "text" in front of the lifecycle
// result and neither the completion equality nor the progress count matched (real run 2, 2026-09-11).
function textFrom(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFrom).join('\n')
  if (value && typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    return Object.values(value).map(textFrom).join('\n')
  }
  return ''
}

// Resolve through existing symlinks before comparing, so lexical `..` and links cannot escape.
function resolvedExisting(absolute) {
  let probe = absolute
  const suffix = []
  while (!existsSync(probe)) { suffix.unshift(basename(probe)); probe = dirname(probe) }
  return resolve(realpathSync(probe), ...suffix)
}

export function confinedToWorktree(root, requested, paths = null) {
  if (paths) return pathWithin(root, requested, paths)
  const absolute = resolve(root, typeof requested === 'string' ? requested : '.')
  return pathWithin(resolvedExisting(resolve(root)), resolvedExisting(absolute))
}

export function lifecycleCanUseTool(worktree, toolName, input, { boardMoves = true, knowledgeBaseIndex = null, profile = null, pathOps = null } = {}) {
  if (['transition', 'write_artifact', 'route_finding', 'run'].map(lifecycleToolName).includes(toolName)) return { behavior: 'allow' }
  if (toolName === 'mcp__planka__move_card' && !boardMoves) return { behavior: 'deny', message: 'board moves are the orchestrator\'s' }
  if (PLANKA_TOOLS.has(toolName)) return { behavior: 'allow' }
  if (profile?.tools.includes(toolName) && !['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'].includes(toolName)) return { behavior: 'allow' }
  if (!['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'deny', message: `tool refused: ${toolName}` }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { behavior: 'deny', message: `invalid tool input: ${toolName}` }
  const requested = input.file_path ?? input.path ?? worktree
  if (typeof requested !== 'string') return { behavior: 'deny', message: `invalid path: ${String(requested)}` }
  if (toolName === 'Read' && knowledgeBaseReadAllowed(knowledgeBaseIndex, requested)) return { behavior: 'allow' }
  const pattern = toolName === 'Glob' ? input.pattern : (input.glob ?? input.pattern)
  if ((toolName === 'Glob' || toolName === 'Grep') && typeof pattern === 'string' && /[\\/]/.test(pattern)) {
    const segments = pattern.split(/[\\/]/)
    const wildcard = segments.findIndex((segment) => /[*?[{]/.test(segment))
    const prefix = segments.slice(0, wildcard < 0 ? segments.length : wildcard).join('/') || '.'
    const base = input.path ?? worktree
    const requestedPrefix = (pathOps ?? { resolve }).resolve(worktree, base, prefix)
    if (!confinedToWorktree(worktree, requestedPrefix, pathOps)) return { behavior: 'deny', message: `path outside worktree: ${pattern}` }
  }
  return confinedToWorktree(worktree, requested, pathOps) ? { behavior: 'allow' } : { behavior: 'deny', message: `path outside worktree: ${requested}` }
}

function usageOf(message) {
  const usage = message.usage ?? {}
  return {
    input: usage.input_tokens ?? 0,
    cache_creation: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  }
}

function addModelUsage(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return
  for (const [model, usage] of Object.entries(source)) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
    const total = target[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0 }
    for (const field of Object.keys(total)) total[field] += Number(usage[field]) || 0
    target[model] = total
  }
}

function servedModelAgreement({ requestedModel, servedModel, servedModelFirstTurn, initReceiptSeen, firstAssistantSeen }) {
  if (!initReceiptSeen) return 'unknown (initialization receipt never arrived)'
  if (servedModel === undefined) return 'unknown (init receipt carries no model)'
  if (!firstAssistantSeen) return 'unknown (stream carries no assistant message)'
  if (servedModelFirstTurn === undefined) return 'unknown (first assistant message carries no model)'
  // Agreement is between the two SDK readings of what was SERVED (the init receipt and the first
  // assistant message). The requested value is an ALIAS or a full id the resolver chose; a remapped
  // profile serves a different id on purpose, so string-equality against the request would read
  // `false` on every correct remap. The request is recorded beside, for the reader, never compared.
  if (servedModel === servedModelFirstTurn) return true
  return `false (served_model=${servedModel}, served_model_first_turn=${servedModelFirstTurn}; requested_model=${requestedModel})`
}

const RECEIPT_ERROR = 'SDK pilot initialization receipt is missing plugins or lifecycle tools: '

function assertPilotInitReceipt(message, sdkRole) {
  const initTools = Array.isArray(message.tools) ? message.tools : []
  const missing = ['transition', 'write_artifact', 'route_finding', 'run'].map(lifecycleToolName).filter((tool) => !initTools.includes(tool))
  try { assertSdkRoleReceipt('pilot', message, sdkRole) } catch (error) {
    throw new Error(RECEIPT_ERROR + (error instanceof Error ? error.message : String(error)), { cause: error })
  }
  if (missing.length > 0) throw new Error(RECEIPT_ERROR + JSON.stringify({ missingTools: missing, tools: initTools }))
}

function reconciledCostReport({ reportContent, cost, archive, report, dir, parentWakes }) {
  if (reportContent.includes('<!-- run-cost -->')) {
    assertCostReportMatches({ report: reportContent, cost, reportPath: archive ? join(archive, 'pilot-report.md') : report, costPath: archive ? join(archive, 'cost.json') : join(dir, '.lane', 'cost.json') })
  }
  const wakeNote = parentWakes.length > 0 ? '\nParent wake usage: separately reported in summary.parent_wakes; excluded from pilot totals.\n' : ''
  return appendCostReport(reportContent + wakeNote, cost)
}

function costPublicationFailure(error, archive, priorError, log) {
  if (!archive) {
    log(`cost receipt unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return priorError
  }
  rmSync(archive, { recursive: true, force: true })
  log(`archive publication refused: ${error instanceof Error ? error.message : String(error)}`)
  return priorError ?? error
}

let atomicWriteSerial = 0
function atomicWrite(file, content, writeFile = writeFileSync) {
  atomicWriteSerial += 1
  const temporary = `${file}.${process.pid}.${atomicWriteSerial}.tmp`
  try {
    writeFile(temporary, content, { flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

// One total per BILLED class, never a grand sum: classes are priced differently and OpenAI output already
// includes reasoning, so adding them double-counts (owner, wt-suite #2913).
function indexedCostTotals(cost) {
  if (!Array.isArray(cost?.phases)) return { phase_totals: {}, run_total: 'unknown' }
  const fields = ['input', 'cache_write', 'cache_read', 'output', 'reasoning']
  const phaseTotals = {}
  const runTotal = Object.fromEntries(fields.map((field) => [field, 0]))
  for (const phase of cost.phases) {
    const target = phaseTotals[phase.phase] ?? { ...Object.fromEntries(fields.map((field) => [field, 0])), usd: 0 }
    for (const model of Object.values(phase.models ?? {})) for (const field of fields) {
      if (typeof model[field] === 'number') { target[field] += model[field]; runTotal[field] += model[field] }
    }
    target.usd = target.usd === 'price unknown' || phase.usd === 'price unknown' ? 'price unknown' : target.usd + (Number(phase.usd) || 0)
    phaseTotals[phase.phase] = target
  }
  return { phase_totals: phaseTotals, run_total: runTotal, usd_total: cost.totals?.usd ?? 'price unknown' }
}

function appendCostIndex({ archiveRoot, runId, card, route, cost, started, ended, archive, log }) {
  try {
    appendFileSync(join(archiveRoot, '.claude', 'reports', 'cost-index.jsonl'), `${JSON.stringify({
      run_id: runId,
      card: String(card),
      route,
      ...indexedCostTotals(cost),
      coverage: cost.coverage,
      started_at: new Date(started).toISOString(),
      ended_at: new Date(ended).toISOString(),
      archive_path: archive ?? null,
    })}\n`)
    return null
  } catch (error) {
    log(`cost index unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return error
  }
}

// A run that can need routing must know at launch that it cannot route, or it discovers it
// after a full critic cycle. LITE counts only when its contract exposes route_finding.
function missingBoardContractWarning(boardContract, route, contract) {
  if (boardContract) return null
  if (route !== 'FULL' && !/\broute_finding\b/.test(contract)) return null
  return 'warning: no board contract; findings that must be routed will end the run partial; relaunch with --board-contract <json file>'
}

function lifecycleDelivery(summary, state) {
  return {
    partial: summary.partial ?? state.partial ?? null,
    deferred: summary.deferred ?? state.deferred ?? null,
  }
}
// Effective effort and executor family per role, resolved exactly as lifecycle-launch resolves them at
// launch time, so the run summary states what each lane runs at and on which family. An override the
// launch would refuse is recorded as unresolved rather than aborting the run here.
function describeExecutorVariants(models, env, defaultExecutor) {
  return Object.fromEntries(Object.entries(models ?? {}).map(([role, model]) => {
    try {
      const { executor, variant: { value, origin } } = phaseLaunchPlan(role, model, defaultExecutor, env)
      return [role, { value, origin, executor }]
    } catch (error) {
      return [role, { value: null, origin: 'unresolved', error: error instanceof Error ? error.message : String(error) }]
    }
  }))
}
// The request is lane-visible; the answer and binding are host-state records.
function parentDecisionChannel({ runId, stateFile, cli, log, root, wake, overrides = {} }) {
  const minutes = Math.ceil((overrides.waitMs ?? DOD_DECISION_WAIT_MS) / 60_000)
  const readDecisions = overrides.readDecisions ?? (() => readPilotDecisions(stateFile))
  const command = (suffix) => pilotDecisionCommand(cli, runId, process.execPath, root, undefined, suffix)
  return {
    decisionCommand: command,
    onDecisionRequest: ({ criteria, requestId, deadline }) => {
      registerPilotDecisionRequest(stateFile, { requestId, criteria, deadline })
    },
    onPublished: ({ file, criteria, requestId }) => {
      const disputed = criteria.map((criterion) => `DoD ${criterion}`).join(', ')
      const answer = command(` --request '${requestId}' --dod <n> --reading <text>`)
      log(`decision request: ${file} — request ${requestId} disputes ${disputed}; the run's parent invokes within ${minutes} min (otherwise ${FALLBACK_RULE}):\n${answer}`)
      wake.start({ runId, requestId, criteria, requestFile: file, command: wakeCommandLine(answer, hostAdapter.platform) })
    },
    rollbackDecisionRequest: ({ criteria, requestId }) => unregisterPilotDecisionRequest(stateFile, { criteria, requestId }),
    onBound: (dispute) => {
      try { return bindPilotDecision(stateFile, { requestId: dispute.requestId, criterion: dispute.criterion, source: dispute.resolution.source, at: dispute.resolution.at, resolution: dispute.resolution }) } catch (error) {
        let winner
        try { winner = readPilotBinding(stateFile, dispute.requestId, dispute.criterion) } catch (readError) {
          throw new Error(`decision store binding failed: ${error.message}; winner unreadable: ${readError.message}`, { cause: readError })
        }
        if (winner) return winner
        throw new Error(`decision store binding failed: ${error.message}; no readable winner`, { cause: error })
      }
    },
    log,
    ...overrides,
    readDecisions,
  }
}
function completedPilotExitCode(completed, partial, deferred) {
  if (!completed) return 1
  return partial || deferred ? 2 : 0
}

function assertDecisionStateOutsideWritable(dir, stateRoot, writableEnv, home) {
  if (confinedToWorktree(dir, stateRoot)) throw new Error(`SDK pilot preflight failed: decision state must be outside the lane-writable worktree: ${stateRoot}`)
  // The worktree check holds on every platform; only the bwrap extra-write overlap is Linux-only.
  const writablePaths = sandboxWritablePaths(writableEnv)
  if (writablePaths === null) return
  for (const writable of writablePaths) {
    const absolute = resolve(writable.startsWith(`~${sep}`) ? join(home, writable.slice(2)) : writable)
    if (confinedToWorktree(stateRoot, absolute) || confinedToWorktree(absolute, stateRoot)) throw new Error(`SDK pilot preflight failed: decision state overlaps WT_LANE_SANDBOX_WRITE: ${absolute}`)
  }
}

function announceDecisionBoundary(env, log) {
  if (laneUnsandboxedAtStart(env)) log('warning: unsandboxed lane: same-user processes can submit parent decisions; sandbox isolation is the authority boundary')
}

function assertPluginDirs(pluginDirs) {
  if ((pluginDirs ?? []).some((pluginDir) => !isAbsolute(pluginDir))) throw new Error('--plugin-dir must be an absolute path')
}
function assertRunnerOptions(options) {
  assertPluginDirs(options.pluginDirs)
  const error = validateParentWakeOptions(options)
  if (error) throw new Error(error)
}

function pilotModelSetup({ options, effectiveEnv, env, profileEnv, exists, resolvePilotModels }) {
  const knowledgeBase = resolveKnowledgeBaseIndex({ promptValue: options.knowledgeBaseIndex, env: effectiveEnv, projectRoot: options.knowledgeBaseProjectRoot ?? options.dir, exists })
  const models = resolvePilotModels({ env, settingsEnv: profileEnv })
  const model = options.hard ? (models.sdkPilotHard ?? models.pilotHard) : (models.sdkPilot ?? models.pilot)
  const modelVariant = model.variant ?? resolveRoleVariant(options.hard ? 'sdkPilotHard' : 'sdkPilot', model.effective, { env, settingsEnv: profileEnv })
  return { knowledgeBase, model, modelVariant }
}

function assertCardFile(cardFile) {
  if (!cardFile) throw new Error('--card-file is required: the route is derived from the card')
}

function assertCardDefinitionOfDone(cardText) {
  if (cardDefinitionOfDone(cardText).length === 0) throw new Error('SDK pilot preflight failed: ask the owner to add a Definition of done to the card')
}

async function waitForPlanBinding(lifecycleServer) {
  if (lifecycleServer.state().phase === 'plan' && lifecycleServer.dodDisputes().some((dispute) => !dispute.resolution)) await lifecycleServer.awaitDodDecisions()
}

function partialInstruction(partial) {
  return partial.reason.startsWith('route_finding refused: no board contract;')
    ? `The run is partial (${partial.reason}): write the pilot report with "Partial: ${partial.reason}" as its first line, then transition report.`
    : `The run is partial (${partial.reason}): write the pilot report with the line "Partial: ${partial.reason}", then transition report.`
}

function bindingNotice(disputes) {
  return disputes.map((dispute) => ` Binding decision on DoD ${dispute.criterion} (${dispute.resolution.source}, runner-owned): ${dispute.resolution.reading}; ${dispute.resolution.criticRule ?? ''}`).join('')
}

function classifyStreamFailure(error, { timeoutBoundary, graceAborted, initReceiptSeen, incompleteReason }) {
  if (timeoutBoundary) return { streamError: null, incompleteReason, sdkStreamError: null }
  const detail = error instanceof Error ? error.message : String(error)
  if (graceAborted) return { streamError: new Error(`timeout: ${detail}`, { cause: error }), incompleteReason: 'timeout', sdkStreamError: detail }
  return { streamError: error, incompleteReason: initReceiptSeen ? `sdk stream error: ${detail}` : incompleteReason, sdkStreamError: null }
}

function usageEvidence(messages, totals, completedTurns, unclosedTurn) {
  const freshTokens = totals.input + totals.cache_creation + totals.output
  if (!unclosedTurn) return { fresh_tokens: freshTokens, turns: completedTurns }
  return {
    fresh_tokens: 'unavailable', turns: 'unavailable', turns_completed: completedTurns,
    fresh_tokens_lower_bound: messages.reduce((sum, message) => sum + message.input + message.cache_creation + message.output, 0),
    fresh_tokens_source: 'Lower bound from recorded assistant message usage; per-message output can undercount the terminal SDK result, so completed-turn fresh tokens are unavailable.',
  }
}

const USAGE_FIELDS = ['input', 'cache_creation', 'cache_read', 'output']

// One assistant message is streamed once per content block with the same id and usage: a repeat replaces the
// recorded usage (keeping the first arrival time), it never adds to it. Returns whether the stream brought usage
// evidence no SDK result has covered yet: a new message, or a repeat whose changed usage takes the recorded message
// sum past the result totals.
function recordAssistantUsage(messages, record, messageId, totals) {
  const previous = messageId ? messages.findIndex((entry) => entry.message_id === messageId) : -1
  if (previous < 0) {
    messages.push(messageId ? { ...record, message_id: messageId } : record)
    return true
  }
  const changed = USAGE_FIELDS.some((field) => messages[previous][field] !== record[field])
  messages[previous] = { ...record, message_id: messageId, arrived_at: messages[previous].arrived_at }
  return changed && USAGE_FIELDS.some((field) => messages.reduce((sum, message) => sum + message[field], 0) > totals[field])
}

function toolCallStart(item, started, state) {
  const call = { tool: item.name, tool_use_id: item.id, started_at: new Date(started).toISOString(), started_ms: started }
  if (item.name === lifecycleToolName('run')) {
    if (item.input?.kind !== undefined) call.kind = item.input.kind
    if (item.input?.name !== undefined) call.name = item.input.name
    const lifecycleState = state()
    call.phase = lifecycleState.phase
    if (lifecycleState.round !== undefined) call.round = lifecycleState.round
  }
  return call
}

function toolCallReceipt(call, ended) {
  const { started_ms: startedMs, ...identity } = call
  return { ...identity, ms: ended - startedMs, ended_at: new Date(ended).toISOString() }
}

function longerToolCall(current, receipt) {
  return current === null || receipt.ms > current.ms ? receipt : current
}

function toolCallFields(longestToolCall, startedTools, ended) {
  const unfinished = [...startedTools.values()].map((call) => { const { started_ms: startedMs, ...identity } = call; return { ...identity, ms: ended - startedMs } })
  return { longest_tool_call_ms: longestToolCall?.ms ?? 0, longest_tool_call: longestToolCall, unfinished_tool_calls: unfinished }
}

function summaryCost(cost) {
  const total = cost.totals === 'unknown' ? null : cost.totals?.usd
  return { total_usd: typeof total === 'number' ? total : null, coverage: cost.coverage }
}

function budgetReceipt(started, ended, declared) {
  const actual = (ended - started) / 1000
  return { declared_seconds: declared, boundary_grace_seconds: TIMEOUT_BOUNDARY_GRACE_MS / 1000, actual_seconds: actual, delta_seconds: Math.round((actual - declared) * 1000) / 1000 }
}

function phasePromptActive(runtime, current) {
  return !runtime.completed && !runtime.timeoutBoundary && !current.closed
}

function boundaryPromptEnd(runtime, current) {
  const { handOff, boundaryEnd } = runtime
  if (runtime.pendingTurnEnds > 0) {
    runtime.pendingTurnEnds -= 1
    handOff(current, boundaryEnd(current))
    return true
  }
  return current.handedOff
}

function advanceContinuation(runtime) {
  runtime.pendingTurnEnds -= 1
  if (runtime.acceptedLifecycleResults > runtime.acceptedAtLastContinuation) runtime.consecutiveContinuations = 0
  runtime.consecutiveContinuations += 1
  runtime.acceptedAtLastContinuation = runtime.acceptedLifecycleResults
}

function continuationContent(runtime) {
  const { lifecycleServer, injectedDecisions } = runtime
  const lifecycleState = lifecycleServer.state()
  const phase = lifecycleState.phase
  const binding = lifecycleServer.dodDisputes().filter((dispute) => dispute.resolution && !injectedDecisions.has(`${dispute.requestId}:${dispute.criterion}`))
  for (const dispute of binding) injectedDecisions.add(`${dispute.requestId}:${dispute.criterion}`)
  return lifecycleState.partial && phase === 'report'
    ? partialInstruction(lifecycleState.partial)
    : `The run is not complete: current phase ${phase}; next: ${nextPhaseTask(phase, runtime.options.dir)}. Continue.${bindingNotice(binding)}`
}

function continuationMessage(runtime, content) {
  const { log } = runtime
  runtime.injectedTurns += 1
  log(`injected: continuation ${content}`)
  if (runtime.consecutiveContinuations === MAX_UNPRODUCTIVE_TURNS) {
    runtime.incompleteReason = `pilot ended its turn ${MAX_UNPRODUCTIVE_TURNS} times without progress`
  }
  return { type: 'user', message: { role: 'user', content } }
}

function mailboxOrDecision(runtime) {
  const { exists, options, readFile, deliveredNotes, log, lifecycleServer, injectedDecisions } = runtime
  const lines = exists(options.mailbox) ? readFile(options.mailbox, 'utf8').split(/\r?\n/).filter(Boolean) : []
  if (lines.length > runtime.mailboxLines) {
    deliveredNotes.push(lines[runtime.mailboxLines])
    const content = `${MAILBOX_PREFIX}${lines[runtime.mailboxLines++]}`
    runtime.injectedTurns += 1
    log(`injected: mailbox message ${content}`)
    return { type: 'user', message: { role: 'user', content } }
  }
  const disputes = lifecycleServer.dodDisputes()
  const decision = disputes.filter((dispute) => dispute.resolution && !injectedDecisions.has(`${dispute.requestId}:${dispute.criterion}`))[0]
  if (decision) {
    injectedDecisions.add(`${decision.requestId}:${decision.criterion}`)
    const content = `Binding decision on DoD ${decision.criterion} (runner-owned, trusted; ${decision.resolution.source}): ${decision.resolution.reading}. ${decision.resolution.criticRule ?? ''} Keep the plan to this reading; the next critic round is bound to it.`
    runtime.injectedTurns += 1
    log(`injected: parent decision ${content}`)
    return { type: 'user', message: { role: 'user', content } }
  }
  return null
}

async function* phaseFollowUps(runtime, current) {
  const { exists, report, pastBoundary, sleep, lifecycleServer } = runtime
  while (phasePromptActive(runtime, current)) {
    if (phaseFollowUpsEnded(runtime, current, exists, report)) return
    if (pastBoundary(current)) {
      if (boundaryPromptEnd(runtime, current)) return
      await sleep(POLL_MS)
      continue
    }
    await waitForPlanBinding(lifecycleServer)
    if (observeBlockedRun(runtime, current)) return
    if (runtime.pendingTurnEnds > 0) {
      advanceContinuation(runtime)
      await waitForPlanBinding(lifecycleServer)
      if (observeBlockedRun(runtime, current)) return
      const content = continuationContent(runtime)
      yield continuationMessage(runtime, content)
      if (runtime.incompleteReason) return
      continue
    }
    const message = mailboxOrDecision(runtime)
    if (message) yield message
    else await sleep(POLL_MS)
  }
}

function phaseFollowUpsEnded(runtime, current, exists, report) {
  if (runtime.awaitingFidelityReceipt && exists(report)) { runtime.completed = true; return true }
  return observeBlockedRun(runtime, current)
}

function recordSessionCall(current, record, messageId) {
  const call = { input: record.input, cache_creation: record.cache_creation, cache_read: record.cache_read, output: record.output }
  if (messageId !== current.last_message_id) { current.calls += 1; current.last_message_id = messageId }
  if (current.calls === 1) current.first_call = call
  current.last_call = call
}

function consumeInitialization(runtime, message) {
  const { sdkRole } = runtime
  if (!runtime.initReceiptSeen && !(message.type === 'system' && (message.subtype === 'init' || message.subtype?.startsWith('hook_')))) {
    throw new Error('SDK pilot initialization receipt never arrived: the first message was ' + message.type + '/' + (message.subtype ?? 'none'))
  }
  if (message.type === 'system' && message.subtype === 'init') {
    runtime.initReceiptSeen = true
    runtime.servedModel = message.model
    assertPilotInitReceipt(message, sdkRole)
  }
}

function consumeFirstAssistant(runtime, message) {
  if (!runtime.firstAssistantSeen && message.type === 'assistant') {
    runtime.firstAssistantSeen = true
    runtime.servedModelFirstTurn = message.message?.model
  }
}

function consumeAssistantUsage(runtime, message, current) {
  const { messages, totals, model, now, persistUsage } = runtime
  if (message.type === 'assistant' && message.message?.usage) {
    const messageId = message.message.id
    const record = { ...usageOf(message.message), model: message.message.model ?? runtime.servedModelFirstTurn ?? runtime.servedModel ?? model.value, arrived_at: new Date(now()).toISOString(), session: current.index, session_phase: current.phase }
    if (recordAssistantUsage(messages, record, messageId, totals)) {
      runtime.lastAssistantUsageIndex = runtime.streamIndex
      current.uncovered = true
    }
    recordSessionCall(current, record, messageId)
    persistUsage()
  }
}

function consumeToolUse(runtime, item, current) {
  const { tools, startedTools, lifecycleCalls, pastBoundary, now, lifecycleServer } = runtime
  tools.push(item.name)
  runtime.turnTools.push(item.name)
  if (pastBoundary(current)) current.calls_after_boundary.push(item.name)
  if (item.id) startedTools.set(item.id, toolCallStart(item, now(), () => lifecycleServer.state()))
  if (item.id && ['transition', 'write_artifact', 'route_finding', 'run'].map(lifecycleToolName).includes(item.name)) lifecycleCalls.set(item.id, item.name)
}

function consumeTimedToolResult(runtime, item) {
  const { startedTools, now } = runtime
  const receipt = toolCallReceipt(startedTools.get(item.tool_use_id), now())
  runtime.longestToolCall = longerToolCall(runtime.longestToolCall, receipt)
  startedTools.delete(item.tool_use_id)
}

function consumeLifecycleResult(runtime, item) {
  const { log, lifecycleCalls } = runtime
  const lifecycleResult = textFrom(item.content)
  log(`lifecycle: ${lifecycleResult}`)
  const lifecycleName = lifecycleCalls.get(item.tool_use_id)
  if (/^(?:accepted phase=|wrote |lane \S+ EXIT=0$|gate \S+ EXIT=0$)/.test(lifecycleResult.trim())) runtime.acceptedLifecycleResults += 1
  if (lifecycleName === lifecycleToolName('transition') && lifecycleResult.trim() === AWAITING_FIDELITY_RESULT) runtime.awaitingFidelityReceipt = true
  lifecycleCalls.delete(item.tool_use_id)
}

function consumeContentItem(runtime, item, current) {
  const { startedTools, lifecycleCalls } = runtime
  if (item.type === 'tool_use') consumeToolUse(runtime, item, current)
  if (item.type === 'tool_result' && item.tool_use_id && startedTools.has(item.tool_use_id)) consumeTimedToolResult(runtime, item)
  if (item.type === 'tool_result' && lifecycleCalls.has(item.tool_use_id)) consumeLifecycleResult(runtime, item)
}

function consumeResultBoundary(runtime, message, current) {
  const { pastBoundary } = runtime
  if (pastBoundary(current)) {
    current.resultAfterBoundary = true
    // The SDK delivers this error result before raising the boundary interruption.
    if (current.deniedAt !== null && message.is_error === true && message.terminal_reason === 'aborted_tools') current.interruptedResult = true
  }
}

function consumeModelUsage(runtime, message, current) {
  const { modelUsage, phaseSessions } = runtime
  // modelUsage is cumulative per query: keep each session's latest, then sum sessions.
  if (message.modelUsage && typeof message.modelUsage === 'object') current.model_usage = message.modelUsage
  for (const key of Object.keys(modelUsage)) delete modelUsage[key]
  for (const item of phaseSessions) addModelUsage(modelUsage, item.model_usage)
}

function consumeTurnUsage(runtime, message, current, usage) {
  const { turns, model, now, totals } = runtime
  current.permission_denials += Array.isArray(message.permission_denials) ? message.permission_denials.length : 0
  current.terminal_reason = message.terminal_reason ?? current.terminal_reason
  turns.push({ ...usage, model: runtime.servedModelFirstTurn ?? runtime.servedModel ?? model.value, ended_at: new Date(now()).toISOString(), tool_names: [...new Set(runtime.turnTools)] })
  runtime.turnTools = []
  for (const key of Object.keys(totals)) totals[key] += usage[key]
  if (!runtime.completed) {
    if (current.handedOff) current.late_turn_ends += 1
    else runtime.pendingTurnEnds += 1
  }
}

function consumePhaseResult(runtime, message, current) {
  runtime.lastResultIndex = runtime.streamIndex
  current.uncovered = false
  consumeResultBoundary(runtime, message, current)
  const usage = usageOf(message)
  consumeModelUsage(runtime, message, current)
  consumeTurnUsage(runtime, message, current, usage)
}

function consumePhaseMessage(runtime, message, current) {
  const { modelTracker, transcript } = runtime
  runtime.streamIndex += 1
  modelTracker.observe(message)
  transcript.push(message)
  // A pre-init account notice carries no model output and is not "another message first".
  if (!runtime.initReceiptSeen && isPreInitNotice(message)) return
  consumeInitialization(runtime, message)
  consumeFirstAssistant(runtime, message)
  consumeAssistantUsage(runtime, message, current)
  const content = message.message?.content
  if (Array.isArray(content)) for (const item of content) consumeContentItem(runtime, item, current)
  if (message.type === 'result') consumePhaseResult(runtime, message, current)
}

// Every way a session ends past its boundary goes through here, so the next phase opens exactly once
// and the designed close is logged once, whichever path reaches it first.
function phaseHandOff(log) {
  return (current, endedBy) => {
    current.ended_by ??= endedBy
    if (!current.handedOff) log(`phase session ${current.index} closed after phase ${current.phase} accepted`)
    current.handedOff = true
  }
}

function closeSessionError(runtime, current, sessionAbort, error) {
  const { handOff, log } = runtime
  const detail = error instanceof Error ? error.message : String(error)
  if (runtime.blockedStop && sessionAbort.signal.aborted) {
    current.closing_error = detail
    log(`blocked session ${current.index}: ${current.closing_error}`)
    return
  }
  // Only a runner-owned no-result abort or the SDK's boundary-interrupted result permits handoff.
  const ownAbort = current.ended_by === 'no_result' && sessionAbort.signal.aborted
  if (current.deniedAt === null || (!ownAbort && !current.interruptedResult)) {
    // Startup failures retain the account gate's sanitized logging.
    if (runtime.initReceiptSeen) log(`phase session ${current.index}: SDK stream error: ${detail}`)
    throw error
  }
  current.closing_error = detail
  // handOff logs the designed close once, whichever path reaches it first.
  if (!ownAbort) handOff(current, 'boundary-deny')
}

async function runPhaseSession(runtime, current, prompts, mcpServer) {
  const { abortController, query, sessionQueryOptions, handOff, boundaryEnd, clearTimer, now, accountSessions } = runtime
  const sessionAbort = new AbortController()
  const forward = () => sessionAbort.abort()
  if (abortController.signal.aborted) sessionAbort.abort()
  else abortController.signal.addEventListener('abort', forward, { once: true })
  current.abort = () => sessionAbort.abort()
  runtime.initReceiptSeen = false
  try {
    const stream = await runtime.account.open(() => query({ prompt: runtime.account.gatePrompt(prompts), options: sessionQueryOptions(current, mcpServer, sessionAbort) }), abortController)
    for await (const message of stream) consumePhaseMessage(runtime, message, current)
    if (!runtime.initReceiptSeen) throw new Error('SDK pilot run ended without an initialization receipt')
    if (observeBlockedRun(runtime)) return
    // A stream ending after a result past the boundary hands off even without another prompt poll.
    if (!runtime.completed && current.resultAfterBoundary) handOff(current, boundaryEnd(current))
  } catch (error) {
    closeSessionError(runtime, current, sessionAbort, error)
  } finally {
    clearTimer(current.noResultTimer)
    current.closed = true
    current.ended_at = new Date(now()).toISOString()
    abortController.signal.removeEventListener('abort', forward)
    accountSessions.push(runtime.account.summary())
  }
}

function pilotDependencies(dependencies) {
  const { query, resolvePilotModels, now = () => Date.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), setTimer = setTimeout, clearTimer = clearTimeout, env = process.env, writeFile = writeFileSync, exists = existsSync, readFile = readFileSync } = dependencies
  return { query, resolvePilotModels, now, sleep, setTimer, clearTimer, env, writeFile, exists, readFile, ...pilotLifecycleDependencies(dependencies) }
}

function pilotLifecycleDependencies({ oldLifecycleHook = null, lifecycleOptions = {}, log = (line) => process.stdout.write(`${line}\n`) }) {
  return { oldLifecycleHook, lifecycleOptions, log }
}

function initializePilotConfiguration(context) {
  let { options } = context
  const { env, log, setTimer, clearTimer, exists, resolvePilotModels, readFile, dependencies } = context
  const profileEnv = loadProfileEnv(options.profileEnv)
  assertRunnerOptions(options)
  // One account gate per SDK query: every phase session spawns a CLI that reads the login again.
  const accountGate = (retryUnavailable = false) => createAccountGate({ expectAccount: context.options.expectAccount, launchEnv: env, profileEnv, log, timers: { setTimer, clearTimer }, retryUnavailable })
  const account = accountGate()
  const effectiveEnv = { ...env, ...profileEnv }
  const { knowledgeBase, model, modelVariant } = pilotModelSetup({ options, effectiveEnv, env, profileEnv, exists, resolvePilotModels })
  // Defaults for programmatic callers (the orchestrator driver): the CLI's parser sets these, runPilot
  // called directly did not — the first real wave died on a `path` of undefined.
  const contractPath = options.contract ?? resolve(MODULE_DIR, '../../autonomy/PILOT-CONTRACT.md')
  const mailboxPath = options.mailbox ?? join(options.dir, '.lane', 'pilot-mailbox.txt')
  options = { ...options, contract: contractPath, mailbox: mailboxPath }
  const contract = readFile(options.contract, 'utf8')
  // The project manifest lives with the project, not in each generated card worktree: resolve it
  // from the same project root the knowledge-base index uses.
  const rules = dependencies.rules ?? loadRules({ projectRoot: options.knowledgeBaseProjectRoot ?? options.dir })
  const systemPrompt = composeStandingPrompt(contract, rules)
  assertCardFile(options.cardFile)
  const cardText = readFile(options.cardFile, 'utf8')
  const boardContract = loadBoardContract(options.boardContract, readFile)
  assertCardDefinitionOfDone(cardText)
  const routing = derivePilotRoute(cardText, options)
  Object.assign(context, { options, profileEnv, accountGate, account, effectiveEnv, knowledgeBase, model,
    modelVariant, contract, rules, systemPrompt, cardText, boardContract, routing })
}

function initializePilotRoute(context) {
  let { options } = context
  const { boardContract, routing, contract, log, dependencies, env, profileEnv, model, modelVariant, now, effectiveEnv } = context
  const contractWarning = missingBoardContractWarning(boardContract, routing.route, contract)
  if (contractWarning) log(contractWarning)
  const timeoutExplicit = options.timeoutExplicit === true
  const timeoutSeconds = options.timeout ?? ROUTE_TIMEOUTS[routing.route]
  announcePilotTimeout(timeoutExplicit, timeoutSeconds, routing, log)
  options = { ...options, timeout: timeoutSeconds, timeoutExplicit }
  const executorProfile = (dependencies.resolveExecutorProfile ?? defaultResolveExecutorProfile)({ worktree: options.dir, route: routing.route, hard: options.hard, env, settingsEnv: profileEnv })
  log(`route=${routing.route} reasons=${routing.reasons.join(',')} model=${model.value} effective=${model.effective} variant=${modelVariant.value} variant_origin=${modelVariant.origin} executor=${executorProfile.executor}${executorProfile.executors ? ' executors=' + Object.entries(executorProfile.executors).map(([role, family]) => role + ':' + family).join(',') : ''}`)
  const report = join(options.dir, '.lane', 'pilot-report.md')
  const usagePath = join(options.dir, '.lane', 'usage.json')
  const summaryPath = join(options.dir, '.lane', 'summary.json')
  const transcriptPath = join(options.dir, '.lane', 'sdk-transcript.json')
  const started = now()
  const runId = `${options.card}-${started}`
  const decisionStoreOptions = { env, ...(dependencies.decisionStateRoot ? { root: dependencies.decisionStateRoot } : {}) }
  const defaultDecisionStateRoot = pilotDecisionStateRoot({ env })
  const decisionStateRoot = resolve(dependencies.decisionStateRoot ?? defaultDecisionStateRoot)
  assertDecisionStateOutsideWritable(options.dir, decisionStateRoot, effectiveEnv.WT_LANE_SANDBOX_WRITE, effectiveEnv.HOME ?? effectiveEnv.USERPROFILE ?? '')
  announceDecisionBoundary(effectiveEnv, log)
  const decisionStateFile = initializePilotDecisionStore(runId, decisionStoreOptions)
  const decisionCli = pilotDecisionCli()
  Object.assign(context, { options, executorProfile, report, usagePath, summaryPath, transcriptPath, started,
    runId, defaultDecisionStateRoot, decisionStateRoot, decisionStateFile, decisionCli })
}

function announcePilotTimeout(timeoutExplicit, timeoutSeconds, routing, log) {
  if (timeoutExplicit && timeoutSeconds < ROUTE_EXPECTED_SECONDS[routing.route]) {
    const reference = routing.route === 'FULL' ? 'FULL runs here have taken up to 3 h 11' : 'LITE runs are budgeted for 1 h 30'
    log(`warning: ${routing.route} timeout ${timeoutSeconds}s is below the route's expected duration; ${reference}`)
  }
}

function initialPilotState() {
  return {
    totals: { input: 0, cache_creation: 0, cache_read: 0, output: 0 }, turns: [], messages: [], modelUsage: {}, transcript: [], tools: [],
    turnTools: [], mailboxLines: 0, injectedDecisions: new Set(), completed: false, injectedTurns: 0, silenceInjections: 0,
    pendingTurnEnds: 0, consecutiveContinuations: 0, acceptedLifecycleResults: 0, acceptedAtLastContinuation: 0,
    incompleteReason: null, blockedStop: null, longestToolCall: null, startedTools: new Map(), streamIndex: 0,
    lastAssistantUsageIndex: -1, lastResultIndex: -1, lifecycleCalls: new Map(), awaitingFidelityReceipt: false,
    initReceiptSeen: false, servedModel: undefined, servedModelFirstTurn: undefined, firstAssistantSeen: false,
    streamError: null, sdkStreamError: null, timeoutBoundary: null, graceAborted: false,
  }
}

function initializePilotSdk(context) {
  const { options, dependencies, effectiveEnv, log, exists, report, oldLifecycleHook } = context
  const pluginRoot = resolve(MODULE_DIR, '../..')
  const configuredPlugins = options.pluginDirs ?? []
  const sdkRole = (dependencies.prepareSdkRole ?? prepareSdkRole)('pilot', { worktree: options.dir, env: effectiveEnv, pluginRoot, loadedCodePaths: dependencies.loadedCodePaths, adapterOptions: { log } })
  sdkRole.pluginPaths.push(...configuredPlugins)

  // B5: completion is `awaiting_fidelity receipt && report exists`, so a report left by an earlier
  // run would satisfy it without this session ever writing one. Refuse to start on a dirty lane.
  assertCleanPilotStart(options.dir); if (exists(report)) throw new Error(`SDK pilot preflight failed: ${report} already exists; a stale report would satisfy completion`)
  if (exists(oldLifecycleHook ?? join(pluginRoot, 'hooks-modules', 'sdk-pilot-lifecycle'))) throw new Error('SDK pilot preflight failed: old lifecycle hook is still present')
  // `.lane/` (a directory pattern) only matches an EXISTING directory: create it before asking git,
  // or a fresh worktree fails the preflight (real wave a2adf9e2).
  mkdirSync(join(options.dir, '.lane'), { recursive: true })
  try { execFileSync('git', ['check-ignore', '.lane'], { cwd: options.dir, stdio: 'ignore' }) } catch { throw new Error('SDK pilot preflight failed: .lane must be git-ignored') }
  Object.assign(context, { pluginRoot, sdkRole })
  initializePilotBoard(context)
}

function initializePilotBoard(context) {
  const { effectiveEnv, dependencies, boardContract } = context
  const boardUrl = resolveWorkflowToolboxOption('planka_mcp_url', { env: effectiveEnv }).value
  const board = dependencies.board ?? (boardContract && boardUrl ? createBoardClient({ url: boardUrl, boardId: boardContract.boardId }) : null)
  const routeFinding = boardContract
    ? board && typeof board.createRoutedCard === 'function'
      ? (args) => board.createRoutedCard(args)
      : async () => { throw new Error('board unavailable: planka_mcp_url is not configured') }
    : null
  const resolveRoutedFinding = boardContract && board && typeof board.resolveRoutedCard === 'function' ? (card) => board.resolveRoutedCard(card) : null
  Object.assign(context, { boardUrl, routeFinding, resolveRoutedFinding })
}

function initializePilotLifecycle(context) {
  const { options, query, effectiveEnv, accountGate, log, dependencies, runId, decisionStateFile, decisionCli,
    decisionStateRoot, defaultDecisionStateRoot, env, lifecycleOptions, routing, executorProfile, profileEnv,
    knowledgeBase, cardText, rules, boardContract, routeFinding, resolveRoutedFinding, sdkRole, state } = context
  const abortController = new AbortController()
  const parentWakes = createParentWakeManager({ parentSession: options.parentSession, parentMode: options.parentMode, query, env: effectiveEnv, accountGate, log, wakeOptions: dependencies.parentWakeOptions })
  context.timeoutGraceTimer = null
  const archiveRoot = options.archiveRoot ?? defaultArchiveRoot({ dir: options.dir, projectRoot: options.knowledgeBaseProjectRoot })
  const decisionChannel = parentDecisionChannel({ runId, stateFile: decisionStateFile, cli: decisionCli, log, wake: parentWakes, root: displayedDecisionStateRoot(decisionStateRoot, defaultDecisionStateRoot, { env, injected: dependencies.decisionStateRoot !== undefined }), overrides: lifecycleOptions.dodDecisions })
  const lifecycleServer = createLifecycleServer({ worktree: options.dir, archiveRoot, route: routing.route, reasons: routing.reasons, executor: executorProfile.executor, executorEnv: { ...env, ...profileEnv }, knowledgeBase, models: executorProfile.models, cardId: options.card, cardText, sessionTag: runId, rules, boardContract, routeFinding, resolveRoutedFinding, lsp: sdkRole.lsp, stopAfterPhase: options.stopAfter, ...lifecycleOptions, dodDecisions: decisionChannel, onBoundaryStop: (stopped) => { state.timeoutBoundary = stopped; state.incompleteReason = stopped.reason; setImmediate(() => abortController.abort()) } })
  const phaseSessions = []
  Object.assign(context, { abortController, parentWakes, archiveRoot, lifecycleServer, phaseSessions })
}

function initializePilotUsage(context) {
  const { phaseSessions, state, usagePath, writeFile } = context
  const { messages, totals, modelUsage, turns, tools } = state
  // A session aborted after assistant usage but before its result leaves usage no result covers.
  const usageUnclosed = () => state.lastAssistantUsageIndex > state.lastResultIndex || phaseSessions.some((item) => item.uncovered && item.ended_by === 'no_result')
  const currentUsage = () => ({ messages, result_totals: totals, model_usage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined, turns, totals, fresh_tokens: usageEvidence(messages, totals, turns.length, usageUnclosed()).fresh_tokens, tool_names: [...new Set(tools)] })
  const persistUsage = () => atomicWrite(usagePath, `${JSON.stringify(currentUsage(), null, 2)}\n`, writeFile)
  Object.assign(context, { usageUnclosed, currentUsage, persistUsage })
}

function initializePilotTimeout(context) {
  const { setTimer, lifecycleServer, state, log, abortController, options } = context
  const timeoutTimer = setTimer(() => {
    if (lifecycleServer.requestStop('timeout')) {
      state.incompleteReason = 'timeout'
      log(`timeout requested; waiting up to ${TIMEOUT_BOUNDARY_GRACE_MS / 60_000} min for the ${lifecycleServer.state().phase} phase boundary`)
      context.timeoutGraceTimer = setTimer(() => {
        if (!state.timeoutBoundary) {
          log('timeout boundary grace elapsed; aborting the SDK run')
          state.graceAborted = true
          abortController.abort()
        }
      }, TIMEOUT_BOUNDARY_GRACE_MS)
    }
  }, options.timeout * 1000)
  context.timeoutTimer = timeoutTimer
}

async function* pilotPrompt(context) {
    const { sdkRole, options, knowledgeBase, routing, cardText } = context
    const lspLine = sdkRole.lsp.available ? 'LSP navigation: available' : `LSP navigation: absent (${sdkRole.lsp.reason})`
    const standing = `Pilot card ${options.card} in ${options.dir}. ${knowledgeBasePromptLine(knowledgeBase)} Read that index if present, then open the fiches it lists that bear on this card; they are read-only. ${GROUNDING_INITIAL_PROMPT} ${lspLine}. Include that exact LSP navigation state in the closing report. Lanes run synchronously through the lifecycle run tool. Keep working through every phase until transition report returns the awaiting_fidelity receipt, then write nothing more and end the turn.${planShapeLine(routing.route)}`
    yield { type: 'user', message: { role: 'user', content: withRepositoryInstructions(options.dir, `${standing}\n\n## The card, verbatim\n\n${cardText}\n\ndo not re-read the card from the board; the text above is the card`) } }
    yield* phaseFollowUps(context.phaseRuntime, context.session)
}

  // One SDK query per lifecycle phase (card: phase sessions). A session is bound to the phase it opened in; once the
  // lifecycle has left that phase, the session gets nothing more, its next tool call is denied with an interrupt,
  // and at its turn end the runner opens the live phase in a fresh query primed with a runner-built opener.
function initializePilotSessions(context) {
  const { lifecycleServer, log } = context
  context.accountSessions = []
  context.deliveredNotes = []
  context.session = null
  const pastBoundary = (current) => {
    const phase = lifecycleServer.state().phase
    return phase !== current.phase && phase !== 'awaiting_fidelity'
  }
  const handOff = phaseHandOff(log)
  const boundaryEnd = (current) => (current.deniedAt === null ? 'turn-end' : 'boundary-deny')
  Object.assign(context, { pastBoundary, handOff, boundaryEnd })
}

function openPilotSession(context) {
    const { lifecycleServer, phaseSessions, now, state } = context
    const timeline = lifecycleServer.timeline()
    const session = { index: phaseSessions.length + 1, phase: lifecycleServer.state().phase, round: timeline.phases.at(-1)?.round ?? null, started_at: new Date(now()).toISOString(), ended_at: null, ended_by: null, calls: 0, first_call: null, last_call: null, last_message_id: null, late_turn_ends: 0, noResultTimer: null, resultAfterBoundary: false, interruptedResult: false, uncovered: false, calls_after_boundary: [], denied_after_boundary: [], permission_denials: 0, terminal_reason: null, model_usage: {}, handedOff: false, deniedAt: null, closed: false, abort: () => {} }
    context.session = session
    phaseSessions.push(session)
    state.pendingTurnEnds = 0
    state.consecutiveContinuations = 0
    state.acceptedAtLastContinuation = state.acceptedLifecycleResults
    return session
}

  // The first message of a later phase session: what that phase needs, never the earlier conversation.
function pilotPhaseOpening(context, current) {
    const { lifecycleServer, state: { injectedDecisions }, deliveredNotes, options, cardText, sdkRole, knowledgeBase } = context
    const lifecycleState = lifecycleServer.state()
    const ledger = lifecycleServer.ledger()
    for (const dispute of ledger.dodDisputes.filter((item) => item.resolution)) injectedDecisions.add(`${dispute.requestId}:${dispute.criterion}`)
    const notes = deliveredNotes.length > 0 ? `## Mailbox notes delivered earlier in this run\n\n${deliveredNotes.map((note) => `${MAILBOX_PREFIX}${note}`).join('\n\n')}` : ''
    const notice = [lifecycleState.partial && current.phase === 'report' ? partialInstruction(lifecycleState.partial) : '', bindingDecisionsSection(ledger.dodDisputes).trim(), notes].filter(Boolean).join('\n\n')
    const content = phaseOpener({
      cardId: options.card, dir: options.dir, cardText, phase: current.phase, task: nextPhaseTask(current.phase, options.dir),
      lspLine: sdkRole.lsp.available ? 'LSP navigation: available' : `LSP navigation: absent (${sdkRole.lsp.reason})`, knowledgeBasePath: knowledgeBase.path,
      manifest: phaseManifest({ phase: current.phase, laneDir: join(options.dir, '.lane'), ledger, timeline: lifecycleServer.timeline() }),
      rules: phaseRules(lifecycleServer.acceptedTransitions(), current.phase), notice,
    })
    return { type: 'user', message: { role: 'user', content: withRepositoryInstructions(options.dir, content) } }
}
async function* pilotPhasePrompt(context, current) {
    const { lifecycleServer, phaseRuntime } = context
    // A plan session never opens on an unbound DoD dispute: the opener carries the binding.
    await waitForPlanBinding(lifecycleServer)
    yield pilotPhaseOpening(context, current)
    yield* phaseFollowUps(phaseRuntime, current)
}

function pilotSessionQueryOptions(context, current, mcpServer, sessionAbort) {
  const { model, modelVariant, systemPrompt, options, boardUrl, effectiveEnv, sdkRole } = context
  return composeSdkRoleQueryOptions({
    model: model.value,
    effort: modelVariant.value,
    systemPrompt,
    settingSources: [],
    maxTurns: 120,
    cwd: options.dir,
    // No Planka endpoint configured means no board tools, never a guessed local port.
    mcpServers: { ...(boardUrl ? { planka: { type: 'http', url: boardUrl } } : {}), [LIFECYCLE_MCP_KEY]: mcpServer },
    canUseTool: async (toolName, input) => pilotSessionPermission(context, current, toolName, input),
    permissionMode: 'default',
    env: { ...effectiveEnv, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    abortController: sessionAbort,
  }, sdkRole)
}

function pilotSessionPermission(context, current, toolName, input) {
       const { pastBoundary, now, setTimer, handOff, lifecycleServer, options, knowledgeBase, sdkRole } = context
      if (pastBoundary(current)) {
        if (current.deniedAt === null) {
          current.deniedAt = now()
          // Independent of the prompt generator: a CLI that stops reading its input still gets its bound.
          current.noResultTimer = setTimer(() => {
            if (current.closed || current.handedOff || current.resultAfterBoundary) return
            handOff(current, 'no_result')
            current.abort()
          }, NO_RESULT_AFTER_DENY_MS)
        }
        current.denied_after_boundary.push(toolName)
        return { behavior: 'deny', message: `session boundary: the lifecycle left phase ${current.phase}; phase ${lifecycleServer.state().phase} runs in a fresh session. End your turn now.`, interrupt: true }
      }
      return lifecycleCanUseTool(options.dir, toolName, input, { boardMoves: options.boardMoves ?? true, knowledgeBaseIndex: knowledgeBase.path, profile: sdkRole.profile })
}

function initializePilotRuntime(context) {
  const { model, effectiveEnv, query, now, sleep, exists, readFile, writeFile, log, options, report, sdkRole,
    lifecycleServer, deliveredNotes, pastBoundary, handOff, boundaryEnd, phaseSessions, persistUsage,
    abortController, clearTimer, accountSessions, state } = context
  const { injectedDecisions, messages, totals, modelUsage, turns, tools, transcript, startedTools, lifecycleCalls } = state
  const sessionQueryOptions = (...args) => pilotSessionQueryOptions(context, ...args)
  const modelTracker = createModelTracker(model.value, effectiveEnv)
  // Accessors share the runner's live state without changing callback receivers or async boundaries.
  const phaseRuntime = {
    query, now, sleep, exists, readFile, writeFile, log, options, report, sdkRole, model, modelTracker,
    lifecycleServer, injectedDecisions, deliveredNotes, pastBoundary, handOff, boundaryEnd,
    messages, totals, modelUsage, phaseSessions, turns, tools, transcript, startedTools, lifecycleCalls, persistUsage,
    sessionQueryOptions, abortController, clearTimer, accountSessions, readBlockedFile: readRegularFile, writeBlockedFile: (file, content) => atomicWrite(file, content, writeFile),
    get account() { return context.account },
    get timeoutBoundary() { return state.timeoutBoundary },
  }
  bindPilotRuntimeState(phaseRuntime, state)
  Object.assign(context, { modelTracker, phaseRuntime })
}

function bindPilotRuntimeState(runtime, state) {
  const fields = ['completed', 'awaitingFidelityReceipt', 'pendingTurnEnds', 'acceptedLifecycleResults',
    'acceptedAtLastContinuation', 'consecutiveContinuations', 'injectedTurns', 'incompleteReason', 'blockedStop',
    'mailboxLines', 'streamIndex', 'initReceiptSeen', 'servedModel', 'firstAssistantSeen', 'servedModelFirstTurn',
    'lastAssistantUsageIndex', 'lastResultIndex', 'turnTools', 'longestToolCall']
  for (const field of fields) Object.defineProperty(runtime, field, {
    enumerable: true, configurable: true, get: () => state[field], set: (value) => { state[field] = value },
  })
}

async function executePilotSessions(context) {
  const { phaseRuntime, lifecycleServer, accountGate, log, state, clearTimer, timeoutTimer, parentWakes, modelTracker } = context
  try {
    await runPhaseSession(phaseRuntime, openPilotSession(context), pilotPrompt(context), lifecycleServer)
    while (context.session.handedOff && !state.completed && !state.timeoutBoundary && !state.incompleteReason) {
      context.account = accountGate(true)
      const next = openPilotSession(context)
      log(`phase session ${next.index}: ${next.phase}`)
      await runPhaseSession(phaseRuntime, next, pilotPhasePrompt(context, next), lifecycleServer.sessionServer(next.index))
    }
  } catch (error) {
    const { timeoutBoundary, graceAborted, initReceiptSeen, incompleteReason } = state
    const failure = classifyStreamFailure(error, { timeoutBoundary, graceAborted, initReceiptSeen, incompleteReason })
    state.sdkStreamError = failure.sdkStreamError
    if (timeoutBoundary || graceAborted) {
      state.streamError = failure.streamError
      state.incompleteReason = failure.incompleteReason
    } else {
      // Outside a timeout the account gate owns the outcome: a refusal is not rethrown and names the account;
      // any other error keeps the classification above (rethrown, "sdk stream error" once init was seen).
      state.streamError = context.account.errorToRethrow(error)
      state.incompleteReason = await context.account.reasonAfterError(error, { initReceiptSeen, incompleteReason })
    }
  } finally {
    for (const warning of modelWarnings(modelTracker.result(), { name: 'pilot' })) log(warning)
    clearTimer(timeoutTimer)
    if (context.timeoutGraceTimer !== null) clearTimer(context.timeoutGraceTimer)
    await parentWakes.finish()
  }
  return finalizePilotRun(context)
}

function finalizePilotRun(context) {
  const { phaseRuntime, currentUsage, exists, report, lifecycleServer, model, now, state } = context
  const { awaitingFidelityReceipt, servedModel, servedModelFirstTurn, initReceiptSeen, firstAssistantSeen } = state
  // B4: returning normally here made the runner fail-open — a stream that ended before the pilot
  // reached awaiting_fidelity produced a summary that read like an ordinary finished run.
   observeBlockedRun(phaseRuntime)
   const usage = currentUsage()
  const completedNormally = awaitingFidelityReceipt && exists(report)
  const finalized = finalizePilotLifecycle(phaseRuntime, completedNormally)
  context.finalizationError = finalized.error
  const lifecycleSummary = finalized.summary
  const { partial, deferred } = lifecycleDelivery(lifecycleSummary, lifecycleServer.state())
  const servedModelAgreementValue = servedModelAgreement({ requestedModel: model.value, servedModel, servedModelFirstTurn, initReceiptSeen, firstAssistantSeen })
  const ended = now()
  Object.assign(context, { usage, completedNormally, lifecycleSummary, partial, deferred, servedModelAgreementValue, ended })
  publishPilotSummary(context)
  computePilotCost(context)
  publishPilotCost(context)
  return finishPilotRun(context)
}

function publishPilotSummary(context) {
  const { lifecycleSummary, routing, options, started, ended, partial, deferred, usageUnclosed, model, modelVariant,
    executorProfile, env, profileEnv, lifecycleServer, servedModelAgreementValue, account, exists, report, completedNormally,
    phaseSessions, accountSessions, parentWakes, usagePath, usage, writeFile, summaryPath, transcriptPath, boardContract, state } = context
  const { messages, totals, turns, injectedTurns, silenceInjections, longestToolCall, startedTools, sdkStreamError,
    servedModel, servedModelFirstTurn, awaitingFidelityReceipt, incompleteReason, transcript } = state
   const summary = { ...lifecycleSummary, route: routing.route, runner_timeout_seconds: options.timeout, runner_timeout_explicit: options.timeoutExplicit, runner_started_at: new Date(started).toISOString(), runner_ended_at: new Date(ended).toISOString(), partial, deferred, ...usageEvidence(messages, totals, turns.length, usageUnclosed()), injected_turns: injectedTurns, silence_injections: silenceInjections, minutes: (ended - started) / 60000, ...toolCallFields(longestToolCall, startedTools, ended), budget: budgetReceipt(started, ended, options.timeout), sdk_stream_error: sdkStreamError, model: model.value, effective_model: model.effective, variant: modelVariant.value, variant_origin: modelVariant.origin, executor_variants: describeExecutorVariants(executorProfile.models, { ...env, ...profileEnv }, executorProfile.executor), dod_disputes: lifecycleServer.dodDisputes(), requested_model: model.value, requested_model_source: model.source, requested_model_effective: model.effective, requested_model_remapped_by: model.remappedBy, served_model: servedModel, served_model_first_turn: servedModelFirstTurn, served_model_agreement: servedModelAgreementValue, account: account.summary(), report_exists: exists(report), awaiting_fidelity_receipt: awaitingFidelityReceipt, completed: completedNormally, reason: completedNormally ? undefined : incompleteReason ?? 'stream ended without awaiting_fidelity lifecycle receipt' }
  // One SDK query per lifecycle phase: each session's own calls, how it ended, and its account verdict.
  summary.phase_sessions = phaseSessions.map((item) => ({ session: item.index, ...Object.fromEntries(PHASE_SESSION_FIELDS.map((field) => [field, item[field] ?? null])) }))
  summary.handoffs = phaseSessions.filter((item) => item.handedOff).length
  summary.account_sessions = accountSessions
  summary.parent_wakes = parentWakes.receipts
  atomicWrite(usagePath, `${JSON.stringify(usage, null, 2)}\n`, writeFile)
  writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`)
  writeWorktreeRetentionMarker({ root: options.dir, cardId: options.card, partial, boardId: boardContract?.boardId ?? null, retainedAt: new Date(ended).toISOString() })
  context.summary = summary
}

function computePilotCost(context) {
  const { options, started, ended, routing, dependencies, summary } = context
  let cost
  try {
    cost = computeRunCost({ laneDir: join(options.dir, '.lane'), worktree: options.dir, startedAt: started, endedAt: ended, route: options.hard ? 'HARD' : routing.route, ...(dependencies.costSessions === undefined ? {} : { sessions: dependencies.costSessions }) })
  } catch (error) {
    cost = unknownRunCost({ route: options.hard ? 'HARD' : routing.route, worktree: options.dir, reason: `cost computation failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  summary.cost = summaryCost(cost)
  context.cost = cost
}

function publishPilotCost(context) {
  const { cost, writeFile, options, summaryPath, summary, exists, report, readFile, modelVariant, lifecycleSummary,
    parentWakes, usage, state: { transcript }, log } = context
  try {
    const costContent = `${JSON.stringify(cost, null, 2)}\n`
    writeFile(join(options.dir, '.lane', 'cost.json'), costContent)
    writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
    let costReport = null
    if (exists(report)) {
      const reportContent = `${readFile(report, 'utf8').trimEnd()}\n\nvariant=${modelVariant.value} origin=${modelVariant.origin} forced=false\n`
      costReport = reconciledCostReport({ reportContent, cost, archive: lifecycleSummary.archive?.path, report, dir: options.dir, parentWakes: parentWakes.receipts })
      writeFile(report, costReport)
    }
    const archive = lifecycleSummary.archive?.path
    if (archive) {
      writeFile(join(archive, 'usage.json'), `${JSON.stringify(usage, null, 2)}\n`)
      writeFile(join(archive, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      writeFile(join(archive, 'sdk-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`)
      writeFile(join(archive, 'cost.json'), costContent)
      if (costReport !== null) writeFile(join(archive, 'pilot-report.md'), costReport)
    }
  } catch (error) {
    context.finalizationError = costPublicationFailure(error, lifecycleSummary.archive?.path, context.finalizationError, log)
  }
}

function finishPilotRun(context) {
  const { archiveRoot, runId, options, routing, cost, started, ended, lifecycleSummary, log, model,
    state: { servedModel, streamError }, usage, summary, completedNormally, partial, deferred } = context
  let { finalizationError } = context
  const costIndexError = appendCostIndex({ archiveRoot, runId, card: options.card, route: options.hard ? 'HARD' : routing.route, cost, started, ended, archive: lifecycleSummary.archive?.path, log })
  finalizationError ||= costIndexError
  log(`served model: ${servedModel ?? 'unknown'} (requested ${model.value})`)
  if (finalizationError) throw finalizationError
  if (streamError) throw streamError
  return { usage, summary, exitCode: completedPilotExitCode(completedNormally, partial, deferred) }
}

export async function runPilot(options, dependencies) {
  const context = { options, dependencies, ...pilotDependencies(dependencies) }
  initializePilotConfiguration(context)
  initializePilotRoute(context)
  context.state = initialPilotState()
  initializePilotSdk(context)
  initializePilotLifecycle(context)
  initializePilotUsage(context)
  initializePilotTimeout(context)
  initializePilotSessions(context)
  initializePilotRuntime(context)
  return executePilotSessions(context)
}
