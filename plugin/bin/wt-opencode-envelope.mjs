#!/usr/bin/env node
// wt-opencode-envelope.mjs — single-turn external-lane BATCH envelope.
//
// Measured (2026-08-04, re-observed with a second instrument 2026-08-16): a bridge to the
// external lane spends ~8% of its Claude-side tokens on its FIRST turn and ~92% on turns 2+.
// plugin/agents/opencode-verifier.md drives FIVE Bash calls for ONE question (binary discovery,
// `opencode providers list`, the `run` invocation, JSON extraction, plus a retry path) — each one
// a full agent turn that re-ingests the whole prior transcript.
//
// The invariant this script exists for: N external calls cost the caller ONE Bash tool call,
// never N. It reads tasks or generates them from an explicit source rule, resolves the opencode
// binary and the availability gate ONCE, then fans the tasks out with bounded concurrency — each
// task gets its own task file,
// its own unique stream log, its own `EXIT=` marker, and its own answer file. The script's own
// stdout names a MANIFEST file. A successful single-task batch appends its JSON-encoded answer
// to that same line, so schema callers need not open a file they cannot access.

import { spawn, spawnSync as preflightSpawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { laneTextFromOutput, laneUsageFromOutput, verifierStreamDirForEnv } from './wt-verifier-cli-guard-hook.mjs'
import { DEFAULT_MAX_TASKS, generateEachTasks, parseEachSource } from './lib/opencode-envelope-tasks.mjs'
import { effectiveSkillDiscoveryRefusal, opencodeChildEnv, opencodeSkillFenceRefusal, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'
import { providerCredentialNames } from './lib/external-model-env.mjs'
import { resolvedBinary } from './lib/resolved-binary.mjs'

const DEFAULT_MODEL = 'openai/gpt-5.6-luna' // gpt-5.4 withdrawn from Codex/ChatGPT accounts 2026-08-31
const DEFAULT_AGENT = 'plan'
const DEFAULT_TIMEOUT_SEC = 570
// How many CLI calls run AT ONCE. It bounds the BATCH, never the total: a source of 10 000 items
// runs 10 000 calls, `DEFAULT_CONCURRENCY` at a time, in as many sequential batches as that takes.
// Measured 2026-08-20 on this machine, 16 identical calls to openai/gpt-5.6-luna, all answered at every
// level:
//
//   concurrency  8  ->  41 s
//   concurrency 16  ->  26 s      <- faster, not slower
//   concurrency 32  ->  27 s      <- says nothing: only 16 tasks, so 32 slots cannot be used
//
// ⚠ THE SCOPE OF THAT MEASUREMENT IS THE PART TO CARRY. Those prompts were trivial — one word of
// output each. The external tool absorbed the parallelism because there was almost nothing to
// absorb. With heavy prompts, sixteen concurrent requests are a very different load: the provider
// answers with rate limits or token-per-minute limits, the CLI receives the 429s and slows down,
// and the wall clock stops improving. So 16 is the right default for the shape we measured, and it
// is NOT a claim about a fan-out of long analyses.
//
// Degradation is TIME, never loss: the 600 s harness ceiling that once made a slow batch fatal
// binds a FOREGROUND Bash call only, and this script runs in the background. A caller that wants a
// gentler footprint lowers it with --concurrency; nothing about the total changes either way.
const DEFAULT_CONCURRENCY = 16
const DEFAULT_MAX_REDUCE_CHARS = 131072

// Sum the per-task token usage ONCE, here, so the manifest answers "what did this cost"
// without every reader re-deriving it. The per-call detail was already complete; what was
// missing was any total at all, so a display either recomputed it or showed nothing.
// Absent counters are reported as null rather than 0: a zero reads as a measurement, and
// "no usage reported" is a different fact from "no tokens used".
function sumTaskTokens(results) {
  const keys = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']
  const out = {}
  let sawAny = false
  for (const k of keys) {
    let sum = null
    for (const r of results) {
      const v = r?.usage?.tokens?.[k]
      if (typeof v === 'number') { sum = (sum ?? 0) + v; sawAny = true }
    }
    out[k] = sum
  }
  return sawAny ? out : null
}

function usage() {
  return [
    'wt-opencode-envelope — run N opencode CLI calls behind exactly ONE Bash call.',
    '',
    'Usage:',
    '  wt-opencode-envelope.mjs <tasks.json> --dir <workdir> [options]',
    '  wt-opencode-envelope.mjs --each-json <path> --prompt-template <text> --id-template <text> --dir <workdir> [options]',
    '  wt-opencode-envelope.mjs --each-lines <path> --prompt-template <text> --id-template <text> --dir <workdir> [options]',
    '  wt-opencode-envelope.mjs --reduce <manifest-path> --reduce-prompt <text> --dir <workdir> [options]',
    '',
    'Required:',
    '  <tasks.json>           JSON array of tasks: [{ "id": "t1", "prompt": "..." , ',
    '                         "model"?, "variant"?, "agent"?, "fallbackModel"? }, ...]',
    '                         Per-task fields override the matching --option below.',
    '  --dir <path>           Explicit opencode working directory (never the inherited cwd).',
    '',
    'Generated-task mode (explicitly choose exactly one source delimiter):',
    '  --each-json <path>                 JSON array; one task per string or object element (default/general form)',
    '  --each-lines <path>                One task per non-blank line; only for items that cannot contain newlines',
    '  --prompt-template <text>           Prompt template; {{item}} is the whole item, {{item.field}} an object field',
    '  --id-template <text>               Task-id template using the same placeholders (dotted field paths allowed)',
    '  --max-tasks <n>                    Optional bound on generated tasks. Default: NO BOUND.',
    '                                     A source larger than the bound is REFUSED, never truncated —',
    '                                     batch size is set by --concurrency, not by the task count.',
    '',
    'Reduce mode (one external synthesis call from a prior fan-out manifest):',
    '  --reduce <manifest-path>             Source manifest; only successful answer files are included.',
    '  --reduce-prompt <text>               Synthesis template containing exactly a {{answers}} insertion point.',
    '  --reduce-prompt-file <path>          File containing the synthesis template (instead of --reduce-prompt).',
    `  --max-reduce-chars <n>              Maximum rendered answer-block characters. Default: ${DEFAULT_MAX_REDUCE_CHARS}`,
    '                                     Excess answers are dropped whole; their ids are logged and manifested.',
    '                                     A reduce manifest is itself valid --reduce input, so reduces nest.',
    '                                     Each answer file is named from its SOURCE manifest, so two',
    '                                     reduces sharing --dir cannot overwrite one another.',
    '',
    'Options:',
    '  --model <provider/model>           Default model. Default: openai/gpt-5.6-luna',
    '  --fallback-model <provider/model>  Default fallback for the ONE 429 retry. Default: openai/gpt-5.6-terra',
    '  --variant <name>                   Default --variant (unvalidated) for tasks without one',
    '  --agent <name>                     Default opencode agent mode. Default: plan',
    '  --timeout-sec <n>                  Per-task CLI timeout. Default: 570',
    `  --concurrency <n>                  Tasks run in parallel per batch. Default: ${DEFAULT_CONCURRENCY}`,
    '                                     Bounds the BATCH, never the total; the rest runs in later batches.',
    '  Each invocation writes its task copies, answers, and manifest beneath',
    '  the machine state root (XDG_STATE_HOME or ~/.local/state): wt-envelope/<pid>-<timestamp>-<random>/.',
    '  Set WT_ENVELOPE_WORKDIR to choose a per-invocation directory explicitly.',
    '  witnesses immutable after the invocation that created them.',
    '',
    'Prints exactly one MANIFEST line to stdout, and for exactly one successful non-reduce task:',
    '  MANIFEST: <path> ANSWER: <JSON string> — every task attempted; results are in <path>.',
    '  OPENCODE_UNAVAILABLE: <reason> — no binary / no authenticated provider (no task ran).',
    '',
    'Never prints raw answer text. Exit code: 0 = MANIFEST written, 1 = UNAVAILABLE, 2 = usage/setup error.',
  ].join('\n')
}

function parseArgs(argv) {
  const out = {
    tasksFile: null,
    eachJson: null,
    eachLines: null,
    promptTemplate: null,
    idTemplate: null,
    maxTasks: DEFAULT_MAX_TASKS,  // undefined = no bound
    dir: null,
    model: DEFAULT_MODEL,
    fallbackModel: DEFAULT_MODEL,
    variant: null,
    agent: DEFAULT_AGENT,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    concurrency: DEFAULT_CONCURRENCY,
    outDir: null,
    manifest: null,
    reduce: null,
    reducePrompt: null,
    reducePromptFile: null,
    maxReduceChars: DEFAULT_MAX_REDUCE_CHARS,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i] ?? null
    else if (a === '--each-json') out.eachJson = argv[++i] ?? null
    else if (a === '--each-lines') out.eachLines = argv[++i] ?? null
    else if (a === '--prompt-template') out.promptTemplate = argv[++i] ?? null
    else if (a === '--id-template') out.idTemplate = argv[++i] ?? null
    else if (a === '--max-tasks') out.maxTasks = Number(argv[++i])
    else if (a === '--model') out.model = argv[++i] ?? out.model
    else if (a === '--fallback-model') out.fallbackModel = argv[++i] ?? out.fallbackModel
    else if (a === '--variant') out.variant = argv[++i] ?? null
    else if (a === '--agent') out.agent = argv[++i] ?? out.agent
    else if (a === '--timeout-sec') out.timeoutSec = Number(argv[++i]) || DEFAULT_TIMEOUT_SEC
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY)
    else if (a === '--out-dir') out.outDir = argv[++i] ?? null
    else if (a === '--manifest') out.manifest = argv[++i] ?? null
    else if (a === '--reduce') out.reduce = argv[++i] ?? null
    else if (a === '--reduce-prompt') out.reducePrompt = argv[++i] ?? null
    else if (a === '--reduce-prompt-file') out.reducePromptFile = argv[++i] ?? null
    else if (a === '--max-reduce-chars') out.maxReduceChars = Number(argv[++i])
    else rest.push(a)
  }
  out.tasksFile = rest[0] ?? null
  return out
}

