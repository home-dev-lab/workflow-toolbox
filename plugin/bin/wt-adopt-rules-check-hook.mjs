#!/usr/bin/env node
// DEPRECATED ENTRY POINT — kept so that sessions which are ALREADY RUNNING do not lose this
// hook when the file is renamed underneath them. Delete no earlier than one minor release
// after the rename landed (renamed in 0.103.x by `feat(plugin)!: rename adopt-rules to adopt`).
//
// WHY THIS FILE EXISTS AT ALL, given the rename commit deliberately removed the old name.
//
// A session's hook registration is a SNAPSHOT taken at session start. Rename a hook entry
// point and every session already running keeps spawning the old path — which no longer
// exists, so node dies in the module loader before a single line of hook code runs. The hook
// is not merely broken there: it never loads, so it cannot even emit the plugin's own
// `FAILED OPEN` trace. From the operator's seat the only symptom is a console line per tool
// call with no hook name in it.
//
// Measured 2026-08-04: **725** such failures in one long-running session, and the cause took
// roughly an hour to attribute — every reproduction attempt invoked the file that EXISTS,
// while the failing invocation named the one that does not.
//
// ⚠ HONEST SCOPE — do not over-credit this shim:
//   - It only helps a rename that SHIPS one. It does nothing for a hook deleted outright,
//     and nothing for the general class "a running session's snapshot no longer matches the
//     tree". That class is not closed by this file.
//   - It buys back exactly one thing here: the adoption-staleness notice. The sibling Bash
//     hooks were never renamed and were never affected.
//
// The delegation is a side-effecting import rather than a spawn: same process, same stdin,
// same exit code, nothing to keep in sync. A spawn would need the payload piped through and
// would double the process cost on every tool call.
//
// It is wrapped in runFailOpenHookAsync under THIS file's own name, not left bare. The
// crash-safety lock forces a self-test through every hook that mentions the fail-open
// contract, and a bare import would satisfy it only through the DELEGATE's wrapper — which
// traces the delegate's name, so a failure in the shim would be reported as a failure
// somewhere else. Tracing under the name that was actually invoked is the whole point of the
// trace.

import { runFailOpenHookAsync } from './lib/fail-open-trace.mjs'

const SELF = 'wt-adopt-rules-check-hook.mjs'

process.stderr.write(
  `${SELF}: DEPRECATED name, delegating to wt-adopt-check-hook.mjs — ` +
    'start a new session to pick up the current registration (this shim is removed one release after the rename)\n',
)

await runFailOpenHookAsync(SELF, async () => {
  await import('./wt-adopt-check-hook.mjs')
})
