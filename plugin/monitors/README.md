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

`cache-keepalive` is registered with `when: always`, but is **off by default**. Set
`WT_CACHE_KEEPALIVE_ENABLED=true` before starting a session to opt in. It emits a one-word-reply
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