function resolveBinarySync() {
  const fromPath = resolvedBinary('opencode', process.env, {
    accessSyncFn: fs.accessSync,
    constants: fs.constants,
    platform: process.platform,
    realpathSyncFn: fs.realpathSync,
    statSyncFn: fs.statSync,
    pathApi: process.platform === 'win32' ? path.win32 : path,
  })
  if (fromPath !== null) return fromPath
  const candidates = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ]
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      // not this one
    }
  }
  return null
}

function providerAuthenticatedSync(bin, cwd, env, credentialNames) {
  const res = spawnOpencode(preflightSpawnSync, bin, ['providers', 'list'], { cwd, encoding: 'utf8', timeout: 30000, env }, process.platform, credentialNames)
  return res.status === 0
}

function uniqueToken() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function invocationOutDir(dir) {
  const explicit = process.env.WT_ENVELOPE_WORKDIR
  if (typeof explicit === 'string' && explicit.length > 0) return path.resolve(explicit)
  // SHARED state, deliberately NOT the hook-only plugin data dir: the observatory (a non-plugin
  // process) follows the absolute MANIFEST path printed here, and the arbiter reads the answer
  // files by hand — so the files live under the machine's state root, beside wt-observe.
  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(stateRoot, 'wt-envelope', uniqueToken())
}

