# TypeScript Pack

This pack provides TypeScript-specific rules, skills, and SDK-only critic and reviewer definitions
for the Workflow Toolbox repository.

## Selection

`wt-lifecycle-hooks` selects the pack when a card Discovery block contains a `Language:` value
matching `typescript`. `wt-rules-on-demand` serves the pack's topic rules on `Edit` and `Write`
tool calls targeting `.ts` or `.tsx` paths. Other language values and an absent `Language:` field
do not select this pack. No build or configuration file, including `tsconfig.json`, selects the
TypeScript pack.

## Limits

- The pack's rules and workflows cover TypeScript and TSX only; its language server also serves JavaScript.
- SDK-only status is a convention plus the absence of these definitions from `plugin/agents/` and
  `plugin/agent-templates/`; the pack does not enforce SDK invocation at runtime.
- Pack selection attaches context notes and topic rules. It does not execute TDD, gates, or a
  reviewer automatically.

## What this pack ships

This pack provides TypeScript-specific rules, skills, and SDK-only critic and reviewer definitions
for the Workflow Toolbox repository. Its `pack.json` declares `.ts` and `.tsx` triggers, two topic
rules, two skills, and two SDK-only agents.

## Language server

The pack carries one `.lsp.json` declaration for `wt-tsls.mjs`; when the Workflow Toolbox plugin is
loaded and a backend is available, TypeScript and JavaScript diagnostics are delivered after edits as
`<new-diagnostics>` blocks. Claude Code loads LSP declarations from a plugin root, not a pack
directory, so `plugin/.lsp.json` deliberately mirrors this pack declaration as the loader bridge.
This makes diagnostics available to sessions that load this plugin; it does not make LSP
configuration conditional on pack selection.

The declaration maps `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.jsx` (with React
language IDs for TSX/JSX). The launcher reads `initialize` and selects a backend in this order:

1. An explicitly configured `tsserver.path`, or a valid `tsserver.js` found from the workspace root
   upwards, uses `typescript-language-server`. That upward search mirrors the server's own
   `rootUri`/`rootPath` search and stops at the first TypeScript lib folder, even if unusable.
2. Otherwise a TypeScript in a sub-folder of the workspace root: the first
   `<folder>/node_modules/typescript` holding `lib/tsserver.js` and a `typescript` package.json.
   The search is breadth-first up to three levels below the root, so the shallowest project wins;
   within one level `.claude` comes first, then the other folders by name. `node_modules`, `.git` and
   symbolic links are not entered, the search stops after 2,000 folders, and a session rooted at the
   home directory skips this step.
3. Otherwise a host TypeScript 7+ native executable: from the `tsc` package on PATH, then from the
   folders where `typescript-language-server` would resolve its own `typescript` (its install, then
   each enclosing `node_modules`), then from the global npm and pnpm roots of the running node.
   A package inside the workspace or the current directory is never executed.
4. Otherwise a host `tsserver.js` is handed to `typescript-language-server`: the one it would
   resolve itself first, then the `tsc` package on PATH, then the global npm and pnpm roots.
5. Otherwise `initialize` receives an error naming every place searched and the install command.
   `typescript-language-server` is not started without a TypeScript, because it would only fail;
   the exception is a client that configured `tsserver.path` itself, which is passed through as is.

For cases 2 and 4 the launcher adds `initializationOptions.tsserver.path` to the `initialize`
request it relays, keeping every other option the client sent, and its stderr line names the
`tsserver.js` used. One server serves the whole workspace, so a workspace whose sub-projects pin
different TypeScript versions is checked with the single version found first.
Resolution reads version metadata without running binaries; the launcher never executes a
workspace-local `tsc`. A `tsserver.js` from the workspace runs workspace code, as it already did for
the root: case 2 extends that to the `node_modules` of sub-folders, dot-folders included.

The language servers are not vendored. Install a backend separately with:

```sh
npm i -g typescript-language-server typescript
```

### Priority and idle lifetime

The executable lowers its own priority before creating any backend: nice 19 on POSIX, mapped by
Node's `PRIORITY_LOW` to the idle priority class on Windows. Ordinary child creation inherits this
priority, including the native backend and Node's tsserver children. Failure to set or read back
the priority is reported on stderr as **unknown**. Low priority is not a CPU-percentage cap: an
otherwise idle machine may still run indexing at full speed. Linux inheritance is tested with real
processes; macOS and Windows still need real-host measurements.

The first backend starts for the `initialize` request, which needs the selected backend's actual
capabilities. The wrapper cannot distinguish an automatic host handshake from a navigation tool
call on that wire. It does not invent a capability response to defer initialization further.

After 60 seconds without a request in flight, the wrapper sends `shutdown`, then `exit`, leaving
the client's connection open. Client or server requests prevent retirement until answered;
diagnostics and file notifications do not extend the deadline. `WT_TSLS_IDLE_MS` can set a whole
number of milliseconds from 1,000 to 3,600,000; invalid values retain 60,000. A five-second shutdown
grace is followed by TERM to the owned backend child and, one second later, KILL if it has not
closed. This timeout path does not signal a host-wide process group; descendant cleanup for an
uncooperative backend remains unverified.

While asleep, file notifications update saved document text without starting a server. Consequently
background diagnostics pause too. The next request starts the same selected backend, reinitializes
it, and replays configuration and current open documents before that request. Incremental edits use
UTF-16 positions; closed documents are omitted. Requests and notifications arriving during restart
keep their order. Accepted dynamic registrations are released when retiring their backend. Internal
initialize/shutdown replies stay off the client's wire. An asleep `shutdown` is answered locally.

