// Is a test-runner start covered by the machine suite lock? Pure logic: every host read (file text,
// home directory, environment) is injected, so the concurrent-test guard and an offline
// re-classification of its journal decide the same way.
//
// The lock contract (docs/public/releasing.md): every non-watch Vitest run under a config whose global
// setup takes the lease, and every package script wrapping the lease, queues on ONE holder; light runs
// only change the queue order. A run under such a config waits for the lock whatever its command head,
// so a bare `pnpm vitest run <file>` there is covered. Coverage is never claimed from what cannot be
// read: an unresolved directory, an explicit `--config` or `--root`, or `pnpm -r test` is `unknown`.
// A watch run takes no lease: `uncovered`.

import path from 'node:path'
import { stripNonCode } from './command-invocation.mjs'

const CONFIG_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']
// Vitest's own search, per directory while walking up: vitest.config.* first, then vite.config.*.
const CONFIG_NAMES = [...CONFIG_EXTENSIONS.map((ext) => `vitest.config${ext}`), ...CONFIG_EXTENSIONS.map((ext) => `vite.config${ext}`)]
// What a config or script must mention to take the lease: this toolkit's global setup, the lock CLI, or
// the library call a custom setup would make.
const CONFIG_LEASE_MARKER = /suite-lease|wt-suite-lock|acquireSuiteLock/
const SCRIPT_LEASE_MARKER = /with-suite-lease|wt-suite-lock/
const SCRIPT_RUNS_VITEST = /(?:^|[\s/])vitest(?:\s|$)/
const META_FLAGS = new Set(['--version', '-v', '--help', '-h'])
const WATCH_FLAGS = new Set(['--watch', '-w'])
const UNREADABLE_CONFIG_FLAGS = /^(?:--config|-c|--root|-r)(?:=|$)/
const MAX_WALK = 24
const PNPM_DIR_FLAG = /^(?:-C|--dir)$/
// Split points that start a new command word, kept so the walk knows when a subshell or group opens
// or closes: a `cd` inside one does not move the directory of what follows it.
// A brace is a group only as its own word (`{ cmd; }`), never inside `${NAME}`.
const SEPARATORS = [/&&/, /\|\|/, /;/, /\|/, /\n/, /(?<![>&])&(?![&>])/]
const GROUP_MARKS = [/\$\(/, /\(/, /\)/, /(?<![$\w])\{(?=\s)/, /(?<=[\s;])\}/]
const TOKEN = new RegExp(`(${[...SEPARATORS, ...GROUP_MARKS].map((part) => part.source).join('|')})`)
const OPENERS = new Set(['$(', '(', '{'])
const CLOSERS = new Set([')', '}'])
const COVERAGE_ORDER = ['bypassed', 'uncovered', 'unknown', 'inherited-lease', 'lease-script', 'lease-config']
const LOCK_DOMAIN = new Set(['WT_SUITE_LOCK_DIR', 'WT_SUITE_LEASE', 'WT_SUITE_LOCK_BROKER', 'HOME', 'XDG_STATE_HOME', 'LOCALAPPDATA', 'USERPROFILE'])

function assignmentCoverage(name, value) {
  if (LOCK_DOMAIN.has(name)) return 'bypassed'
  if (name !== 'WT_SUITE_LOCK') return null
  if (value === '0') return 'bypassed'
  return /['"$]/.test(value) ? 'unknown' : null
}

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean)
}

function lastPathPart(value) {
  return String(value || '').split(/[\\/]/).at(-1)?.toLowerCase() || ''
}

// `NAME=value` words in front of a command word: returned, and stripped from the head.
function leadingAssignments(segment) {
  const assigned = {}
  let rest = segment.trim()
  for (;;) {
    const match = rest.match(/^(?:(?:sudo|env)\s+)?([A-Za-z_]\w*)=(\S*)(?:\s+|$)/)
    if (!match) return { assigned, rest }
    assigned[match[1]] = match[2]
    rest = rest.slice(match[0].length)
  }
}

function commandHead(segment) {
  let rest = segment.trim()
  for (;;) {
    const next = rest.replace(/^(?:(?:then|do|else|elif|if|while|until|command|time|env|sudo|!)\s+)/, '')
    if (next === rest) return rest
    rest = next
  }
}