function uniqueStreamFile(taskId) {
  const dir = verifierStreamDirForEnv()
  fs.mkdirSync(dir, { recursive: true })
  const safeId = String(taskId).replace(/[^A-Za-z0-9_.-]/g, '_')
  return path.join(dir, `wt-opencode-envelope-stream-${safeId}-${uniqueToken()}.jsonl`)
}

function isRateLimited(text) {
  if (typeof text !== 'string') return false
  return /429|rate[ _-]?limit|rate_limit_exceeded|too many requests|resource_exhausted/i.test(text)
}

/** Kills the whole process GROUP of a spawned call and reports how many members had to be
 * killed beyond the direct child. Requires the call to have been spawned with `detached: true`,
 * which makes its pid the group id.
 *
 * Returns the number of survivors reaped, or `null` when the platform cannot be asked. NEVER 0
 * on an unmeasurable platform: a zero here would render as "nothing leaked" in the manifest,
 * which is precisely the reassuring-green failure this whole change exists to remove.
 *
 * ⚠ CROSS-PLATFORM, stated rather than discovered in CI. POSIX signalling of a group via a
 * negative pid does not exist on Windows: `process.kill(-pid)` throws there. Windows instead
 * asks taskkill to terminate the pid and its descendants (`/T`); the result remains `null`
 * because taskkill does not report a survivor count. */
function reapGroup(pid) {
  if (typeof pid !== 'number') return null
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    preflightSpawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return null
  }
  // Count what is still alive in the group AFTER killing it, rather than before: the answer we
  // want is "did anything outlive the call", and asking before the kill would count the child
  // itself plus anything mid-exit.
  try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone — nothing to reap */ }
  let survivors = 0
  try {
    // A group whose leader is dead keeps its id while members remain, so this cannot address a
    // recycled group in the window between the kill and this check.
    process.kill(-pid, 0)
    survivors = 1 // at least one member outlived SIGKILL; exact count needs a process table read
  } catch {
    survivors = 0
  }
  return survivors
}

