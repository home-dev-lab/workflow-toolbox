#!/usr/bin/env node
import { runSuiteLockCliEntrypoint } from './wt-suite-lock.mjs'

// This runner always runs its argv verbatim under the lock: WT_SUITE_LOCK_CMD names this file, a
// lane invokes it as `"$WT_SUITE_LOCK_CMD" <command> [args...]`, no reserved words. An adopted
// `wt-lane.mjs` predating this runner (e.g. the copy under a config dir's scripts/, refreshed by
// `adopt`) can still build the OLDER template itself: `node <suiteLockCli> run --`. Stripping one
// leading `run --` (or a bare `--`) here keeps that older launcher working without doubling the
// prefix into `run -- run -- <command>`, which would make this runner's own `run` subcommand try
// to spawn a program literally named `run`.
let argv = process.argv.slice(2)
if (argv[0] === 'run' && argv[1] === '--') argv = argv.slice(2)
else if (argv[0] === '--') argv = argv.slice(1)

process.exitCode = await runSuiteLockCliEntrypoint(['run', '--', ...argv])
