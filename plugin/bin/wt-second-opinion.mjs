#!/usr/bin/env node
// Admission publishes PENDING (no EXIT line) before importing trusted policy code.
// An in-process deadline cannot preempt a synchronous infinite loop; external
// termination leaves PENDING. Completely unwritable/unreplaceable output is
// unsupported for file-only completion; request aliases are preserved unchanged.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSecondOpinionDependencies, runSecondOpinion } from './lib/second-opinion-core.mjs'
import { hostAdapter } from './lib/host/adapter.mjs'

const usage = 'Usage: node wt-second-opinion.mjs --request <file> --out <file> [--effort low|medium|high] [--route auto|astra|opus] [--repo <dir>]\nLinux sandbox refuses a named file the reviewer cannot read (exit 2); a named directory it cannot read is reported and the review runs.\nWT_SECOND_OPINION_ADMISSION optionally names an absolute ES module path: default admit({ repo, request, env }) returns null to admit or a non-empty refusal string (exit 3); configuration or module failures refuse too. Canonical repo/request paths are shared with launch; out must not name the request. Import and admission have a 10000 ms deadline, overridable with WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS (positive integer, maximum 2147483647); synchronous policy code must not block the event loop.'

function parseArgs(argv) {
  const options = { effort: 'medium', route: 'auto', repo: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (['--request', '--out', '--effort', '--route', '--repo'].includes(arg)) {
      if (!argv[i + 1]) return { ...options, error: `${arg} requires a value` }
      options[arg.slice(2)] = argv[++i]
    } else return { ...options, error: `unknown argument: ${arg}` }
  }
  return validateArgs(options)
}

function validateArgs(options) {
  if (!options.request) return { ...options, error: '--request is required' }
  if (!options.out) return { ...options, error: '--out is required' }
  if (!['low', 'medium', 'high'].includes(options.effort)) return { ...options, error: '--effort must be low, medium, or high' }
  if (!['auto', 'astra', 'opus'].includes(options.route)) return { ...options, error: '--route must be auto, astra, or opus' }
  options.request = path.resolve(options.request)
  options.out = path.resolve(options.out)
  options.repo = path.resolve(options.repo)
  if (!existsSync(options.request) || !statSync(options.request).isFile()) return { ...options, error: `--request is not a file: ${options.request}` }
  if (!existsSync(options.repo) || !statSync(options.repo).isDirectory()) return { ...options, error: `--repo is not a directory: ${options.repo}` }
  return options
}

let outputPath
let admissionPending = false
const abortController = new AbortController()
const requestTermination = (signal) => {
  abortController.abort(signal)
}
const signalListeners = new Map(['SIGHUP', 'SIGTERM', 'SIGINT'].map((signal) => [signal, () => requestTermination(signal)]))
for (const [signal, listener] of signalListeners) process.once(signal, listener)

function removeSignalListeners() {
  for (const [signal, listener] of signalListeners) process.removeListener(signal, listener)
}

async function admissionRefusal({ repo, request }, env) {
  const variable = 'WT_SECOND_OPINION_ADMISSION'
  const modulePath = env[variable]
  if (!path.isAbsolute(modulePath)) return `${variable}: must name an absolute ES module path`
  try {
    const { default: admit } = await import(pathToFileURL(modulePath).href)
    if (typeof admit !== 'function') return `${variable}: default export must be a function`
    const result = await admit({ repo, request, env })
    if (result === null) return null
    if (typeof result === 'string' && result.trim()) return `${variable}: ${result}`
    return `${variable}: admit must return null or a non-empty string`
  } catch (error) {
    return `${variable}: admission module failed: ${formatError(error)}`
  }
}

function formatError(error) {
  try { return String(error instanceof Error ? error.message : error) } catch { return 'unprintable thrown value' }
}

