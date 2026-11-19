import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveConsent, resolveConfigDir } from './lane-consent-check-core.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'
import { originalSecondOpinionRepo, secondOpinionPrompt } from './second-opinion-prompt.mjs'
import { announceUnsandboxedLane, LaneSandboxRefusal, resolveLaneSandbox } from './host/lane-sandbox.mjs'
import { requestNamedPaths, requestDirectoryNote, requestPathRefusal, unreadEscape } from './host/second-opinion-request-paths.mjs'
import { createModelTracker, modelWarnings } from './model-fallback-core.mjs'
import { quoteRemedyWord } from './remedy-quote.mjs'
import { appServerTreeTerminated, resolveAstraSandbox, verifiedAstraResult } from './second-opinion-codex-turn.mjs'

const CODEX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
// The Claude fallback always runs Opus at xhigh; the caller's --effort drives only the Astra route.
const OPUS_EFFORT = 'xhigh'
export { requestNamedPaths }
function signalExitCode(reason) {
  if (reason === 'SIGHUP') return 129
  if (reason === 'SIGINT') return 130
  if (reason === 'SIGQUIT') return 131
  if (reason === 'SIGTERM') return 143
  return null
}
function appendLine(out, line) {
  appendFileSync(out, `${String(line).replace(/\r?\n/g, ' ').trim()}\n`)
}
// Every refusal has the same shape: the whole output is the REFUSED line, then its EXIT marker.
function refuse(out, message, code) {
  writeFileSync(out, `REFUSED: ${message}\n`)
  appendLine(out, `EXIT=${code}`)
  return code
}

function appendOutput(out, text) {
  if (!text) return
  appendFileSync(out, text.endsWith('\n') ? text : `${text}\n`)
}

