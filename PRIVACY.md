# Privacy & data handling

**Short version: this plugin collects no user data, contains no telemetry or
analytics, and transmits nothing about you or your conversations anywhere.**

Everything it does happens locally, on your machine, against files Claude Code
already writes for the Workflow tool.

## What each component touches

- **`workflow-composer`, `toolkit-scaffold`** — authoring skills. They read and
  write workflow script files in your project. No network, no data collection.

- **`workflow-debugger`** — reads a Workflow run's own on-disk **journal**
  (`workflows/wf_<runId>.json`) and, as a fallback, the per-agent transcripts
  (`agent-*.jsonl`) to diagnose a finished run. It extracts run **status, agent
  metadata, and token counts** — not the text of your conversations — and never
  transmits them.

- **Stop hook** (`bin/wt-stop-hook.mjs`) — fires when a turn ends, reads the
  background-task list from the hook payload plus the run journal, and surfaces a
  short notice (and, on request, a cost/traceability audit report). It writes a
  small deduplication state file under your system temp directory so the same run
  is not announced twice. A full audit report folder is written to disk **only**
  when you opt in via the `$DWT_WORKFLOW_LOG_DIR` environment variable (or a
  `--out` flag). No network.

- **`upgrade-canary`** — a maintainer-only tool that re-verifies the Workflow
  runtime after a Claude Code upgrade. It makes one outbound network connection:
  a best-effort `GET` of the **public** Claude Code
  `CHANGELOG.md` from `raw.githubusercontent.com` (5-second timeout, single
  attempt, silently skipped if offline). **No data about you is sent** — it is a
  plain fetch of a public file. It also launches local Workflow runs against the
  toolkit using your existing local Claude Code authentication; nothing leaves
  your machine.

- **Quota watch** (`bin/wt-quota-watch.mjs` + bundled `bin/wt-quota-probe.mjs`)
  — monitors the account's five-hour and seven-day quota windows. Probe
  resolution is `--probe <path>` first, then `<configDir>/scripts/quota-usage.mjs`
  if you already have one, else the bundled probe. The probe only READS
  `<configDir>/.credentials.json`; it never writes credentials. The access token
  is used only as an `Authorization` header to
  `https://api.anthropic.com/api/oauth/usage`, is never printed or logged, and
  that endpoint is not publicly documented by Anthropic, so it may change or
  disappear without notice.
  The probe's stdout contract is one compact JSON line:
  `{configDir, quota_model, five_hour, seven_day, weekly_scoped}`. `quota_model`
  is the discriminator: `'subscription'` means at least one real quota window exists;
   `'none'` means a usage-billed account with no five-hour/seven-day window, and consumers must
   stay silent rather than infer health from null percentages.
   When the session is routed through a configured CLI Proxy origin, the watcher
   sends only the session id, effective model, and the gateway key the session
   already holds to that exact origin's selected-usage endpoint. It sends
   nothing to another origin, and never sends source, conversation, or Claude
    credentials to the proxy.

- **External-lane launcher** (`bin/wt-lane.mjs`) — starts a detached local
  `opencode run` with an explicit worktree, model, and brief, closes stdin, and
  writes local output plus an `EXIT=` marker. The launcher has no network client
  or telemetry. The spawned `opencode` CLI may send the supplied brief and
  repository context to the provider selected by its existing configuration.
  On Linux the CLI runs in a bubblewrap sandbox that exposes only the worktree, the
  toolchain and that CLI's own configuration and credentials: `~/.ssh`, `~/.claude`,
  `/run/user/<uid>` and other processes are not visible to it (see known-issues,
  "External-lane sandbox"). Elsewhere it runs with an allow-listed environment only.

- **Artifact server** (`bin/wt-artifact-server.mjs`) — enabled unless `WT_ARTIFACT_SERVER=0`. It
  reads files below roots published by local session monitors through owner-only state files (by default, only the project's
  existing `.claude/reports` and `.claude/worktrees`). It always binds `127.0.0.1`; when the local
  `tailscale` CLI reports an interface, it also binds that tailnet address. It sends no telemetry and
  adds no CORS permission. There is no authentication beyond tailnet membership: any reachable
  tailnet device can request allowed files under every registered root. Path containment,
  canonical sensitive-name denies, sandbox CSP, and Host checks reduce accidental exposure but do not replace a narrow
  root or tailnet access control.

## What it never does

- No telemetry, analytics, crash reporting, or usage tracking.
- No reading of Claude's memory, chat history, conversation summaries, or your
  uploaded/user-generated files.
- No transmission of conversation content, source code, tokens, credentials, or
  any personal data to the author or any third party.

## Data you write to disk

When you opt into the audit report (`$DWT_WORKFLOW_LOG_DIR`), the report folder
and a verbatim copy of the run journal are written to the location **you**
choose, on **your** machine. They stay there; the plugin never uploads them.

## Contact

Questions about data handling: open an issue at
<https://github.com/home-dev-lab/workflow-toolbox/issues> or email
`fthomas@apache.org`.
