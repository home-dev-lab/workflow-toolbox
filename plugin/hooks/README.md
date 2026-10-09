# What is running collector

Run the supported collector entry point from a project root to print the exact JSON snapshot consumed by the pane:

```bash
node plugin/hooks/snapshot-cli --planka-base-url http://localhost:3000
```

By default it scans `<cwd>/.claude`, the active Claude config directory, the standard state directories, and `/proc`. Use `--suite-root`, `--config-dir`, `--state-root`, `--liveness-dir`, `--suite-lock-root`, `--extra-root`, or `--proc-root` to point it at another installation. Card and artifact links can be diagnosed with `--planka-base-url`, `--planka-config-file`, and `--link-base`. `--active-window-min` controls freshness and `--now` supplies a fixed ISO collection time.

Run `node plugin/hooks/snapshot-cli --help` for the complete argument reference.

## Work journal hooks

`bin/wt-work-journal-hook.mjs` records Bash acts at PreToolUse/PostToolUse and admitted MCP
acts at PostToolUse. SessionStart verifies its chain, recovers interrupted writes and shows
a bounded subject digest. Stop warns about unmatched or unconfirmed outward acts.
See [the journal guide](../../docs/public/work-journal.md) for commands, backup and the
per-user storage boundary on Linux, macOS and Windows.
