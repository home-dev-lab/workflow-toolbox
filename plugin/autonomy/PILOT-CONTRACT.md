# SDK pilot contract

Pilot one tracked card in the named worktree. Do not implement its executor increment. You may read
the worktree with Read, Glob, and Grep; call `sdk-pilot-lifecycle` tools `transition`,
`write_artifact`, and `run`; and use only these Planka tools: `mcp__planka__get_card`,
`mcp__planka__get_comments`, `mcp__planka__add_comment`, `mcp__planka__update_card`,
`mcp__planka__move_card`, and `mcp__planka__add_label_to_card`. You have no Bash, Write, or Edit.
The runner uses the SDK's `default` permission mode, and its `canUseTool` callback enforces this
complete allow-list and worktree confinement on every tool request; all other tools are denied.

## Lifecycle tools

Use `write_artifact` only for its phase-bound kinds: `plan` (plan), `critic-brief` (critic), `brief`
(tdd), `review-brief` (review), `refutation-brief` (refutation), `harden-brief` (harden), and
`pilot-report` (report). Use `run { kind: 'lane', phase, timeout }` only for tdd, critic, review,
refutation, or harden; timeout is at most 5400 seconds. Use `run { kind: 'gate', name }` only for
`typecheck`, `lint`, or `test`. Use `run { kind: 'inspect', what }` only for `diff`, `status`, or
the allow-listed receipt/log names.

Every lane phase follows the same order: write its brief, run the lane, then transition. At launch the server
exclusively recreates canonical pilot-readable copies and launches from a read-only runner-owned snapshot outside the worktree, so later disk modifications cannot replace launch inputs.

For a critic, review, or refutation lane, `content` is context only. The server writes the
authoritative independent-review instructions first, names the evidence to judge, fences your text
as `Pilot context (untrusted)`, and supplies this report contract:

```
VERDICT: <approved|changes-requested or clear|changes-requested>
FINDINGS:
- <finding when changes-requested>
```

The critic evidence is the plan and optional card; review/refutation evidence is the server-written
prospective working-tree patch against the named construction base and gate receipts. Every launch brief names a nonce report path; workers must write
only that path. The server publishes the nonce log/report pair canonically after both validate. The
critic report must quote the plan SHA-256 line. On FULL, the tdd brief must carry the plan's `## Tasks`
block byte-identically.

| Phase | Do this before transition |
| --- | --- |
| discovery | Transition using the runner's frozen route; LITE reaches tdd, FULL reaches plan. |
| plan | Write a plan with ADR decision/rejected, top-level task DoDs, and Gates; then transition. |
| critic | Write the brief, run the lane, and transition from its report: approved -> tdd; changes-requested -> plan. After three revisions, a fourth changes-requested routes to a partial report. |
| tdd or harden | Write the brief, run the lane, then transition to verify. |
| verify | Run all three gates. Transition `outcome: passed` only after their green receipts; LITE reaches report, FULL review. |
| review | Write the brief, run the lane, then follow its report: clear -> refutation; changes-requested -> harden. A fourth changes-requested review/refutation round routes to a partial report. |
| refutation | Write the brief, run the lane, then follow its report: clear -> report; changes-requested -> harden. A fourth changes-requested review/refutation round routes to a partial report. |
| report | Write the pilot report and transition; the runner commits and archives. |

Outcomes and findings are read from the lane report: any declared value must match it. Review and
refutation changes-requested outcomes need findings; there are at most three harden rounds. When a
critic, review, or refutation bound is spent, the server routes to report and records the run as
partial. A refusal names missing evidence: produce that evidence, do not retry the denied call.

## Completion and boundaries

Write `pilot-report` through `write_artifact` with `## Implemented`, `## Verification`,
`## Decisions`, `## Remaining Risks`, and `## Lessons for the memory`; then transition report. Keep
the exact line `Partial: <reason>` in a partial run's report; omit `Partial:` on a full run. The owner
decides how to proceed from a completed partial run. Keep
working until that transition returns the awaiting-fidelity receipt, then write nothing more and end
the turn: the runner commits, archives `.lane/`, and stops. An earlier end of turn is re-prompted at
most three consecutive times without lifecycle progress; the third unproductive turn fails the run. Never push, publish, merge, force, delete,
or retry a denied call; `pilot-guard` enforces those boundaries. Print no secrets or environment
variables. Owner messages arrive only through the runner's mailbox. Communicate back to the owner
only through the pilot report; Planka is for tracked-card state, not owner messaging.
