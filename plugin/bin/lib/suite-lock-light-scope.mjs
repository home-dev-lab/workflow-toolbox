import { quoteRemedyWord } from './remedy-quote.mjs'

// A light suite-lock ticket is for ONE test file, a typecheck or a lint. A light run that covers several
// test files, or a whole suite, takes the slot ahead of waiting full runs for longer than its class allows.
// This module recognises such a run from its argv and words the warning (or, in refuse mode, the refusal).
//
// Probation: the default mode is `warn` (WT_SUITE_LOCK_LIGHT_SCOPE=warn|refuse). Every firing is recorded in
// <lock root>/light-scope.jsonl and listed by `wt-suite-lock light-scope`. Exit condition for flipping the
// default to `refuse`: at least 20 firings over at least 3 distinct days, every one checked as covering two or
// more test files (or a whole suite), and zero false hits (a flagged run that covered at most one test file).
//
// Blind spot, by design: a script file (`bash x.sh`, `zsh .lane/g1.zsh`) and a shell string (`bash -c '...'`) are
// opaque and never flagged. A guard that may refuse prefers a miss to a false hit: only well-understood runner
// shapes are classified, and anything else reads as 'other'.
export const LIGHT_SCOPE_PROBATION = 'flip the default to refuse after >= 20 firings over >= 3 days, each covering >= 2 test files, with 0 false hits'

const TEST_FILE = /\.(test|spec|selftest)\.[cm]?[jt]sx?$/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const NODE_VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-shard', '--test-reporter', '--test-reporter-destination',
  '--test-concurrency', '--test-timeout', '--import', '--require', '-r', '--env-file', '--conditions', '-C', '--loader', '--experimental-loader'])
const VITEST_VALUE_FLAGS = new Set(['-t', '--testNamePattern', '--project', '--config', '-c', '--reporter', '--root', '-r', '--dir',
  '--pool', '--shard', '--exclude', '--outputFile', '--mode', '--environment', '--maxWorkers', '--minWorkers', '--testTimeout', '--retry', '--bail',
  '--hookTimeout', '--teardownTimeout', '--slowTestThreshold', '--maxConcurrency'])
const ANY_VALUE_FLAGS = new Set([...NODE_VALUE_FLAGS, ...VITEST_VALUE_FLAGS])
const SUITE_SCRIPTS = new Set(['test', 'test:all', 'test:unit'])
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn'])
const PLAIN_WRAPPERS = new Set(['setsid', 'time', 'command', 'exec'])
// Node options after which no test file runs: evaluated code, help, version, syntax check.
const NODE_NO_RUN = new Set(['-e', '--eval', '-p', '--print', '-h', '--help', '-v', '--version', '-c', '--check'])
const DIR_OPTIONS = new Set(['-C', '--dir', '--prefix', '--filter'])
const VITEST_NON_RUN = new Set(['list', 'bench', 'init', 'typecheck'])
const VITEST_RUN = new Set(['run', 'watch', 'dev', 'related'])
// A lint, format or typecheck tool handed test files checks them; it never runs them.
const LINT_TOOLS = new Set(['eslint', 'prettier', 'tsc', 'biome', 'oxlint', 'jscpd', 'depcruise', 'knip', 'stylelint'])
const LINT_PACKAGES = new Set(['eslint', 'prettier', 'typescript', '@biomejs', 'oxlint', 'jscpd', 'dependency-cruiser', 'knip', 'stylelint'])
const SUITE_LOCK_CLI = /(^|\/)wt-suite-lock(\.mjs)?$/
const OTHER = Object.freeze({ kind: 'other', files: [] })
const SUITE_FILE_SECONDS = 24 // p90 hold of a one-file light run, suite-lock journal 2026-11-09..14
const SUITE_MINUTES = 30

const countScope = (files) => ({ kind: files.length > 1 ? 'multi' : 'single', files })
const baseName = (word) => String(word).split('/').pop()
// A filter naming a directory or a glob selects a whole tree.
const treeFilter = (word) => word === '.' || word.endsWith('/') || word.includes('*')

