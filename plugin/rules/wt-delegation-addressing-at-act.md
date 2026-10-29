# Delegation ladder — addressing at act

## Addressing a delegated agent — name vs raw id, and what breaks silently

Reaching/watching delegates: misread facts → false "dead"/"idle", no error; harness quiet.
Undocumented, changeable without notice; dated measurement, not permanent contract.

**Addressing.** Short `name` normal, works after turn ends; completed-agent name resumes
transcript. Raw id (`a<name>-<hash>` named, `a<hex>` anonymous) fallback, not primary:
only unnamed agent or newer agent taking name (latest wins).

⚠ **Cross-restart revival by raw id is REPRODUCED, not a one-off — short name may still fail.**
After a full session restart (not merely turn completion), short name has failed while raw id
succeeded, reproduced twice. **Operative order: probe before re-spawning**:
one raw-id `SendMessage`, no cost; substantive reply → surviving context, routing failure →
fresh spawn. Assuming restart kills delegates, respawning first discards recoverable context.

**Unrecorded raw id recoverable**: `subagents/` filenames (`agent-<raw-id>.jsonl`) ARE the ids;
scan recovers nonresolving name's id without optional hooks/enabled state directories.
Handover should still carry id explicitly; otherwise directory scan only route.

⚠ **TUI silence proves neither state, never shows resumed agent.** Alive/responsive/full-context
revived agent does not appear anywhere in the interactive agent list; absence never proves
death. Probe above; never infer death from the list.

⚠ **Honest scope**: reproduced REACHABILITY-WITH-CONTEXT across restart, this harness version,
observed cases. First probe, not as a permanent guarantee; never generalize "restart never loses
agent", nor retired opposite.

## A delegated agent's transcript is a DIFFERENT file from the session's own

Freshness watcher's natural guess, session conversation log, ≠ delegate transcript:

```
<projects-dir>/<session-id>.jsonl                              ← the SESSION's own conversation
<projects-dir>/<session-id>/subagents/agent-<raw-id>.jsonl      ← the DELEGATE's own transcript
```

⚠ **Top-level watcher = hollow guard.** Session writes → "active" whether delegate working/
stuck/gone; silence indistinguishable from healthy delegate. Every freshness check:
`subagents/agent-<raw-id>.jsonl`; confirm exists BEFORE arming. Absent → never armed, not quiet.

## The naming/observer trade-off — state it, don't pick a side

Paired read-only observer declared → spawn shape decides attachment, same undocumented surface:

| Spawn shape | Observer attaches | Addressable by name | Addressable by raw id |
|---|---|---|---|
| anonymous (no `name`) | yes | no | yes (recover via `subagents/`) |
| `name` **+** an isolated worktree | yes | yes | yes |
| `name` alone | **no** (drops silently) | yes | yes |

Third-row drop conditional: existing addressable teammates, lazy team-context initialization;
first named spawn may attach without isolation. Don't infer condition; choose safe either way.

Three-way trade-off, never universal prescription: anonymous observer/no name (raw-id recovery);
named unisolated risks silent observer loss; named isolated keeps both EXCEPT external-lane
delegator: zero-diff-at-idle isolation reaped under live lane → unusable for that delegate.
State coordinator shape/reason, never silent default.

## Pass LIVENESS_AGENT_ID to every delegate you spawn directly

`pilot-wave`/direct `pilot`/`pilot-orchestrator`: delegate cannot read own raw id; no env var.
No handoff → liveness file (arc watcher's third correlation input; "Liveness file" in
`pilot.md`/`pilot-orchestrator.md`) weakens to declared name, anonymous → `UNCORRELATABLE`.
Anonymous not rare: ONLY safe external-lane-delegator shape, most likely to lose correlation.

Raw id arrives only when `Agent` spawn RETURNS, after prompt; follow-up, never brief field.
Immediately on return, BEFORE next action, `SendMessage` one line:

```
LIVENESS_AGENT_ID: <raw id>
```

EVERY direct `pilot`/`pilot-orchestrator`, named/anonymous: one short message closes gap for
mechanism's most-needed delegates.

## Writing a fence with its expiry

The cost is invisible from both sides. Whoever obeys a stale fence reports work correctly blocked
and names the fence as the trigger; whoever set it reads a well-formed refusal. Both are right, and
the work stopped for nothing.

So name the EXPIRY IN the fence, never the fence alone: *"until the compression pass finishes"* is
checkable by the reader, *"don't touch Y"* is forever.

⚠ **Writing the expiry is only half — an expiry nobody re-reads is inert.** A stale fence reads
exactly like a live one: same text, and no way for a reader to tell which. The cheap remedies:

- name the fence's condition where whatever SATISFIES it gets recorded, so closing the work and
  lifting the fence are one act rather than two;
- when a fence quotes a state, quote the SOURCE that decides it, so a reader checks in one command
  instead of trusting the sentence;
