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
// Blind spot, by design: a script file (`bash x.sh`, `zsh .lane/g1.zsh`) is opaque and never flagged.
export const LIGHT_SCOPE_PROBATION = 'flip the default to refuse after >= 20 firings over >= 3 days, each covering >= 2 test files, with 0 false hits'

const TEST_FILE = /\.(test|spec|selftest)\.[cm]?[jt]sx?$/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const NODE_VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination',
  '--test-concurrency', '--test-timeout', '--import', '--require', '-r', '--env-file', '--conditions', '-C', '--loader', '--experimental-loader'])
const VITEST_VALUE_FLAGS = new Set(['-t', '--testNamePattern', '--project', '--config', '-c', '--reporter', '--root', '-r', '--dir',
  '--pool', '--shard', '--exclude', '--outputFile', '--mode', '--environment', '--maxWorkers', '--minWorkers', '--testTimeout', '--retry', '--bail'])
const SUITE_SCRIPTS = new Set(['test', 'test:all', 'test:unit'])
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn'])
const PREFIX_WRAPPERS = new Set(['npx', 'env', 'nice', 'setsid', 'time', 'command', 'exec'])
const DIR_OPTIONS = new Set(['-C', '--dir', '--prefix', '--filter'])
const SHELLS = new Set(['bash', 'sh', 'zsh'])
const OTHER = Object.freeze({ kind: 'other', files: [] })
const SUITE_FILE_SECONDS = 24 // p90 hold of a one-file light run, suite-lock journal 2026-11-09..14
const SUITE_MINUTES = 30

const countScope = (files) => ({ kind: files.length > 1 ? 'multi' : 'single', files })

// Positional words of an argument list; a flag in valueFlags consumes the next word unless written --flag=value.
function positionals(args, valueFlags) {
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    const word = String(args[index])
    if (!word.startsWith('-')) out.push(word)
    else if (!word.includes('=') && valueFlags.has(word)) index += 1
  }
  return out
}

function runsNodeTest(args) {
  return args.some((word) => word === '--test' || String(word).startsWith('--test='))
}

function nodeScope(args) {
  const targets = positionals(args, NODE_VALUE_FLAGS)
  if (!runsNodeTest(args)) {
    const files = targets.filter((word) => TEST_FILE.test(word))
    if (files.length > 1) return countScope(files)
    return targets.length > 0 && TEST_FILE.test(targets[0]) ? countScope([targets[0]]) : OTHER
  }
  if (targets.length === 0) return { kind: 'suite', files: [] }
  // A directory or a glob node expands itself covers a whole tree.
  if (targets.some((word) => word.includes('*') || !SCRIPT_FILE.test(word))) return { kind: 'suite', files: targets }
  return countScope(targets)
}

// `vitest run a b`, `vitest a b` (filters), never `vitest list|bench|typecheck`.
function vitestScope(args) {
  const first = args[0]
  if (first !== undefined && first !== 'run' && !String(first).startsWith('-')) return OTHER
  const targets = positionals(first === 'run' ? args.slice(1) : args, VITEST_VALUE_FLAGS)
  return targets.length === 0 ? { kind: 'suite', files: [] } : countScope(targets)
}

function packageScriptScope(manager, args) {
  const script = args[0] === 'run' ? args[1] : args[0]
  const rest = args.slice(args[0] === 'run' ? 2 : 1)
  if (script === 'vitest') return vitestScope(rest)
  if (!SUITE_SCRIPTS.has(script)) return OTHER
  const files = rest.filter((word) => TEST_FILE.test(word))
  return files.length === 0 ? { kind: 'suite', files: [] } : countScope(files)
}

// One unwrapping step, or null when the head is the runner itself.
function unwrapStep(head, rest) {
  if (/^[A-Za-z_]\w*=/.test(head) || PREFIX_WRAPPERS.has(head)) return rest
  if (head === 'timeout') return rest.slice(1)
  if (!PACKAGE_MANAGERS.has(head)) return null
  if (DIR_OPTIONS.has(rest[0])) return [head, ...rest.slice(2)]
  return rest[0] === 'exec' || rest[0] === 'dlx' ? rest : null
}

// Strips environment assignments and launch wrappers down to the runner's own argv.
function unwrap(argv) {
  let words = argv.map(String)
  for (let step = 0; step < 12 && words.length > 0; step += 1) {
    const next = unwrapStep(words[0], words.slice(1))
    if (next === null) break
    words = next
  }
  return words
}

// A shell string: every test file it names counts (sequential runs under one lease), then each segment.
function shellStringScope(text) {
  const files = [...new Set(text.split(/[\s;&|()"']+/).filter((word) => TEST_FILE.test(word)))]
  if (files.length > 1) return countScope(files)
  for (const segment of text.split(/&&|\|\||;|\||\n/)) {
    const scope = lightRunScope(segment.trim().split(/\s+/).filter(Boolean))
    if (scope.kind === 'suite' || scope.kind === 'multi') return scope
  }
  return files.length === 1 ? countScope(files) : OTHER
}

// { kind: 'single' | 'multi' | 'suite' | 'other', files }: how many test files a command covers.
export function lightRunScope(argv) {
  if (!Array.isArray(argv)) return OTHER
  const [head, ...rest] = unwrap(argv)
  if (head === undefined) return OTHER
  const base = head.split('/').pop()
  if (base === 'node') return nodeScope(rest)
  if (base === 'vitest') return vitestScope(rest)
  if (PACKAGE_MANAGERS.has(base)) return packageScriptScope(base, rest)
  if (SHELLS.has(base) && rest[0] === '-c' && typeof rest[1] === 'string') return shellStringScope(rest[1])
  return OTHER
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
  write(lightScopeMessage({ scope, mode, advice: heavyJobAdvice({ command, scope, env }) }))
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