function lintTool(script) {
  const parts = String(script).split('/')
  return LINT_TOOLS.has(parts.at(-1).replace(/\.[cm]?js$/, '')) || parts.slice(0, -1).some((part) => LINT_PACKAGES.has(part))
}

// Does this flag take the next word as its value? Known value flags do; a dotted option (`--coverage.reporter
// text`) does unless the next word is another flag or a test file. Unknown flags are read as booleans.
function consumesValue(word, next, valueFlags) {
  if (word.includes('=') || next === undefined) return false
  if (valueFlags.has(word)) return true
  return word.startsWith('--') && word.includes('.') && !String(next).startsWith('-') && !TEST_FILE.test(String(next))
}

// Positional words of an argument list. A bare number is never a file (an unknown flag's value): when in
// doubt this errs towards counting fewer files, so a guess never refuses a legitimate one-file run.
function positionals(args, valueFlags) {
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    const word = String(args[index])
    if (word.startsWith('-')) index += consumesValue(word, args[index + 1], valueFlags) ? 1 : 0
    else if (!/^\d+(\.\d+)?$/.test(word)) out.push(word)
  }
  return out
}

function runsNodeTest(args) {
  return args.some((word) => word === '--test' || String(word).startsWith('--test='))
}

// `node a.test.mjs` runs one file; `node <runner> a.test.mjs b.test.mjs` hands a runner several.
function nodeScriptScope(targets) {
  const [script, ...rest] = targets
  if (script === undefined || lintTool(script)) return OTHER
  if (TEST_FILE.test(script)) return countScope([script])
  const files = rest.filter((word) => TEST_FILE.test(word))
  return files.length > 1 ? countScope(files) : OTHER
}

function nodeScope(args) {
  if (args.some((word) => NODE_NO_RUN.has(word) || /^--(eval|print)=/.test(word))) return OTHER
  const targets = positionals(args, NODE_VALUE_FLAGS)
  if (!runsNodeTest(args)) return nodeScriptScope(targets)
  if (targets.length === 0) return { kind: 'suite', files: [] }
  // A directory or a glob node expands itself covers a whole tree.
  if (targets.some((word) => word.includes('*') || !SCRIPT_FILE.test(word))) return { kind: 'suite', files: targets }
  return countScope(targets)
}

// Filters a test runner receives: none, a directory or a glob select a whole suite or tree.
function filterScope(targets) {
  if (targets.length === 0 || targets.some(treeFilter)) return { kind: 'suite', files: targets }
  return countScope(targets)
}

// `vitest [run|watch|related] a b` (filters), never `vitest list|bench|init|typecheck`.
function vitestScope(args) {
  if (VITEST_NON_RUN.has(args[0])) return OTHER
  return filterScope(positionals(VITEST_RUN.has(args[0]) ? args.slice(1) : args, VITEST_VALUE_FLAGS))
}

// A `test` script's runner is unknown, so only test-file-shaped words and directories count; a bare `pnpm test`
// runs the whole suite, and arguments that name no test file are read as options of an unknown runner.
function testScriptScope(rest) {
  if (rest.length === 0) return { kind: 'suite', files: [] }
  const targets = positionals(rest, ANY_VALUE_FLAGS)
  const dirs = targets.filter((word) => word.endsWith('/'))
  if (dirs.length > 0) return { kind: 'suite', files: dirs }
  const files = targets.filter((word) => TEST_FILE.test(word))
  return files.length === 0 ? OTHER : countScope(files)
}

function packageScriptScope(args) {
  const script = args[0] === 'run' ? args[1] : args[0]
  const rest = args.slice(args[0] === 'run' ? 2 : 1).filter((word) => word !== '--')
  if (script === 'vitest') return vitestScope(rest)
  return SUITE_SCRIPTS.has(script) ? testScriptScope(rest) : OTHER
}

