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
receives its own lane event synchronously from the lifecycle result instead.

Supervision uses one `.lane/supervision/<runId>.json` record per run and an atomic
`.lane/supervision/current.json` pointer. Worker and child liveness is classified centrally from each
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
