---
name: leaf-readonly-three-tools
description: Confirms the leaf-readonly agent's exact tool fence.
tags: [agent, leaf-readonly]
runs: 1
max_turns: 4
allowed_tools: [Agent]
---

Spawn `workflow-toolbox:leaf-readonly` and ask it to enumerate its own available tools. Return only its answer. The expected answer is an exact tool list, not a list of unavailable tools.
