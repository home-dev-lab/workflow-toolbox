# Delegation ladder — addressing at act

## Addressing a delegated agent — name vs raw id, and what breaks silently

Reaching/watching a delegated agent: two facts easy to get wrong — produces false "it's
dead"/"it's idle" instead of an error; harness stays quiet either way. Both come from exercising
the surface directly; undocumented, may change without notice — treat below as dated
measurement, not permanent contract.

**Addressing.** Short `name` = normal address, keeps working after agent's own turn ends —
messaging a completed agent's name resumes it from transcript. Raw id (`a<name>-<hash>` named,
`a<hex>` anonymous) = fallback: use only when agent has no name, or a newer one took same name
(latest wins). Both routes exercised end-to-end (delivered AND acted on), both worked — raw id
isn't the primary address.

⚠ **Cross-restart revival by raw id is REPRODUCED, not a one-off — short name may still fail.**
After a full session restart (not just an agent completing its own turn), a previously-alive
agent addressed by short name has been seen to fail while the same agent's raw id succeeded —
and, corrected from an earlier draft calling this "a single unreproduced observation",
reproduced TWICE the same day, from a cold main session after a deliberate restart: a wave
orchestrator carrying ~290k tokens of context was revived by raw id with full mission scope,
open card ids, worktree state intact, then revived its own subordinate the same way with 178
prior messages intact. **Operative order: probe before re-spawning** — one `SendMessage` by raw
id costs nothing, reads both directions: substantive reply = context survived, routing failure
= fall back to fresh spawn. Re-spawning first, on the assumption a restart always kills a
delegate, throws away exactly the context this probe would have recovered.

**Raw id is recoverable even unrecorded**: `subagents/` directory's filenames
(`agent-<raw-id>.jsonl`) ARE the ids — a handover note should still carry it explicitly,
otherwise only route is that directory scan.

⚠ **TUI's silence is not evidence either way — never shows a resumed agent.** A revived agent —
alive, responsive, full prior context intact — does not appear anywhere in the interactive agent list, so
"nothing listed" is never proof it's gone; check by probing (above), never by reading the list.

⚠ **Honest scope**: what's reproduced = REACHABILITY-WITH-CONTEXT across a restart, on this
harness version, in cases actually observed. Treat as a probe worth running first, not as a
permanent guarantee — don't generalize into "a restart never loses an agent" any more than the
retired wording generalized the opposite.

## A delegated agent's transcript is a DIFFERENT file from the session's own

A freshness watcher armed on "the agent's transcript" is easy to point at the wrong file —
natural guess, the session's own conversation log, isn't it:

```
<projects-dir>/<session-id>.jsonl                              ← the SESSION's own conversation
<projects-dir>/<session-id>/subagents/agent-<raw-id>.jsonl      ← the DELEGATE's own transcript
```

⚠ **A watcher armed on the top-level file is a hollow guard.** Measures session's own writes,
not the delegate's — reports "active" as long as session keeps talking regardless of whether
delegate working, stuck, or gone; silence indistinguishable from a healthy delegate. Point any
freshness check at `subagents/agent-<raw-id>.jsonl`, confirm file exists before arming: absent
file = watcher never armed, not a quiet delegate.

**Side benefit**: filenames under `subagents/` ARE the raw ids (`agent-<raw-id>.jsonl`) —
dependency-free way to recover a delegate's raw id when name stops resolving, no dependency on
any optional hook or state directory being enabled.

## The naming/observer trade-off — state it, don't pick a side

Delegate definition declares a paired read-only observer → how it's spawned changes whether
observer attaches, on this same undocumented surface:

| Spawn shape | Observer attaches | Addressable by name | Addressable by raw id |
|---|---|---|---|
| anonymous (no `name`) | yes | no | yes (recover via `subagents/`) |
| `name` **+** an isolated worktree | yes | yes | yes |
| `name` alone | **no** (drops silently) | yes | yes |

Third row's drop is conditional: happens once session already has other addressable teammates
(team context initializes lazily) — very first named spawn can still land the observer even
without isolation. Don't reason whether condition holds for a given spawn; pick a shape safe
either way.

Real three-way trade-off, not a rule to prescribe once: anonymous keeps observer at cost of
name-based addressing (recoverable via raw id above); named-without-isolation risks losing
observer silently; named-plus-isolated keeps both — EXCEPT when delegate hands its own
increment to an external executor lane, because an isolated worktree with zero-diff at idle
gets reaped while lane still runs inside it, making that combination unusable for a
lane-delegating delegate specifically. State which shape a coordinator uses and why, rather
than defaulting to one without saying so.

## Pass LIVENESS_AGENT_ID to every delegate you spawn directly

Via `pilot-wave` or direct spawn of `pilot`/`pilot-orchestrator` — same discipline applies: a
delegate can't read its own raw agent id from inside itself, no environment variable carries
it. Never hand it over → its liveness file (arc watcher's third correlation input; see
"Liveness file" in `pilot.md`/`pilot-orchestrator.md`) degrades to a weaker key (declared name)
or, for an anonymous spawn, to `UNCORRELATABLE`. Anonymous isn't rare — it's the ONLY safe
shape for a delegate handing its increment to an external executor lane (see trade-off above),
exactly the population most likely to lose correlation.

`Agent` tool returns raw id only when spawn call RETURNS, after prompt already sent — id is
never a field inside the brief, it's a follow-up. Moment spawn call returns, before next
action, `SendMessage` the delegate one line:

```
LIVENESS_AGENT_ID: <raw id>
```

Do this for every direct spawn of a `pilot` or `pilot-orchestrator`, named or anonymous. Costs
one short message, closes the gap for exactly the delegates the mechanism most needs to cover.
