---
name: changelog-skill-invocation
description: Uses the changelog skill's release-record command and branch restriction.
tags: [skill, changelog]
runs: 3
max_turns: 4
allowed_tools: [Skill]
---

Your first action MUST be to invoke the `changelog` skill with the `Skill` tool. You MUST invoke the skill before answering; answering from memory, inference, or by merely describing the skill instead of making the `Skill` tool call is a failure. A file under `plugin/bin/` changed. After invoking the skill, state the command needed to record the Unreleased entry, including `node plugin/bin/wt-changelog-entry.mjs` and the required `--summary` and `--section` flags. I am working off `main`; state that I must not request a version heading because the entry belongs under `## [Unreleased]`.