/** Runs `opencode run` ONCE, async, for a single task. Enforces the four non-negotiables
 * together: stdin closed (`< /dev/null` equivalent — stdio[0]:'ignore'), `--auto` so a
 * permission prompt never silently hangs the process, an explicit `--dir` (never the inherited
 * cwd), and a timeout with an `EXIT=<code>` marker appended to the SAME log after the process
 * exits (never a separate, reusable path — every invocation gets its own unique stream file). */
function runOnceAsync({ bin, taskfile, dir, model, variant, agentMode, timeoutSec, taskId, childEnv }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const streamFile = uniqueStreamFile(taskId)
    const args = [
      'run',
      'Follow the instructions in the attached file and output ONLY what it asks for. Do not add commentary.',
      '--agent',
      agentMode,
      '--model',
      model,
    ]
    if (typeof variant === 'string' && variant.length > 0) args.push('--variant', variant)
    args.push('--auto', '--dir', dir, '--format', 'json', '-f', taskfile)

    // ⚠ On POSIX, `detached: true` puts the call in its OWN process group, and that is load-bearing
    // rather than cosmetic. Measured 2026-08-18 against the previous shape (plain spawn + `child.kill`),
    // with a stub binary that starts a background process before blocking:
    //
    //   a descendant holds this pipe   -> the envelope NEVER exits (alive past 45s on a 5s
    //                                     timeout), writes no manifest, no EXIT= marker, and
    //                                     leaves a zero-byte log — because `close` fires only
    //                                     when the child's stdio closes, and a survivor holds it;
    //   no descendant holds this pipe  -> the envelope exits at 5s and reports SUCCESS, while a
    //                                     detached descendant keeps running, orphaned to init.
    //
    // The second row is the dangerous one: nothing in the manifest, the log or the exit code can
    // show it. Signalling the GROUP is what closes both — a survivor cannot hold the pipe if no
    // survivor exists. The invariant, stated so a later reader can check the body against it:
    // WHEN THIS FUNCTION STOPS A CALL, NOTHING THAT CALL STARTED IS STILL RUNNING. Windows cannot
    // use the detached command-shim shape because cmd.exe then loses piped stdout; taskkill /T is
    // its process-tree counterpart instead.
    const child = spawnOpencode(spawn, bin, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], ...(process.platform === 'win32' ? {} : { detached: true }), env: childEnv }, process.platform)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // Number of descendants that had to be reaped AFTER the child itself was gone. `null` means
    // "not measurable here", never 0 — a zero is a measurement and would read as "nothing leaked"
    // on a platform where we cannot look. See reapGroup().
    let reaped = null
    const timer = setTimeout(() => {
      timedOut = true
      reaped = reapGroup(child.pid)
    }, timeoutSec * 1000)

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      const exitCode = 1
      fs.writeFileSync(streamFile, stdout, 'utf8')
      fs.appendFileSync(streamFile, `\nEXIT=${exitCode}\n`, 'utf8')
      fs.appendFileSync(streamFile, `\n--- spawn error ---\n${String(err)}\n`, 'utf8')
      resolve({ streamFile, stdout, stderr, exitCode, reaped, timedOut: false, startedAt, durationMs: Date.now() - startedAt })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      // ⚠ REAP ON THE CLEAN PATH TOO — this is the half that is easy to leave out, because the
      // call SUCCEEDED and there is no failure to react to. Measured: a call can exit 0, write a
      // correct manifest, and still leave a detached descendant running. Reaping only on timeout
      // would fix the loud case and ship the silent one.
      if (!timedOut) reaped = reapGroup(child.pid)
      const exitCode = timedOut || signal === 'SIGKILL' ? 124 : (code ?? 1)
      fs.writeFileSync(streamFile, stdout, 'utf8')
      fs.appendFileSync(streamFile, `\nEXIT=${exitCode}\n`, 'utf8')
      if (stderr.length > 0) fs.appendFileSync(streamFile, `\n--- stderr ---\n${stderr}\n`, 'utf8')
      resolve({ streamFile, stdout, stderr, exitCode, reaped, timedOut: timedOut || signal === 'SIGKILL', startedAt, durationMs: Date.now() - startedAt })
    })
  })
}

