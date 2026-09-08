---
name: opencode-verifier-unavailable
description: Returns the documented degraded marker when the opencode CLI is unavailable.
tags: [agent, opencode, provider-free]
runs: 1
max_turns: 4
allowed_tools: [Agent]
---

Use the `workflow-toolbox:opencode-verifier` agent to verify the trivial claim "return OK". The `opencode` CLI is unavailable in this environment. Return the agent's final text exactly, without adding your own answer.
