#!/usr/bin/env node
// wt-missing-package-script-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS (never
// blocks) on a Bash command that invokes a package-manager script (`pnpm <script>`, `npm run
// <script>`, `yarn <script>`) whose name does NOT exist in the `scripts` map of the
// `package.json` governing the command's effective directory.
//
// WHY THE HAZARD. In a pnpm/npm/yarn workspace, `cd`ing into a sub-package and running the
// WORKSPACE ROOT's gate command from there (`test`/`lint`/`typecheck`) fails with a
// package-manager error and a non-zero exit — because that script is defined at the root, not
// in the sub-package. The cost is not the failed command; it is that the failure is
// INDISTINGUISHABLE from the failure being looked for, at exactly the moment of looking for it.
// A non-zero exit right after a merge reads as "the merge broke the build" — this project's own
// `wt-merge-chain-guard-hook.mjs` exists for a sibling shape of the same confusion, a stale tree
// certified by a chained gate. This guard closes the adjacent case: a genuinely fresh tree, a
// script name that simply does not resolve from the directory the command runs in.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). Command-line parsing here is
// necessarily heuristic (no real shell parser), so a false positive is possible; warn-only until
// its false-positive rate is measured on this project's own real traffic.
//
// `cd`/`&&` CHAINS ARE TRACKED. `cd toolkit && pnpm test` resolves the script against `toolkit`,
// not against whatever directory the Bash tool call itself carries, and several `cd`s in one
// chain resolve cumulatively, in order. Resolution is CONSERVATIVE: the moment the effective
// directory cannot be determined with confidence (`cd -`, a `cd` target containing `$` or a
// backtick, a target that does not exist or is not a directory, or any segment containing
// `(`/`)` — subshells and command substitution are not modeled), that segment and every later
// one in the SAME chain is treated as unresolvable and the guard stays silent for it — an
// absolute-path `cd` later in the same chain still recovers, since it doesn't depend on the
// unknown state. This tracking exists BECAUSE the untracked version shipped once already (in
// this project's private precursor) and warned on a correct `cd toolkit && pnpm test` within
// minutes of going live — the single most common real shape, missed by a verification set
// written alongside the code that produced it.
//
// DATA SPANS ARE STRIPPED before segment splitting, the same discipline
// `wt-merge-chain-guard-hook.mjs` uses: a heredoc body, a backtick span, a quoted string, and a
// shell comment are never split on `&&`/`;`/`|`/newline as if they were separate commands — a
// quoted commit message containing `; pnpm test` must not read as a real chained invocation.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - `pnpm install`, `pnpm add`, `npx`, `pnpm dlx`, `pnpm exec`, or a direct binary path
//     (`node_modules/.bin/vite`) — none of these are script-name lookups, deliberately silent;
//   - a script that exists but would fail for an unrelated reason (missing dep, syntax error) —
//     this guard only checks EXISTENCE of the script name, never whether it would succeed;
//   - `cd -`, `cd "$VAR"`, `cd $(...)`, a `cd` into a non-existent directory, or any command
//     touching `(`/`)` (subshells, command grouping) — the effective directory is not
//     confidently known, so the guard stays silent rather than guess;
//   - workspace-aware flags this guard cannot fully interpret beyond `-r`/`--filter`/`-w`/`-C`/
//     `--dir` (which it treats as "package resolution is not the plain CWD lookup" and stays
//     silent on);
//   - any command other than a Bash tool_use.
//
// Fail-open: any error anywhere (unreadable/malformed package.json, unparseable command line,
// no package.json in the tree) degrades to silence via runFailOpenHook, never to a thrown error.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// Walk up from `startDir` to find the nearest package.json. Returns { dir, pkg } or null.
function findNearestPackageJson(startDir) {
  let dir = startDir
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const pkg = readJson(candidate)
      if (pkg) return { dir, pkg }
      return null // exists but unreadable/malformed → fail open
    }
    const parent = dirname(dir)
    if (parent === dir) return null // reached filesystem root
    dir = parent
  }
  return null
}

