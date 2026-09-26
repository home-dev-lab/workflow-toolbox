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
//   node wt-run-gate.mjs --record typecheck -- pnpm typecheck
//   node wt-run-gate.mjs --check <tree-dir> [--gate test,typecheck,lint]
//
// Exit code of THIS process = the gate's own exit code, unless the fail-pattern mismatch check
// trips (forced to 1 in that case). Either way, `<out-dir>/<name>.exit` holds the ground truth —
// a caller (a pilot brief, a CI step, a report script) reads THAT file, never this process's own
// stdout, to decide pass/fail; stdout is for a human.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { diffTreeEntryDigests, readGateRecord, recordPath, repoRoot, treeEntryDigests, treeSignature, writeGateRecord } from './lib/gate-evidence.mjs'

const HELP = `wt-run-gate — run ONE gate command and make its exit code non-bypassable: writes
the gate's real exit code to <out-dir>/<name>.exit and its combined output to <name>.log, with
no shell construct between the child finishing and that write.

Usage:
  node wt-run-gate.mjs --name typecheck --out-dir .claude/gate-logs \\
    [--fail-pattern 'error TS\\d'] -- pnpm typecheck
  node wt-run-gate.mjs --record typecheck -- pnpm typecheck
  node wt-run-gate.mjs --check <tree-dir> [--gate test,typecheck,lint]

Exit code of this process = the gate's own exit code (forced to 1 if --fail-pattern matches the
log despite exit 0). --record additionally writes the named gate's exit, finish time, and exact
tree signature to the guard-journal state directory. --check reads records for a tree without
running a command and exits 0 only when every requested gate is green for its current signature.
`

// A gate's exit code answers for the COMMAND, never for the SUBJECT: it can be genuinely green
// about a tree nobody intended to certify. Measured 2026-09-15: four merged deliveries were gated
// from the repository's own root, which held `main` while the work sat on `develop` in a worktree.
// Every number was true and none of it was about the change. So the identity of the tree is
// printed on the SAME line as the exit code — the whole failure is that the two facts otherwise
// get read at different moments, and only one of them gets read at all.
//
// Degrades LEGIBLY in every direction rather than going quiet: a missing or failing git prints
// `tree=unknown`, a directory outside a repository prints `tree=not-a-repo`. An omitted field
// would read as "the same as expected", which is the one thing it must never mean.
function treeIdentity(cwd) {
  const git = (...gitArgs) => {
    const out = spawnSync('git', ['-C', cwd, ...gitArgs], { shell: false, encoding: 'utf8' })
    if (out.error || out.status !== 0) return null
    return (out.stdout ?? '').trim()
  }
  // Same discrimination the skill fence makes between a lookup MECHANISM failure and a genuine
  // absence, and it is not cosmetic: outside a repository `--is-inside-work-tree` exits NON-ZERO,
  // so a status-only reading reports `unknown` for a directory that is simply not a repo. The
  // deciding signal is whether git could be LAUNCHED at all.
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { shell: false, encoding: 'utf8' })
  if (probe.error) return 'tree=unknown'
  if (probe.status !== 0 || (probe.stdout ?? '').trim() !== 'true') return 'tree=not-a-repo'
  const head = git('rev-parse', '--short', 'HEAD')
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD') || 'detached'
  if (head === null) return 'tree=unknown'
  // A record is keyed by a tree SIGNATURE, so a dirty tree's record is not reproducible from the
  // commit alone. Say so where the exit code is read, not only in the record.
  const status = git('status', '--porcelain', '--untracked-files=no')
  const dirty = status === null ? ' dirty=unknown' : status === '' ? '' : ' dirty'
  return `tree=${branch}@${head}${dirty}`
}

function recordedHead(root) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- gate identity comes from this repository's git executable.
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { shell: false, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : (result.stdout ?? '').trim() || null
}

function recordedTreeIsDirty(root) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- gate identity comes from this repository's git executable.
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain'], { shell: false, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : (result.stdout ?? '').trim() !== ''
}

function fail(msg) {
  process.stderr.write(`wt-run-gate: ${msg}\n`)
  process.exit(2)
}

