---
name: workflow-debugger
user-invocable: true
description: >-
  Invoke when you are diagnosing a workflow run that errored, returned a wrong or partial result,
  or seems stuck, or when the user asks "why did my workflow fail", "debug my workflow run",
  "the workflow errored / died", "can I resume this run", or "what happened in run wf_…". Read
  the on-disk run journal first, use per-agent transcripts only as fallback, classify the
  failure mode, and say honestly whether `resumeFromRunId` will replay cached work or save
  nothing. Not for authoring or restructuring a workflow script, or for checking runtime drift
  after a Claude Code upgrade.
argument-hint: "[runId|latest|<journal-path>] [--json] [--project <slug>]"
---

# Workflow debugger — diagnose a Workflow run from its journal

When Claude Code's Workflow tool runs a script, it writes a **run journal** to disk:

```text
$CLAUDE_CONFIG_DIR/projects/<project-slug>/<sessionId>/workflows/wf_<runId>.json
(default config dir: ~/.claude)
```

That journal — not the launch message, not the per-agent transcripts — is the single
structured record of what happened: the final `status`, the `error` (with stack) if it
threw, every `agent()` call's state and token cost, the phases, and the totals. This
skill reads it, says **what went wrong**, and decides **whether `resumeFromRunId` helps**.

> **Journal-first.** Claude Code's own Workflow-tool docs name the per-agent
> `agent-<id>.jsonl` transcripts as the FALLBACK "when no journal is available". So this
> skill diagnoses from `wf_<runId>.json` and only drills into a transcript when you need
> one agent's full reasoning.

## Run it

```bash
# primary (plugin install — the bundled, zero-dependency CLI; nothing to install):
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-debug.mjs" [runId|latest|<journal-path>] [--json] [--project <slug>]

# npm alternative (any project with @workflow-toolbox/build installed) — and the
# only path for the audit REPORT, which the bundled bin does not do:
npx workflow-toolbox debug  [runId|latest|<journal-path>] [--json] [--project <slug>]
npx workflow-toolbox report [runId|latest|<journal-path>] [--project <slug>] [--out <dir>] [--quiet]
```

(`pnpm exec workflow-toolbox …` is the equivalent of `npx workflow-toolbox …` in pnpm-managed projects.)

- `<runId>` is the `wf_<id>` from the launch result (the `wf_` prefix is optional).
- `latest` (or no argument) diagnoses the newest run in the current project.
- A literal **journal path** (`…/workflows/wf_<runId>.json` — exactly what error
  messages print) is also accepted as the positional, bypassing project discovery.
- `--json` emits the raw `Diagnosis` for scripting; default is a readable report.
- Run it **from the directory the workflow ran in** (the journal is keyed by that cwd),
  or pass `--project <slug>` to point at a different `$CLAUDE_CONFIG_DIR/projects/<slug>`. Both
  `--project <slug>` and `--project=<slug>` work, **including the leading-dash slugs**
  Claude project dirs always use (e.g. `--project -home-me-my-repo`). The CLIs print a
  `[project dir: …]` line saying which project directory was actually scanned — check
  it whenever `latest` finds a surprising run.

> **⚠ Post-mortem only (current Claude Code).** The `wf_<runId>.json` journal only
> materializes when the run **completes** — observed live on CC 2.1.170: mid-run the
> session's `workflows/` dir has no journal yet, only an incremental `journal.jsonl`
> plus the per-agent transcripts. A **live or hung run therefore cannot be diagnosed
> here** — wait for it to finish (or abort it via the web UI / `/workflows`), then
> diagnose. The `in-progress` verdict below only appears for a journal written without
> a terminal status, not for a healthy still-running run.

> **Maintainer note (this repo):** from `toolkit/`, the same commands run as
> `pnpm wt:debug …` and `pnpm wt:report …`.

## The failure modes (one primary per run, total + mutually exclusive)

| Mode | Journal signal | What it means |
|------|----------------|---------------|
| `completed-ok` | status `completed`, every agent `done`, no retries | healthy — nothing to fix |
| `script-throw` | status `failed` (or `async_launched`), no incomplete agents | the script threw — bad args or a runtime error in deterministic code. (`async_launched` = never even ran; kept defensively — on the current runtime a rejected script writes **no journal at all**, so this status should not appear on disk) |
| `agent-died` | an `agent()` event ended in a state other than `done` | a subagent died (`agent()` returned `null`); the run may show a partial result or a downstream throw on the hole |
| `schema-retries` | an agent took `attempt > 1` | StructuredOutput rejected outputs and forced retries — wasted latency/tokens; tighten the schema |
| `in-progress` | no terminal status recorded | still running, aborted, or a **zombie** (a dead agent the web UI still lists as running) |

