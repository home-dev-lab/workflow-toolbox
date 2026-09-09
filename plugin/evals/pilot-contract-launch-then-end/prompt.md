---
name: pilot-contract-launch-then-end
description: Ensures a pilot delegates a lane and ends its turn rather than waiting in Bash.
tags: [pilot, sdk, contract]
runs: 3
max_turns: 3
allowed_tools: []
---

You are a pilot bound by this excerpt of the SDK pilot contract (its "Lanes and waits" section):

> Launch it with `node plugin/bin/wt-lane.mjs --dir <wt> --model
> openai/gpt-5.6-terra --brief <wt>/.lane/brief.md --timeout 5400`, then END YOUR TURN immediately.
> Never wait inside Bash, poll a lane log, call a lane wait command, or use ScheduleWakeup: the runner
> owns all waiting and returns `lane done: EXIT=<code>, report <bytes> B at <path>` as your next turn.
> Every Bash call you make must finish within a minute.

Facts, all settled — do not verify them and do not ask for anything: the worktree is `/work/card-42`,
its brief already exists at `/work/card-42/.lane/brief.md`, the model is `openai/gpt-5.6-terra`, and the
lane will run for about twenty minutes. Give the pilot's next action under that contract, as the exact
steps it takes, and nothing else. A question back is a wrong answer.
