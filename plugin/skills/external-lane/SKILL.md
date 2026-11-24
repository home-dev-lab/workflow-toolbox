---
name: external-lane
description: Use when asked to delegate an implementation/review to an external lane, launch an opencode lane, or brief a lane.
---

# External lane

Timeout receipts are matchable in the host-owned run log: `LANE_BOUND` gives the limits, `LANE_DECISION_NEEDED` announces the decision deadline, and `LANE_EXTENDED` records the extension count, source, next deadline, and last activity. The unattended bound is `(max-extensions + 1) × (timeout + decision-grace)` seconds, or **22,800 seconds (6 h 20 min)** with the defaults, plus startup and termination overhead. `--idle-window <seconds>` defaults to 1200: a lane with known silence beyond that window gets default abandon at its timeout and a `LANE_NOT_EXTENDED reason=idle` receipt. Explicit owner extensions still work while extensions remain.

The worker's idle watchdog remains observe-only until calibrated. `LANE_IDLE_WARN` appears once per silent stretch, based on log growth, worktree writes, and live descendants; resumed activity re-arms it. Opt into stopping with `--idle-timeout <positive seconds>` (default 0/off): it writes `LANE_IDLE_STOP`, `TERMINATION=idle`, and `EXIT=126`. Timeout abandonment writes `TERMINATION=timeout` and the same exit code. Unknown process evidence or a bounded/unknown write scan produces `LANE_IDLE_UNKNOWN` and a recorded reason, never an idle warning or stop. Read the supervision record's `idle.maxSilentSeconds` when collecting calibration evidence. After 30 lanes ending `EXIT=0` have supplied that measurement, set the future default idle timeout above the largest measured silence; until then enforcement requires the explicit flag.

Use an external lane for a complete implementation or review, not a five-minute harness task.

1. Create a dedicated Git worktree and a brief file at .lane/brief.md inside it. Paste the definition of done verbatim, list invariants and exact gates, require detached gates with `EXIT=` markers, require a lane report, and end with `## Lessons for the memory`.
2. Confirm account/project consent. Install the stable launcher with `node plugin/skills/adopt/scripts/install.mjs --set scripts --install --global`; this installs thin launchers for the lane, waiter, arc watcher, and quota watcher into `<configDir>/scripts/`. Each resolves the installed plugin at launch time and runs its canonical `bin/` executable, including its own consent gate. Re-adopt an older copied launcher once to switch to the shim. Check with `node plugin/skills/adopt/scripts/install.mjs --set scripts --check --global --fail-on-drift`. The plugin-cache `plugin/bin/wt-lane.mjs` works too but changes with plugin upgrades.
3. Launch: `node "$CLAUDE_CONFIG_DIR/scripts/wt-lane.mjs" --dir <worktree> --model <provider/model> --brief <worktree>/.lane/brief.md --timeout 5400`. The shim picks up installed executable updates on the next launch. `--timeout` is an owner decision bound, not a kill timer; `--decision-grace 300` controls how long the owner has before the default, and `--max-extensions 3` bounds repeated extension defaults before abandon. Configure `lane_models` and `lane_skills` in the plugin's Claude Code settings; both accept comma- or newline-separated values. `WT_LANE_MODELS` and `WT_LANE_SKILLS` remain environment fallbacks when their plugin option is absent. A plugin option always wins over its env fallback. The launcher copies only declared skills into `.lane/` and exposes them with a lane-local `OPENCODE_CONFIG` `skills.paths` file; `save-memory` and `planka-tracking` are always refused because lanes cannot write shared memory or boards. The lane runs at low priority by default (`--priority normal` opts out): niceness 19 on Linux and macOS, below-normal CPU priority on Windows, plus the idle I/O class on Linux only; the run log's `stage=priority` line says what was applied or why it degraded. There is no attachment flag: `--attach` (either form) is refused with exit 2 because attachments were removed; compose any extra text into the brief file, or expose a read-only path with `WT_LANE_SANDBOX_READ`.
4. Monitor with the allow-covered waiter: `Monitor({command: 'node <configDir>/scripts/wt-lane-wait.mjs --dir <wt>'})`. The matching rule is `Bash(node <configDir>/scripts/wt-lane-wait.mjs:*)`; an allow rule covers the command a Monitor runs. It waits for the host-owned supervision record's terminal state and exit code; an `EXIT=` in the lane's stdout is display-only. A report is input, not proof.
5. Read the report and diff-read the worktree. Run real required gates on that tree, detached with independent `EXIT=` logs. Never re-gate less than once on the real tree. Then commit and merge normally.