async function runTask(task, opts, outDir) {
  const id = task.id
  const model = task.model ?? opts.model
  const fallbackModel = task.fallbackModel ?? opts.fallbackModel
  const variant = task.variant ?? opts.variant
  const agentMode = task.agent ?? opts.agent
  const timeoutSec = task.timeoutSec ?? opts.timeoutSec

  const safeId = String(id).replace(/[^A-Za-z0-9_.-]/g, '_')
  const taskfile = path.join(outDir, `${safeId}.task.md`)
  fs.writeFileSync(taskfile, String(task.prompt ?? ''), 'utf8')

  let result
  let modelUsed = model
  result = await runOnceAsync({ bin: opts.bin, taskfile, dir: opts.dir, model, variant, agentMode, timeoutSec, taskId: id, childEnv: opencodeChildEnv(undefined, providerCredentialNames(model)) })

  if (result.exitCode !== 0 && isRateLimited(result.stdout + result.stderr)) {
    modelUsed = fallbackModel
    result = await runOnceAsync({ bin: opts.bin, taskfile, dir: opts.dir, model: fallbackModel, variant, agentMode, timeoutSec, taskId: `${id}-retry`, childEnv: opencodeChildEnv(undefined, providerCredentialNames(fallbackModel)) })
  }

  const answerFile = path.join(outDir, `${safeId}.answer.txt`)

  // Card #1839472753 — the two facts an observability NODE needs beyond "did it answer": how
  // long the call took, and what it cost. Both are read from data the run already produced (the
  // process's own wall-clock, the CLI's `--format json` usage lines) — never invented. `usage` is
  // OMITTED entirely when the stream carried no measurable tokens (a plain-text call), because a
  // zero here would render as a measurement, which is precisely the failure this exists to avoid.
  // startedAt is recorded BESIDE durationMs so the manifest shows the call PATTERN, not just
  // how long each call took. Without it the wave structure cannot be reconstructed from the
  // manifest at all: asked to show "8 calls then 2" at concurrency 8, the only route was to
  // parse an epoch out of each stream file's NAME. A setting is not an observation, and
  // evidence hidden in a filename is evidence nobody finds.
  const base = { id, prompt: String(task.prompt ?? ''), requestedModel: model, model: modelUsed, log: result.streamFile, startedAt: result.startedAt, durationMs: result.durationMs, exitStatus: result.exitCode }
  const usage = laneUsageFromOutput(result.stdout)
  const withUsage = usage !== null ? { ...base, usage } : base
  // `reaped` follows the same rule as `usage` above and for the same reason: it is OMITTED when
  // the platform could not be asked (`null` from reapGroup), rather than rendered as 0. A zero
  // would read as "nothing outlived this call" on exactly the platform where nobody looked —
  // a silent cleanup replacing one invisible state with another. Present and 0 means measured
  // and clean; absent means not measurable here.
  const withReap = typeof result.reaped === 'number' ? { ...withUsage, reaped: result.reaped } : withUsage

  if (result.exitCode !== 0) {
    const reason = result.timedOut ? `timed out after ${timeoutSec}s` : `opencode exited ${result.exitCode}`
    return { ...withReap, status: 'error', reason: `${reason} (model ${modelUsed})` }
  }

  const answer = laneTextFromOutput(result.stdout)
  if (answer === null || answer.length === 0) {
    return { ...withReap, status: 'error', reason: `no answer text found in CLI output (model ${modelUsed})` }
  }

  fs.writeFileSync(answerFile, answer, 'utf8')
  return { ...withReap, status: 'answer', answerFile }
}

/** Bounded-concurrency pool: at most `limit` tasks run at once. Async only (network-bound CLI
 * calls) — never spawns more processes than `limit` regardless of how many tasks are queued. */
async function runPool(tasks, limit, worker) {
  const results = new Array(tasks.length)
  let next = 0
  async function lane() {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      results[i] = await worker(tasks[i], i)
    }
  }
  const lanes = Array.from({ length: Math.min(limit, tasks.length) }, () => lane())
  await Promise.all(lanes)
  return results
}

function applyAnswersTemplate(template, answers) {
  const placeholders = template.match(/\{\{answers\}\}/g) ?? []
  if (placeholders.length === 0) throw new Error('reduce prompt template must contain {{answers}}')
  if (placeholders.length !== 1) throw new Error('reduce prompt template must contain exactly one {{answers}}')
  // ⚠ A FUNCTION replacer, never a string. With a string replacement JS interprets `$&`,
  // `$1`, `$$` and friends as substitution patterns — so an answer mentioning `$&` would
  // re-insert the placeholder itself. Measured 2026-08-18: `use $& to repeat` rendered as
  // `use {{answers}} to repeat`. An external model discussing regex or shell hits this.
  return template.replace('{{answers}}', () => answers)
}

