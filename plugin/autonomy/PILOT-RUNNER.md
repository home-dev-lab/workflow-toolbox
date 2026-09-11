# SDK pilot runner

`node plugin/bin/wt-pilot-runner.mjs --card <id> --dir <worktree>` starts an Agent SDK pilot behind
the adopted `PILOT-CONTRACT.md`. It keeps the prompt stream open, reads newline-delimited owner
messages from `.lane/pilot-mailbox.txt` (or `--mailbox`), and owns executor-lane waits: it detects a
pilot `wt-lane.mjs` launch, polls the reported log for `EXIT=`, and injects one completion turn. The pilot's own report is `.lane/pilot-report.md`; the lane's stays
`.lane/report.md`, and the runner stops on the pilot's file only.

The runner passes `settingSources: []`, `bypassPermissions`, the local `pilot-guard` and
`sdk-pilot-lifecycle` Function Hooks, a curated `Bash`/read-only SDK surface, and the Planka HTTP MCP.
The lifecycle module owns a fixed-path artifact writer for `.lane/brief.md` and `.lane/pilot-report.md`;
it admits the former only in TDD and the latter only at `awaiting_fidelity`. Its Bash allow-list admits
only the contract's read-only inspection, the exact lane launcher in TDD, and a commit only in Report.
The lifecycle is session-scoped and ends at `awaiting_fidelity`; it is an execution trace, not proof
of independent authorship or report truth. It does not read `/proc`, so its mailbox and lane-log polling are cross-platform.

## Integration

Before merge, Main runs the shipped commands
`node plugin/bin/wt-pilot-fidelity.mjs freeze --root <worktree> --out-dir <bundle-dir> --card <id> --session <id> --base <commit> --head <commit> --file .lane/report.md [--file <lane-path> ...]`
then `node plugin/bin/wt-pilot-fidelity.mjs verify --root <worktree> --dir <bundle-dir>` before
checking `.lane/report.md` against the branch diff and gate logs. The checker receives only the
frozen bundle: its manifest binds card/session, base/head, dirty tree
signature, and every included report, ledger, gate log, terminal `EXIT=` marker, and external
execution receipt by hash. It rejects missing/extra files, symlinks, escapes, altered bytes, and a
changed tree. Main then checks:
each Implemented claim needs a diff hunk and each gate claim a terminal `EXIT=` line. Refuted or
unverifiable claims block merge. Gate receipts use the shared tree signature, which covers tracked
and untracked file contents, type, mode, and symlink targets; ignored files, submodules, ambient
toolchain/configuration, and same-user artifact rewriting remain outside that identity.

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

`--lane-silence <min>` defaults to 12 and injects `lane silent: no write for N min, log <bytes> B, pid alive|gone|unknown` once per inactive worktree window. The runner samples only mtimes, skipping `.git`, `node_modules`, and the lane log, and checks known pids with guarded `process.kill(pid, 0)`. `summary.json` records these in `silence_injections`, while `injected_turns` includes them with every other injected turn.

## Known limit of the Bash fence (stopgap)

The lifecycle hook admits Bash by matching the command string against an allow-list. That shape has
leaked three times — a launcher path it did not anticipate, an unpinned `-C` repository, and a
control character that turns one allowed command into two. It now accepts only printable ASCII and
rejects shell metacharacters, which closes the known escapes, but string-matching a shell command is
not a containment boundary. The structural replacement is a dedicated spawn tool taking structured
argv with no shell at all, tracked as a follow-up safety increment; treat the current rule as a
stopgap and do not extend it with further special cases.
