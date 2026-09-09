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
