---
name: opencode-verifier-unavailable
description: Returns the documented degraded marker when the opencode CLI is unavailable.
tags: [agent, opencode, provider-free]
runs: 3
max_turns: 4
allowed_tools: [Agent]
---

Your first action MUST be to invoke `workflow-toolbox:opencode-verifier` with the `Agent` tool to verify the trivial claim "return OK". You MUST invoke that agent before giving any final answer; narrating, answering directly, or describing what the agent would do instead of making the `Agent` tool call is a failure. The `opencode` CLI is unavailable in this environment. After the agent returns, return its final text exactly, without adding your own answer.