function codexCompanion(env) {
  const cache = path.join(resolveConfigDir(env), 'plugins', 'cache', 'openai-codex', 'codex')
  let versions
  try {
    versions = readdirSync(cache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return null
  }
  for (const version of versions) {
    const candidate = path.join(cache, version, 'scripts', 'codex-companion.mjs')
    if (existsSync(candidate)) return candidate
  }
  return null
}

// The companion's plugin version root (`<version>/scripts/codex-companion.mjs`), read-only in the sandbox.
function companionRoot(companion) {
  const scripts = path.dirname(companion)
  return path.basename(scripts) === 'scripts' ? path.dirname(scripts) : scripts
}

// A refusal before the companion starts: release the plan and the ownership record. No companion or
// broker ever ran, so ownership's broker diagnostics describe nothing and are not reported.
function refuseBeforeLaunch(sandbox, ownership, removeListeners) {
  sandbox.dispose?.()
  ownership.stop()
  removeListeners()
}

function runCodex({ companion, cwd, effort, request, namedPaths = [], env, signal, adapter, maxOutputBytes = CODEX_OUTPUT_LIMIT_BYTES, resolveSandbox = resolveLaneSandbox }) {
  if (signal?.aborted) return Promise.resolve({ status: 1, stdout: '', stderr: 'Codex companion launch aborted before spawn.\n', cleanup: [], interrupted: signal.reason })
  const completionNonce = randomBytes(32).toString('hex')
  const ownership = adapter.createCodexBrokerOwnership(env)
  const companionArgs = [companion, 'task', '--fresh', '--model', 'gpt-6-astra', '--effort', effort, request]
  let stopEverything = (reason = null) => {
    if (reason) { return ownership.stop() }
    return []
  }
  const onAbort = () => stopEverything(signal?.reason)
  const onExit = () => { stopEverything() }
  process.once('exit', onExit)
  signal?.addEventListener('abort', onAbort, { once: true })
  const state = { sandbox: undefined, directoryNote: null, child: undefined, completionNonce }
  try {
    // second-opinion only reads the repository: it is bound read-only (H5).
    state.sandbox = resolveSandbox({ profile: 'codex', bin: process.execPath, args: companionArgs, cwd, env: ownership.env, paths: { readable: [companionRoot(companion)] }, platform: adapter.platform, readonlyCwd: true, completionNonce })
    announceUnsandboxedLane(state.sandbox)
    const refusal = checkCodexSandbox(state, ownership, { namedPaths, env, cwd, signal, onAbort, onExit })
    if (refusal) return Promise.resolve(refusal)
    state.child = spawnCodexChild(state.sandbox, ownership, companionArgs, cwd, adapter)
  } catch (error) {
    return codexLaunchError(error, state.sandbox, ownership, signal, onAbort, onExit)
  }
  return collectCodexChild(state, ownership, { signal, onAbort, onExit, maxOutputBytes, updateStop: (stop) => { stopEverything = stop } })
}

function checkCodexSandbox(state, ownership, { namedPaths, env, cwd, signal, onAbort, onExit }) {
  const sandbox = state.sandbox
  if (sandbox.kind !== 'bwrap') return null
  const removeListeners = () => { process.removeListener('exit', onExit); signal?.removeEventListener('abort', onAbort) }
  if (typeof sandbox.unreadable !== 'function') {
    refuseBeforeLaunch(sandbox, ownership, removeListeners)
    return { status: 2, stdout: '', stderr: 'REFUSED: sandbox plan cannot check request paths.\n', cleanup: [], sandbox: sandbox.line }
  }
  const unseen = sandbox.unreadable(namedPaths, { env: ownership.env, exempt: unreadEscape(env.WT_SECOND_OPINION_UNREAD, ownership.env.HOME ?? env.HOME ?? '') })
  // Only files refuse; an unreadable named directory is reported and the review runs.
  const missing = unseen.filter((item) => typeof item === 'string' || !item.directory)
  state.directoryNote = requestDirectoryNote(unseen.filter((item) => typeof item !== 'string' && item.directory).map((item) => item.path), ownership.env.HOME ?? env.HOME ?? '', env)
  if (missing.length) {
    refuseBeforeLaunch(sandbox, ownership, removeListeners)
    return { status: 2, stdout: '', stderr: requestPathRefusal(missing, cwd, ownership.env.HOME ?? env.HOME ?? '', env), cleanup: [], sandbox: sandbox.line }
  }
  return null
}

function spawnCodexChild(sandbox, ownership, companionArgs, cwd, adapter) {
  // The broker records a namespace pid; ownership must find its host descendant.
  if (sandbox.kind === 'bwrap') ownership.brokerInChildPidNamespace?.()
  const [command, commandArgs] = sandbox.wrap(process.execPath, companionArgs)
  return spawn(command, commandArgs, {
    cwd, env: ownership.env, detached: adapter.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true,
  })
}

function codexLaunchError(error, sandbox, ownership, signal, onAbort, onExit) {
  process.removeListener('exit', onExit)
  signal?.removeEventListener('abort', onAbort)
  sandbox?.dispose?.()
  ownership.stop()
  // A path-check refusal happens before any broker runs.
  if (sandbox?.kind === 'bwrap' && error instanceof LaneSandboxRefusal) {
    return Promise.resolve({ status: 1, stdout: '', stderr: `REFUSED: ${error.message}\n`, cleanup: [], sandbox: sandbox.line })
  }
  throw error
}

function startCodexLifecycle({ child, sandbox }, ownership) {
  let cleanup = null
  let companionAlive = true
  let interrupted = null
  const captureBroker = () => {
    if (companionAlive && child.pid) ownership.capture(child.pid)
  }
  captureBroker()
  const captureTimer = setInterval(captureBroker, 25)
  captureTimer.unref()
  child.once('exit', () => {
    companionAlive = false
    clearInterval(captureTimer)
  })
  const stop = (reason = null, ownershipOptions = {}) => {
    if (cleanup) return cleanup
    if (reason) interrupted ??= reason
    clearInterval(captureTimer)
    captureBroker()
    if (companionAlive) child.kill('SIGTERM')
    // The public client closes its own app-server; no companion broker is expected.
    cleanup = ownership.stop(ownershipOptions).filter((line) => line !== 'app-server cleanup unavailable: broker not captured before companion exit')
    // The refreshed codex token is written back to the shared ~/.codex by the sandbox (host
    // perimeter) only if it changed; the shared file stayed read-only during the run (H3).
    sandbox.writeBackAuth?.()
    sandbox.dispose?.()
    return cleanup
  }
  return { stop, closed: () => { companionAlive = false }, clearCapture: () => clearInterval(captureTimer),
    get cleanup() { return cleanup }, get interrupted() { return interrupted } }
}

function captureCodexOutput(child, output, lifecycle, maxOutputBytes) {
  const collect = (stream, chunk) => {
    if (output.overflow) return
    output.bytes += chunk.length
    if (output.bytes > maxOutputBytes) {
      output.overflow = true
      output.chunks.stdout.length = 0
      output.chunks.stderr.length = 0
      output.chunks.completion.length = 0
      lifecycle.stop()
      return
    }
    output.chunks[stream].push(chunk)
  }
  child.stdout.on('data', (chunk) => collect('stdout', chunk))
  child.stderr.on('data', (chunk) => collect('stderr', chunk))
  child.stdio[3].on('data', (chunk) => collect('completion', chunk))
}

function codexChildResult(output, lifecycle, maxOutputBytes, status, errorText = () => '') {
  return output.overflow
    ? { status: 1, stdout: '', stderr: `REFUSED: Codex companion output exceeded ${maxOutputBytes} bytes.\n`, cleanup: lifecycle.cleanup }
    : { status, stdout: Buffer.concat(output.chunks.stdout).toString(), stderr: `${Buffer.concat(output.chunks.stderr).toString()}${errorText()}`, cleanup: lifecycle.cleanup }
}

function awaitCodexClose(state, output, lifecycle, { signal, onAbort, onExit, maxOutputBytes }) {
  const { child, sandbox, directoryNote, completionNonce } = state
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      lifecycle.clearCapture()
      process.removeListener('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, completionNonce, completionRecord: Buffer.concat(output.chunks.completion).toString(), interrupted: lifecycle.interrupted, sandbox: sandbox.line, notes: directoryNote ? [directoryNote] : [] })
    }
    child.once('error', (error) => {
      lifecycle.stop()
      finish(codexChildResult(output, lifecycle, maxOutputBytes, 1, () => `${error.message}\n`))
    })
    child.once('close', (code, childSignal) => {
      lifecycle.closed()
      const record = Buffer.concat(output.chunks.completion).toString()
      lifecycle.stop(null, { treeTerminated: appServerTreeTerminated(record, completionNonce) })
      finish(codexChildResult(output, lifecycle, maxOutputBytes, code ?? (childSignal ? 1 : 0)))
    })
  })
}

