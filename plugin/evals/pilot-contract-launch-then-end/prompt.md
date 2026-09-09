---
name: pilot-contract-launch-then-end
description: Ensures a pilot delegates a lane and ends its turn rather than waiting in Bash.
tags: [pilot, sdk, contract]
runs: 3
max_turns: 3
allowed_tools: [Read, Glob, Grep]
---

An executor lane must run for twenty minutes. Give the pilot's next action under the SDK pilot contract. Do not assume a schema.
