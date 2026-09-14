---
name: external-lane-names-launcher
description: Names the supported detached external-lane launcher and its launch properties.
tags: [skill, external-lane]
runs: 3
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

I want to hand a complete implementation to a detached external lane (opencode) on this machine, so that it keeps running for an hour without my session waiting on it. Consult the relevant skill or launcher source, then answer in a short list. Your answer MUST include the single `node .../wt-lane.mjs` launch command with all four required flags: `--dir <worktree>`, `--model <provider/model>`, `--brief <worktree>/.lane/brief.md`, and `--timeout 5400`. It MUST also state all four launch guarantees: the launcher closes stdin, passes `--auto` so permission prompts do not block it, uses the explicit directory, and writes an `EXIT=` marker after timeout. Do not substitute a foreground `opencode run` command.
