---
name: changelog-skill-invocation
description: Uses the changelog skill's release-record command and branch restriction.
tags: [skill, changelog]
runs: 3
max_turns: 4
allowed_tools: [Skill]
---

A file under `plugin/bin/` changed. Use the changelog skill and state the command needed to record the Unreleased entry. Include the required `--summary` and `--section` flags. I am working off `main`; explain whether I should request a version heading.