// Walk further UP past `fromDir` (exclusive) looking for an ANCESTOR package.json that DOES
// define `scriptName` — used only to build the helpful "run it from <path>" hint.
function findAncestorDefining(fromDir, scriptName) {
  let dir = dirname(fromDir)
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const pkg = readJson(candidate)
      if (pkg && pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, scriptName)) {
        return dir
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// A command line carries CODE and DATA in the same string. Strip data spans before splitting on
// shell separators, or a quoted/heredoc/commented mention of `pnpm <script>` reads as a real
// chained invocation. Same discipline as wt-merge-chain-guard-hook.mjs's stripDataSpans().
function stripDataSpans(cmd) {
  let out = cmd
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2$/gm, '<<HEREDOC')
  out = out.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, '<<HEREDOC')
  out = out.replace(/`[^`]*`/g, '`CODESPAN`')
  out = out.replace(/'[^']*'/g, "'Q'").replace(/"[^"]*"/g, '"Q"')
  out = out.replace(/(^|\s)#.*$/gm, '$1')
  return out
}

// Tokenize a single simple command (already split on shell operators) into words, stripping
// simple quoting. Not a real shell parser — good enough for `pnpm <script>` / `cd <dir>` shapes.
function tokenize(segment) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(segment))) {
    tokens.push(m[1] ?? m[2] ?? m[3])
  }
  return tokens
}

// Split a full command string on shell command separators (&&, ||, ;, |, newline) into
// independently-checkable segments.
function splitSegments(cmd) {
  return cmd
    .split(/&&|\|\||;|\n|\|(?!\|)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Recognize a `cd` invocation in a segment. Returns the raw target token, or null if the
// segment isn't a `cd`.
function matchCdTarget(segment) {
  const tokens = tokenize(segment)
  if (tokens.length === 0 || tokens[0] !== 'cd') return null
  return tokens[1] ?? '~' // bare `cd` goes to $HOME
}

// Resolve a `cd` target against the currently-tracked cwd. `cwdTrusted` is false once an earlier
// segment in the same chain left the effective directory unknown — a RELATIVE target can't be
// resolved against an untrusted base, but an ABSOLUTE (or `~`-relative) target still can, which
// is how the chain recovers after an unresolvable segment.
function resolveCd(target, currentCwd, cwdTrusted) {
  if (target === '-') return { unresolvable: true } // previous dir — not tracked
  if (/[$`]/.test(target)) return { unresolvable: true } // variable / command substitution

  let candidate
  if (target === '~' || target === '') {
    candidate = homedir()
  } else if (target.startsWith('~/')) {
    candidate = join(homedir(), target.slice(2))
  } else if (target.startsWith('/')) {
    candidate = target
  } else {
    if (!cwdTrusted) return { unresolvable: true }
    candidate = join(currentCwd, target)
  }

  try {
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      return { unresolvable: true } // nonexistent / not-a-dir target — don't guess
    }
  } catch {
    return { unresolvable: true }
  }
  return { cwd: candidate }
}

const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn'])

// Sub-commands / flags that are NOT a script-name lookup at all.
const NON_SCRIPT_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un',
  'exec', 'dlx', 'create', 'init', 'link', 'unlink', 'why',
  'outdated', 'update', 'up', 'audit', 'list', 'ls', 'view',
  'publish', 'pack', 'login', 'logout', 'whoami', 'config',
  'set', 'get', 'store', 'prune', 'rebuild', 'patch', 'import',
  'dedupe', 'licenses', 'env', 'doctor', 'root', 'bin',
])

// Flags that appear before the script name and must be skipped when locating it.
const SKIPPABLE_FLAGS_WITH_VALUE = new Set(['--filter', '-C', '--dir'])