function collectCodexChild(state, ownership, options) {
  const output = { chunks: { stdout: [], stderr: [], completion: [] }, bytes: 0, overflow: false }
  const lifecycle = startCodexLifecycle(state, ownership)
  options.updateStop(lifecycle.stop)
  captureCodexOutput(state.child, output, lifecycle, options.maxOutputBytes)
  if (options.signal?.aborted) options.onAbort()
  return awaitCodexClose(state, output, lifecycle, options)
}

export function listProcessTable(adapter) {
  try {
    return adapter.readProcessSnapshot()
  } catch {
    return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
  }
}

export function listProcessRelationships(adapter) {
  try { return adapter.readProcessRelationships() } catch {
    return { status: 'unavailable', processes: [], reason: 'process relationship discovery unavailable on this platform' }
  }
}

export function listBrokers(adapter, table = listProcessTable(adapter)) {
  if (!table.supported) return { supported: false, pids: [], reason: 'broker cleanup unavailable on this platform' }
  return { supported: true, pids: table.processes.filter((process) => /openai-codex[\\/]codex.*scripts[\\/]app-server-broker/i.test(process.command)).map((process) => process.pid) }
}

function resolveSdkQuery(repo, env) {
  const require = resolveAgentSdkRequire({ projectDir: repo, env })
  return require('@anthropic-ai/claude-agent-sdk').query
}

