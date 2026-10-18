# Monitor Roles

Claude Code 2.1.266 was measured to accept exactly two monitor `when:` shapes:
`always` and `on-skill-invoke:<skill-name>`. The manifest has no environment-variable
condition, so it cannot express the relay role. It remains `always`: using
`on-skill-invoke:` would silently disarm a principal session that delegates without
invoking that skill, which is fail-unsafe.

A launcher that creates a relay session sets `WT_SESSION_ROLE=relay`. The value is
trimmed and case-insensitive. Any other value, including an unset marker, is the
fail-safe principal role, so principal watchers retain their existing behavior.
Each watcher exits immediately after help handling and prints this exact line:

```
<WATCHER NAME> NOT ARMED: relay session (WT_SESSION_ROLE=relay) — this session only relays; it cannot act on this watcher's events
```

Reading an environment variable is portable across the supported platforms.

## Delegated completion relay

`delegated-arc-watch` observes only its own main session transcript. `WAKE` names a raw
delegate id whose background task finished after a clean `end_turn` without a later
assistant record, with the exact `SendMessage` call: main sends it verbatim, including its
`[wt-relay ...]` marker. A background command that no subagent of this session launched is
main's own and stays silent; unattributable records produce `ARC WATCH DEGRADED`, never a
guessed target. An unresolved WAKE is announced again with backoff until its target
resumes; main's SendMessage is still a model step. A completion older than 24 hours is
never relayed, since waking an agent that late points it at stale work; the one-shot
scanner lists those as `STALE (not relayed ...)`. A delegate spawned anonymously or named
with worktree isolation self-woke in the measured majority (606 of 628 and 168 of 173 on
two installations), not every case.

The watch announces WAKE only. Whether a nested delegate's parent received its completion
notice is inferred from missing records, and that inference did not survive real
transcripts, so `FORWARD` candidates are not announced: `wt-delegate-wake-scan.mjs` lists
them as `FORWARD (unverified)` diagnostics whose precision is unmeasured.

Declared `WAITING-FOR` entries remain in the registry even after a clean stop. The
heartbeat lists unresolved waits declared in the last 24 hours; the one-shot
`wt-spawn-registry-scan.mjs` lists all unresolved waits. A transcript-confirmed next
turn clears them. Detached work has no harness completion event, so a file appearing
does not prove it is finished.
The one-shot `wt-delegate-wake-scan.mjs --session <main transcript> [--at <iso>]`
replays the same attribution and can append transcript-confirmed `resumed` transitions
with `--write-resumed` (using `WT_OUTBOUND_GUARD_DIR` when set).

## Prompt-cache keepalive

`cache-keepalive` is registered with `when: always` and is **on by default**. Set
`WT_CACHE_KEEPALIVE_ENABLED=false` before starting a session to disable it. It emits a one-word-reply
request only after the session transcript shows no real model call for 50 minutes on a `claude-*`
model or 25 minutes on a `gpt-*` model. Synthetic zero-usage assistant records do not reset that
clock. Unrecognised model names never wake.