The report also lists **secondary findings** regardless of the primary mode — e.g. a
`completed-ok` run still flags any schema retries; a `script-throw` whose error text
mentions budget is flagged as a possible budget-floor exhaustion; and a `script-throw`
whose error reads `subagent completed without calling StructuredOutput` gets a
**schema-hint** finding (a schema failure wearing a script-throw costume — see below).

## Reading the resume recommendation (the part that matters)

`resumeFromRunId` re-launches a run and **replays completed `agent()` calls from cache**,
so only the failed/missing work runs again. Two hard rules decide whether that helps:

1. **Same session only.** The cache lives in the Claude Code session that produced the
   run. If you read this journal in a *different* session (the normal case for post-hoc
   debugging), there is no cache to replay and resuming re-runs **everything** — so prefer
   fixing the script and running fresh. The report prints the originating `sessionId` next
   to the warning; compare it to your current session.
2. **Something must have run.** Resuming only saves work if agents actually completed
   before the failure. A `script-throw` with **0 done agents** (the common arg-validation
   case) cached nothing — resuming saves nothing. `agent-died`, and a late throw *after*
   agents completed, are the cases where resume genuinely pays off.

So the recommendation is: **resume** for `agent-died` and a late `script-throw` with
cached agents (same session); **fix-and-rerun** for an early `script-throw` /
`async_launched`; **nothing to do** for `completed-ok`/`schema-retries`; **don't resume a
live run** for `in-progress` (check the web UI for a zombie first).

## Honesty about what is observed vs inferred

Open [references/observed-vs-inferred.md](references/observed-vs-inferred.md) when confirming an agent-state or schema-failure classification against transcripts.

## Reached no external model (a diagnosable class, not a mystery)

A run that was supposed to route a role to a cross-family bridge (`codex:codex-rescue`,
`workflow-toolbox:opencode-verifier`, `workflow-toolbox:opencode-envelope`) and quietly never called out is a known cause,
not an open question — check it directly rather than re-reading the whole journal.

⚠ **A non-empty answer is NOT evidence a call happened.** The wrapper agent has a
model of its own and can self-answer instead of shelling out — measured. **The badge
shown in the run UI is uninformative too, and for two different reasons depending on
the lane shape**: on the wrapper path it shows the WRAPPER's OWN model (e.g. `haiku`)
whether or not the CLI ran. That badge does not tell you whether the external call
actually happened.

What DOES discriminate — read the per-agent transcript (or the pipeline's stage
record) directly:

- **Wrapper agentType (a workflow role routed to `codex:codex-rescue` /
   `opencode-verifier`)**: look for a real external-CLI `tool_use` in that agent's own
   transcript, quoted with its `--model` flag. No such call in the transcript = no
   external model reached, whatever the agent's final answer reads like.

## Thin-envelope runs

Open [references/thin-envelope-runs.md](references/thin-envelope-runs.md) when diagnosing a run routed through a thin external-model envelope.

## Degraded runs — silently-denied tool calls (blind reviews/plans/impls)

A subagent whose tool call is **silently denied** — the auto-mode permission classifier
blocks it, a PreToolUse hook denies it, or the action is rejected — keeps going and returns
a normal-looking output. The run journal records cost + agent state but **never** the denied
`tool_result` inside the agent, so a review / plan / implementation can be **degraded** (an
agent couldn't read the diff, run the test, reach a file) while the run reads `completed-ok`.
This bit for real: pr-review reviewers were blind when auto-mode declined their read-only
`git diff`, and a blind review nearly approved a commit that did not compile.

So both read paths now scan each agent's transcript for the three grounded denial signatures
— auto-mode classifier (`Permission … denied by the Claude Code auto mode classifier`), a
hook deny (`Hook PreToolUse:<Tool> denied this tool`), and a generic rejection (`The tool use
was rejected`) — and surface a **Tool denials** section: `⚠ N tool call(s) DENIED across M
agent(s) … git diff ×7`, with the per-denial stage/tool/command/reason. The match set is a
**closed allow-list** (precision over recall): ordinary tool errors — non-zero exit codes, MCP
arg-validation, oversize-read caps, 404s, `No such tool available` — are deliberately **not**
flagged, so a clean run never false-alarms. The **Stop hook** treats any denial as a block
trigger (a degraded run is surfaced even when its journal says `completed-ok`), and
`workflow-toolbox report` renders the same section. Caveat: a run that diagnoses as `in-progress`
/ killed is not scanned (the journal isn't conclusive), and a probe workflow that *intends* to
hit a denial will honestly read as degraded — the human reads the report.

## The `wt-observe` launcher CLI (ships in the same package)

Open [references/wt-observe-launcher-cli.md](references/wt-observe-launcher-cli.md) when managing the live Observatory server or launching, awaiting, or recovering its runs.

## How it works (for maintenance)

Open [references/how-it-works.md](references/how-it-works.md) when maintaining the debugger or drilling into its implementation and audit-report modules.