### Delegate launcher routing

A delegate must pass its own raw liveness agent ID explicitly: the inherited
`CLAUDE_CODE_SESSION_ID` identifies its parent session, not the delegate.
Use IDs containing only letters, digits, underscores or hyphens. Before launching,
write your liveness file as described in the pilot template (`complete:false`,
`waitingOn:"lane"`, your raw ID in `agentId`). Then launch and wait using that same ID:

```sh
node <configDir>/scripts/wt-lane.mjs --launcher-agent <id> --dir <worktree> --model <provider/model> --brief <worktree>/.lane/brief.md
node <configDir>/scripts/wt-lane-wait.mjs --launcher-agent <id> --poll 2 --timeout 3300
```

Run the **second command as your own background Bash tool call** (`run_in_background:true`),
then yield. Its completion is the channel that wakes you. Re-arm it on expiry and
after handling each lane exit. Launcher
mode returns 0 when it consumes an event, 125 when its wait budget ends, and 1 when
delivery is unknown. Completion text carries the work's own exit code. Persistent
acknowledgements prevent later waiters from replaying consumed events; pending events from
before waiter startup are delivered too. Use one waiter per launcher ID.

`WT_LAUNCHER_AGENT=<id>` is the lane flag's fallback. Set it per lane launch rather than
exporting a delegate's identity into main. The host watcher publishes lane-exit events;
keep that watcher running from the updated install.

Events are individual files under `wt-launcher-events/<id>/pending/` beside the
lane host-state root, created mode 0600 in private directories (on Windows, access follows the owner's
state-directory ACL). Live delegate events stay out of main's watcher output.
For an unconsumed event, if liveness says `complete:true`, main receives
`orphaned-launcher=<id>` immediately; consumed events are never echoed to main.
An absent liveness file gets a 120-second grace from its first observed absence.
The main watcher revisits pending lane exits even if their lane record disappears.
Even with live liveness, an event unconsumed for 57 minutes (one 55-minute waiter plus
the 120-second grace) falls back to main. Keep re-arming the waiter on expiry.
An orphan delivered to main is acknowledged separately from the historical notice
archive, so archive eviction cannot hide a pending event or replay a handled one.
An unreadable liveness file triggers a named routing diagnostic and main fallback.
A failed publication reports `launcher-publish-failed` and is retried from the lane record;
storage errors do not change the sweep's or waiter's exit status. A delegate must keep `complete:false` while
waiting and mark it complete only after handling its final work events.
Publishers write complete private temporary files with exclusive creation, then publish
with a hard link that never overwrites an existing name. No publisher waits on a reader.
Readers rename pending events into their own claimed directory; only the successful
claimer prints. Both recipients complete synchronous output before renaming into `done/`.
A crash between output and acknowledgement can replay delivery. A later reader returns
a claim to pending only with positive process-death or measured PID-reuse evidence,
never age alone; unknown ownership is reported and retained. Done history is retained
for seven days, exceeding the one-day completion lookback. Temporary hard links reserve
names until done retention; half-written temporary files never enter pending.
Windows sharing failures retry at most four attempts and report a named exhaustion.
Legacy spool files, locks and malformed old claims are ignored with `launcher-legacy-ignored`.
Gate/test/queue events and supervision notices retain their existing channels; recovery
WAKEs stay with main. The launcher waiter consumes lane-exit events only.

### Lane waiter outcomes

The waiter's `--timeout` caps only the wait. `WAIT BUDGET ENDED: lane pid <N> still running`
exits **125**, leaving the lane alive. If identity cannot be verified it prints `liveness unknown (<reason>)`;
if only the child survives it names the gone worker and the running child. Neither outcome proves completion.
`LANE DONE exit=<n>` displays the terminal host-record exit and passes through integers in 0–255, including
124 or 125; integers outside that range return 1. Read the outcome text as well as the code.
`LANE DIED exit=unknown` exits 1; argument or supervision errors exit 2.
The supervisor records its own deadline as `state=decision-needed`, `reason=timeout-bound`, and `timeoutAt`;
this is a live decision point. Non-running budget lines include `state=<state>`; `state=decision-needed`
also includes `timeoutAt` and `decisionDueAt`, and `state=terminating` identifies pending termination.
Timeout abandonment is a terminal `state=abandoned` record: `LANE DONE exit=126 cause=timeout`.
Abandonment causes come only from `decisionSource`: grace-default/extension-ceiling → timeout, idle → idle,
owner → owner, grace-error → grace-error. A stale `reason=timeout-bound` does not determine the cause.
The waiter never prints `LANE TIMEOUT`; a recorded exit 124 alone does not establish a timeout.

