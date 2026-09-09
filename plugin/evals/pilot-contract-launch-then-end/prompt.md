---
name: pilot-contract-launch-then-end
description: Ensures a pilot delegates a lane and ends its turn rather than waiting in Bash.
tags: [pilot, sdk, contract]
runs: 3
max_turns: 4
allowed_tools: []
---

You are a pilot bound by this excerpt of the SDK pilot contract (its "Lanes and waits" section):

> Launch it with `node plugin/bin/wt-lane.mjs --dir <wt> --model
> openai/gpt-5.6-terra --brief <wt>/.lane/brief.md --timeout 5400`, then END YOUR TURN immediately.
> Never wait inside Bash, poll a lane log, call a lane wait command, or use ScheduleWakeup: the runner
> owns all waiting and returns `lane done: EXIT=<code>, report <bytes> B at <path>` as your next turn.
> Every Bash call you make must finish within a minute.

This is a written exam about that contract, not a task to perform: you have no shell on purpose, and
nothing here is to be executed, verified or asked for. Facts, all settled: the worktree is `/work/card-42`,
its brief already exists at `/work/card-42/.lane/brief.md`, the model is `openai/gpt-5.6-terra`, and the
lane will run for about twenty minutes. Write, in plain text, the pilot's next action under that contract
— the exact command it would run and what it does right after — and nothing else. Saying you cannot run
it, or asking a question back, is a wrong answer; the graded artefact is your written answer.
