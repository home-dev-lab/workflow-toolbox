---
name: external-lane-names-launcher
description: Names the supported detached external-lane launcher and its launch properties.
tags: [skill, external-lane]
runs: 1
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

I want to hand a complete implementation to a detached external lane (opencode) on this machine, so that it keeps running for an hour without my session waiting on it. Which single command launches it, and which four properties does that launch need so it neither hangs on stdin nor dies silently on a permission prompt? Answer in a short list.