The thresholds are overridden by `WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES` and
`WT_CACHE_KEEPALIVE_OPENAI_MINUTES`. `WT_CACHE_KEEPALIVE_MAX_REFRESHES` caps consecutive refresh
attempts without intervening real work (default 10), and `WT_CACHE_KEEPALIVE_POLL_SECONDS` changes
the 60-second poll. `WT_CACHE_KEEPALIVE_JOURNAL_DIR` relocates the per-session state and JSONL audit
journal from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cache-keepalive/`.

A due wake yields to native idle compaction when compaction is enabled, the latest real call's
context (input + cache-read + cache-creation tokens, without rounding) meets the effective floor,
and a one-hour cache write is known. This gate is model-independent. It journals `skip` with
reason `native idle compaction applies` once per idle period, retaining that decision across
restarts and transient transcript read errors. The floor defaults to 200000.
`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` accepts positive integers in plain digits; invalid values
use the default, and values below 100000 are clamped up to 100000.

The monitor reads its own environment first for that floor and `DISABLE_AUTO_COMPACT`, resolving
missing keys separately through settings `env` blocks. Only the literal strings `1` and `true`
count as a set `DISABLE_AUTO_COMPACT` switch. The independent scalar `idleCompaction` key follows
managed settings, `.claude/settings.local.json`, `.claude/settings.json`, then user `settings.json`
precedence; `false` disables the size gate. Confirmed missing files use vendor defaults;
unreadable files, malformed JSON, non-object settings, and dangling policy links leave unresolved
values unknown. Unknown eligibility inputs keep the native gate inactive. Plugin monitors run
only in interactive CLI sessions, never in noninteractive `-p` mode; SDK entrypoints `sdk-cli`,
`sdk-ts`, and `sdk-py` remain extra exclusions. See the vendor [plugins reference](https://code.claude.com/docs/en/plugins-reference#monitors),
[idleCompaction reference](https://code.claude.com/docs/en/settings-reference#idlecompaction)
and [environment variables](https://code.claude.com/docs/en/env-vars).

Native compaction also requires feature-flag fetching. `DISABLE_GROWTHBOOK` and `DO_NOT_TRACK`
block it at `1` or `true`, but not `0` or `false`. Any non-empty `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` blocks it, including `0` and `false`.
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
`CLAUDE_CODE_USE_ANTHROPIC_AWS`, and `CLAUDE_CODE_USE_MANTLE` block fetching at `1` or `true`
unless `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set. Undocumented boolean values leave
eligibility unknown. These keys use the same per-key environment/settings precedence as the
floor. Claude apps gateway sessions have no documented signal available to this monitor.

Cache freshness is separate from attempt cadence. Cadence still uses the latest real-call or
wake timestamp; freshness uses real calls and confirmed `refreshed` outcomes only. A due wake
is skipped with `prompt cache freshness expired` after 60 minutes with one-hour-write evidence,
or after five minutes with five-minute-only evidence. Within the latest real call's model,
retained one-hour evidence wins over five-minute writes; evidence from another model is discarded.
Legacy evidence without a model key belongs to the latest model. Unknown TTL or an unknown
latest real-call timestamp preserves the existing wake behavior; a later timestamped call
restores normal expiry. A threshold below
five minutes can refresh before a five-minute cache expires. These checks cover stale startup
and sleep/resume. Synthetic `uncallable` outcomes do not renew freshness. A `pendingWake` older
than one threshold period without an outcome is journaled `unresolved` and cleared; another
attempt is possible only when the remaining gates allow it.

State stores the latest real context and writer evidence for each known TTL with call-id/time
provenance and the model to which it belongs. Discovery scans the transcript in bounded chunks.
Initial discovery and legacy backfill search older writers for the latest model. Normal polls
collect all streamed records for the saved stop ID and newer calls, including interleaved writer
records, without counting rewritten stop-id usage as new work. Unrelated older calls do not
repopulate incremental evidence. Usage fields must be finite numbers; TTL counters must also be
positive. Journal `usage` retains its four fields; `cacheTtl` is a separate
outcome field. File-based managed locations are Linux `/etc/claude-code`, macOS
`/Library/Application Support/ClaudeCode`, and Windows `%ProgramFiles%/ClaudeCode`.
Launch-only settings, managed drop-ins, registry/MDM, and server-delivered policy are not resolved
by this monitor. Actual native feature-flag delivery and the effect of warm turns on the native
idle timer remain unmeasured here.

