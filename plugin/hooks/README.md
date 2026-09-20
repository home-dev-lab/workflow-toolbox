# What is running collector

Run the supported collector entry point from a project root to print the exact JSON snapshot consumed by the pane:

```bash
node plugin/hooks/snapshot-cli --planka-base-url http://localhost:3000
```

By default it scans `<cwd>/.claude`, the active Claude config directory, the standard state directories, and `/proc`. Use `--suite-root`, `--config-dir`, `--state-root`, `--liveness-dir`, `--suite-lock-root`, `--extra-root`, or `--proc-root` to point it at another installation. Card and artifact links can be diagnosed with `--planka-base-url`, `--planka-config-file`, and `--link-base`. `--active-window-min` controls freshness and `--now` supplies a fixed ISO collection time.

Run `node plugin/hooks/snapshot-cli --help` for the complete argument reference.