async function boundedAdmission(options, env) {
  const variable = 'WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS'
  const timeout = Number(env[variable] ?? 10_000)
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    return `WT_SECOND_OPINION_ADMISSION: ${variable} must be a positive integer no greater than 2147483647`
  }
  let timer
  const deadline = performance.now() + timeout
  const expired = `WT_SECOND_OPINION_ADMISSION: timed out after ${timeout} ms`
  try {
    const refusal = await Promise.race([
      admissionRefusal(options, env),
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), timeout) }),
    ])
    return performance.now() >= deadline ? expired : refusal
  } finally { clearTimeout(timer) }
}

function sameRequestFile(options) {
  if (!options.out || !options.request || !existsSync(options.out) || !existsSync(options.request)) return false
  const request = statSync(options.request)
  const out = statSync(options.out)
  return realpathSync(options.out) === realpathSync(options.request) || (request.dev === out.dev && request.ino === out.ino)
}

function writeAdmissionRefusal(out, text) {
  try { writeFileSync(out, text); return } catch {}
  const temporary = `${out}.refusal-${randomUUID()}`
  let created = false
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    created = true
    renameSync(temporary, out)
  } finally { if (created) rmSync(temporary, { force: true }) }
}

function refuseAdmission(out, refusal) {
  const message = refusal.replace(/\r?\n/g, ' ')
  process.stderr.write(`wt-second-opinion: ${message}\n`)
  writeAdmissionRefusal(out, `REFUSED: ${message}\nEXIT=3\n`)
  return 3
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  const env = process.env
  if (env.WT_SECOND_OPINION_ADMISSION !== undefined && sameRequestFile(options)) {
    admissionPending = true
    process.stderr.write('wt-second-opinion: WT_SECOND_OPINION_ADMISSION: --out and --request name the same file\n')
    return 3
  }
  if (options.error) {
    if (options.out) writeFileSync(options.out, `REFUSED: ${options.error}\nEXIT=2\n`)
    process.stderr.write(`wt-second-opinion: ${options.error}\n${usage}\n`)
    return 2
  }
  outputPath = options.out
  if (env.WT_SECOND_OPINION_ADMISSION !== undefined) {
    admissionPending = true
    options.repo = realpathSync(options.repo)
    options.request = realpathSync(options.request)
    const refusal = await pendingAdmission(options, env)
    if (refusal !== null) return refuseAdmission(options.out, refusal)
    admissionPending = false
  }
  return runSecondOpinion({ ...options, signal: abortController.signal, abortController }, createSecondOpinionDependencies(hostAdapter), env)
}

async function pendingAdmission(options, env) {
  writeAdmissionRefusal(options.out, 'PENDING: WT_SECOND_OPINION_ADMISSION\n')
  process.on('uncaughtException', admissionFailure)
  process.on('unhandledRejection', admissionFailure)
  try { return await boundedAdmission(options, env) } finally {
    process.removeListener('uncaughtException', admissionFailure)
    process.removeListener('unhandledRejection', admissionFailure)
  }
}

function finish(code) {
  removeSignalListeners()
  process.exitCode = code
  if (code === 3 && admissionPending) process.exit(code)
}

function legacyFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  if (outputPath) {
    try {
      const existing = readFileSync(outputPath, 'utf8')
      if (!/^EXIT=\d+$/m.test(existing.split(/\r?\n/).filter(Boolean).at(-1) ?? '')) {
        appendFileSync(outputPath, `REFUSED: second-opinion failed: ${message.replace(/\r?\n/g, ' ')}\nEXIT=1\n`)
      }
    } catch {
      try { writeFileSync(outputPath, `REFUSED: second-opinion failed: ${message.replace(/\r?\n/g, ' ')}\nEXIT=1\n`) } catch {}
    }
  }
  process.stderr.write(`wt-second-opinion: ${message}\n`)
  finish(1)
}

function admissionFailure(error) {
  if (!admissionPending) return legacyFailure(error)
  const refusal = `WT_SECOND_OPINION_ADMISSION: second-opinion failed: ${formatError(error)}`
  try { if (outputPath) refuseAdmission(outputPath, refusal) } catch (writeError) {
    process.stderr.write(`wt-second-opinion: cannot publish refusal to --out: ${formatError(writeError)}\n`)
  }
  finish(3)
}

main().then(finish).catch(admissionFailure)