// env [-i] [-u NAME] [NAME=value...] command
function unwrapEnv(rest) {
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) index += rest[index] === '-u' || rest[index] === '-C' ? 2 : 1
  return rest.slice(index)
}

// npx [--yes|-y|--package=x...] command; nice [-n N] command
function unwrapLeadingOptions(rest, valued) {
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) index += valued.has(rest[index]) ? 2 : 1
  return rest.slice(index)
}

// timeout [-s SIGNAL] [-k DURATION] [--option=value...] DURATION command
function unwrapTimeout(rest) {
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) index += rest[index] === '-s' || rest[index] === '-k' ? 2 : 1
  return rest.slice(index + 1)
}

// `wt-suite-lock run [flags] -- command`, directly or as `node <path>/wt-suite-lock.mjs`: the covered command.
function unwrapSuiteLock(words) {
  const separator = words.indexOf('--')
  return separator >= 0 ? words.slice(separator + 1) : null
}

// `pnpm -C dir ...` keeps the manager; `pnpm exec x` / `pnpm dlx x` hands over to x.
function packageManagerStep(head, rest) {
  if (DIR_OPTIONS.has(rest[0])) return [head, ...rest.slice(2)]
  return rest[0] === 'exec' || rest[0] === 'dlx' ? rest.slice(1) : null
}

// Wrappers with options of their own, stripped down to the command they launch.
const OPTION_WRAPPERS = {
  env: unwrapEnv,
  timeout: unwrapTimeout,
  npx: (rest) => unwrapLeadingOptions(rest, new Set(['-p', '--package', '-c', '--call'])),
  nice: (rest) => unwrapLeadingOptions(rest, new Set(['-n', '--adjustment'])),
}

// One unwrapping step, or null when the head is the runner itself.
function unwrapStep(words) {
  const [head, ...rest] = words
  const base = baseName(head)
  if (/^[A-Za-z_]\w*=/.test(head) || PLAIN_WRAPPERS.has(base)) return rest
  if (Object.hasOwn(OPTION_WRAPPERS, base)) return OPTION_WRAPPERS[base](rest)
  if (SUITE_LOCK_CLI.test(head) || (base === 'node' && SUITE_LOCK_CLI.test(rest[0] ?? ''))) return unwrapSuiteLock(rest)
  return PACKAGE_MANAGERS.has(base) ? packageManagerStep(head, rest) : null
}

// Strips environment assignments and launch wrappers down to the runner's own argv.
function unwrap(argv) {
  let words = argv.map(String)
  for (let step = 0; step < 12 && words.length > 0; step += 1) {
    const next = unwrapStep(words)
    if (next === null) break
    words = next
  }
  return words
}

// { kind: 'single' | 'multi' | 'suite' | 'other', files }: how many test files a command covers.
export function lightRunScope(argv) {
  if (!Array.isArray(argv)) return OTHER
  const [head, ...rest] = unwrap(argv)
  if (head === undefined) return OTHER
  const base = baseName(head)
  if (base === 'node') return nodeScope(rest)
  if (base === 'vitest') return vitestScope(rest)
  return PACKAGE_MANAGERS.has(base) ? packageScriptScope(rest) : OTHER
}

export function coversSeveralTestFiles(scope) {
  return scope.kind === 'multi' || scope.kind === 'suite'
}

export function lightScopeMode(env = process.env) {
  return env.WT_SUITE_LOCK_LIGHT_SCOPE === 'refuse' ? 'refuse' : 'warn'
}

export function expectedMinutes(scope) {
  if (scope.kind === 'suite') return SUITE_MINUTES
  return Math.max(1, Math.ceil((scope.files.length * SUITE_FILE_SECONDS) / 60))
}

const shellLine = (argv) => argv.map((word) => quoteRemedyWord(word)).join(' ')

