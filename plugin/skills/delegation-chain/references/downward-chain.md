This reference belongs to the delegation-chain skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## 1. The downward chain — how a delegate is spawned, and what each shape costs

| Spawn shape | Named? | Observer attaches? | Worktree-cleaner risk | Good for |
|---|---|---|---|---|
| anonymous (no `name`) | no | yes | none (no dedicated worktree unless the delegate makes its own) | a delegate that hands its writes to an external executor lane |
| `name` **+** `isolation` | yes | yes | none | any delegate that must be addressable by name AND does not delegate its writes elsewhere |
| `name` alone (no `isolation`) | yes | **no — dropped silently** | n/a | avoid |
| installed via a PLUGIN (a namespaced type) | — | **no — pairing skipped silently, no warning** | n/a | never, if the observer matters — adopt an editable project copy instead |

**A user-level local copy of the same bare name silently WINS over a plugin registration**,
qualifying every row above: `<config-dir>/agents/<name>.md` shadows `plugin/agents/<name>.md`
on a bare-name spawn, with no version banner and no fingerprint marking it as a shadow. It
never updates when the plugin ships a fix, and it sits outside every staleness check the
plugin's own adoption tooling performs — a bare-name spawn that "looks like the current
plugin version" can silently be running a stale local file instead, months out of date, with
nothing in the spawn result or the agent listing distinguishing the two. Before trusting that
a bare-name spawn resolves to the plugin's current definition, check whether a same-named file
exists in the local agent directory first.

**A plugin-registered agent's `permissionMode`, `hooks`, and `mcpServers` frontmatter fields
are silently NEUTERED — read, then ignored, with only a warning for these three; `observer`
and `observerMessage` are ignored with NO warning at all.** A reader who declares
`permissionMode: <restrictive>` on a plugin-registered agent, expecting it to fence the
agent's behaviour, is trusting a field the loader discards. The one mechanical fence that
survives plugin registration is `disallowedTools` (a pattern-based denylist, matched against
the literal tool invocation) — everything else requiring `permissionMode`, a custom `hooks:`
entry, a scoped `mcpServers:` list, or a paired `observer` needs an editable, non-plugin-
registered copy (a local `.claude/agents/` file) to actually take effect. This is exactly why
a suite that ships an `observer:` watchdog distributes its definitions unregistered and
requires project adoption — a plugin-registered copy would run with no watchdog and no error
telling you so.

⚠ **`disallowedTools` is not the safe fence it looks like either, for one specific shape: a
`Bash(<pattern>)` entry removes the ENTIRE Bash tool, not the matched invocation.** A single
entry like `disallowedTools: ["Bash(git push --force:*)"]` makes every Bash command fail with
"No such tool available: Bash" — while the agent's own listing still reads "All tools except
Bash(git push --force:*)", giving no hint that the tool is gone rather than narrowed. This
directly undercuts the previous paragraph's "disallowedTools is the one mechanical fence" —
it is, for any non-Bash tool pattern, but a Bash-scoped entry is a trap disguised as the
fix. Refuse a dangerous Bash verb with a `PreToolUse` hook instead: it refuses the
INVOCATION and leaves the tool intact.

Two mechanisms explain the middle two rows, and both are read from the harness, not guessed:

- **A named spawn with no `isolation`, once the session already has a team context, is routed
  down an in-process-teammate path that REBUILDS the agent definition instead of using it**: the
  observer pairing is never read, and a permission-mode fence the definition declared can be
  overwritten too. The condition is invisible at the moment you spawn — the identical call keeps
  everything intact in a headless run and silently drops it in an interactive one — so don't
  reason about whether it currently holds; treat the row as true unconditionally. `isolation`
  keeps the spawn on the normal path, which is why pairing `name` with `isolation` is safe again.
