# SDK pilot runner

`node plugin/bin/wt-pilot-runner.mjs --card <id> --dir <worktree>` starts an Agent SDK pilot behind
the adopted `PILOT-CONTRACT.md`. It keeps the prompt stream open, reads newline-delimited owner
messages from `.lane/pilot-mailbox.txt` (or `--mailbox`), and owns executor-lane waits: it detects a
pilot `wt-lane.mjs` launch, polls the reported log for `EXIT=`, and injects one completion turn. The pilot's own report is `.lane/pilot-report.md`; the lane's stays
`.lane/report.md`, and the runner stops on the pilot's file only.

The runner passes `settingSources: []`, `bypassPermissions`, the local Function Hook fence, and the
Planka HTTP MCP. It does not read `/proc`, so its mailbox and lane-log polling are cross-platform.

Use `--profile-env <settings.json>` to pass a profile's `env` block to `query()`. This is how a GPT
pilot runs: retain the approved alias in `WT_PILOT_MODEL`/`WT_PILOT_HARD_MODEL`, then remap it with
`ANTHROPIC_DEFAULT_<ALIAS>_MODEL`. `--hard` selects `pilotHard` through `resolvePilotModels`.

Use `--card-file <path>` to put the arbiter-provided card text verbatim in the first pilot prompt.
The prompt tells the pilot not to re-read that card from the board. Each injected lane completion,
owner message, or timeout also prints an `injected: ...` line to stdout for the runner log.

At exit `.lane/usage.json` contains per-result token categories and tools; `.lane/summary.json`
contains fresh tokens (`input + cache_creation + output`), result turns, elapsed minutes, and the
longest observed tool call plus injected-turn count. The target is under 100 k fresh tokens; PoC 4 measured 167,615. Runner
ownership of waits and the short verification template are designed reductions, not yet a measured
real-card result.
