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
// never N. It reads a JSON array of tasks, resolves the opencode binary and the availability
// gate ONCE, then fans the tasks out with bounded concurrency — each task gets its own task file,
// its own unique stream log, its own `EXIT=` marker, and its own answer file. The script's own
// stdout is exactly one line naming a MANIFEST file; it never prints any task's answer, whatever
// N is — the caller reads individual answer files only if and when it needs their content.

import { spawn, spawnSync as preflightSpawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { laneTextFromOutput, verifierStreamDirForEnv } from './wt-verifier-cli-guard-hook.mjs'

const DEFAULT_MODEL = 'openai/gpt-5.4'
const DEFAULT_AGENT = 'plan'
const DEFAULT_TIMEOUT_SEC = 570
const DEFAULT_CONCURRENCY = 4

function usage() {
  return [
    'wt-opencode-envelope — run N opencode CLI calls behind exactly ONE Bash call.',
    '',
    'Usage: wt-opencode-envelope.mjs <tasks.json> --dir <workdir> [options]',
    '',
    'Required:',
    '  <tasks.json>           JSON array of tasks: [{ "id": "t1", "prompt": "..." , ',
    '                         "model"?, "variant"?, "agent"?, "fallbackModel"? }, ...]',
    '                         Per-task fields override the matching --option below.',
    '  --dir <path>           Explicit opencode working directory (never the inherited cwd).',
    '',
    'Options:',
    '  --model <provider/model>           Default model. Default: openai/gpt-5.4',
    '  --fallback-model <provider/model>  Default fallback for the ONE 429 retry. Default: openai/gpt-5.4',
    '  --variant <name>                   Default --variant (unvalidated) for tasks without one',
    '  --agent <name>                     Default opencode agent mode. Default: plan',
    '  --timeout-sec <n>                  Per-task CLI timeout. Default: 570',
    '  --concurrency <n>                  Max tasks run in parallel. Default: 4',
    '  --out-dir <path>                   Where answer files + manifest are written.',
    '                                     Default: the directory containing <tasks.json>',
    '  --manifest <path>                  Manifest file path. Default: <tasks.json>.manifest.json',
    '',
    'Prints EXACTLY ONE line to stdout, one of:',
    '  MANIFEST: <path>              — every task attempted; results (per task) are in <path>.',
    '  OPENCODE_UNAVAILABLE: <reason> — no binary / no authenticated provider (no task ran).',
    '',
    'Never prints any answer text. Exit code: 0 = MANIFEST written, 1 = UNAVAILABLE, 2 = usage/setup error.',
  ].join('\n')
}

function parseArgs(argv) {
  const out = {
    tasksFile: null,
    dir: null,
    model: DEFAULT_MODEL,
    fallbackModel: DEFAULT_MODEL,
    variant: null,
    agent: DEFAULT_AGENT,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    concurrency: DEFAULT_CONCURRENCY,
    outDir: null,
    manifest: null,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i] ?? null
    else if (a === '--model') out.model = argv[++i] ?? out.model
    else if (a === '--fallback-model') out.fallbackModel = argv[++i] ?? out.fallbackModel
    else if (a === '--variant') out.variant = argv[++i] ?? null
    else if (a === '--agent') out.agent = argv[++i] ?? out.agent
    else if (a === '--timeout-sec') out.timeoutSec = Number(argv[++i]) || DEFAULT_TIMEOUT_SEC
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY)
    else if (a === '--out-dir') out.outDir = argv[++i] ?? null
    else if (a === '--manifest') out.manifest = argv[++i] ?? null
    else rest.push(a)
  }
  out.tasksFile = rest[0] ?? null
  return out
}

