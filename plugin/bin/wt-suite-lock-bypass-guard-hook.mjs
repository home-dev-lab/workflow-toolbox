#!/usr/bin/env node
// PreToolUse on Bash: WARN (never block) an Agent-tool sub-agent whose command bypasses the machine
// suite lock. The lock serializes test runs so load-sensitive timing tests stay stable; a delegate
// that skips it reports a green that does not count and can perturb a concurrent locked run.
//
// WHO IS COVERED. Agent-tool sub-agents only: a PreToolUse Bash payload with a non-empty `agent_id`
// (Claude Code documents `agent_id` as "present when the hook fires inside a subagent").
//   - Main session (no agent_id): no output, no journal. It keeps the ability on purpose.
//   - Workflow-tool subagent (harness label `workflow-subagent`, a transcript inside
//     `subagents/workflows/<run>/`, or its own `agent-<agent_id>.jsonl` in a run directory):
//     no output, journaled `silent`. A Workflow worker whose payload carries no agent_id is not seen.
//   - SDK roles: their guard payload carries no agent_id, so they are not covered.
//   - External opencode/codex lanes: they run no Claude Code hooks.
//
// WHAT IT DETECTS, in command-word position only, on a heredoc-blanked view of the command. An
// "assignment" is `NAME=value` before a command word, a bare `NAME=value` statement, or one after
// `export`, `declare -x`, `env [flags]`, `cross-env` or `sudo` (an argument there may be quoted
// whole: `env "NAME=0"`). `X=$X` / `X=${X}` (PowerShell `$env:X = $env:X`, cmd `set X=%X%`) forwards
// the variable unchanged and is silent for every class. The scan descends into the script of
// `bash|sh|zsh|dash|ksh [options] -c`, `cmd /c` or `/k` (Git Bash spells it `//c`; `set NAME=value`,
// `set "NAME=value"`, `set /a NAME=expr`, case-insensitive), and
// `powershell|pwsh -Command` (`$env:NAME = value`, case-insensitive), and into `$(...)` and backticks;
// lock-CLI calls are checked inside cmd and PowerShell scripts too.
//   lock-disabled         WT_SUITE_LOCK whose unquoted value is exactly `0` (cmd's
//                         `set WT_SUITE_LOCK=0 && x` stores "0 ", which is not a bypass).
//   lock-dir-elsewhere    WT_SUITE_LOCK_DIR set to a literal path outside the temporary root.
//   lock-dir-temp         WT_SUITE_LOCK_DIR under the temporary root (or TMPDIR/TEMP/TMP, mktemp).
//   lock-dir-unresolved   WT_SUITE_LOCK_DIR set from any other expansion.
//   lease-forged          a non-empty WT_SUITE_LEASE (a lease marker covers both lock domains).
//   lock-released-forced  `wt-suite-lock release --force`.
//   lock-stale-reclaim    `wt-suite-lock run|release --stale-s 0` (the separate form, the only one
//                         the CLI reads), on win32 only: only there does age alone reclaim a live
//                         holder.
//   state-root-moved      a variable the lock directory is derived from (artifactStateDir with
//                         os.homedir()), assigned for a locked gate: XDG_STATE_HOME or HOME on
//                         Linux and macOS; XDG_STATE_HOME, LOCALAPPDATA or USERPROFILE on win32
//                         (where os.homedir() reads USERPROFILE, not HOME). A locked gate is
//                         pnpm test|typecheck|lint|quality, a non-watch vitest (`vitest run`, or
//                         `vitest <filter>`), `wt-suite-lock run`, and `wt-suite-lock-run`.
// Silent: WT_SUITE_LOCK=1, WT_SUITE_LOCK_WAIT_S, WT_SUITE_LOCK_CMD, WT_SUITE_LOCK_BROKER alone,
// empty values, a top-level `set NAME=...` (bash's positional-parameter builtin), and every mention
// outside command-word position (grep patterns, echo text, heredoc bodies, commit messages, comments).
//
// NOT COVERED: `pnpm exec vitest|eslint|tsc` and per-package `vitest run` scripts outside the lease
// wrapper, a vitest config without the lease globalSetup, `vitest --watch`, variables exported in an
// earlier Bash call or inside a script file, a value inherited from the session environment (for
// example a settings `env` block), env-only bypasses with no command text (a delivery gate that
// forwards WT_SUITE_LOCK / WT_SUITE_LOCK_DIR), editing lock files by hand, PowerShell
// `Set-Item env:` / `[Environment]::SetEnvironmentVariable`, a script fed to a shell through a
// heredoc or stdin (`bash <<EOF`, `bash -s <<EOF`) or built by `eval '…'` (neither is scanned), and
// Windows `--stale-s` age reclaim beyond the literal `0` flag. `cmd /c "set /p NAME=…"` reads its
// value from input and stays silent. Also not covered: an inline interpreter that sets the
// environment (`node -e`, `python -c`); a value computed at run time (`$((0))`, `$'0'`, a command
// substitution); `readonly` and other declaration forms besides `export` and `declare -x`; the
// script of `env -S`; a state root moved in one statement and read by a later nested shell; an
// unset or overriding effect (`env -u`, a later assignment of the same name), which may still warn;
// nesting deeper than MAX_DEPTH shells or substitutions.
//
// OUTPUT. A scoped exception to the convention that owned hooks stay silent for sub-agents
// (emitGuardNotice drops output when agent_id is set): this warning exists FOR the sub-agent, the
// actor bypassing the lock, and fires only on that agent's own act, so it writes
// `hookSpecificOutput.additionalContext` directly. It never writes `permissionDecision`: an `allow`
// would auto-approve the call, and `deny` is the promoted phase. `WT_GUARD_MODE=observe` mutes the
// output (the journal records `silent`). Fail-open on any error.
//
// PROMOTION. Warn-only until its record is read: after 20 real-origin `warned` journal entries read
// one by one with zero false positives, `lock-disabled`, `lease-forged` and `lock-released-forced`
// switch to a deny decision for Agent-tool sub-agents. Each journal record carries the call's
// tool_use_id (never the command text), so a reviewer can find it in the transcript. `lock-dir-elsewhere` and
// `state-root-moved` stay warn until their own 20. `lock-dir-temp` and `lock-dir-unresolved` stay
// warn-only with no promotion until their own record shows whether legitimate bounded runs
// dominate. `lock-stale-reclaim` has no promotion.
//
// Test seam: WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM (read by the host helper) names the platform whose
// lock semantics apply.

