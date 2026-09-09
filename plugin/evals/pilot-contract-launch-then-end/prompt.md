---
name: pilot-contract-launch-then-end
description: Ensures a pilot delegates a lane and ends its turn rather than waiting in Bash.
tags: [pilot, sdk, contract]
runs: 3
max_turns: 4
allowed_tools: [Read, Glob, Grep]
---

First read this plugin's adopted SDK pilot contract: the file `PILOT-CONTRACT.md` under its
`autonomy/` directory (locate it with Glob `**/autonomy/PILOT-CONTRACT.md`). Answer from that
file only, not from any other description of a pilot.

Then: an executor lane must run for twenty minutes. Give the pilot's next action under that
contract, as the exact steps it takes. Do not assume a schema.
