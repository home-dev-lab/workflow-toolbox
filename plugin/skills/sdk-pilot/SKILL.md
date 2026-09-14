---
name: sdk-pilot
description: >-
  Expose the experimental wt-pilot-runner for one tracked card when the user explicitly wants to
  exercise or evaluate the SDK lifecycle. Explain when to use it instead of the supported adopted
  pilot-wave harness, launch it detached with a card file and worktree, and watch its receipts.
---

# SDK pilot

Use this skill only when the user explicitly wants to exercise, evaluate, or debug the SDK pilot
runner for one tracked card. **It is NOT YET SUPPORTED.** The 0.174.0 release notes say the SDK
runner, orchestrator, executor, and lifecycle server are present but not supported; their interfaces
may change and a full end-to-end run is not yet proven.

For ordinary autonomous card delivery, use `pilot-wave` and the project's adopted `pilot` or
`pilot-orchestrator`. That is the supported harness path and keeps main as arbiter. This skill does
not alter `pilot-wave`, adoption, or its behavior.

## Prepare

Create a dedicated Git worktree for the card. Write the complete tracker card to a regular card file;
the runner derives its LITE/FULL route from those exact bytes. Ensure `.lane/` and
`.claude/reports/` are ignored. Resolve the optional knowledge-base index explicitly when known;
otherwise the runner checks `WT_KNOWLEDGE_BASE_INDEX`, then the project-derived Claude memory path.

## Launch detached

From the repository root, create `.lane/`, then launch with absolute paths:

```bash
mkdir -p <worktree>/.lane
setsid nohup sh -c 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-pilot-runner.mjs" \
  --card <card-id> --card-file <absolute-card-file> --dir <absolute-worktree> \
  --knowledge-base-index <absolute-MEMORY.md> \
  --plugin-dir <absolute-rules-on-demand-plugin> \
  --plugin-dir <absolute-lsp-plugin> \
  > <absolute-worktree>/.lane/sdk-pilot.log 2>&1; \
  echo EXIT=$? >> <absolute-worktree>/.lane/sdk-pilot.log' \
  >/dev/null 2>&1 < /dev/null &
```

Omit `--knowledge-base-index` when no prompt-level value is available. Omit either repeatable
`--plugin-dir` when that local plugin is not configured; every supplied path must be absolute and the
runner refuses an initialization receipt that omits it. Other optional flags include `--profile-env`,
`--contract`, `--hard`, `--mailbox`, and `--timeout`.

On Windows, launch the same Node command with `Start-Process` rather than `setsid nohup`.

## Watch

Poll the worktree's .lane/sdk-pilot.log until its final `EXIT=<code>` marker appears, and read the whole log.
Inspect the .lane/summary.json, .lane/usage.json, .lane/cost.json, .lane/sdk-transcript.json, and
.lane/pilot-report.md files. Exit 0 is a completed full run, exit 2 is a completed partial run, and exit 1
is incomplete or failed. Do not infer completion from model prose: the runner requires its correlated
`accepted phase=awaiting_fidelity` lifecycle receipt and a pilot report.

To total archived costs mechanically, run `node "${CLAUDE_PLUGIN_ROOT}/bin/wt-run-cost.mjs"
<reports-directory>`. It totals complete runs by LITE/FULL/HARD route and lists partial runs separately;
add `--include-partial` only when partial costs should enter route totals.