- Worker identity: macOS uses `ps` argv/start time and excludes zombies; Windows uses PowerShell `Get-Process`
  start time/image with recorded argv. Unavailable or ambiguous identity is **unknown** on either platform.
- Child identity: the same macOS/Windows probes check the recorded child independently; an unreadable child
  is **unknown**, and a verified surviving child is reported separately from a gone worker.
- Existence/state fallback: macOS uses the `ps` process table and zombie state; Windows uses `Get-Process`
  existence and has no POSIX zombie-state evidence. Probe failure is **unknown**, never assumed alive or dead.

On Linux the lane runs in a bubblewrap sandbox isolated in filesystem, PID table and network: only the worktree, the toolchain, and the CLI's own config and credentials are visible, never `~/.ssh`, `~/.claude`, `/run/user/<uid>` or other processes; the git pointer files are read-only; OpenCode runs on private per-run data/cache/state; and the lane reaches only its configured local model endpoint, no other host loopback service. The run log's `stage=sandbox` line records the writable and readable sets. When a lane genuinely needs another path, set `WT_LANE_SANDBOX_READ` or `WT_LANE_SANDBOX_WRITE` (colon-separated absolute paths) in the environment that runs `wt-lane.mjs`; never disable the sandbox to fix a missing path. A present-but-failing `bwrap` refuses the launch; only `WT_LANE_SANDBOX=off` runs unsandboxed, and it says so in one line.

Host-state location update: the old `.lane/pid`, `.lane/run.log`, `.lane/env.log`, `.lane/brief-snapshots/`, and `.lane/supervision*/` locations named below are legacy. New launches place these in a private per-worktree directory under `~/.local/state/wt-lane-host/` (Linux), `~/Library/Application Support/wt-lane-host/` (macOS), or `%LOCALAPPDATA%/wt-lane-host/` (Windows). The launch receipt prints the log path. Live or unreadable legacy supervision refuses a new launch; control and wait ignore legacy-only records. This relocation is a real trust boundary only on Linux, where the bwrap sandbox actually keeps a lane from reading or forging it; on macOS and Windows the lane runs unsandboxed with the owner's own rights, so the same relocation there is organisational, not a security guarantee. After upgrading the plugin, restart any long-lived orphan-watch process too — it keeps reading the old in-worktree location for as long as it stays alive, independent of a re-adopted launcher.

The narrow allow rules are `Bash(node /home/<user>/.claude/scripts/wt-lane.mjs:*)` and `Bash(node /home/<user>/.claude/scripts/wt-lane-wait.mjs:*)`. The launcher passes `--auto`, closes stdin, uses the explicit directory, and uses the toolbox-wide OpenCode fence: every child forces omission of Claude Code skill roots. At launch, an uncached and bounded `opencode debug skill` probe runs with the child's exact environment, directory, and config; any effective `save-memory` or `planka-tracking` discovery (including case and `_`/`-` variants), or any failed probe, refuses the launch. Inherited `OPENCODE_CONFIG` is dropped. The probe is a checked-at-launch filesystem snapshot: local filesystem changes after it completes can change later discovery, and this fence does not attempt to defend against an actor racing local writes. Requested skills are rebuilt under `.lane/` from validated, non-symlink trees whose root frontmatter name matches the requested directory and which contain no nested `SKILL.md`. It writes `.lane/pid`, one `.lane/supervision/<runId>.json` record per run, and an atomic `current.json` pointer. A timeout leaves live work running. Session and pilot owners may choose only `extend` or `abandon`. To relaunch from the worktree's current state, run `node plugin/bin/wt-lane-control.mjs --dir <worktree> --decision abandon`, then start a fresh lane with `node "$CLAUDE_CONFIG_DIR/scripts/wt-lane.mjs" --dir <worktree> --model <provider/model> --brief <file>`; abandonment keeps worktree files intact. Owner ids and tokens prevent accidents but are not authentication. The always-on watcher is observe-only by default and routes attributable notices only to a matching session; unattributable warnings remain project-scoped, and stdout notices are independent of journal success. The SDK lifecycle returns pilot evidence and its control token directly to the pilot. Codex brokers are observed but never cleanup candidates because idleness detection is not implemented. On POSIX the waiter checks liveness with `kill -0`; on Windows it uses the platform process-list path. Consent and saturation hooks recognize `node .../wt-lane.mjs`; activity observes the real `opencode` process and attributes it to its worktree. Never use a harness-managed isolated worktree for a lane: its cleaner can remove an unchanged tree while the detached process is writing.
