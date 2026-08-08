#!/usr/bin/env node
// wt-lane-probe.mjs — prove an executor LANE is routing to a worktree WHILE IT RUNS, not by
// asking the party being checked at report time.
//
// Origin (see the card that requested this script): a wave mandate said "every increment goes
// to the GPT lane"; both pilots coded in place and only used the lane for review, discovered
// only in the FINAL REPORT — a self-report is the testimony of the party under check. The next
// wave's orchestrator did better by hand: `readlink /proc/<pid>/cwd` on every live lane process,
// matched against each pilot's worktree. This script makes that repeatable and archivable.
//
// What it does: lists live processes whose command line matches --pattern (a lane CLI's name,
// e.g. "opencode"), resolves each one's cwd, and reports — per worktree named on the command
// line — whether a matching process is CURRENTLY working inside it. A worktree with no match
// gets an explicit "idle" verdict, never silence: a probe that only speaks when it finds
// something is indistinguishable from a probe that never ran (see the mechanical-ground-truth
// note above the DoD in this repo's working-methodology rule — a check must be legible in BOTH
// outcomes). A matching process whose cwd is NOT under any named worktree is reported under
// `unattributed`, with cwd + a truncated command line + ppid captured AT THIS INSTANT — a bare
// pid is a reference to something that may not exist by the time anyone reads the report.
//
// Platform: cwd-per-pid is resolved via /proc (Linux) or `lsof` (macOS); Windows has no
// equivalent primitive this script can drive without extra tooling, so it reports
// `cwdSupported: false` explicitly rather than a plausible-looking empty result — see the
// project rule on never returning a silent zero for "cannot measure".
//
// ⚠ Never print a full, unfiltered process command line on this machine: session wrappers put
// hundreds of `export FOO=...` on argv, some of them real secrets. This script only ever reads
// a SINGLE already-identified pid's args (`ps -o args= -p <pid>`) and truncates to 120 chars —
// it never dumps a `pgrep -af`/`ps -ef`-style listing.
//
// Usage:
//   node wt-lane-probe.mjs --worktree /abs/path/one --worktree /abs/path/two \
//     [--pattern opencode] [--archive .claude/lane-probe/wave-20260803.jsonl]
//
// Exit codes: 0 = the probe ran (regardless of what it found — findings are not a gate);
// 2 = usage error (no --worktree given, or the archive directory could not be created).
// Read the JSON on stdout (one line) for the actual verdict; never infer from the exit code.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-lane-probe — prove an executor LANE is routing to a worktree WHILE IT RUNS, not
by asking at report time. Lists live processes matching --pattern, resolves each one's cwd, and
reports per named worktree whether a matching process is CURRENTLY working inside it.

Usage:
  node wt-lane-probe.mjs --worktree /abs/path/one [--worktree /abs/path/two ...]
    [--pattern opencode] [--archive .claude/lane-probe/wave-20260803.jsonl]
    --worktree <path>  a worktree to check (repeatable, at least one required)
    --pattern <name>   lane CLI process-name pattern (default: opencode)
    --archive <path>   also append the JSON result line to this file

Exit codes: 0 the probe ran (findings are not a gate) · 2 usage error. Read the JSON on stdout.
`

function fail(msg) {
  process.stderr.write(`wt-lane-probe: ${msg}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
  const args = { worktrees: [], pattern: 'opencode', archive: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--worktree') args.worktrees.push(argv[++i])
    else if (arg === '--pattern') args.pattern = argv[++i]
    else if (arg === '--archive') args.archive = argv[++i]
    else fail(`unknown flag '${arg}'`)
  }
  if (args.worktrees.length === 0) fail('at least one --worktree <abs-path> is required')
  if (!args.pattern) fail('--pattern must not be empty')
  return args
}

