import { posix } from 'node:path'
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
const LIGHT_SCOPE_PROBATION = 'flip the default to refuse after >= 20 firings over >= 3 days, each covering >= 2 test files, with 0 false hits'

const TEST_FILE = /\.(test|spec|selftest)\.[cm]?[jt]sx?$/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const NODE_VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-shard', '--test-coverage-include',
  '--test-coverage-exclude', '--test-global-setup', '--title', '--input-type', '--watch-path', '--disable-warning', '--test-reporter', '--test-reporter-destination',
  '--test-concurrency', '--test-timeout', '-r', '--env-file', '--conditions', '-C',
  // Module-preload options take a module specifier as their value; spelled from their names here so this
  // option table is not read as a call site that passes them a value.
  ...['import', 'require', 'loader', 'experimental-loader'].map((name) => `--${name}`)])
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
// Options after which a wrapper or a runner prints and exits without running anything.
const PRINT_AND_EXIT = new Set(['-h', '--help', '-v', '-V', '--version'])
const SUITE_LOCK_CLI = /(^|\/)wt-suite-lock(\.mjs)?$/
const OTHER = Object.freeze({ kind: 'other', files: [] })
const SUITE_FILE_SECONDS = 24 // p90 hold of a one-file light run, suite-lock journal 2026-11-09..14
const SUITE_MINUTES = 30

// The same path named twice runs once.
function countScope(files) {
  const unique = [...new Set(files)]
  return { kind: unique.length > 1 ? 'multi' : 'single', files: unique }
}
// Commands are POSIX shell text: their separator is the POSIX one on every host (a Windows-style path in a
// command reads as an unknown head, so it is never flagged).
const baseName = (word) => posix.basename(String(word))
const endsWithSeparator = (word) => word.endsWith(posix.sep)
// A filter naming a directory or a glob selects a whole tree.
const treeFilter = (word) => word === '.' || endsWithSeparator(word) || word.includes('*')

// Does this flag take the next word as its value? Known value flags do, and so does a dotted option
// (`--coverage.reporter text`) unless the next word is another flag. Unknown flags are read as booleans.
function consumesValue(word, next, valueFlags) {
  if (word.includes('=') || next === undefined) return false
  if (valueFlags.has(word)) return true
  return word.startsWith('--') && word.includes('.') && !String(next).startsWith('-')
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

// Node's own options: the option words before the first positional word (values skipped). Anything after
// the script belongs to the script, so `node tool.mjs --test x` does not run the test runner.
function nodeLeadingOptions(args) {
  const options = []
  for (let index = 0; index < args.length && String(args[index]).startsWith('-'); index += 1) {
    options.push(String(args[index]))
    if (consumesValue(String(args[index]), args[index + 1], NODE_VALUE_FLAGS)) index += 1
  }
  return options
}

// `node a.test.mjs` runs one file. A script handed test-file arguments is not assumed to run them.
function nodeScriptScope(targets) {
  return targets.length > 0 && TEST_FILE.test(targets[0]) ? countScope([targets[0]]) : OTHER
}

function nodeScope(args) {
  const options = nodeLeadingOptions(args)
  if (options.some((word) => NODE_NO_RUN.has(word) || /^--(eval|print)=/.test(word))) return OTHER
  const targets = positionals(args, NODE_VALUE_FLAGS)
  if (!options.some((word) => word === '--test' || word.startsWith('--test='))) return nodeScriptScope(targets)
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
  if (args.some((word) => PRINT_AND_EXIT.has(word) || String(word).startsWith('--typecheck'))) return OTHER
  return filterScope(positionals(VITEST_RUN.has(args[0]) ? args.slice(1) : args, VITEST_VALUE_FLAGS))
}

// A `test` script's runner is unknown, so only test-file-shaped words and directories count; a bare `pnpm test`
// runs the whole suite, and arguments that name no test file are read as options of an unknown runner.
function testScriptScope(rest) {
  if (rest.length === 0) return { kind: 'suite', files: [] }
  const targets = positionals(rest, ANY_VALUE_FLAGS)
  const dirs = targets.filter(endsWithSeparator)
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

// npx [--yes|-y|--package=x...] command; nice [-n N] command. A help or version option runs nothing after it.
function unwrapLeadingOptions(rest, valued) {
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) {
    if (PRINT_AND_EXIT.has(rest[index])) return []
    index += valued.has(rest[index]) ? 2 : 1
  }
  return rest.slice(index)
}

// env [-i] [-u NAME] [NAME=value...] command
function unwrapEnv(rest) {
  return unwrapLeadingOptions(rest, new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']))
}

// timeout [-s SIGNAL] [-k DURATION] [--option=value...] DURATION command
function unwrapTimeout(rest) {
  return unwrapLeadingOptions(rest, new Set(['-s', '--signal', '-k', '--kill-after'])).slice(1)
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

function coversSeveralTestFiles(scope) {
  return scope.kind === 'multi' || scope.kind === 'suite'
}

export function lightScopeMode(env = process.env) {
  return env.WT_SUITE_LOCK_LIGHT_SCOPE === 'refuse' ? 'refuse' : 'warn'
}

function expectedMinutes(scope) {
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

function lightScopeMessage({ scope, mode, advice }) {
  const what = scope.kind === 'suite' ? 'a whole test suite or directory' : `${scope.files.length} test files`
  const verdict = mode === 'refuse' ? 'refused' : 'warning (probation; refused once WT_SUITE_LOCK_LIGHT_SCOPE=refuse)'
  const reason = advice.reason ? ` (${advice.reason})` : ''
  return `wt-suite-lock: light ticket ${verdict}: this run covers ${what}; a light ticket covers one test file, a typecheck or a lint.\n` +
    `wt-suite-lock: run it as a heavy job instead${reason}:\n  ${advice.command}\n`
}

const FILE_LIST_CAP = 40

// Records one firing; any failure (clock, id, file) only loses the record, never changes the run.
function recordFiring(log, entry, now) {
  try { return log ? log.record({ ts: new Date(now()).toISOString(), ...entry }) : null } catch { return null }
}

// Checks one light request. Returns { refused, end(heldMs) }. Neither the warning nor the record can throw.
export function guardLightRun({ command, route, env = process.env, write, log, now = Date.now }) {
  const scope = lightRunScope(command)
  if (!coversSeveralTestFiles(scope)) return { refused: false, end: () => {} }
  const mode = lightScopeMode(env)
  try { write(lightScopeMessage({ scope, mode, advice: heavyJobAdvice({ command, scope, env }) })) } catch { /* a closed stderr never stops the run */ }
  const id = recordFiring(log, { route, mode, outcome: mode === 'refuse' ? 'refused' : 'warned', kind: scope.kind,
    fileCount: scope.files.length, files: scope.files.slice(0, FILE_LIST_CAP), project: env.WT_SUITE_LOCK_PROJECT?.trim() || null }, now)
  return { refused: mode === 'refuse', end: (heldMs) => { try { if (id) log.end(id, heldMs) } catch { /* the hold is lost, not the run */ } } }
}

function firingLine(firing) {
  const hold = firing.holdS === null || firing.holdS === undefined ? 'hold unknown' : `held ${firing.holdS} s`
  const files = Array.isArray(firing.files) ? firing.files.slice(0, 3).join(' ') : ''
  const more = firing.fileCount > 3 ? ` (+${firing.fileCount - 3})` : ''
  return `${firing.ts} ${firing.route} ${firing.outcome} ${firing.kind} ${firing.fileCount} file(s), ${hold}: ${files}${more}`
}

function formatLightScopeFirings(firings) {
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