function extractScriptInvocation(tokens) {
  const mgr = tokens[0]
  let i = 1
  let workspaceAware = false

  // npm run <script> / yarn run <script>
  if ((mgr === 'npm' || mgr === 'yarn') && tokens[i] === 'run') {
    i++
  }

  // Skip leading flags (pnpm -r test, pnpm --filter x test, pnpm -w test).
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const flag = tokens[i]
    if (flag === '-r' || flag === '--recursive' || flag === '-w' || flag === '--workspace-root') {
      workspaceAware = true
      i++
      continue
    }
    if (SKIPPABLE_FLAGS_WITH_VALUE.has(flag)) {
      workspaceAware = true
      i += 2
      continue
    }
    if (flag.startsWith('--filter=') || flag.startsWith('--dir=')) {
      workspaceAware = true
      i++
      continue
    }
    // Unknown flag (e.g. --silent, --if-present) — skip it, keep looking for the script name.
    i++
  }

  const scriptName = tokens[i]
  if (!scriptName) return null
  if (NON_SCRIPT_SUBCOMMANDS.has(scriptName)) return null
  if (mgr === 'pnpm' && scriptName === 'run') {
    // `pnpm run <script>` — take the next token instead.
    const next = tokens[i + 1]
    if (!next) return null
    return { scriptName: next, workspaceAware }
  }

  return { scriptName, workspaceAware }
}

function checkSegment(segment, cwd) {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return null
  const mgr = tokens[0]
  if (!PACKAGE_MANAGERS.has(mgr)) return null

  const invocation = extractScriptInvocation(tokens)
  if (!invocation) return null
  const { scriptName, workspaceAware } = invocation
  if (workspaceAware) return null // filter/-r/-w resolves elsewhere; not this guard's business

  const nearest = findNearestPackageJson(cwd)
  if (!nearest) return null // no package.json anywhere — fail open

  const scripts = nearest.pkg && typeof nearest.pkg.scripts === 'object' ? nearest.pkg.scripts : {}
  if (Object.prototype.hasOwnProperty.call(scripts, scriptName)) return null // exists — silent

  const ancestorDir = findAncestorDefining(nearest.dir, scriptName)

  return { scriptName, cwdPkgDir: nearest.dir, ancestorDir }
}

function findFinding(cmd, initialCwd) {
  let currentCwd = initialCwd
  let cwdTrusted = true // false once a `cd` in this chain leaves the directory unknown

  for (const segment of splitSegments(stripDataSpans(cmd))) {
    // Subshells / command grouping (`( … )`) are not modeled — stay silent rather than guess.
    if (segment.includes('(') || segment.includes(')')) {
      cwdTrusted = false
      continue
    }

    const cdTarget = matchCdTarget(segment)
    if (cdTarget !== null) {
      const resolved = resolveCd(cdTarget, currentCwd, cwdTrusted)
      if (resolved.unresolvable) {
        cwdTrusted = false
      } else {
        currentCwd = resolved.cwd
        cwdTrusted = true // recovered — this cd resolved with confidence
      }
      continue
    }

    if (!cwdTrusted) continue // effective directory unknown — don't check, don't guess

    const finding = checkSegment(segment, currentCwd)
    if (finding) return finding
  }
  return null
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return

  const initialCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()

  const finding = findFinding(cmd, initialCwd)
  if (!finding) return

  const { scriptName, cwdPkgDir, ancestorDir } = finding
  const hint = ancestorDir
    ? ` It IS defined in the package.json at \`${ancestorDir}\` — run it from there instead.`
    : ' No package.json up the tree defines it either — this may be a genuine typo.'

  recordGuardEvent({
    guard: 'wt-missing-package-script-guard-hook.mjs',
    decision: 'warned',
    class: 'missing-script',
    reason: `${scriptName} @ ${cwdPkgDir}`,
    cwd: cwdPkgDir,
  })

  emitGuardNotice({
    stdoutJson: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          `[workflow-toolbox missing-script guard] WARNING (not blocked): script \`${scriptName}\` ` +
          `is not defined in the package.json governing \`${cwdPkgDir}\`.${hint} A failure here ` +
          'can be mistaken for a real regression right after a merge — verify the CWD before ' +
          'reading this as a broken build.',
      },
    },
  })
}

runFailOpenHook('wt-missing-package-script-guard-hook.mjs', main)