function sdkRemedy(error) {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line sonarjs/super-linear-regex -- one bounded SDK error message; rewriting would change which remedies match
  const remedy = /run:\s*(.+)$/i.exec(message)?.[1]
  return remedy ? `run: ${remedy}` : `install @anthropic-ai/claude-agent-sdk (${message})`
}

export const createSecondOpinionDependencies = (adapter, options = {}) => ({
  resolveCodexCompanion: codexCompanion,
  runCodex: (runOptions) => runCodex({ ...runOptions, adapter, maxOutputBytes: options.maxOutputBytes,
    resolveSandbox: (request) => resolveAstraSandbox(options.resolveSandbox ?? resolveLaneSandbox, request) }).then(verifiedAstraResult),
  resolveSdkQuery,
})

function secondOpinionRequest(options) {
  return options.requestText ?? readFileSync(options.request, 'utf8')
}

function refuseUnconsentedAstra(options, consent) {
  return refuse(options.out, consent.outcome === 'unknown'
    ? 'Astra requires active GPT lane consent, and the consent setting could not be read; check executor_lane_consent in the plugin settings of this profile and project.'
    : 'Astra requires active GPT lane consent.', 1)
}

// A second opinion exists to escape the session's own model-family biases, so `auto` never
// picks a Claude model: without a consented external lane, the second opinion is the user.
// Only an explicit `--route opus` runs the Claude consult.
function refuseUnconsentedAuto(options, consent) {
  // The remedy names the level that refused: `wt-lane-consent --on` writes only the account
  // setting, so a project that narrows consent needs its own `--project <repo> --on`.
  const accountOff = consent.account.state !== 'true'
  const projectNarrows = consent.project.state === 'not_true'
  const reasons = []
  const remedies = []
  if (consent.outcome === 'unknown') {
    reasons.push('the consent setting could not be read (check executor_lane_consent in the plugin settings of this profile and project)')
  } else {
    if (accountOff) {
      reasons.push('GPT lane consent is off for this account')
      remedies.push('wt-lane-consent --on')
    }
    if (projectNarrows) {
      reasons.push('this project narrows GPT lane consent')
      remedies.push(`wt-lane-consent --project ${quoteRemedyWord(originalSecondOpinionRepo(options))} --on`)
    }
  }
  return refuse(options.out, `no consented external lane is available for an independent second opinion; ${reasons.join(', and ')}. `
    + 'A same-family consult cannot counter this session\'s own biases, so ask the user for the second opinion instead.'
    + (remedies.length ? ` To route it to GPT-6 Astra, run: ${remedies.join(' && ')}` : ''), 1)
}

function appendAstraResult(options, result) {
  if (result.sandbox) appendLine(options.out, result.sandbox)
  // Each note on its own line right under the sandbox line, before the answer.
  for (const note of result.notes ?? []) appendLine(options.out, note)
  appendOutput(options.out, result.stdout)
  appendOutput(options.out, result.stderr)
  for (const line of result.cleanup ?? []) appendLine(options.out, line)
}

function finishAstraOpinion(options, result) {
  const answer = (result.stdout ?? '').trim()
  // The owned-child adapter requires a validated positive completion record.
  // Answer and diagnostic prose remain evidence, never a verdict channel.
  const code = signalExitCode(result.interrupted) ?? (result.status || (!answer ? 1 : 0))
  appendLine(options.out, `EXIT=${code}`)
  return code
}

async function runAstraOpinion(options, dependencies, env, request) {
  const companion = dependencies.resolveCodexCompanion(env)
  if (!companion) {
    return refuse(options.out, 'GPT lane consent is active, but the Codex companion runtime is not installed; install the openai-codex plugin.', 1)
  }

  writeFileSync(options.out, 'ROUTE=gpt-astra\n')
  let result
  try {
    result = await dependencies.runCodex({
      companion,
      cwd: options.repo,
      effort: options.effort,
      request: secondOpinionPrompt(options, request, 'astra'),
      namedPaths: requestNamedPaths(request, env.HOME ?? ''),
      env,
      signal: options.signal,
    })
    appendAstraResult(options, result)
  } catch (error) {
    result = { status: 1 }
    appendLine(options.out, error instanceof Error ? error.message : String(error))
  }

  return finishAstraOpinion(options, result)
}