The monitor resolves the current transcript as
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<absolute-project-slug>/<CLAUDE_CODE_SESSION_ID>.jsonl`
and scans backward in 64 KiB chunks rather than loading the file. A missing or unreadable transcript
is journaled and retried; it never produces a wake or terminates the monitor set.

## Lane owner and orphan watch

`lane-orphan-watch` is registered with `when: always`. It reports still-running lanes after 10
minutes without a worktree write (`lane_stall_minutes` or `WT_LANE_STALL_MINUTES`) and reports each
launcher decision point with evidence; neither condition kills live work. Attributable decision,
stall, and `would-clean` notices are restricted to the recorded owning session; unattributable
warnings remain project-scoped. The default `lane_orphan_cleanup=observe` (env fallback
`WT_LANE_ORPHAN_CLEANUP`) journals `would-clean` and signals nothing. Each `stalled` and `would-clean`
event carries its supervision `runId`; promotion audits count distinct runId episodes, not repeated
sweeps of one episode. Promote to `enforce` only after at least 100 distinct audited episodes show
zero live victims. Enforcement requires an exact attributed child,
an `exited` or `abandoned` supervision record, a gone launcher, and immediate argv/cwd identity
verification. Codex brokers are only `broker-observed`: broker idleness detection is not implemented.
Unattributed warnings are project-root scoped and never killed.

The append-only version-1 JSONL journal is
`<plugin-data-dir>/lane-supervisor/lane-supervisor.jsonl`; path resolution follows
`plugin/bin/lib/plugin-data-dir.mjs`. Session-owned events are delivered on monitor stdout. A pilot
also receives its lane result synchronously from the lifecycle result.

Completion notices scan the machine-wide lane host state, independently of the project root.
`LANE exited: owner=... worktree=... runId=... state=... exit=... at=... report=... present|absent`
wakes the recorded owning session for both session- and pilot-owned lanes, including exits while
the watcher was stopped. Terminal records and nonterminal records with both processes classified
gone qualify; unknown process identity does not. Missing exit codes or exit times render as `unknown`.
An unset or invalid `CLAUDE_CODE_SESSION_ID` disables completion notices with a stderr diagnostic.

Announced run IDs persist in `wt-lane-exit-notices/<session-id>.json` beside the lane host state root,
independently of the plugin/config directory. The archive retains 24 hours and at most 10,000 entries;
an eviction watermark prevents capped entries from being announced again. Each archive write removes
other sessions' regular archive files untouched for more than seven days, preserving archives for
sessions resumed within a week. Old supervision directories and individual records are skipped by
modification time before records are read. Unreadable or vanished records and unlistable directories
are skipped independently, with one stderr diagnostic per path during the watcher's lifetime.
On first use, or after a corrupt archive, existing completions are
recorded silently and one `LANE exit-watch baseline: <n> finished lanes recorded, not announced` line
is emitted. Later restarts deliver newly finished lanes once after successful persistence. Completion
lines are printed before the archive write: an interruption or failed write can cause a retry duplicate,
rather than marking an unprinted notice as announced. Completion-scan failures are reported
once on stderr and do not interrupt the existing owner/orphan sweep.

The adopt `scripts` set also installs `wt-arc-watch.mjs` and `wt-quota-watch.mjs` as
thin launchers in `<configDir>/scripts/`. They resolve the installed plugin on each start,
so watcher bodies and libraries update together. On POSIX with `process.execve`, the shim
keeps the same pid; older Node versions and Windows use a signal-forwarding child process.
A missing plugin or executable is reported synchronously on monitor stdout and stderr,
with exit 2. Check these copies with `--set scripts --check --global --fail-on-drift`;
SessionStart also reports stale, edited, hand-authored, and target-missing copies.

Supervision uses one host-owned `<lane-host-state-root>/<hash>/supervision[-<slot>]/<runId>.json`
record per run and an atomic `current.json` pointer in the same directory. The root is resolved by
`laneHostStateRoot()` (with `WT_LANE_HOST_STATE` available outside the lane sandbox).
Worker and child liveness is classified centrally from each
recorded pid+argv identity; unavailable identity evidence is `unknown`, never dead. The launcher
refuses another lane while the current answer is live, decision-needed, orphaned, or unknown. Only an
unknown record beyond its recorded hard bound may be superseded. Control ownership is an accident guard, not authentication.
Session and pilot timeout decisions are `extend` or `abandon`. To relaunch from the worktree's current
state, run `node plugin/bin/wt-lane-control.mjs --dir <worktree> --decision abandon`, then start a fresh
lane on that worktree with `node <configDir>/scripts/wt-lane.mjs --dir <worktree> --model
<provider/model> --brief <file>`; the worktree files are retained.

The journal rotates at 10 MiB and keeps one previous file. A notice is emitted even if its journal
write fails; journal failures are reported once per failing streak and retried. Linux provides the full watcher/control contract; other platforms
receive one availability notice per session. Detached grandchildren that call `setsid` escape the
launcher's process group and cannot be reached by group cleanup.