function resolveBinarySync() {
  const which = preflightSpawnSync('command -v opencode', { shell: true, encoding: 'utf8' })
  if (which.status === 0 && typeof which.stdout === 'string' && which.stdout.trim().length > 0) {
    return which.stdout.trim().split('\n')[0]
  }
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

function providerAuthenticatedSync(bin) {
  const res = preflightSpawnSync(bin, ['providers', 'list'], { encoding: 'utf8', timeout: 30000 })
  return res.status === 0
}

function uniqueToken() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
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

/** Runs `opencode run` ONCE, async, for a single task. Enforces the four non-negotiables
 * together: stdin closed (`< /dev/null` equivalent — stdio[0]:'ignore'), `--auto` so a
 * permission prompt never silently hangs the process, an explicit `--dir` (never the inherited
 * cwd), and a timeout with an `EXIT=<code>` marker appended to the SAME log after the process
 * exits (never a separate, reusable path — every invocation gets its own unique stream file). */
function runOnceAsync({ bin, taskfile, dir, model, variant, agentMode, timeoutSec, taskId }) {
  return new Promise((resolve) => {
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

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutSec * 1000)

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      const exitCode = 1
      fs.writeFileSync(streamFile, stdout, 'utf8')
      fs.appendFileSync(streamFile, `\nEXIT=${exitCode}\n`, 'utf8')
      fs.appendFileSync(streamFile, `\n--- spawn error ---\n${String(err)}\n`, 'utf8')
      resolve({ streamFile, stdout, stderr, exitCode, timedOut: false })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const exitCode = timedOut || signal === 'SIGKILL' ? 124 : (code ?? 1)
      fs.writeFileSync(streamFile, stdout, 'utf8')
      fs.appendFileSync(streamFile, `\nEXIT=${exitCode}\n`, 'utf8')
      if (stderr.length > 0) fs.appendFileSync(streamFile, `\n--- stderr ---\n${stderr}\n`, 'utf8')
      resolve({ streamFile, stdout, stderr, exitCode, timedOut: timedOut || signal === 'SIGKILL' })
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
  const taskfile = path.join(opts.dir, `.oc-envelope-${safeId}-${uniqueToken()}.md`)
  fs.writeFileSync(taskfile, String(task.prompt ?? ''), 'utf8')

  let result
  let modelUsed = model
  try {
    result = await runOnceAsync({ bin: opts.bin, taskfile, dir: opts.dir, model, variant, agentMode, timeoutSec, taskId: id })

    if (result.exitCode !== 0 && isRateLimited(result.stdout + result.stderr)) {
      modelUsed = fallbackModel
      result = await runOnceAsync({ bin: opts.bin, taskfile, dir: opts.dir, model: fallbackModel, variant, agentMode, timeoutSec, taskId: `${id}-retry` })
    }
  } finally {
    try { fs.unlinkSync(taskfile) } catch { /* best-effort cleanup */ }
  }

  const answerFile = path.join(outDir, `${safeId}.answer.txt`)

  if (result.exitCode !== 0) {
    const reason = result.timedOut ? `timed out after ${timeoutSec}s` : `opencode exited ${result.exitCode}`
    return { id, status: 'error', reason: `${reason} (model ${modelUsed})`, model: modelUsed, log: result.streamFile }
  }

  const answer = laneTextFromOutput(result.stdout)
  if (answer === null || answer.length === 0) {
    return { id, status: 'error', reason: `no answer text found in CLI output (model ${modelUsed})`, model: modelUsed, log: result.streamFile }
  }

  fs.writeFileSync(answerFile, answer, 'utf8')
  return { id, status: 'answer', answerFile, model: modelUsed, log: result.streamFile }
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

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  const opts = parseArgs(argv)
  if (opts.tasksFile === null || opts.dir === null) {
    process.stderr.write(`${usage()}\n`)
    process.stderr.write('\nMissing required <tasks.json> and/or --dir.\n')
    return 2
  }
  if (!fs.existsSync(opts.tasksFile)) {
    process.stdout.write(`OPENCODE_ERROR: tasks file not found: ${opts.tasksFile}\n`)
    return 2
  }
  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    process.stdout.write(`OPENCODE_ERROR: --dir is not a directory: ${opts.dir}\n`)
    return 2
  }

  let tasks
  try {
    tasks = JSON.parse(fs.readFileSync(opts.tasksFile, 'utf8'))
  } catch (err) {
    process.stdout.write(`OPENCODE_ERROR: tasks file is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
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

  const bin = resolveBinarySync()
  if (bin === null) {
    process.stdout.write('OPENCODE_UNAVAILABLE: opencode binary not found on PATH or known install locations\n')
    return 1
  }
  if (!providerAuthenticatedSync(bin)) {
    process.stdout.write('OPENCODE_UNAVAILABLE: no opencode provider authenticated (providers list failed)\n')
    return 1
  }

  const outDir = opts.outDir ?? path.dirname(path.resolve(opts.tasksFile))
  fs.mkdirSync(outDir, { recursive: true })
  const manifestPath = opts.manifest ?? `${opts.tasksFile}.manifest.json`

  const results = await runPool(tasks, opts.concurrency, (task) => runTask(task, { ...opts, bin }, outDir))

  const manifest = {
    tasksFile: path.resolve(opts.tasksFile),
    dir: path.resolve(opts.dir),
    concurrency: Math.min(opts.concurrency, tasks.length),
    total: results.length,
    answered: results.filter((r) => r.status === 'answer').length,
    errored: results.filter((r) => r.status === 'error').length,
    tasks: results,
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  process.stdout.write(`MANIFEST: ${manifestPath}\n`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stdout.write(`OPENCODE_ERROR: unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