function opusStream(query, options, request, env) {
  return query({
    prompt: secondOpinionPrompt(options, request, 'opus'),
    options: {
      model: 'opus',
      effort: OPUS_EFFORT,
      cwd: options.repo,
      tools: ['Read', 'Glob', 'Grep'],
      settingSources: [],
      permissionMode: 'default',
      abortController: options.abortController,
      canUseTool: async (toolName) => ['Read', 'Glob', 'Grep'].includes(toolName)
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'second-opinion is read-only' },
      env,
    },
  })
}

function finishOpusOpinion(options, modelTracker, { answer, failed, refused }) {
  if (!answer.trim()) {
    failed = true
    answer = 'Claude Opus returned no answer.'
  }
  appendOutput(options.out, answer)
  const observation = modelTracker.result()
  for (const warning of modelWarnings(observation, { name: 'second-opinion' })) appendLine(options.out, warning)
  if (refused) appendLine(options.out, 'OUTCOME=refused-by-provider provider=anthropic')
  const code = signalExitCode(options.signal?.aborted ? options.signal.reason : null) ?? (failed || refused ? 1 : 0)
  appendLine(options.out, `EXIT=${code}`)
  return code
}

function opusStopReason(message) {
  return message.type === 'assistant' ? message.message?.stop_reason : message.stop_reason
}

function observeOpusCompletion(state, message) {
  if (message.parent_tool_use_id != null) return
  if (message.type === 'system' && message.subtype === 'model_refusal_no_fallback') state.refused = true
  const reason = opusStopReason(message)
  if (typeof reason === 'string' && ['assistant', 'result'].includes(message.type)) state.refused = reason === 'refusal'
  if (message.type !== 'result') return
  if (message.is_error) state.failed = true
  if (typeof message.result === 'string') state.answer = message.result
}

async function runOpusOpinion(options, dependencies, env, request) {
  writeFileSync(options.out, 'ROUTE=claude-opus\n')

  let query
  try {
    query = dependencies.resolveSdkQuery(originalSecondOpinionRepo(options), env)
  } catch (error) {
    appendLine(options.out, `REFUSED: Claude Agent SDK unavailable; ${sdkRemedy(error)}`)
    appendLine(options.out, 'EXIT=1')
    return 1
  }

  const state = { answer: '', failed: false, refused: false }
  const modelTracker = createModelTracker('opus', env)
  try {
    const stream = opusStream(query, options, request, env)
    for await (const message of stream) {
      modelTracker.observe(message)
      observeOpusCompletion(state, message)
    }
  } catch (error) {
    state.failed = true
    state.answer = error instanceof Error ? error.message : String(error)
  }
  return finishOpusOpinion(options, modelTracker, state)
}

export async function runSecondOpinion(options, dependencies, env = process.env) {
  const request = secondOpinionRequest(options)
  const consent = resolveConsent(originalSecondOpinionRepo(options), env)
  const route = options.route ?? 'auto'

  // The CLI validates the value; a direct caller gets the same refusal rather than a silent Opus run.
  if (!['auto', 'astra', 'opus'].includes(route)) {
    return refuse(options.out, `unknown route ${JSON.stringify(route)}; use auto, astra, or opus.`, 2)
  }
  if (route === 'astra' && consent.outcome !== 'true') {
    return refuseUnconsentedAstra(options, consent)
  }
  if (route === 'auto' && consent.outcome !== 'true') return refuseUnconsentedAuto(options, consent)
  if (route === 'astra' || route === 'auto') return runAstraOpinion(options, dependencies, env, request)
  return runOpusOpinion(options, dependencies, env, request)
}