import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { guardMode, recordGuardEvent } from './lib/guard-journal.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'
import { suiteLockBypassGuardPlatform, suiteLockDirLocation } from './lib/host/suite-lock-bypass-host.mjs'
import { blankHeredocBodies, parseStatements, shellUnquote } from './lib/rm-critical-path-core.mjs'
import { isWorkflowSubagentPayload } from './lib/subagent-delivery-shape.mjs'

const GUARD = 'wt-suite-lock-bypass-guard-hook.mjs'
const TAG = '[workflow-toolbox suite-lock bypass guard]'
const PREFILTER = /WT_SUITE_L|wt-suite-lock|HOME|LOCALAPPDATA|USERPROFILE/i
const MAX_DEPTH = 4

// Mirrors artifactStateDir (lib/artifact-server.mjs) and os.homedir(): which variables move the
// lock directory on which platform.
const POSIX_STATE_ROOTS = new Set(['XDG_STATE_HOME', 'HOME'])
const WIN32_STATE_ROOTS = new Set(['XDG_STATE_HOME', 'LOCALAPPDATA', 'USERPROFILE'])
const LOCK_NAMES = new Set(['WT_SUITE_LOCK', 'WT_SUITE_LOCK_DIR', 'WT_SUITE_LEASE'])
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'coproc', 'noglob', 'nocorrect'])
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const POWERSHELLS = new Set(['powershell', 'pwsh'])
// Wrappers that run the next word as the command, each with the flags that take an argument.
const PASS_THROUGH = new Map([
  ['nohup', new Set()],
  ['setsid', new Set()],
  ['exec', new Set(['-a'])],
  ['command', new Set()],
  ['builtin', new Set()],
  ['nice', new Set(['-n', '--adjustment'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['ionice', new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid'])],
  ['chrt', new Set()],
  ['taskset', new Set()],
])
// Node options that take a module argument before the script path. Written as one string: these are
// flag NAMES to skip, not a spawn argv.
const NODE_PRELOAD_FLAGS = new Set('-r --require --import --loader'.split(' '))
// Long shell options that take an argument before `-c`.
const SHELL_LONG_FLAGS_WITH_ARGUMENT = new Set(['--rcfile', '--init-file'])
const ENV_FLAGS_WITH_ARGUMENT = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])
const SUDO_FLAGS_WITH_ARGUMENT = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'])
const PNPM_FLAGS_WITH_ARGUMENT = new Set(['-C', '--dir', '-F', '--filter', '--workspace-concurrency', '--reporter'])
const GATE_SCRIPT = /^(?:test|typecheck|lint|quality)(?::|$)/
const ASSIGNMENT = /^([A-Za-z_]\w*)=/s
// `/c` or `/k`; Git Bash passes `//c` so that MSYS does not rewrite it as a path.
const CMD_SWITCH = /^\/\/?[ck]$/i
// `set /a NAME=expr` assigns the expression's value. (`set /p NAME=prompt` reads it from input; its
// switch stays in the name, which then matches no lock variable.)
const CMD_SET_ARITHMETIC = /^\/a\s+/i
const POWERSHELL_ENV_PREFIX = /^\$env:(\w+)/i
const WT_SUITE_LOCK_CLI = /^wt-suite-lock(?:\.mjs|\.cmd)?$/
const WT_SUITE_LOCK_RUNNER = /^wt-suite-lock-run(?:\.mjs|\.cmd)?$/
const VITEST_WATCH = new Set(['watch', 'dev', '--watch', '-w'])

const LOCATION_CLASS = { temp: 'lock-dir-temp', unresolved: 'lock-dir-unresolved', elsewhere: 'lock-dir-elsewhere' }
const BYPASS_CLASSES = new Set(['lock-disabled', 'lock-dir-elsewhere', 'lease-forged', 'lock-released-forced', 'lock-stale-reclaim', 'state-root-moved'])
const WHAT = {
  'lock-disabled': '`WT_SUITE_LOCK=0` switches the machine suite lock off for this command',
  'lock-dir-elsewhere': '`WT_SUITE_LOCK_DIR` points this command at a lock other than the machine suite lock',
  'lease-forged': '`WT_SUITE_LEASE` claims a suite lease this command does not hold',
  'lock-released-forced': '`wt-suite-lock release --force` removes a lock that a live run may hold',
  'lock-stale-reclaim': '`--stale-s 0` lets a Windows waiter reclaim a live holder\'s lock by age alone',
  'state-root-moved': 'moving the state or home directory the suite lock lives under (XDG_STATE_HOME or HOME; LOCALAPPDATA or USERPROFILE on Windows) for a test gate moves the lock with it, so the gate runs outside the machine queue',
  'lock-dir-temp': '`WT_SUITE_LOCK_DIR` under the temporary directory gives this command its own lock, outside the machine queue',
  'lock-dir-unresolved': '`WT_SUITE_LOCK_DIR` set from an expansion gives this command its own lock, outside the machine queue',
}
const BYPASS_ADVICE =
  'Never bypass the machine suite lock: wait in the queue (`wt-suite-lock status` shows the holder and the queue). ' +
  'On exit 75 (queue timeout) re-queue, or report to your arbiter. While you wait, edit and lint the touched files. ' +
  'If your brief says the arbiter runs the tests, leave them to it. A green from an unlocked run does not count, ' +
  'and the run can disturb a locked run\'s timing-sensitive tests.'
const ISOLATED_ADVICE =
  'An isolated lock dir is legitimate only for a bounded mutation or red-proof run under an outer `timeout N`, ' +
  'never for a gate whose result you report; that gate goes through the machine lock or to your arbiter.'

// `-c`, `-co`, … `-command`: PowerShell accepts any unambiguous prefix of `-Command`.
function isPowerShellCommandFlag(word) {
  const flag = word.toLowerCase()
  return flag.length >= 2 && '-command'.startsWith(flag)
}

// `$env:NAME = value` → { name, expression }, or null.
function powerShellEnvAssignment(statement) {
  const prefix = POWERSHELL_ENV_PREFIX.exec(statement)
  if (!prefix || /^\d/.test(prefix[1])) return null
  const rest = statement.slice(prefix[0].length).trimStart()
  if (!rest.startsWith('=')) return null
  return { name: prefix[1], expression: rest.slice(1) }
}

// cmd `set …` statement (optionally after `(` or `@`) → the text after `set`, or null.
function cmdSetBody(part) {
  let text = part.trimStart()
  if (text.startsWith('(') || text.startsWith('@')) text = text.slice(1).trimStart()
  if (!/^set\s/i.test(text)) return null
  return text.slice(3).trimStart()
}

function commandName(word) {
  return path.win32.basename(shellUnquote(word)).replace(/\.exe$/i, '')
}

function isRedirection(word) {
  return /^\d*(?:[<>]|&>)/.test(word)
}

// `X=$X` or `X=${X}` (quoted or not, never single-quoted) forwards the variable unchanged.
function forwardsItself(name, value, raw) {
  return !raw.includes("'") && (value === `$${name}` || value === `\${${name}}`)
}

// A prefix assignment: the shell recognises it only when the name and `=` are unquoted
// (`"A=0" cmd` runs a command named `A=0`).
function assignmentOf(word) {
  const match = ASSIGNMENT.exec(word)
  if (!match) return null
  const value = shellUnquote(word.slice(match[1].length + 1))
  return { name: match[1], value, forwarded: forwardsItself(match[1], value, word) }
}

// An argument of env/export/declare/cross-env/sudo: the program sees the unquoted word, so
// `env "A=0"` and `export 'A=0'` assign just like their unquoted forms.
function argumentAssignmentOf(word) {
  const plain = shellUnquote(word)
  const match = ASSIGNMENT.exec(plain)
  if (!match) return null
  const value = plain.slice(match[1].length + 1)
  return { name: match[1], value, forwarded: forwardsItself(match[1], value, word) }
}

function skipFlags(words, start, withArgument) {
  let index = start
  while (index < words.length) {
    const flag = shellUnquote(words[index])
    if (flag === '--') return index + 1
    if (!flag.startsWith('-')) return index
    index += withArgument.has(flag) ? 2 : 1
  }
  return index
}

function takeAssignments(words, start, into, scope, of = assignmentOf) {
  let index = start
  for (let next = of(words[index] ?? ''); next; next = of(words[index] ?? '')) {
    into.push({ ...next, scope })
    index += 1
  }
  return index
}

// Peel wrappers until the real command word: env/cross-env/sudo contribute assignments to it.
function resolveCommand(words, start, inline) {
  let rest = words.slice(start)
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    const name = commandName(rest[0])
    if (name === 'env') {
      const after = takeAssignments(rest, skipFlags(rest, 1, ENV_FLAGS_WITH_ARGUMENT), inline, 'inline', argumentAssignmentOf)
      rest = rest.slice(after)
    } else if (name === 'cross-env' || name === 'cross-env-shell') {
      rest = rest.slice(takeAssignments(rest, 1, inline, 'inline', argumentAssignmentOf))
    } else if (name === 'sudo') {
      rest = rest.slice(takeAssignments(rest, skipFlags(rest, 1, SUDO_FLAGS_WITH_ARGUMENT), inline, 'inline', argumentAssignmentOf))
    } else if ((name === 'npx' || name === 'pnpx') && commandName(rest[1] ?? '').startsWith('cross-env')) {
      rest = rest.slice(1)
    } else if (name === 'pnpm' && shellUnquote(rest[1] ?? '') === 'exec' && commandName(rest[2] ?? '').startsWith('cross-env')) {
      rest = rest.slice(2)
    } else if (PASS_THROUGH.has(name)) {
      let index = skipFlags(rest, 1, PASS_THROUGH.get(name))
      if (name === 'timeout' && /^\d/.test(shellUnquote(rest[index] ?? ''))) index += 1
      rest = rest.slice(index)
    } else break
  }
  return rest
}

function wtSuiteLockArgs(command) {
  const name = commandName(command[0] ?? '')
  if (WT_SUITE_LOCK_CLI.test(name)) return command.slice(1).map(shellUnquote)
  if (name !== 'node') return null
  const script = skipFlags(command, 1, NODE_PRELOAD_FLAGS)
  if (!WT_SUITE_LOCK_CLI.test(commandName(command[script] ?? ''))) return null
  return command.slice(script + 1).map(shellUnquote)
}

function staleBoundIsZero(args) {
  const end = args.includes('--') ? args.indexOf('--') : args.length
  for (let index = 1; index < end; index += 1) {
    // Only the separate `--stale-s N` form: the lock CLI treats `--stale-s=N` as an unknown argument.
    if (args[index] !== '--stale-s') continue
    const value = args[index + 1]
    if (value !== undefined && value.trim() !== '' && Number(value) === 0) return true
  }
  return false
}

function isLockRunner(command) {
  const name = commandName(command[0] ?? '')
  if (WT_SUITE_LOCK_RUNNER.test(name)) return true
  if (name !== 'node') return false
  return WT_SUITE_LOCK_RUNNER.test(commandName(command[skipFlags(command, 1, NODE_PRELOAD_FLAGS)] ?? ''))
}

// A non-watch vitest takes the lease through its globalSetup, with or without `run`.
function vitestTakesLease(args) {
  return !args.some((arg) => VITEST_WATCH.has(arg))
}

function isGate(command) {
  const lockArgs = wtSuiteLockArgs(command)
  if (lockArgs) return lockArgs[0] === 'run'
  if (isLockRunner(command)) return true
  const name = commandName(command[0] ?? '')
  const args = command.slice(1).map(shellUnquote)
  if (name === 'vitest') return vitestTakesLease(args)
  if (name === 'npx' || name === 'pnpx') return args[0] === 'vitest' && vitestTakesLease(args.slice(1))
  if (name !== 'pnpm') return false
  let index = skipFlags(command, 1, PNPM_FLAGS_WITH_ARGUMENT) - 1
  if (args[index] === 'run') index += 1
  if (args[index] === 'exec') index += 1
  if (args[index] === 'vitest') return vitestTakesLease(args.slice(index + 1))
  return GATE_SCRIPT.test(args[index] ?? '')
}

function movesStateRoot(name, platform) {
  return (platform === 'win32' ? WIN32_STATE_ROOTS : POSIX_STATE_ROOTS).has(name)
}

function scanPosix(text, scan, depth) {
  if (depth > MAX_DEPTH) return
  const { statements, nested } = parseStatements(blankHeredocBodies(text))
  const assignments = []
  const gates = []
  let statementIndex = 0
  for (const { words: rawWords } of statements) {
    statementIndex += 1
    const words = []
    for (let index = 0; index < rawWords.length; index += 1) {
      if (isRedirection(rawWords[index])) {
        if (/^\d*(?:[<>]{1,3}|&>>?|[<>]&|>\|)$/.test(rawWords[index])) index += 1
        continue
      }
      words.push(rawWords[index])
    }
    let start = 0
    while (start < words.length && RESERVED.has(words[start])) start += 1
    if (start >= words.length) continue
    const inline = []
    const commandStart = takeAssignments(words, start, inline, 'inline')
    if (commandStart >= words.length) {
      for (const assignment of inline) assignments.push({ ...assignment, scope: 'persistent', at: statementIndex })
      continue
    }
    const head = commandName(words[commandStart])
    if (head === 'export' || ((head === 'declare' || head === 'typeset') && words.slice(commandStart + 1).some((word) => /^-\w*x/.test(word)))) {
      for (const word of words.slice(commandStart + 1)) {
        const assignment = argumentAssignmentOf(word)
        if (assignment) assignments.push({ ...assignment, scope: 'persistent', at: statementIndex })
      }
      continue
    }
    const command = resolveCommand(words, commandStart, inline)
    const gate = command.length > 0 && isGate(command)
    for (const assignment of inline) assignments.push({ ...assignment, at: statementIndex, gate })
    if (gate) gates.push(statementIndex)
    if (command.length === 0) continue
    inspectCommand(command, scan, depth)
  }
  // Forwarding a variable as itself changes nothing the lock reads.
  const effective = assignments.filter((assignment) => !assignment.forwarded)
  for (const assignment of effective) judgeAssignment(assignment, scan, 'posix', (name) => name)
  // A state root only moves the lock for a gate it reaches: its own statement, or a later one.
  for (const assignment of effective) {
    if (!movesStateRoot(assignment.name, scan.platform) || assignment.value === '') continue
    const reaches = assignment.scope === 'persistent' ? gates.some((at) => at > assignment.at) : assignment.gate
    if (reaches) scan.add('state-root-moved', 'posix')
  }
  for (const { body } of nested) scanPosix(body, scan, depth + 1)
}

// `wt-suite-lock release --force` or `run|release --stale-s 0`; true when the command is the lock CLI.
function inspectLockCommand(command, scan, form) {
  const lockArgs = wtSuiteLockArgs(command)
  if (!lockArgs) return false
  const sub = lockArgs[0]
  if (sub === 'release' && lockArgs.includes('--force')) scan.add('lock-released-forced', form)
  if ((sub === 'run' || sub === 'release') && scan.platform === 'win32' && staleBoundIsZero(lockArgs)) scan.add('lock-stale-reclaim', form)
  return true
}

// Lock-CLI calls inside one cmd or PowerShell statement.
function inspectScriptPart(part, scan, form) {
  for (const { words } of parseStatements(part).statements) {
    const command = resolveCommand(words, takeAssignments(words, 0, [], 'inline'), [])
    if (command.length > 0) inspectLockCommand(command, scan, form)
  }
}

function inspectCommand(command, scan, depth) {
  const name = commandName(command[0])
  const lower = name.toLowerCase()
  if (inspectLockCommand(command, scan, 'posix')) return
  if (POSIX_SHELLS.has(name)) {
    for (let index = 1; index < command.length - 1; index += 1) {
      const flag = shellUnquote(command[index])
      if (flag === '-o' || flag === '+o' || flag === '-O' || flag === '+O') { index += 1; continue }
      if (flag === '--') break
      if (flag.startsWith('--')) {
        if (SHELL_LONG_FLAGS_WITH_ARGUMENT.has(flag)) index += 1
        continue
      }
      if (!/^[-+][A-Za-z]+$/.test(flag)) break
      if (flag.startsWith('-') && flag.includes('c')) {
        scanPosix(shellUnquote(command[index + 1]), scan, depth + 1)
        break
      }
    }
    return
  }
  if (lower === 'cmd') {
    const switchAt = command.findIndex((word, index) => index > 0 && CMD_SWITCH.test(shellUnquote(word)))
    if (switchAt < 0 || switchAt === command.length - 1) return
    const rest = command.slice(switchAt + 1)
    const script = rest.length === 1 && rest[0].startsWith('"') && rest[0].endsWith('"') ? shellUnquote(rest[0]) : rest.join(' ')
    scanCmd(script, scan)
    return
  }
  if (POWERSHELLS.has(lower)) {
    const flagAt = command.findIndex((word, index) => index > 0 && isPowerShellCommandFlag(shellUnquote(word)))
    let scriptWords
    if (flagAt > 0) scriptWords = command.slice(flagAt + 1)
    else if (lower === 'powershell') scriptWords = command.slice(1).filter((word) => !shellUnquote(word).startsWith('-'))
    else return
    scanPowerShell(scriptWords.map(shellUnquote).join(' '), scan)
  }
}

// Split on cmd/PowerShell statement separators outside quotes.
function splitStatements(script, separators, quotes) {
  const parts = []
  let current = ''
  let quote = null
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (quotes.includes(char)) { quote = char; current += char; continue }
    const separator = separators.find((candidate) => script.startsWith(candidate, index))
    if (separator) {
      parts.push(current)
      current = ''
      index += separator.length - 1
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function gateFollows(parts, from) {
  return parts.slice(from + 1).some((part) => parseStatements(part).statements.some(({ words }) => {
    const command = resolveCommand(words, takeAssignments(words, 0, [], 'inline'), [])
    return command.length > 0 && isGate(command)
  }))
}

// cmd.exe: `set NAME=value` keeps everything up to the separator, trailing spaces included.
function scanCmd(script, scan) {
  const parts = splitStatements(script, ['&&', '||', '&', '|', '\n'], ['"'])
  parts.forEach((part, index) => {
    const setBody = cmdSetBody(part)
    if (setBody === null) {
      inspectScriptPart(part, scan, 'cmd')
      return
    }
    const arithmetic = CMD_SET_ARITHMETIC.exec(setBody)
    let body = arithmetic ? setBody.slice(arithmetic[0].length) : setBody
    if (body.startsWith('"')) {
      const close = body.indexOf('"', 1)
      body = close < 0 ? body.slice(1) : body.slice(1, close)
    }
    const equals = body.indexOf('=')
    if (equals <= 0) return
    let assignment = { name: body.slice(0, equals), value: body.slice(equals + 1) }
    // `set /a` evaluates its right side: a decimal literal stores its number (`00` stores `0`); any
    // other expression is left as written and never matches a literal check.
    if (arithmetic) {
      const expression = assignment.value.trim()
      assignment = { name: assignment.name.trim(), value: /^\d+$/.test(expression) ? String(Number(expression)) : expression }
    }
    // `set X=%X%` forwards the variable unchanged.
    if (assignment.value.toUpperCase() === `%${assignment.name.toUpperCase()}%`) return
    judgeAssignment(assignment, scan, 'cmd', (name) => name.toUpperCase())
    if (movesStateRoot(assignment.name.toUpperCase(), scan.platform) && assignment.value !== '' && gateFollows(parts, index)) scan.add('state-root-moved', 'cmd')
  })
}

function powerShellValue(expression) {
  const text = expression.trim()
  const quoted = /^(['"])(.*)\1$/s.exec(text)
  if (quoted) return quoted[2]
  return text
}

// PowerShell: `$env:NAME = value` at the start of a statement.
function scanPowerShell(script, scan) {
  const parts = splitStatements(script, ['&&', '||', ';', '|', '\n'], ["'", '"'])
  parts.forEach((part, index) => {
    const match = powerShellEnvAssignment(part.trim())
    if (!match) {
      inspectScriptPart(part, scan, 'powershell')
      return
    }
    const assignment = { name: match.name, value: powerShellValue(match.expression) }
    // `$env:X = $env:X` forwards the variable unchanged.
    if (assignment.value.toLowerCase() === `$env:${assignment.name.toLowerCase()}`) return
    judgeAssignment(assignment, scan, 'powershell', (name) => name.toUpperCase())
    if (movesStateRoot(assignment.name.toUpperCase(), scan.platform) && assignment.value !== '' && gateFollows(parts, index)) scan.add('state-root-moved', 'powershell')
  })
}

function judgeAssignment(assignment, scan, form, fold) {
  const name = fold(assignment.name)
  if (!LOCK_NAMES.has(name)) return
  const { value } = assignment
  if (name === 'WT_SUITE_LOCK') {
    if (value === '0') scan.add('lock-disabled', form)
    return
  }
  if (value === '') return
  if (name === 'WT_SUITE_LEASE') {
    scan.add('lease-forged', form)
    return
  }
  scan.add(LOCATION_CLASS[suiteLockDirLocation(value, scan.cwd)] ?? 'lock-dir-elsewhere', form)
}

function detectSuiteLockBypass(command, { cwd = '', platform = 'linux' } = {}) {
  const found = new Map()
  const scan = { cwd, platform, add: (cls, form) => { if (!found.has(cls)) found.set(cls, form) } }
  scanPosix(command, scan, 0)
  return found
}

function message(found) {
  const classes = [...found.keys()]
  const lines = [`${TAG} WARNING (not blocked): ${classes.map((cls) => WHAT[cls]).join('; ')}.`]
  if (classes.some((cls) => BYPASS_CLASSES.has(cls))) lines.push(BYPASS_ADVICE)
  if (classes.some((cls) => !BYPASS_CLASSES.has(cls))) lines.push(ISOLATED_ADVICE)
  return lines.join('\n')
}

function main() {
  const input = readStdinJson()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return
  const command = input.tool_input?.command
  if (typeof command !== 'string' || !PREFILTER.test(command)) return
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  const found = detectSuiteLockBypass(command, { cwd, platform: suiteLockBypassGuardPlatform() })
  if (found.size === 0) return
  const workflow = isWorkflowSubagentPayload(input)
  for (const [cls, form] of found) {
    recordGuardEvent({
      guard: GUARD,
      decision: workflow ? 'silent' : 'warned',
      class: cls,
      cwd: cwd || undefined,
      session: input.session_id,
      agent: input.agent_id,
      // The tool_use_id lets a reviewer find the call in the transcript; the command text itself
      // is never journaled (it can carry secrets).
      evidence: {
        agentType: typeof input.agent_type === 'string' ? input.agent_type : 'unknown',
        form,
        ...(typeof input.tool_use_id === 'string' ? { toolUseId: input.tool_use_id } : {}),
      },
    })
  }
  if (workflow || guardMode() === 'observe') return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message(found) } }))
}

runFailOpenHook(GUARD, main)