// Names WHAT changed, for the stderr line a `--record` gate prints when the tree it certified
// moved out from under it. Bounded to 5 paths (`, and N more` beyond that) — enough to point a
// reader at the cause without dumping an entire diff.
//
// This is DESCRIPTION ONLY — the caller decides whether the tree changed from treeSignature()
// and HEAD, never from `changedPaths`. A per-entry diff is built by a second routine
// (treeEntryDigests/diffTreeEntryDigests) that could in principle miss something the audited
// signature caught (a future drift between the two, or a timing gap between the two separate
// walks); if that ever happens, the honest answer is to SAY SO rather than claim a path that
// was never actually found.
function describeTreeChange(startedHead, currentHead, changedPaths) {
  const headPart = startedHead !== currentHead
    ? `HEAD moved ${startedHead ?? 'unknown'} -> ${currentHead ?? 'unknown'}`
    : 'HEAD unchanged'
  const shown = changedPaths.slice(0, 5)
  const more = changedPaths.length > 5 ? `, and ${changedPaths.length - 5} more` : ''
  const pathsPart = changedPaths.length > 0 ? `changed: ${shown.join(', ')}${more}` : 'changed: (not attributable to a file)'
  return `${headPart}; ${pathsPart}`
}

function parseArgs(argv) {
  // --help must be recognised only BEFORE a literal '--' — anything after that marker is the
  // gate command itself (e.g. `-- some-tool --help` must run some-tool, not print this usage).
  const dashDashIndex = argv.indexOf('--')
  const ownArgs = dashDashIndex === -1 ? argv : argv.slice(0, dashDashIndex)
  handleHelpFlag(ownArgs, HELP)
  const args = { name: null, record: null, check: null, gates: null, outDir: '.', outDirExplicit: false, failPattern: null, cmd: [] }
  let i = 0
  for (; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i]
    else if (argv[i] === '--record') args.record = argv[++i]
    else if (argv[i] === '--check') args.check = argv[++i]
    else if (argv[i] === '--gate') args.gates = argv[++i]
    else if (argv[i] === '--out-dir') { args.outDir = argv[++i]; args.outDirExplicit = true }
    else if (argv[i] === '--fail-pattern') args.failPattern = argv[++i]
    else if (argv[i] === '--') { args.cmd = argv.slice(i + 1); break }
    else fail(`unknown flag '${argv[i]}' (did you forget '--' before the command?)`)
  }
  if (args.check) {
    if (args.name || args.record || args.outDirExplicit || args.failPattern || args.cmd.length > 0) {
      fail('--check <tree-dir> cannot be combined with gate-run options')
    }
    const gates = (args.gates ?? 'test,typecheck,lint').split(',')
    if (gates.length === 0 || gates.some((gate) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(gate))) {
      fail('--gate must be a comma-separated list of plain gate names')
    }
    args.gates = gates
    return args
  }
  if (args.gates) fail('--gate is only valid with --check <tree-dir>')
  if (!args.name && !args.record) fail('--name <label> or --record <gate> is required')
  if (!args.name) args.name = args.record
  // `--name` becomes a bare path.join() segment for the .exit/.log files below — an
  // unsanitized `../other-gate` would let one gate's report overwrite an unrelated file
  // outside --out-dir (cross-family review finding on this card). Refuse anything that
  // isn't a plain filename-safe token; this also keeps concurrent gates from colliding on
  // the same pair of files, since each caller is forced to pick a name distinct from any
  // path segment already in play.
  if (args.name && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.name)) {
    fail(`--name '${args.name}' must be a plain filename-safe token (letters, digits, '.', '_', '-' — no '/' or '..')`)
  }
  if (args.record && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.record)) fail(`--record '${args.record}' must be a plain filename-safe token`)
  if (args.cmd.length === 0) fail("no command given — pass it after '--', e.g. -- pnpm typecheck")
  return args
}

