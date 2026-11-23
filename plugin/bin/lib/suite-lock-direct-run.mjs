import { directRunIsFile, directRunNodeHead, directRunTestFilename } from './host/suite-lock-direct-file.mjs'

export const DIRECT_RUN_WARN_S = 60
const SAFE_NODE_OPTION = /^(?:--max-old-space-size=\d+|--no-warnings|--enable-source-maps)$/
const TEST_OPTIONS = [
  /^--test$/, /^--test-only$/, /^--no-warnings$/,
  /^--test-reporter=(?:spec|tap|dot|junit|lcov)$/,
  /^--test-name-pattern=.*$/s, /^--test-skip-pattern=.*$/s, /^--test-timeout=\d+$/,
]

function fullMatch(pattern, word) {
  return typeof word === 'string' && pattern.exec(word)?.[0] === word
}

function withoutNice(argv) {
  if (argv[0] !== 'nice') return argv
  if (argv[1] === '-n' && fullMatch(/^[+-]?\d+$/, argv[2])) return argv.slice(3)
  if (fullMatch(/^(?:-\d+|--adjustment=[+-]?\d+)$/, argv[1])) return argv.slice(2)
  return argv.slice(1)
}

function safeNodeEnvironment(env) {
  if (env.NODE_OPTIONS === undefined) return true
  if (typeof env.NODE_OPTIONS !== 'string') return false
  return env.NODE_OPTIONS.trim().split(/\s+/).filter(Boolean).every((token) => SAFE_NODE_OPTION.test(token))
}

function testFileArgument(args) {
  if (args.length === 1 && !args[0].startsWith('-')) return args[0]
  const seen = new Set()
  for (const option of args.slice(0, -1)) {
    const key = option.split('=', 1)[0]
    if (seen.has(key) || !TEST_OPTIONS.some((pattern) => fullMatch(pattern, option))) return null
    seen.add(key)
  }
  return seen.has('--test') ? args.at(-1) : null
}

function invalidArguments(argv) {
  return !Array.isArray(argv) || !argv.length || !Array.from(argv).every((word) => typeof word === 'string')
}

// This admission parser is deliberately stricter than the light-scope warning classifier.
export function runsWithoutTicket(argv, { cwd = process.cwd(), env = process.env, isFile = directRunIsFile } = {}) {
  if (invalidArguments(argv)) return false
  if (!safeNodeEnvironment(env)) return false
  const command = withoutNice(argv)
  if (!directRunNodeHead(command[0])) return false
  const file = testFileArgument(command.slice(1))
  if (!directRunTestFilename(file)) return false
  try { return isFile(file, cwd) === true } catch { return false }
}

export function directLightRun({ light, staticRun, park, command }, options) {
  return light === true && !staticRun && !park && runsWithoutTicket(command, options)
}

function directWarningSeconds(env) {
  const seconds = Number(env.WT_SUITE_LOCK_DIRECT_WARN_S)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DIRECT_RUN_WARN_S
}

export function watchDirectRun({ env = process.env, write = (text) => process.stderr.write(text) } = {}) {
  const started = performance.now()
  const boundMs = directWarningSeconds(env) * 1000
  let timer
  const check = () => {
    const elapsedMs = performance.now() - started
    const remaining = boundMs - elapsedMs
    if (remaining > 0) { timer = setTimeout(check, Math.min(remaining, 2_147_483_647)); timer.unref(); return }
    write(`wt-suite-lock: direct run still running after ${(elapsedMs / 1000).toFixed(1)} seconds; a run this long belongs in the queue: wt-suite-lock run -- <command> [args...]\n`)
  }
  timer = setTimeout(check, Math.min(boundMs, 2_147_483_647))
  timer.unref()
  return () => clearTimeout(timer)
}

export async function runDirectCommand(spawn, { env = process.env, write = (text) => process.stderr.write(text) } = {}) {
  write('wt-suite-lock: running one Node test file directly, without a ticket; use wt-suite-lock run -- <command> [args...] to keep the queue\n')
  const stopWarning = watchDirectRun({ env, write })
  try { return await spawn() } finally { stopWarning() }
}