// The runner part of a head, or null when the head does not start a test run.
function runnerOf(head) {
  const [first, ...args] = words(head)
  if (!first) return null
  const executable = lastPathPart(first)
  if (executable === 'vitest') return args[0] === 'run' ? { kind: 'vitest', args: args.slice(1), dir: null } : null
  if (executable !== 'pnpm') return null
  let dir = null
  let index = 0
  while (PNPM_DIR_FLAG.test(args[index] ?? '')) {
    dir = args[index + 1] ?? null
    index += 2
  }
  const rest = args.slice(index)
  if (rest[0] === 'test') return { kind: 'pnpm-test', args: rest.slice(1), dir }
  if ((rest[0] === '-r' || rest[0] === '--recursive') && rest[1] === 'test') return { kind: 'pnpm-recursive-test', args: rest.slice(2), dir }
  if (rest[0] === 'vitest') return { kind: 'vitest', args: rest.slice(1), dir }
  if (rest[0] === 'exec' && rest[1] === 'vitest') return { kind: 'vitest', args: rest.slice(2), dir }
  return null
}

function expand(value, vars, home) {
  // Quoted spans arrive blanked to '' or "" (stripNonCode): their content is not readable here.
  if (/[`'"]/.test(value)) return null
  const expanded = value
    .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, braced, bare) => vars[braced ?? bare] ?? all)
    .replace(/^~(?=\/|$)/, () => home ?? '~')
  return /[$~]/.test(expanded) || expanded === '' ? null : expanded
}

function resolveFrom(base, target) {
  if (target === null) return null
  if (path.isAbsolute(target)) return path.normalize(target)
  return base ? path.resolve(base, target) : null
}

function startOf(runner, rest, assigned, state) {
  const args = runner.args
  return {
    head: rest.trim(),
    kind: runner.kind,
    dir: runner.dir === null ? state.dir : resolveFrom(state.dir, expand(runner.dir, state.vars, state.home)),
    bypass: state.exportedAssignment === 'bypassed' || Object.entries(assigned).some(([name, value]) => assignmentCoverage(name, value) === 'bypassed'),
    assignment: Object.entries(assigned).map(([name, value]) => assignmentCoverage(name, value)).find(Boolean) ?? state.exportedAssignment,
    watch: runner.kind === 'vitest' && (args[0] === 'watch' || args[0] === 'dev' || args.some((arg) => WATCH_FLAGS.has(arg))),
    explicitConfig: runner.kind === 'vitest' && args.some((arg) => UNREADABLE_CONFIG_FLAGS.test(arg)),
  }
}

/**
 * Every test-runner start in a Bash command, in order. A version or help query is not a start.
 * `dir` is null when the run's directory cannot be read from the command (a non-literal `cd`, `cd -`,
 * `pushd`, a `cd` whose effect is unknown).
 * @returns {{ head: string, kind: 'vitest'|'pnpm-test'|'pnpm-recursive-test', dir: string|null, bypass: boolean, watch: boolean, explicitConfig: boolean }[]}
 */
export function parseTestRunStarts(command, cwd = null, home = null) {
  if (typeof command !== 'string' || !command) return []
  const state = { dir: cwd, vars: {}, home, exportedAssignment: null }
  const stack = []
  const starts = []
  for (const token of stripNonCode(command.replace(/\bWT_SUITE_LOCK=(['"])0\1/g, 'WT_SUITE_LOCK=0')).replace(/(^|[\s;&|()])#[^\n]*/gm, '$1').split(TOKEN)) {
    if (OPENERS.has(token)) { stack.push(state.dir); continue }
    if (CLOSERS.has(token)) {
      if (stack.length) state.dir = stack.pop()
      continue
    }
    const { assigned, rest } = leadingAssignments(commandHead(token))
    if (!rest) {
      for (const [name, value] of Object.entries(assigned)) state.vars[name] = expand(value, state.vars, home) ?? `$${name}`
      continue
    }
    if (/^export\s+/.test(rest)) {
      for (const exported of rest.slice(7).matchAll(/(?:^|\s)([A-Za-z_]\w*)=(\S*)/g)) {
        state.exportedAssignment = assignmentCoverage(exported[1], exported[2]) ?? state.exportedAssignment
      }
      continue
    }
    const head = commandHead(rest)
    if (/^(?:pushd|popd)(?:\s|$)/.test(head)) { state.dir = null; continue }
    if (/^cd(?:\s|$)/.test(head)) {
      const cd = head.match(/^cd\s+([^\s-]\S*)\s*$/)
      state.dir = cd ? resolveFrom(state.dir, expand(cd[1], state.vars, home)) : null
      continue
    }
    const runner = runnerOf(head)
    if (!runner || runner.args.slice(0, Math.max(0, runner.args.indexOf('--') === -1 ? runner.args.length : runner.args.indexOf('--'))).some((arg) => META_FLAGS.has(arg))) continue
    starts.push(startOf(runner, head, assigned, state))
  }
  return starts
}

export function parseTestRunStart(command, cwd = null, home = null) {
  return parseTestRunStarts(command, cwd, home)[0] ?? null
}

function walkUp(dir, visit) {
  let current = dir
  for (let step = 0; step < MAX_WALK; step++) {
    const found = visit(current)
    if (found !== undefined) return found
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

function nearestConfig(dir, readText) {
  return walkUp(dir, (current) => {
    for (const name of CONFIG_NAMES) {
      const text = readText(path.join(current, name))
      if (typeof text === 'string') return text
    }
    return undefined
  })
}

// The nearest package.json's `test` script and its directory; a package.json without one stops the walk
// the way pnpm does (it runs the script of the package it is in).
function nearestTestScript(dir, readText) {
  return walkUp(dir, (current) => {
    const text = readText(path.join(current, 'package.json'))
    if (typeof text !== 'string') return undefined
    try {
      const script = JSON.parse(text)?.scripts?.test
      return typeof script === 'string' ? { script, dir: current } : null
    } catch { return null }
  })
}

function configCoverage(dir, readText) {
  const config = nearestConfig(dir, readText)
  return config !== null && CONFIG_LEASE_MARKER.test(config) ? 'lease-config' : 'uncovered'
}

/**
 * @returns {'bypassed'|'inherited-lease'|'lease-config'|'lease-script'|'uncovered'|'unknown'}
 *   `inherited-lease` runs at once inside the holder's lease: it is covered, but it does not queue.
 */
export function lockCoverage({ dir, kind, bypass = false, assignment = null, watch = false, explicitConfig = false, readText, env = {} }) {
  if (bypass || assignment === 'bypassed' || env.WT_SUITE_LOCK === '0') return 'bypassed'
  if (assignment === 'unknown') return 'unknown'
  if (watch) return 'uncovered'
  if (typeof env.WT_SUITE_LEASE === 'string' && env.WT_SUITE_LEASE) return 'inherited-lease'
  if (!dir || explicitConfig || kind === 'pnpm-recursive-test') return 'unknown'
  if (kind !== 'pnpm-test') return configCoverage(dir, readText)
  const found = nearestTestScript(dir, readText)
  if (!found) return 'uncovered'
  if (SCRIPT_LEASE_MARKER.test(found.script)) return 'lease-script'
  return SCRIPT_RUNS_VITEST.test(found.script) ? configCoverage(found.dir, readText) : 'uncovered'
}

/** The least covered of several starts' coverage: one uncovered start makes the command uncovered. */
export function worstCoverage(coverages) {
  return coverages.reduce((worst, next) => (COVERAGE_ORDER.indexOf(next) < COVERAGE_ORDER.indexOf(worst) ? next : worst), 'lease-config')
}

/** Covered and waiting its turn: the holder's runners and the waiters ahead cannot overlap it. */
export function isQueued(coverage) {
  return coverage === 'lease-config' || coverage === 'lease-script'
}

/**
 * Runners that can overlap a queued run: every runner that is not the lock holder, a queued waiter, or
 * a descendant of either. Membership is positive evidence only (`participants` is the holder's and the
 * tickets' pids); with `participants` null (lock unreadable) every runner counts.
 */
export function runnersOutsideLock(runners, participants, parentOf) {
  if (!participants) return runners.length
  return runners.filter((runner) => {
    const seen = new Set()
    let pid = runner.pid
    while (pid > 0 && !seen.has(pid)) {
      if (participants.has(pid)) return false
      seen.add(pid)
      pid = parentOf(pid)
    }
    return true
  }).length
}
