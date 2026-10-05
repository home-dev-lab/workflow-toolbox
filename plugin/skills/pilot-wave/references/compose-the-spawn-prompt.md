This reference belongs to the pilot-wave skill; all paths are relative to the skill directory (the parent of references/).

## Step 3 — compose the spawn prompt (with model elevation)

Before composing any pilot or orchestrator spawn, run the shipped model resolver CLI:

```bash
node <plugin-root>/bin/wt-pilot-models.mjs
```

It resolves `WT_PILOT_MODEL`, `WT_PILOT_HARD_MODEL`, and `WT_ORCHESTRATOR_MODEL` in that order
from the process environment, the active `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`
`env` block, or the shipped default `sonnet`. The CLI prints each resolved value and its source.
Use `model=<value>` from that output on the corresponding spawn: `pilot` for an ordinary card,
`pilotHard` when the card is classified hard by the stated criteria, and `orchestrator` for a
wave. The prompt must name the same `model=<value> (source=<env|settings|default>[, effective=<model> via ANTHROPIC_DEFAULT_<ALIAS>_MODEL (<env|settings>)])` — a GPT pilot is the same alias under a profile that remaps it, never a separate runner; never let an
unresolved value inherit the session model. A refused value stops the spawn and names the
opencode-runner follow-up rather than falling back.

⚠ **A `name` on a typed spawn costs you the observer — unless you also pass `isolation`.**

In a session that already has addressable teammates, a named spawn is routed down the
in-process-teammate path, and that path **rebuilds** the agent definition instead of using it:
the `observer:` pairing is never read, `permissionMode` is overwritten, and the definition's
system prompt survives only as an appendix to a generic base prompt. Read from the harness
source (CLI 2.1.220) and confirmed by measurement.

The condition is narrow and invisible at the moment you spawn — the same call keeps everything
in a headless run and loses the observer in an interactive one — so do not reason about
whether it holds. **Two shapes are safe, and both were verified end to end:**

| Shape | Observer | Tools | Your name visible |
|---|---|---|---|
| anonymous (no `name`) | attached | intact | no |
| `name` **+** `isolation` | **attached** | intact | **yes** |
| `name` alone | **dropped** | intact | yes |