// The command to run instead. heavy-job.sh lives outside the plugin: WT_SUITE_LOCK_HEAVY_JOB names it.
// Unset, or inside a lane sandbox, the remedy is an exclusive ticket on this same CLI.
export function heavyJobAdvice({ command, scope, env = process.env }) {
  const wrapper = env.WT_SUITE_LOCK_HEAVY_JOB?.trim()
  const exclusive = `wt-suite-lock run -- ${shellLine(command)}`
  if (env.WT_SUITE_LOCK_BROKER?.trim()) return { command: exclusive, reason: 'inside a lane sandbox, where the host wrapper is not reachable' }
  if (!wrapper) return { command: exclusive, reason: 'WT_SUITE_LOCK_HEAVY_JOB is not set' }
  const project = env.WT_SUITE_LOCK_PROJECT?.trim()
  const words = [wrapper, ...(project ? ['--project', project] : []), '--expected-min', String(expectedMinutes(scope)), '--suite-lock', '--', ...command]
  return { command: shellLine(words), reason: null }
}

export function lightScopeMessage({ scope, mode, advice }) {
  const what = scope.kind === 'suite' ? 'a whole test suite or directory' : `${scope.files.length} test files`
  const verdict = mode === 'refuse' ? 'refused' : 'warning (probation; refused once WT_SUITE_LOCK_LIGHT_SCOPE=refuse)'
  const reason = advice.reason ? ` (${advice.reason})` : ''
  return `wt-suite-lock: light ticket ${verdict}: this run covers ${what}; a light ticket covers one test file, a typecheck or a lint.\n` +
    `wt-suite-lock: run it as a heavy job instead${reason}:\n  ${advice.command}\n`
}

const FILE_LIST_CAP = 40

// Checks one light request. Returns { refused, end(heldMs) }. `log` records firings; it must never throw.
export function guardLightRun({ command, route, env = process.env, write, log, now = Date.now }) {
  const scope = lightRunScope(command)
  if (!coversSeveralTestFiles(scope)) return { refused: false, end: () => {} }
  const mode = lightScopeMode(env)
  try { write(lightScopeMessage({ scope, mode, advice: heavyJobAdvice({ command, scope, env }) })) } catch { /* a closed stderr never stops the run */ }
  const id = log?.record({ ts: new Date(now()).toISOString(), route, mode, outcome: mode === 'refuse' ? 'refused' : 'warned',
    kind: scope.kind, fileCount: scope.files.length, files: scope.files.slice(0, FILE_LIST_CAP), project: env.WT_SUITE_LOCK_PROJECT?.trim() || null })
  return { refused: mode === 'refuse', end: (heldMs) => { if (id) log.end(id, heldMs) } }
}

function firingLine(firing) {
  const hold = firing.holdS === null || firing.holdS === undefined ? 'hold unknown' : `held ${firing.holdS} s`
  const files = Array.isArray(firing.files) ? firing.files.slice(0, 3).join(' ') : ''
  const more = firing.fileCount > 3 ? ` (+${firing.fileCount - 3})` : ''
  return `${firing.ts} ${firing.route} ${firing.outcome} ${firing.kind} ${firing.fileCount} file(s), ${hold}: ${files}${more}`
}

export function formatLightScopeFirings(firings) {
  const days = new Set(firings.map((firing) => String(firing.ts).slice(0, 10)))
  const head = `light-scope: ${firings.length} firing(s) over ${days.size} day(s); probation: ${LIGHT_SCOPE_PROBATION}\n`
  return head + firings.map((firing) => `${firingLine(firing)}\n`).join('')
}

// `wt-suite-lock light-scope [--json]`: the probation record, read on the host.
export function lightScopeCli(args, root, read) {
  if (args.some((arg) => arg !== '--json')) throw new Error('light-scope accepts only --json')
  if (root.startsWith('broker:')) throw new Error('light-scope reads the host lock root; run wt-suite-lock light-scope on the host')
  const firings = read(root)
  process.stdout.write(args.includes('--json') ? `${JSON.stringify({ probation: LIGHT_SCOPE_PROBATION, firings })}\n` : formatLightScopeFirings(firings))
  return 0
}
