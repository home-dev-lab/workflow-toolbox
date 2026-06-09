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

- **Stop hook** (`bin/dwt-stop-hook.mjs`) — fires when a turn ends, reads the
  background-task list from the hook payload plus the run journal, and surfaces a
  short notice (and, on request, a cost/traceability audit report). It writes a
  small deduplication state file under your system temp directory so the same run
  is not announced twice. A full audit report folder is written to disk **only**
  when you opt in via the `$DWT_WORKFLOW_LOG_DIR` environment variable (or a
  `--out` flag). No network.

- **`upgrade-canary`** — a maintainer-only tool that re-verifies the Workflow
  runtime after a Claude Code upgrade. It makes the plugin's **only outbound
  network connection**: a best-effort `GET` of the **public** Claude Code
  `CHANGELOG.md` from `raw.githubusercontent.com` (5-second timeout, single
  attempt, silently skipped if offline). **No data about you is sent** — it is a
  plain fetch of a public file. It also launches local Workflow runs against the
  toolkit using your existing local Claude Code authentication; nothing leaves
  your machine.

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
