#!/usr/bin/env node
// wt-run-gate.mjs — run ONE gate command and make its exit code NON-BYPASSABLE.
//
// Measured: a task notification reported `exit 0` for a gate batch while
// `pnpm typecheck` had actually failed with `exit 2`. The number that reached the report was
// not the gate's own — it was the exit code of a wrapper's trailing `echo`, because the wrapper
// chained several commands and only the LAST one's code survives to be read. Redirecting a gate
// to a file and reading `$?` right after (the standard "verify by ground truth" recipe) is
// necessary but NOT sufficient: it still assumes nothing else runs between the gate and the
// read, and a hand-typed shell one-liner has no way to enforce that assumption.
//
// This script IS that enforcement, mechanically:
//   1. It runs exactly ONE command, with no shell (`spawnSync(cmd, args, { shell: false })`) —
//      there is no `&&`, `;`, or pipe for a later command to hide behind, and zsh's empty
//      `PIPESTATUS` expansion never enters the picture because nothing is piped.
//   2. The VERY NEXT statement after the child process returns writes its real exit code to a
//      file named for THIS gate alone (`<name>.exit`) — no other command, no `echo`, no shell
//      construct sits between the gate finishing and that write.
//   3. It also writes the gate's combined stdout+stderr to `<name>.log`, and — when
//      `--fail-pattern <regex>` is given — scans that log for the pattern. A MISMATCH (exit 0
//      but the pattern is present) is reported loudly and forces this script's own exit code to
//      be non-zero even though the gate reported success: two signals that fail differently
//      (the exit code and the log content) must agree before a caller may call it green.
//
// Usage:
//   node wt-run-gate.mjs --name typecheck --out-dir .claude/gate-logs \
//     [--fail-pattern 'error TS\d'] -- pnpm typecheck
//
// Exit code of THIS process = the gate's own exit code, unless the fail-pattern mismatch check
// trips (forced to 1 in that case). Either way, `<out-dir>/<name>.exit` holds the ground truth —
// a caller (a pilot brief, a CI step, a report script) reads THAT file, never this process's own
// stdout, to decide pass/fail; stdout is for a human.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-run-gate — run ONE gate command and make its exit code non-bypassable: writes
the gate's real exit code to <out-dir>/<name>.exit and its combined output to <name>.log, with
no shell construct between the child finishing and that write.

Usage:
  node wt-run-gate.mjs --name typecheck --out-dir .claude/gate-logs \\
    [--fail-pattern 'error TS\\d'] -- pnpm typecheck

Exit code of this process = the gate's own exit code (forced to 1 if --fail-pattern matches the
log despite exit 0). <out-dir>/<name>.exit holds the ground truth for a caller to read.
`

function fail(msg) {
  process.stderr.write(`wt-run-gate: ${msg}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  // --help must be recognised only BEFORE a literal '--' — anything after that marker is the
  // gate command itself (e.g. `-- some-tool --help` must run some-tool, not print this usage).
  const dashDashIndex = argv.indexOf('--')
  const ownArgs = dashDashIndex === -1 ? argv : argv.slice(0, dashDashIndex)
  handleHelpFlag(ownArgs, HELP)
  const args = { name: null, outDir: '.', failPattern: null, cmd: [] }
  let i = 0
  for (; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i]
    else if (argv[i] === '--out-dir') args.outDir = argv[++i]
    else if (argv[i] === '--fail-pattern') args.failPattern = argv[++i]
    else if (argv[i] === '--') { args.cmd = argv.slice(i + 1); break }
    else fail(`unknown flag '${argv[i]}' (did you forget '--' before the command?)`)
  }
  if (!args.name) fail('--name <label> is required (names the .exit/.log files for this gate)')
  // `--name` becomes a bare path.join() segment for the .exit/.log files below — an
  // unsanitized `../other-gate` would let one gate's report overwrite an unrelated file
  // outside --out-dir (cross-family review finding on this card). Refuse anything that
  // isn't a plain filename-safe token; this also keeps concurrent gates from colliding on
  // the same pair of files, since each caller is forced to pick a name distinct from any
  // path segment already in play.
  if (args.name && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.name)) {
    fail(`--name '${args.name}' must be a plain filename-safe token (letters, digits, '.', '_', '-' — no '/' or '..')`)
  }
  if (args.cmd.length === 0) fail("no command given — pass it after '--', e.g. -- pnpm typecheck")
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.outDir, { recursive: true })
  const exitFile = path.join(args.outDir, `${args.name}.exit`)
  const logFile = path.join(args.outDir, `${args.name}.log`)

  const [cmd, ...cmdArgs] = args.cmd
  const res = spawnSync(cmd, cmdArgs, { shell: false, encoding: 'utf8' })
  // The line that matters: NOTHING runs between the gate returning and its code being written.
  // Three distinct outcomes, recorded as three distinct markers rather than coerced into one
  // number (cross-family review finding: a signal-killed process has `status === null` AND
  // `signal !== null` — writing bare `null` would silently look like "could not determine",
  // indistinguishable from other failure shapes, when the real fact is "killed by SIGTERM"):
  //   - res.error   → the command could not even be launched (e.g. ENOENT)
  //   - res.signal  → the process was killed by a signal, never returned its own exit code
  //   - otherwise   → res.status is the gate's real exit code
  const realExitCode = res.error || res.signal ? null : res.status
  const exitFileText = res.error
    ? `ERROR ${res.error.message}\n`
    : res.signal
      ? `SIGNAL ${res.signal}\n`
      : `${realExitCode}\n`
  fs.writeFileSync(exitFile, exitFileText)

  // stdout and stderr are captured and concatenated separately (spawnSync gives no single
  // interleaved stream without a pty/shell) — a --fail-pattern that spans the boundary
  // between them, or relies on interleaving order, is a documented limitation, not a bug:
  // most gate tools (test/typecheck/lint runners) emit their diagnostic text on ONE of the
  // two streams, which this still catches correctly.
  const combined = (res.stdout ?? '') + (res.stderr ?? '')
  fs.writeFileSync(logFile, combined)

  if (res.signal) {
    process.stderr.write(`wt-run-gate: ${args.name}: killed by signal ${res.signal} — no exit code was ever returned\n`)
    process.exit(1)
  }

  if (res.error) {
    process.stderr.write(`wt-run-gate: ${args.name}: failed to launch — ${res.error.message}\n`)
    process.exit(2)
  }

  process.stdout.write(`GATE ${args.name}: exit=${realExitCode} log=${logFile} exit-file=${exitFile}\n`)

  let forceFail = false
  if (args.failPattern) {
    let re
    try {
      re = new RegExp(args.failPattern, 'm')
    } catch (err) {
      // A bad regex is a CALLER error, not a gate result — the .exit/.log files above are
      // already correct ground truth for the gate itself; don't let this crash obscure that
      // or masquerade as the gate's own failure.
      process.stderr.write(`wt-run-gate: ${args.name}: --fail-pattern is not a valid regex — ${err.message}\n`)
      process.exit(2)
    }
    const patternFound = re.test(combined)
    process.stdout.write(`GATE ${args.name}: pattern=${patternFound ? 'FOUND' : 'absent'} (/${args.failPattern}/)\n`)
    if (realExitCode === 0 && patternFound) {
      forceFail = true
      process.stderr.write(
        `wt-run-gate: ${args.name}: INCONSISTENT — exit code says 0 but the failure pattern was found in the log.\n` +
          `  Two signals disagree: trust neither blindly. Read ${logFile} before treating this gate as green.\n`,
      )
    }
  }

  process.exit(forceFail ? 1 : (realExitCode ?? 1))
}

main()
