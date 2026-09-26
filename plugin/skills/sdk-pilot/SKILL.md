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
the runner derives its LITE/FULL route from those exact bytes. Ensure `.lane/` is ignored in the
worktree. The run's durable archive lands OUTSIDE the worktree, only under
`<archive root>/.claude/reports/<card>-<timestamp>/`, so it
survives `git worktree remove`: pass `--archive-root <project root>` (its `.claude/reports/` must be
ignored there), or let the runner default to the main checkout that owns the worktree. Resolve the optional knowledge-base index explicitly when known;
otherwise the runner checks `WT_KNOWLEDGE_BASE_INDEX`, then the project-derived Claude memory path.
Every normal or abnormal run also appends one summary line to the single durable
`<archive root>/.claude/reports/cost-index.jsonl` index.

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
`--contract`, `--hard`, `--mailbox`, and `--timeout`. Without `--timeout`, LITE runs use 90 minutes
and FULL runs use 6 hours. A shorter explicit value is allowed and prints the route-specific warning;
expiry stops at the next completed lifecycle phase boundary rather than killing work in flight.

On Windows, launch the same Node command with `Start-Process` rather than `setsid nohup`.

Every launch first writes an `admission.json` receipt under the worktree's `.lane` directory and joins a machine-wide FIFO. It starts only when
fewer than `sdk_pilot_max_active` runs are active (default 3, environment fallback
`WT_SDK_PILOT_MAX_ACTIVE`) and the one-minute load is below the available core count. Linux reads
`/proc/loadavg`; macOS reads `os.loadavg()`. Windows `os.loadavg()` reports zeros, so Windows uses
the cap alone and records that named fallback in the run log. An unreadable Linux or macOS load
probe likewise logs once and falls back to the cap; it never silently removes the cap.

## Watch

Poll the worktree's .lane/sdk-pilot.log until its final `EXIT=<code>` marker appears, and read the whole log.
Inspect the .lane/summary.json, .lane/usage.json, .lane/cost.json, .lane/sdk-transcript.json, and
.lane/pilot-report.md files. Exit 0 is a completed full run, exit 2 is a completed partial run, and exit 1
is incomplete or failed. Do not infer completion from model prose: the runner requires its correlated
`accepted phase=awaiting_fidelity` lifecycle receipt and a pilot report.
While the run is active, watch the log for a line starting `decision request:`. Open the
`dod-decision-request.md` it names and read the disputed criterion, the plan's reading and the
critic's reading. Decide the reading yourself, as the run's parent, and invoke the exact
`wt-pilot-runner.mjs decide --run ... --dod ... --reading ...` command in the log/request. It writes
atomically to host-only run state that no sandboxed lane can reach; no mailbox or lane-file text is a
 decision. On unsandboxed Linux, macOS, or Windows, another process of the same OS user can invoke
 `decide`; only a sandbox boundary isolates a lane from host state. The runner warns on unsandboxed
 runs. Never forward the question to the user. Answer within 15 minutes; after that the runner
binds the card criterion's literal words verbatim and records that the critic may not block again on
that criterion for the rest of the run. The report and summary quote both.
While the run is active, the lane's usage.json receipt is atomically refreshed for each SDK assistant usage
receipt. What is running uses those receipts for live phase and run totals; delegated lane usage is
added when that lane ends because its CLI does not expose partial usage.

To total archived costs mechanically, run `node "${CLAUDE_PLUGIN_ROOT}/bin/wt-run-cost.mjs"
<reports-directory>`. It totals complete runs by LITE/FULL/HARD route and provider family, lists every
run's unknown count, and lists partial or unknown-outcome runs separately; add `--include-partial` only
when those runs should enter route totals. Legacy run and lane windows are inferred from archived
timestamps or documented mtime fallbacks, so do not hand-enter a window for routine aggregation.

For the repeatable real-host phase-transition check, follow
[`references/what-is-running-e2e.md`](references/what-is-running-e2e.md).
