#!/usr/bin/env node
// The admission policy is TRUSTED code with the CLI's own privileges; its worker bounds TIME and isolates accidental failure, not access (it is not a sandbox).
// Deliberate interference, such as installing exception handlers, forging worker messages, spawning children that outlive the worker or blocking in native code, is outside what this check can catch.
// Admission first publishes PENDING without EXIT; wholly unwritable/unreplaceable output cannot support file-only completion, and request aliases remain unchanged.
import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from './lib/host/second-opinion-filesystem.mjs'
import path from 'node:path'
import { createSecondOpinionDependencies, runSecondOpinion } from './lib/second-opinion-core.mjs'
import { hostAdapter } from './lib/host/adapter.mjs'
import { boundedAdmission, formatAdmissionError as formatError } from './lib/host/admission.mjs'
import { resolveAdmissionModule } from './lib/host/admission-options.mjs'
import { withSecondOpinionSnapshot } from './lib/host/second-opinion-snapshot.mjs'
import { requestDigest } from './lib/host/opencode-request-files.mjs'
import { requireUnchangedRequest } from './lib/opencode-admission.mjs'
import { snapshotEnvironment } from './lib/host/admission-snapshot.mjs'

const usage = 'Usage: node wt-second-opinion.mjs --request <file> --out <file> [--effort low|medium|high] [--route auto|astra|opus] [--repo <dir>]\nLinux sandbox refuses a named file the reviewer cannot read (exit 2); a named directory it cannot read is reported and the review runs.\nWT_SECOND_OPINION_ADMISSION optionally names an absolute ES module path: default admit({ repo, request, env }) returns null to admit or a non-empty refusal string (exit 3); configuration or module failures refuse too. Canonical repo/request paths are shared with launch; out must not name the request. Import, admission and clean worker exit have a 10000 ms deadline, overridable with WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS (positive integer, maximum 2147483647); expiry terminates the policy worker, including synchronous loops.'

const admissionUsage = '\nWhen WT_SECOND_OPINION_ADMISSION is undefined, second_opinion_admission in the profile settings.json plugin options is used. A defined env value wins, including empty (which refuses). Invalid/unreadable settings or conflicting/non-string admission options refuse. With admission active, the request and repo are copied to a private snapshot and .git is excluded at every level. Absolute repo paths in the rendered prompt are rewritten on component boundaries; relative paths stay relative. Inputs become read-only before scanning, with separate writable runtime scratch (Windows directories remain writable; same-user chmod is possible). External symlinks and special files refuse; normal terminal paths remove the snapshot. With neither configuration source present, execution is unchanged.'

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
  options.repoSpelling = options.repo
  try { options.repo = realpathSync.native(options.repo) } catch {
    return { ...options, error: `--repo is not a directory: ${options.repo}` }
  }
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

function sameRequestFile(options) {
  if (!options.out || !options.request || !existsSync(options.out) || !existsSync(options.request)) return false
  const request = statSync(options.request)
  const out = statSync(options.out)
  return realpathSync(options.out) === realpathSync(options.request) || (request.dev === out.dev && request.ino === out.ino)
}

function outputNamesRequest(options, argv) {
  if (sameRequestFile(options)) return true
  return argv.some((arg, index) => arg === '--request' && sameRequestFile({ out: options.out, request: argv[index + 1] }))
}

function replaceAdmissionOutput(temporary, out) {
  try { renameSync(temporary, out); return } catch (error) {
    if (hostAdapter.platform !== 'win32' || error?.code !== 'EPERM') throw error
    const output = lstatSync(out)
    if (!output.isFile() || output.nlink > 1 || (output.mode & 0o200)) throw error
    // Windows denies replacement of a read-only destination, unlike POSIX.
    // Clear that attribute only on an unshared regular inode; never follow links.
    chmodSync(out, output.mode | 0o200)
    try { renameSync(temporary, out) } catch (retryError) {
      try { chmodSync(out, output.mode) } catch { /* Restoration is best-effort; preserve the retry error. */ }
      throw retryError
    }
  }
}

function writeAdmissionRefusal(out, text) {
  try { writeFileSync(out, text); return } catch { /* Fall back to atomic replacement when direct publication is denied. */ }
  const temporary = `${out}.refusal-${randomUUID()}`
  let descriptor
  let created = false
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    created = true
    writeFileSync(descriptor, text)
    closeSync(descriptor)
    descriptor = undefined
    replaceAdmissionOutput(temporary, out)
  } finally {
    try { if (descriptor !== undefined) closeSync(descriptor) } finally {
      if (created) rmSync(temporary, { force: true })
    }
  }
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
    process.stdout.write(`${usage}${admissionUsage}\n`)
    return 0
  }
  const env = process.env
  const admission = secondOpinionAdmission(options, env)
  if (admission && outputNamesRequest(options, process.argv.slice(2))) {
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
  if (admission) {
    admissionPending = true
    options.repo = realpathSync.native(options.repoSpelling)
    options.request = realpathSync(options.request)
    return pendingAdmission(options, env, admission)
  }
  return dispatchSecondOpinion(options, env)
}

function secondOpinionAdmission(options, env) {
  try { return resolveAdmissionModule('WT_SECOND_OPINION_ADMISSION', env) } catch (error) {
    admissionPending = true
    if (!outputNamesRequest(options, process.argv.slice(2))) outputPath = options.out
    throw error
  }
}

function dispatchSecondOpinion(options, env) {
  return runSecondOpinion({ ...options, signal: abortController.signal, abortController }, createSecondOpinionDependencies(hostAdapter), snapshotEnvironment(options.snapshot, env))
}

async function pendingAdmission(options, env, admission) {
  writeAdmissionRefusal(options.out, 'PENDING: WT_SECOND_OPINION_ADMISSION\n')
  return withSecondOpinionSnapshot(options, async (runOptions) => {
    const signal = runOptions.snapshot.signal
    const abort = () => abortController.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const sha256 = requestDigest(runOptions.request)
      const refusal = await boundedAdmission(runOptions, env, {
        moduleVariable: 'WT_SECOND_OPINION_ADMISSION', timeoutVariable: 'WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS', admission, signal: abortController.signal,
      })
      if (refusal !== null) return refuseAdmission(options.out, refusal)
      requireUnchangedRequest(runOptions.request, sha256, 'WT_SECOND_OPINION_ADMISSION', admission, abortController.signal)
      admissionPending = false
      return await dispatchSecondOpinion(runOptions, env)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  })
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
      try { writeFileSync(outputPath, `REFUSED: second-opinion failed: ${message.replace(/\r?\n/g, ' ')}\nEXIT=1\n`) } catch { /* Stderr still reports the failure when output publication is unavailable. */ }
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
