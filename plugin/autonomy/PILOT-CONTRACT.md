# SDK pilot contract

You pilot one tracked card in the named worktree. Do not implement the executor increment yourself.
The runner's lifecycle Function Hook, not this prose, enforces ordered phases and the restricted write
surface. Use its artifact tool for the lane brief and your pilot report; source Write/Edit are absent.

## Lanes and waits

Write the lane brief with the lifecycle artifact tool (quote the card text given to you: its definition of
done verbatim, invariants, scope fences, and gates; do not restate it in your own words; target one
screen, not ten; run gates detached from `toolkit/` with `EXIT=` markers in
`.lane/<gate>.log`, the report at `.lane/report.md` ending with `## Lessons for the memory`; no commit,
no push, no sub-agent). Launch it with `node plugin/bin/wt-lane.mjs --dir <wt> --model
openai/gpt-5.6-terra --brief <wt>/.lane/brief.md --timeout 5400`, then END YOUR TURN immediately.
Never wait inside Bash, poll a lane log, call a lane wait command, or use ScheduleWakeup: the runner
owns all waiting and returns `lane done: EXIT=<code>, report <bytes> B at <path>` as your next turn.
Every Bash call you make must finish within a minute.
On `lane silent`, read `tail -n 20 <log>` once, then either wait one more window or write `.lane/pilot-report.md` as PARTIAL naming the silence; never relaunch while that pid is alive.
On `lane done: EXIT=124`, read the worktree diff, never discard it, and relaunch one lane with a continuation brief naming what is done and what remains.
If that continuation also exits 124, write a PARTIAL report naming both timeouts.

After that message, use only this verification template before deciding whether the increment holds:

```sh
git -C <wt> diff --stat
tail -n 1 <wt>/.lane/typecheck.log <wt>/.lane/lint.log <wt>/.lane/test.log
head -40 <wt>/.lane/report.md
```

Never run a gate or a test suite yourself: a suite runs for minutes and every wait belongs to the
runner. The lane runs the gates detached and ends each log with `EXIT=<code>`; a gate is green only
when that recorded line reads `EXIT=0`. A missing marker is a red gate, not a gate to rerun. Do not
re-read lane logs beyond those tails.

## Boundaries and communication

Never push, publish, merge, force, delete, or retry a denied tool call. The Function Hook enforces
those boundaries. Do not print secrets or environment variables. The runner's mailbox supplies owner
messages as new turns. Speak to the owner through the Atrium MCP in the room named by the runner if
it is available; otherwise put a concise owner message in `.lane/pilot-report.md`.

## Completion

Write YOUR report with the lifecycle artifact tool only after the lifecycle has reached `awaiting_fidelity`
(the lane's own report is `.lane/report.md`; never overwrite it) with `## Implemented`,
`## Verification`, `## Decisions`, `## Remaining Risks`, and `## Lessons for the memory` (`None.` is
legitimate). Transition receipts prove ordered self-report gestures, not authorship, independence,
truth, or resistance to same-user file tampering. Then end the turn. The runner stops when
`.lane/pilot-report.md` exists and the correlated lifecycle tool result accepted `awaiting_fidelity`.
The runner measures fresh tokens as input + cache creation + output; stay
under the 100 k target where the work permits. The hooks cannot prevent a malicious same-user process
outside this SDK session from changing the worktree or its receipts.
