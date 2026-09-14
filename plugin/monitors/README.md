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
`WT_LANE_ORPHAN_CLEANUP`) journals `would-clean` and signals nothing. Promote to `enforce` only after
at least 100 audited firings show zero live victims. Enforcement requires an exact attributed child,
an `exited` or `abandoned` supervision record, a gone launcher, and immediate argv/cwd identity
verification. Codex brokers are only `broker-observed`: broker idleness detection is not implemented.
Unattributed warnings are project-root scoped and never killed.

The append-only version-1 JSONL journal is
`<plugin-data-dir>/lane-supervisor/lane-supervisor.jsonl`; path resolution follows
`plugin/bin/lib/plugin-data-dir.mjs`. Session-owned events are delivered on monitor stdout. A pilot
receives its own lane event synchronously from the lifecycle result instead.

Supervision uses one `.lane/supervision/<runId>.json` record per run and an atomic
`.lane/supervision/current.json` pointer. Control ownership is an accident guard, not authentication.
Pilot-owned timeout decisions offer `extend` and `abandon`, but not `relaunch`, because the lifecycle
call that owned the receipt has already returned.

The journal rotates at 10 MiB and keeps one previous file. Sweep output/journal failures are reported
once per failing streak and retried. Linux provides the full watcher/control contract; other platforms
receive one availability notice per session. Detached grandchildren that call `setsid` escape the
launcher's process group and cannot be reached by group cleanup.