### CPU budget (observational)

On POSIX hosts, the Node backend runs in its own process group. Its launcher samples every direct
`tsserver.js` / `_tsserver.js` child every five seconds, independently of the server's event loop.
100% means one CPU core, regardless of the host's core count. More than 100% for 120 consecutive
sampled seconds produces one warning, for an individual server or their combined family. Sampling
continues; this CPU watchdog never sends a signal. Idle retirement is a separate protocol lifecycle,
not a CPU-budget stop. Initial indexing and long requests share the observational budget.

Linux reads cumulative user/system CPU ticks from `/proc`, using `/usr/bin/getconf CLK_TCK` for
their unit. macOS reads cumulative CPU time and process birth/group identity with `/bin/ps` in
the C locale. Windows and other platforms report **unavailable**; the CPU budget is unenforced
there. Unreadable or malformed OS measurements also report unavailable, never zero CPU, and
break the evidence of consecutive over-budget time.

The launcher pins the backend's birth identity before sampling. Diagnostics go to stderr; stdout
remains LSP protocol bytes. The initialize-response observer detaches after the handshake rather
than continuing to parse backend output for a response that has already arrived.

### Navigation

Navigation is not requested by this pack. To opt in, a human may paste: "Use the available LSP
navigation tools to look up this symbol and its references."

Measured on Linux, the no-instruction LSP arm produced one TS6133 `<new-diagnostics>` block in 11
turns at 178,823.5 cache-read tokens per turn. The instructed arm used `workspaceSymbol` and
`findReferences`, caught TS2554, and used 25.0% more turns and 95.8% more bytes read than the
no-plugin arm. A later reading measured 44.4% and 55.6% more turns for its instructed arms. See
`.claude/research/lsp-20260908/.lane/v3/report.md` and `v4/report.md`.

The 2026-09-11 missing-binary headless probe still completed its requested edit and printed only:

```ts
function acceptsOne(value: string): string {
  return value
}

acceptsOne()
```

It emitted no `<new-diagnostics>` block or missing-command warning. The declaration therefore
fails open rather than reporting a legible error in this harness; install the command above before
relying on diagnostics. The available-binary probe loaded the server and registered its diagnostics
handler, but likewise did not publish a diagnostic before the headless session ended; see
`.lane/lsp-missing.json`, `.lane/lsp-available.json`, and their debug logs.

The 2026-09-12 two-arm probe (section Probe below) explains the earlier non-delivery with two
measured causes, both read from Claude Code's own debug log: the temporary project held no
`typescript` module, so `typescript-language-server` refused `initialize` ("Could not find a valid
TypeScript installation") — the global install line above is not enough for a workspace without a
`typescript` dependency, so the probe fixture now symlinks one in; and a delivered diagnostic lands
on a LATER tool result, so a session that edits and stops never receives it — the probe waits and
reads again after the edit. With both fixed, the planted TS2554 error was delivered.

The 2026-09-12 measurements below predate the launcher and its expanded extension mapping.

## Probe

Run:

```sh
node toolkit/scripts/lsp-pack-probe.mjs typescript
```

The archived artifacts are `.claude/reports/1861821660-lsp-probes/typescript/available/` and
`.claude/reports/1861821660-lsp-probes/typescript/missing/`. The available arm passes only when
`command -v` resolves and a diagnostic naming the planted error arrives.

Available arm — PASS (2026-09-12, Linux, `command -v` → `~/.local/bin/typescript-language-server`, typescript-language-server 6.0.0): the harness debug log records `textDocument/publishDiagnostics` received and 4 diagnostic attachments delivered across the later tool results, and the session quoted `Expected 1 arguments, but got 0. [2554]`; 39566 ms wall time for the headless session; artifacts `.claude/reports/1861821660-lsp-probes/typescript/available/` (stdout.log, stderr.log, debug.log, elapsed-ms.txt, command-v.txt, version.txt, workspace-modules.txt).

The missing arm passes only when no diagnostic arrives and the session ends normally.

Missing arm — PASS (same date; `command -v` → not found on the shim PATH, `node` and `claude` still resolving): the harness attempted to start the server and failed (`Failed to start LSP server`: the command is absent), no `publishDiagnostics` was received and 0 attachments were delivered, the session ended normally (exit 0, 40827 ms) with no diagnostic and no missing-command message — the declaration fails open; artifacts `.claude/reports/1861821660-lsp-probes/typescript/missing/`.

## Cross-platform verdict

The Node interpreter must resolve on Claude Code's PATH. The backend must be discoverable on that
PATH: Linux was measured with the native TypeScript 7 executable and typescript-language-server
6.0.0. The Windows npm `.cmd` shim layout is supported without running a shell; unrecognized
wrappers are refused. Sub-folder and host searches build every path with the Windows or POSIX path
rules of the host; on Windows the global npm root is read beside `node.exe` and under `%APPDATA%\npm`.
An unreadable folder counts as empty, so the search degrades to the next case, never to a wrong
path. macOS uses POSIX paths like Linux; macOS and Windows remain unmeasured on real hosts.

## Optional assets

The optional assets listed in `pack.json` are the rules-on-demand topic rules `tdd-vitest.md` and
`lint-typecheck-build.md`, the TDD/lint/build skills `tdd-red-green` and `lint-typecheck-build`,
and the SDK-only agents `critic.md` and `reviewer.md`.

## Adding Another Pack

Follow `docs/public/language-packs.md` for the complete add-a-language recipe.