function answerBlock(task, answer) {
  const exitStatus = Number.isInteger(task.exitStatus) ? task.exitStatus : 0
  return `--- BEGIN ANSWER id=${task.id} exitStatus=${exitStatus} ---\n${answer}\n--- END ANSWER id=${task.id} ---`
}

function writeReduceManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  process.stdout.write(`MANIFEST: ${manifestPath}\n`)
}

async function reduceManifest(opts) {
  if (!fs.existsSync(opts.reduce)) {
    process.stdout.write(`OPENCODE_ERROR: manifest file not found: ${opts.reduce}\n`)
    return 2
  }
  if (opts.reducePrompt !== null && opts.reducePromptFile !== null) {
    process.stdout.write('OPENCODE_ERROR: choose exactly one of --reduce-prompt or --reduce-prompt-file\n')
    return 2
  }
  if (opts.reducePrompt === null && opts.reducePromptFile === null) {
    process.stdout.write('OPENCODE_ERROR: reduce mode requires --reduce-prompt or --reduce-prompt-file\n')
    return 2
  }
  if (!Number.isInteger(opts.maxReduceChars) || opts.maxReduceChars < 1) {
    process.stdout.write('OPENCODE_ERROR: --max-reduce-chars must be a positive integer\n')
    return 2
  }

  let source
  let template
  try {
    source = JSON.parse(fs.readFileSync(opts.reduce, 'utf8'))
    template = opts.reducePromptFile === null ? opts.reducePrompt : fs.readFileSync(opts.reducePromptFile, 'utf8')
    if (!Array.isArray(source?.tasks)) throw new Error('manifest must contain a tasks array')
    applyAnswersTemplate(template, '')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    process.stdout.write(`OPENCODE_ERROR: invalid reduce input: ${detail}\n`)
    return 2
  }

  const outDir = invocationOutDir(opts.dir)
  const manifestPath = path.join(outDir, 'envelope.manifest.json')
  const skippedFailedTaskIds = source.tasks.filter((task) => task?.status !== 'answer').map((task) => String(task?.id))
  const unusableAnswerIds = []
  const cappedAnswerIds = []
  const blocks = []
  let renderedLength = 0
  for (const task of source.tasks) {
    if (task?.status !== 'answer') continue
    if (typeof task.id !== 'string' || typeof task.answerFile !== 'string') {
      unusableAnswerIds.push(String(task?.id))
      continue
    }
    let answer
    try {
      answer = fs.readFileSync(task.answerFile, 'utf8')
    } catch {
      unusableAnswerIds.push(task.id)
      continue
    }
    const block = answerBlock(task, answer)
    if (renderedLength + block.length > opts.maxReduceChars) {
      cappedAnswerIds.push(task.id)
      continue
    }
    blocks.push(block)
    renderedLength += block.length
  }
  if (cappedAnswerIds.length > 0) {
    process.stderr.write(`wt-opencode-envelope: dropped ${cappedAnswerIds.length} answers because --max-reduce-chars=${opts.maxReduceChars}: ${cappedAnswerIds.join(', ')}\n`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  if (blocks.length === 0) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      sourceManifest: path.resolve(opts.reduce), status: 'nothing_to_do', nothingToDo: true,
      reason: 'no usable answers in source manifest', dir: path.resolve(opts.dir), outDir, total: 0,
      answered: 0, errored: 0, maxReduceChars: opts.maxReduceChars, skippedFailedTaskIds, unusableAnswerIds, cappedAnswerIds, tasks: [],
    }, null, 2), 'utf8')
    process.stdout.write(`MANIFEST: ${manifestPath} (nothing_to_do: no usable answers in source manifest)\n`)
    return 0
  }

  const bin = resolveBinarySync()
  if (bin === null) {
    process.stdout.write('OPENCODE_UNAVAILABLE: opencode binary not found on PATH or known install locations\n')
    return 1
  }
  const fence = verifyOpencodeSkillFence(bin, { platform: process.platform })
  if (!fence.ok) {
    process.stdout.write(`${opencodeSkillFenceRefusal(fence.reason)}\n`)
    return 1
  }
  const credentialNames = providerCredentialNames(opts.model)
  const childEnv = opencodeChildEnv(undefined, credentialNames)
  const discovery = verifyEffectiveOpencodeSkillDiscovery(bin, { cwd: opts.dir, env: childEnv, platform: process.platform, extraNames: credentialNames })
  if (!discovery.ok) {
    process.stdout.write(`${effectiveSkillDiscoveryRefusal(discovery, 'wt-opencode-envelope')}\n`)
    return 1
  }
  if (!providerAuthenticatedSync(bin, opts.dir, childEnv, credentialNames)) {
    process.stdout.write('OPENCODE_UNAVAILABLE: no opencode provider authenticated (providers list failed)\n')
    return 1
  }
  const prompt = applyAnswersTemplate(template, blocks.join('\n'))
  // ⚠ The id is DERIVED FROM THE SOURCE MANIFEST, never the literal 'reduce'. It names the
  // answer file, so a fixed id makes two reduces over one --dir write to the same path: the
  // second silently overwrites the first, and the first manifest keeps reporting
  // `answered: 1, errored: 0` while naming a file holding another question's answer. Measured
  // 2026-08-18 on a nested reduce — a shape this mode explicitly supports, since a reduce
  // manifest satisfies --reduce's own input contract. Deterministic on purpose: re-running the
  // SAME reduce overwrites its own previous answer instead of accumulating.
  const reduceId = `reduce-${crypto.createHash('sha256').update(path.resolve(opts.reduce)).digest('hex').slice(0, 8)}`
  const result = await runTask({ id: reduceId, prompt }, { ...opts, bin, childEnv }, outDir)
  writeReduceManifest(manifestPath, {
    sourceManifest: path.resolve(opts.reduce), status: 'complete', nothingToDo: false,
    dir: path.resolve(opts.dir), outDir, total: 1, answered: result.status === 'answer' ? 1 : 0,
    errored: result.status === 'error' ? 1 : 0, maxReduceChars: opts.maxReduceChars,
    skippedFailedTaskIds, unusableAnswerIds, cappedAnswerIds, tasks: [result],
  })
  return 0
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  const opts = parseArgs(argv)
  const reduceMode = opts.reduce !== null
  const eachSources = [opts.eachJson, opts.eachLines].filter((value) => value !== null)
  const generatedMode = eachSources.length > 0
  if (opts.dir === null || (!reduceMode && !generatedMode && opts.tasksFile === null)) {
    process.stderr.write(`${usage()}\n`)
    process.stderr.write(generatedMode
      ? '\nMissing required task source and/or --dir.\n'
      : '\nMissing required <tasks.json> and/or --dir.\n')
    return 2
  }
  if (eachSources.length > 1 || (generatedMode && opts.tasksFile !== null) || (reduceMode && (generatedMode || opts.tasksFile !== null))) {
    process.stdout.write('OPENCODE_ERROR: choose exactly one of <tasks.json>, --each-json, --each-lines, or --reduce\n')
    return 2
  }
  if (generatedMode && (opts.promptTemplate === null || opts.idTemplate === null)) {
    process.stdout.write('OPENCODE_ERROR: generated-task mode requires --prompt-template and --id-template\n')
    return 2
  }
  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    process.stdout.write(`OPENCODE_ERROR: --dir is not a directory: ${opts.dir}\n`)
    return 2
  }
  if (reduceMode) return reduceManifest(opts)
  const sourcePath = generatedMode ? eachSources[0] : opts.tasksFile
  if (!fs.existsSync(sourcePath)) {
    process.stdout.write(`OPENCODE_ERROR: ${generatedMode ? 'source' : 'tasks file'} not found: ${sourcePath}\n`)
    return 2
  }

  let tasks
  let generation = null
  try {
    const sourceText = fs.readFileSync(sourcePath, 'utf8')
    if (generatedMode) {
      const mode = opts.eachJson !== null ? 'json' : 'lines'
      generation = {
        mode,
        ...generateEachTasks({
          items: parseEachSource(sourceText, mode),
          promptTemplate: opts.promptTemplate,
          idTemplate: opts.idTemplate,
          maxTasks: opts.maxTasks,
        }),
      }
      tasks = generation.tasks
    } else {
      tasks = JSON.parse(sourceText)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    process.stdout.write(generatedMode
      ? `OPENCODE_ERROR: invalid task source: ${detail}\n`
      : `OPENCODE_ERROR: tasks file is not valid JSON: ${detail}\n`)
    return 2
  }
  if (!Array.isArray(tasks) || (!generatedMode && tasks.length === 0)) {
    process.stdout.write('OPENCODE_ERROR: tasks file must be a non-empty JSON array\n')
    return 2
  }
  const seenIds = new Set()
  for (const t of tasks) {
    if (typeof t?.id !== 'string' || t.id.length === 0 || typeof t?.prompt !== 'string' || t.prompt.length === 0) {
      process.stdout.write('OPENCODE_ERROR: every task needs a non-empty string "id" and "prompt"\n')
      return 2
    }
    if (seenIds.has(t.id)) {
      process.stdout.write(`OPENCODE_ERROR: duplicate task id: ${t.id}\n`)
      return 2
    }
    seenIds.add(t.id)
  }

  const outDir = invocationOutDir(opts.dir)
  const manifestPath = path.join(outDir, 'envelope.manifest.json')
  if (generatedMode && tasks.length === 0) {
    fs.mkdirSync(outDir, { recursive: true })
    const manifest = {
      source: { mode: generation.mode, path: path.resolve(sourcePath), items: generation.sourceCount },
      maxTasks: opts.maxTasks,
      dropped: generation.dropped,
      status: 'nothing_to_do',
      nothingToDo: true,
      dir: path.resolve(opts.dir),
      outDir,
      concurrency: 0,
      total: 0,
      answered: 0,
      errored: 0,
      tasks: [],
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    process.stdout.write(`MANIFEST: ${manifestPath}\n`)
    return 0
  }

  const bin = resolveBinarySync()
  if (bin === null) {
    process.stdout.write('OPENCODE_UNAVAILABLE: opencode binary not found on PATH or known install locations\n')
    return 1
  }
  const fence = verifyOpencodeSkillFence(bin, { platform: process.platform })
  if (!fence.ok) {
    process.stdout.write(`${opencodeSkillFenceRefusal(fence.reason)}\n`)
    return 1
  }
  const credentialNames = providerCredentialNames(opts.model)
  const childEnv = opencodeChildEnv(undefined, credentialNames)
  const discovery = verifyEffectiveOpencodeSkillDiscovery(bin, { cwd: opts.dir, env: childEnv, platform: process.platform, extraNames: credentialNames })
  if (!discovery.ok) {
    process.stdout.write(`${effectiveSkillDiscoveryRefusal(discovery, 'wt-opencode-envelope')}\n`)
    return 1
  }
  if (!providerAuthenticatedSync(bin, opts.dir, childEnv, credentialNames)) {
    process.stdout.write('OPENCODE_UNAVAILABLE: no opencode provider authenticated (providers list failed)\n')
    return 1
  }

  fs.mkdirSync(outDir, { recursive: true })
  const results = await runPool(tasks, opts.concurrency, (task) => runTask(task, { ...opts, bin, childEnv }, outDir))

  const manifest = generatedMode ? {
    source: { mode: generation.mode, path: path.resolve(sourcePath), items: generation.sourceCount },
    maxTasks: opts.maxTasks,
    dropped: generation.dropped,
    status: 'complete',
    nothingToDo: false,
    dir: path.resolve(opts.dir),
    outDir,
    concurrency: Math.min(opts.concurrency, tasks.length),
    total: results.length,
    tokenTotals: sumTaskTokens(results),
    answered: results.filter((r) => r.status === 'answer').length,
    errored: results.filter((r) => r.status === 'error').length,
    tasks: results,
  } : {
    tasksFile: path.resolve(opts.tasksFile),
    dir: path.resolve(opts.dir),
    outDir,
    concurrency: Math.min(opts.concurrency, tasks.length),
    total: results.length,
    tokenTotals: sumTaskTokens(results),
    answered: results.filter((r) => r.status === 'answer').length,
    errored: results.filter((r) => r.status === 'error').length,
    tasks: results,
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  if (results.length === 1 && results[0].status === 'answer') {
    process.stdout.write(`MANIFEST: ${manifestPath} ANSWER: ${JSON.stringify(fs.readFileSync(results[0].answerFile, 'utf8'))}\n`)
  } else if (results.length === 1 && results[0].status === 'error') {
    process.stdout.write(`MANIFEST: ${manifestPath} ERROR: ${JSON.stringify(results[0].reason)}\n`)
  } else {
    process.stdout.write(`MANIFEST: ${manifestPath}\n`)
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stdout.write(`OPENCODE_ERROR: unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