// Resolve to a real, absolute path when the target exists; fall back to a plain resolve()
// otherwise (a worktree that no longer exists still deserves an "idle" verdict, not a crash).
function safeRealpath(p) {
  const resolved = path.resolve(p)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

// Read the WHOLE process table's pid->ppid mapping in ONE subprocess call, instead of one
// `ps -p <pid>` fork per level of the ancestor chain. Measured on this machine (2026-08-03):
// the real ancestor chain from a probe process to pid 1 is 9 levels deep (Bash-tool wrapper →
// zsh → tmux/session layers → init) — the original per-level design forked `ps` up to 9 times
// PER PROBE INVOCATION just to build the exclusion set, on top of the one `pgrep` fork. Across
// a test suite issuing several probe invocations in a tight window, that is enough real OS
// process churn to perturb unrelated, timing-sensitive sibling tests running concurrently in
// other vitest workers (observed directly: two different siblings failed on two different
// runs, both timing/spawn-shape assertions, while `main` stayed clean under the same load —
// a process-churn/scheduling-jitter signature, not a logic bug in either side). One `ps -eo`
// call plus an in-memory walk produces the identical exclusion set with 1 fork instead of up
// to maxDepth.
function readPidToPpidMap(maxEntries = 20000) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    const map = new Map()
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [pidStr, ppidStr] = trimmed.split(/\s+/)
      const pid = Number(pidStr)
      const ppid = Number(ppidStr)
      if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid)
      if (map.size >= maxEntries) break // pathological table size guard, not expected in practice
    }
    return map
  } catch {
    return null // caller treats a failed table read as "no ancestor info available", never a crash
  }
}

// Walk the ppid chain up from `startPid` using an already-read pid->ppid map (see
// readPidToPpidMap above), returning every ancestor pid found (bounded depth). Why this exists,
// concretely: when this script is invoked as a one-line shell command (e.g. `zsh -c 'node
// wt-lane-probe.mjs --pattern X ...'`, the exact shape a caller's own Bash tool uses), the
// WRAPPING SHELL's own argv is that literal command text — which contains the pattern too.
// `pgrep -f` matches command lines, so that ancestor shell matches its own probe's pattern and
// would otherwise show up as a false `unattributed` anomaly on every single run. Excluding only
// `process.pid` (the node process itself) misses this — the match is one level up the process
// tree, not on the process itself. Reproduced directly on 2026-08-03: a one-line invocation
// self-matched via its wrapper shell; the identical command run from a multi-line script
// (invoked by file path, whose argv does not contain the pattern text) did not. Bounded depth
// guards against a pathological ppid cycle or a table read that returned an incomplete map.
function getAncestorPids(startPid, ppidMap, maxDepth = 32) {
  const ancestors = new Set()
  if (!ppidMap) return ancestors // table read failed — no ancestor info, exclude nothing extra
  let pid = startPid
  for (let i = 0; i < maxDepth; i += 1) {
    const ppid = ppidMap.get(pid)
    if (!Number.isInteger(ppid) || ppid <= 1 || ancestors.has(ppid)) break
    ancestors.add(ppid)
    pid = ppid
  }
  return ancestors
}

// pgrep -f <pattern> for PIDs ONLY (never -a/-l — see the header note on secrets in argv).
// Exit code 1 means "no process matched", which is a legitimate empty result, not a probe
// failure; anything else (missing binary, unexpected error) means this platform/environment
// cannot answer the question, and that must be reported as such, not as an empty match list.
function listMatchingPids(pattern) {
  if (process.platform === 'win32') {
    return { supported: false, pids: [], reason: 'no pgrep equivalent driven by this script on win32' }
  }
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    const rawPids = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
    // Exclude THIS process's own pid AND every ancestor of it (see getAncestorPids above):
    // `pgrep -f <pattern>` matches against the full command line, and both this process's own
    // argv and — when invoked as a one-line shell command — its wrapping shell's argv carry the
    // pattern too. Without excluding the whole chain, every probe would find (and misreport)
    // itself or its own invoking shell as an unrelated anomaly. The pid->ppid table is read
    // ONLY when there is at least one candidate to filter — an empty pgrep result needs no
    // ancestor info at all, saving that fork on the common "idle" case.
    const selfAndAncestors =
      rawPids.length === 0
        ? new Set([process.pid])
        : new Set([process.pid, ...getAncestorPids(process.pid, readPidToPpidMap())])
    const pids = rawPids.filter((n) => !selfAndAncestors.has(n))
    return { supported: true, pids }
  } catch (error) {
    if (error && error.status === 1) return { supported: true, pids: [] }
    return { supported: false, pids: [], reason: error instanceof Error ? error.message : String(error) }
  }
}

