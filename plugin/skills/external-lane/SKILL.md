---
name: external-lane
description: Use when asked to delegate an implementation/review to an external lane, launch an opencode lane, or brief a lane.
---

# External lane

Use an external lane for a complete implementation or review, not a five-minute harness task.

1. Create a dedicated Git worktree and a brief file at .lane/brief.md inside it. Paste the definition of done verbatim, list invariants and exact gates, require detached gates with `EXIT=` markers, require a lane report, and end with `## Lessons for the memory`.
2. Confirm account/project consent. Install the stable launcher with `node plugin/skills/adopt/scripts/install.mjs --set scripts --install --global`; it installs `<configDir>/scripts/wt-lane.mjs`. The plugin-cache `plugin/bin/wt-lane.mjs` works too but changes with plugin upgrades.
3. Launch: `node "$CLAUDE_CONFIG_DIR/scripts/wt-lane.mjs" --dir <worktree> --model <provider/model> --brief <worktree>/.lane/brief.md --timeout 5400`.
4. Monitor with the allow-covered waiter: `Monitor({command: 'node <configDir>/scripts/wt-lane-wait.mjs --dir <wt>'})`. The matching rule is `Bash(node <configDir>/scripts/wt-lane-wait.mjs:*)`; an allow rule covers the command a Monitor runs. It waits for the launcher's worker pid and the terminal `EXIT=` marker, then propagates the lane exit code. A report is input, not proof.
5. Read the report and diff-read the worktree. Run real required gates on that tree, detached with independent `EXIT=` logs. Never re-gate less than once on the real tree. Then commit and merge normally.

The narrow allow rules are `Bash(node /home/<user>/.claude/scripts/wt-lane.mjs:*)` and `Bash(node /home/<user>/.claude/scripts/wt-lane-wait.mjs:*)`. The launcher passes `--auto`, closes stdin, uses the explicit directory, forces OpenCode to omit Claude Code skill roots (including the single-writer memory skills), writes `.lane/pid`, and writes `EXIT=124` on timeout. On POSIX the waiter checks liveness with `kill -0`; on Windows it uses the platform process-list path. Consent and saturation hooks recognize `node .../wt-lane.mjs`; activity observes the real `opencode` process and attributes it to its worktree. Never use a harness-managed isolated worktree for a lane: its cleaner can remove an unchanged tree while the detached process is writing.