`isolation` keeps the spawn on the normal path (the harness's own condition excludes it), so
naming is free again as long as it travels with it. Measured: a named+isolated pilot got its
watchdog 4 seconds after spawn, ran Bash, and had the destructive-action guard refuse a
publish attempt.

Two practical notes on `isolation`, both measured:

- It puts the agent in a worktree of the repo, and **the agent can still create its own**
  worktree on top if its brief calls for one — nested creation works and cleans up. In most
  cases it no longer needs to.
- It requires the **spawning session's** working directory to be inside a git repository, not
  the repo you are targeting. On an umbrella project holding several repos, a spawn succeeds
  or fails depending on where the shell happens to be; the failure is explicit, not silent.

If you spawn anonymously, `SendMessage` still reaches the agent by the agent id the spawn
result gives you.

Spawn the orchestrator (wave) or pilot (single card) via the Agent tool. **Elevate the model
AT SPAWN**: the shipped agent definitions deliberately OMIT a `model:` field. With no pin, the
agent inherits the SESSION's own model — which is available by construction, because it is the
model already running this session. A PINNED `model:`, by contrast, could name a tier the
user's account cannot access, and that hard-fails the spawn. Omitting the pin is therefore what
makes the definition portable; YOU, the spawner, still SHOULD elevate explicitly here — the
Agent tool's `model` parameter overrides the frontmatter, so pin the strongest model you can
reliably call, falling back down the tiers if the top one is not available. Effort is pinned in
the definitions and is universal — leave it unless you have a reason.

One pairing fact behind why adoption is required at all: current Claude Code versions do not
honor the `observer:` frontmatter for plugin-REGISTERED agents — a pilot spawned that way
would run WITHOUT its `pilot-watchdog` observer attached, silently. That is why the pilot
suite ships as templates rather than registered agents: there is no namespaced
"workflow-toolbox:pilot" type to spawn as a fallback, only the adopted project copy.
**Resolution rule for every spawn this skill composes: check the project's `.claude/agents/`
first — if it carries a `pilot.md` (and, for a wave, a `pilot-orchestrator.md`), spawn the
BARE names (`pilot`, `pilot-orchestrator`).**
**When no project copy exists, PROPOSE the adoption before spawning anything — don't tell the
user to go do it and don't invent a namespaced type to spawn instead**: explain that without
project copies there is nothing to spawn (the templates are inert on their own), name exactly
what would be installed where (`pilot.md` + `pilot-watchdog.md` — plus `pilot-orchestrator.md`
and `pilot-orchestrator-watchdog.md` for a wave — from the plugin's `agent-templates/`
directory into the project's `.claude/agents/`, bare names, trivially reversible). Make the
copy through the `workflow-toolbox:adopt` skill (`--set agents --install`), NOT a raw
file copy: adopt stamps each copy with a version banner + content fingerprint, so a
later `--check` DETECTS when the plugin has moved ahead of the copy (a hand copy has no
staleness detection). Then spawn the bare names. If the user declines the adoption, this
skill cannot proceed — say so plainly rather than falling back to something that no longer
exists.

The spawn prompt must carry:

1. The card id(s) + a digest of each card's comments (the design is often arbitrated there); put one `PILOT-CARD: <id>` line per assigned card at column 0, outside code fences, for the duplicate-pilot guard to read.
2. Repo scope with ABSOLUTE paths — and, when it matters, **which repos/dirs are PUBLIC vs
   private** (a write that lands product artifacts on a public surface is outward-facing; the
   agents treat that as a boundary concern to flag, not a silent commit — see below).
3. The resolved environment-brief blocks from Step 1.
4. Invariants, non-goals, and known traps for the work.
5. The file-report contract: "write your full report to a file under `REPORT_DIR`, named so
   its basename does NOT start with `report`/`summary`/`findings`/`analysis` (e.g.
   `<cardId>-report.md`); your final message is ONE line: REPORT WRITTEN: <verdict>".
6. "Address escalations to <the spawning agent> via SendMessage."
7. `LIVENESS_AGENT_ID` is deliberately NOT in this list's prompt text — the raw agent id does
   not exist until the spawn call returns, one step after the prompt is composed. See the
   subsection right below for how it actually reaches the delegate.

If the spawn prompt overrides `STOP_GATE_INTERVAL_MIN`, name it explicitly. Otherwise the
orchestrator uses its default 10-minute close gate: when declaring a tier or mission COMPLETE it
must do two live re-queries separated by at least that much real elapsed time, and both reads must
come back empty/resolved.

### LIVENESS_AGENT_ID — sent as the first follow-up message, never inside the composed brief

The `Agent` tool hands you the raw agent id only in its RETURN value, after the spawn call has
already gone out with the prompt text you composed. So the id cannot literally be a field
inside that prompt — treating it as one is the actual trap here (see the knowledge-base fiche
`delegate-cannot-name-itself`: a constraint written before the mechanism it serves is tested
can read as reasonable and still be unsatisfiable).

**The resolved shape**: the moment the `Agent` call returns, before doing anything else,
`SendMessage` the newly-spawned agent one line:

```
LIVENESS_AGENT_ID: <raw id from the Agent tool's return value>
```

Queued messages are delivered at the delegate's next tool round, so this reaches it before its
own first tool call in the overwhelming majority of cases — early enough for the intake-time
liveness write `pilot.md`'s tier-1 cascade step expects. Do this for EVERY spawn this skill
composes — named, anonymous, isolated — not only the lane-delegating case that motivates it;
singling out one spawn shape is how the discipline gets forgotten on the others.

This is the SENDING half of the cascade `pilot.md` and `pilot-orchestrator.md` already document
on the RECEIVING side (`agentIdSource: "brief" | "name" | "none"`). Skip this message and every
delegate spawned through this skill falls back to tier 2 (its own declared name) or tier 3
(`UNCORRELATABLE`) — silently losing exactly the correlation coverage the mechanism exists to
provide for anonymous, lane-delegating pilots.