// cwd of a single already-identified pid. Returns { ok:true, cwd } | { ok:false, reason }.
// Linux: readlink /proc/<pid>/cwd — exactly the command the card's own evidence used.
// macOS: `lsof -a -p <pid> -d cwd -Fn` (its 'n'-prefixed line is the path).
// Anything else (win32, or a platform lsof/proc can't answer on): caller checks cwdSupported
// first and never reaches here for those pids.
function getCwd(pid) {
  try {
    if (process.platform === 'linux') {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
      return { ok: true, cwd }
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      const nLine = out.split('\n').find((line) => line.startsWith('n'))
      if (!nLine) return { ok: false, reason: 'lsof returned no cwd line (process may have exited)' }
      return { ok: true, cwd: nLine.slice(1) }
    }
    return { ok: false, reason: `unsupported platform: ${process.platform}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ppid and a TRUNCATED command line for one already-identified pid — never a raw listing.
function getPpidAndArgs(pid) {
  const readField = (flag) => {
    try {
      return execFileSync('ps', ['-o', flag, '-p', String(pid)], { encoding: 'utf8' }).trim().split('\n').pop()?.trim() ?? null
    } catch {
      return null
    }
  }
  const ppidRaw = readField('ppid=')
  const args = readField('args=')
  return {
    ppid: ppidRaw ? Number(ppidRaw) : null,
    argsTruncated: args ? args.slice(0, 120) : null,
  }
}

function main() {
  const { worktrees: rawWorktrees, pattern, archive } = parseArgs(process.argv.slice(2))
  const worktrees = rawWorktrees.map((w) => ({ input: w, real: safeRealpath(w) }))

  const { supported: pidsSupported, pids, reason: pidsReason } = listMatchingPids(pattern)

  const cwdSupported = process.platform === 'linux' || process.platform === 'darwin'

  const result = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    pattern,
    cwdSupported,
    pidsSupported,
    worktrees: [],
    unattributed: [],
  }

  if (!pidsSupported) {
    result.reason = pidsReason ?? 'process listing unavailable on this platform'
    for (const w of worktrees) {
      result.worktrees.push({ worktree: w.input, status: 'unknown-platform-unsupported', matchedPids: [] })
    }
    emit(result, archive)
    return
  }

  if (!cwdSupported) {
    result.reason = `cwd resolution not implemented for platform '${process.platform}'`
    for (const w of worktrees) {
      result.worktrees.push({ worktree: w.input, status: 'unknown-platform-unsupported', matchedPids: [] })
    }
    // Still worth recording which pids matched the pattern even without cwd — but never as
    // "unattributed", which on every other platform means "resolved, but doesn't match a
    // named worktree". Here nothing was resolved at all.
    result.unresolvedPids = pids
    emit(result, archive)
    return
  }

  const byWorktree = new Map(worktrees.map((w) => [w.real, { worktree: w.input, status: 'idle', matchedPids: [] }]))

  for (const pid of pids) {
    const cwdResult = getCwd(pid)
    if (!cwdResult.ok) continue // process likely exited between pgrep and the read — not an anomaly worth reporting
    const realCwd = (() => {
      try {
        return fs.realpathSync(cwdResult.cwd)
      } catch {
        return cwdResult.cwd
      }
    })()

    const owner = worktrees.find((w) => realCwd === w.real || realCwd.startsWith(w.real + path.sep))
    if (owner) {
      const entry = byWorktree.get(owner.real)
      entry.status = 'active'
      entry.matchedPids.push(pid)
    } else {
      const { ppid, argsTruncated } = getPpidAndArgs(pid)
      result.unattributed.push({ pid, cwd: realCwd, ppid, argsTruncated })
    }
  }

  result.worktrees = [...byWorktree.values()]
  emit(result, archive)
}

function emit(result, archivePath) {
  const line = JSON.stringify(result)
  process.stdout.write(`${line}\n`)
  if (archivePath) {
    try {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true })
      fs.appendFileSync(archivePath, `${line}\n`)
    } catch (error) {
      // Archiving failure must not be mistaken for probe failure or silently swallowed —
      // both are reported, on stderr, without changing the exit code (the probe itself
      // succeeded; only the durability of its record did not).
      process.stderr.write(
        `wt-lane-probe: WARNING — probe ran but could not archive to ${archivePath}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
  process.exit(0)
}

main()