- **An isolated worktree is auto-cleaned when it is UNCHANGED at the moment the delegate goes
  idle.** A delegate that routes its implementation to an external executor lane has a
  ZERO-DIFF tree by construction at exactly that moment: its own writes are zero, the lane's
  writes have not landed yet. The reaper can remove the tree — directory, branch, and git
  metadata — WHILE THE LANE IS STILL WRITING INTO IT. This is why a lane-delegating delegate
  cannot safely use `name` + `isolation` even though that combination is otherwise the safest
  named shape: it needs its OWN hand-created worktree (outside harness-managed isolation)
  instead, passed to it as a path in its brief.

**The consequence that follows from both rows together**: a delegate that delegates its own
writes to an external lane is anonymous **by construction**, not by preference — every named
alternative either drops its observer or gets its tree reaped mid-write. Do not read "spawn
anonymously" as a stylistic default; read it as the only shape left once the lane-delegation
requirement is factored in.

### The identity problem this creates, and how it is resolved

An anonymous delegate cannot read its own raw agent id (no environment variable carries it), and
it has no declared name to fall back on either — so it has no identity a watcher can correlate it
against, from either end.

The resolution is a **three-tier cascade**, evaluated by the delegate itself in this order:

1. **An explicit `LIVENESS_AGENT_ID: <raw id>` line**, sent by the spawner as an IMMEDIATE
   FOLLOW-UP `SendMessage` right after the spawn call returns — never embedded in the composed
   brief text, because the raw id does not exist until the spawn call has already gone out with
   whatever prompt was written. A spawner following this discipline sends the id as a first
   message; a delegate that reaches its own intake step without having seen this line checks its
   inbox for it before falling back to tier 2 — its absence from the initial prompt does not mean
   it was never sent, only that it has not arrived yet.
2. **The delegate's own declared spawn name**, if it has one.
3. **Neither.** The delegate is UNCORRELATABLE — an explicit, named state, never a silent gap.

Every watcher keyed on identity (the arc watcher, the liveness file, the observer-pairing
checker) degrades along this same cascade, and a spawner that skips step 1's follow-up message
silently loses the strongest tier for every anonymous delegate it spawns — not only the
lane-delegating ones; singling out one spawn shape for the follow-up is how the discipline gets
forgotten on the rest.

### Two more spawn-shape traps: a cost trap and a capability lie

- **`subagent_type: "fork"` clones the ENTIRE spawner conversation on every spawn, paid as a
  cache-write.** It is tempting to reach for as a cheap placeholder — "spawn something to wait
  for this event" — but a fork copies the whole accumulated conversation regardless of what the
  forked agent actually does with it; a noop/placeholder fork used this way has cost hundreds of
  thousands of tokens for work that a zero-cost background Bash tick (a bounded sleep loop
  exiting on a condition) would have done for free. Reach for `fork` only when the task genuinely
  needs the accumulated reasoning history, never as a lightweight wait-primitive or relay.
- **`TaskList`/`TaskGet`/`TaskCreate`/`TaskUpdate` are gated by AGENT ROLE, not by a `tools:`
  allowlist — no configuration grants them to an ordinary subagent, and declaring them in a
  definition's `tools:` is a promise the agent can never keep.** The strip happens AFTER
  allowlist resolution, so even an unrestricted `tools: *` does not restore them; a subagent
  whose `tools:` is additionally *restricted* gets nothing at all back from `ToolSearch` for
  them either — not an error, just silence indistinguishable from "not deferred yet", which
  invites retrying a call that will never succeed. The two working routes are: the spawner
  relays task state in the prompt (no side effects, the one to prefer), or the agent is spawned
  as an agent-team teammate — which keeps the task tools but is a named spawn, trading away
  observer pairing exactly as described above unless it is also isolated.

### What this section does NOT cover

- Whether a NESTED worktree a delegate creates on top of its own isolation, or on top of its
  hand-created lane worktree, is itself subject to the same reaping condition — unverified; the
  measurement that established the reaping trap only exercised a top-level isolated tree.
- Whether the identity cascade's tier 1 survives a spawner that itself gets compacted between
  the spawn call returning and the follow-up message being sent — not exercised.