function checkGateRecords(treeDir, gates) {
  let root
  let signature
  try {
    root = repoRoot(treeDir)
    signature = treeSignature(root)
  } catch (err) {
    fail(`cannot inspect tree '${treeDir}' - ${err.message}`)
  }

  let allGreen = true
  for (const name of gates) {
    const file = recordPath(root, name)
    let record
    try {
      fs.accessSync(file, fs.constants.R_OK)
    } catch (err) {
      if (err.code === 'ENOENT') {
        process.stdout.write(`${name}: missing\n`)
        allGreen = false
        continue
      }
      fail(`cannot read record directory '${path.dirname(file)}' - ${err.message}`)
    }
    record = readGateRecord(root, name)

    if (!record || record.version !== 2 || record.tree !== signature) {
      process.stdout.write(`${name}: missing\n`)
      allGreen = false
    } else if (record.exit === 0) {
      process.stdout.write(`${name}: green ${record.tree} ${record.finishedAt}\n`)
    } else {
      process.stdout.write(`${name}: red ${record.tree} ${record.finishedAt} exit=${record.exit}\n`)
      allGreen = false
    }
  }
  process.exit(allGreen ? 0 : 1)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.check) checkGateRecords(args.check, args.gates)
  // Record-mode artifacts must not become untracked files in the checked tree: a later gate
  // would otherwise make an earlier record stale merely by writing its own log.
  const root = args.record ? repoRoot(process.cwd()) : null
  // startedTree is the DECISION source, exactly as before this file grew a per-entry diff:
  // both changedDuringGate and recordTargetChanged below decide on treeSignature()/HEAD alone.
  // startedEntries exists only to DESCRIBE what changed in the stderr line — a per-entry diff
  // built by a newer, separate routine must never be trusted to decide, only to narrate.
  const startedTree = args.record ? treeSignature(root) : null
  const startedEntries = args.record ? treeEntryDigests(root) : null
  const startedHead = args.record ? recordedHead(root) : null
  const outDir = args.record && !args.outDirExplicit
    ? path.join(path.dirname(recordPath(root, args.record)), 'logs')
    : args.outDir
  fs.mkdirSync(outDir, { recursive: true })
  const exitFile = path.join(outDir, `${args.name}.exit`)
  const logFile = path.join(outDir, `${args.name}.log`)

  const identity = treeIdentity(process.cwd())

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

  let changedDuringGate = false
  if (args.record) {
    // Compute after the child exits: an edit during a gate must invalidate its evidence.
    // The DECISION is treeSignature()/HEAD, exactly as before; treeEntryDigests() is called only
    // to name what changed if the decision says it did.
    const finishedTree = treeSignature(root)
    const finishedHead = recordedHead(root)
    changedDuringGate = startedTree !== finishedTree || startedHead !== finishedHead
    const recordFile = writeGateRecord(root, {
      version: 2,
      name: args.record,
      command: args.cmd.join(' '),
      exit: changedDuringGate ? 1 : realExitCode ?? 1,
      finishedAt: new Date().toISOString(),
      tree: finishedTree,
      head: finishedHead,
      dirty: recordedTreeIsDirty(root),
    })
    if (changedDuringGate) {
      const changedPaths = diffTreeEntryDigests(startedEntries, treeEntryDigests(root))
      process.stderr.write(
        `wt-run-gate: ${args.record}: tree changed during gate; record refused — ` +
          `${describeTreeChange(startedHead, finishedHead, changedPaths)}\n`,
      )
    }
    process.stdout.write(`GATE ${args.record}: record=${recordFile}\n`)
  }

  if (res.signal) {
    process.stderr.write(`wt-run-gate: ${args.name}: killed by signal ${res.signal} — no exit code was ever returned (${identity} dir=${process.cwd()})\n`)
    process.exit(1)
  }

  if (res.error) {
    process.stderr.write(`wt-run-gate: ${args.name}: failed to launch — ${res.error.message} (${identity} dir=${process.cwd()})\n`)
    process.exit(2)
  }

  process.stdout.write(`GATE ${args.name}: exit=${realExitCode} ${identity} dir=${process.cwd()} log=${logFile} exit-file=${exitFile}\n`)

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

  // Recomputed here, separately from the check above: something can still write into the
  // certified tree between that check and this one (measured 2026-09-26 — a certification whose
  // own report files landed in the tree after the record was already written), and that window
  // must not silently exit 1 with no explanation of what was written or why the record on disk no
  // longer matches.
  let recordTargetChanged = false
  if (args.record) {
    // The DECISION is treeSignature()/HEAD, same as the check above. treeEntryDigests() is
    // called only when the decision says something changed, to name what.
    const finalTree = treeSignature(root)
    const finalHead = recordedHead(root)
    recordTargetChanged = startedTree !== finalTree || startedHead !== finalHead
    if (recordTargetChanged && !changedDuringGate) {
      const changedPaths = diffTreeEntryDigests(startedEntries, treeEntryDigests(root))
      process.stderr.write(
        `wt-run-gate: ${args.record}: tree changed after the gate's own record was written; ` +
          `no updated record was written, so the record on disk is now stale — record refused — ` +
          `${describeTreeChange(startedHead, finalHead, changedPaths)}\n`,
      )
    }
  }
  process.exit(forceFail || recordTargetChanged ? 1 : (realExitCode ?? 1))
}

main()
