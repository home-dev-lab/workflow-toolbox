---
name: workflow-debugger
description: >-
  Diagnose why a Claude Code Workflow-tool RUN failed or behaved oddly, from its
  on-disk run journal, and decide whether a `resumeFromRunId` re-launch will actually
  help. Invoke when a workflow launched but errored, returned a wrong or partial
  result, seems stuck, or the user asks "why did my workflow fail", "debug my
  workflow run", "the workflow errored / died", "can I resume this run", "what
  happened in run wf_…", or wants a run's journal read and explained. It reads the
  structured journal Claude Code writes for every run (the per-agent `agent-*.jsonl`
  transcripts are only a fallback), classifies the failure mode, and recommends —
  honestly — when resuming replays cached work and when it would save nothing. Out of
  scope: AUTHORING or restructuring a workflow script (that is the workflow-composer
  skill) and checking whether a Claude Code upgrade changed the runtime surface (that
  is the upgrade-canary skill).
argument-hint: "[runId|latest|<journal-path>] [--json] [--project <slug>]"
---

# Workflow debugger — diagnose a Workflow run from its journal

When Claude Code's Workflow tool runs a script, it writes a **run journal** to disk:

```text
~/.claude/projects/<project-slug>/<sessionId>/workflows/wf_<runId>.json
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
  or pass `--project <slug>` to point at a different `~/.claude/projects/<slug>`. Both
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
| `script-throw` | status `failed` (or `async_launched`), no incomplete agents | the script threw — bad args, a syntax/`meta` error (`async_launched` = never even ran), or a runtime error in deterministic code |
| `agent-died` | an `agent()` event ended in a state other than `done` | a subagent died (`agent()` returned `null`); the run may show a partial result or a downstream throw on the hole |
| `schema-retries` | an agent took `attempt > 1` | StructuredOutput rejected outputs and forced retries — wasted latency/tokens; tighten the schema |
| `in-progress` | no terminal status recorded | still running, aborted, or a **zombie** (a dead agent the web UI still lists as running) |

The report also lists **secondary findings** regardless of the primary mode — e.g. a
`completed-ok` run still flags any schema retries, and a `script-throw` whose error text
mentions budget is flagged as a possible budget-floor exhaustion.

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

Across every real journal on disk, agents only ever end `done`, `attempt` is always `1`,
and failures are arg-validation throws. So `agent-died`, `schema-retries`, and
budget-exhaustion detection are **inferred from the SDK contract, not observed** — they
key off robust structural signals (a non-`done` state, `attempt > 1`) and, for budget,
only an advisory text Finding (never a primary verdict, so a wording miss costs nothing).
If a run exhibits one of these for real, treat the classification as a strong hint and
confirm against the agent's transcript.

## How it works (for maintenance)

The logic is a tested package in the toolkit; the plugin ships only the bundled artifact.

- `@workflow-toolbox/debugger` `journal.ts` — tolerant journal types + `parseJournal` (never throws) +
  agent accessors (`doneAgents`/`incompleteAgents`/`retriedAgents`). Unit-tested.
- `diagnose.ts` — the pure decision table `diagnoseRun` + `recommendResume`. Unit-tested.
- `format.ts` — the pure text report. Unit-tested.
- `source.ts` — impure journal resolution (filters `wf_*` before the mtime sort so a sibling
  `agent-*.meta.json` never wins "latest"). Held out of `pnpm test`.
- `cli.ts` — the entry esbuild bundles into `plugin/bin/wt-debug.mjs` (node ESM, zero npm
  deps). `pnpm debugger:build` re-freezes it byte-identically into both `toolkit/bin/` and
  `plugin/bin/`; a byte-identity test guards against drift.

Related: **workflow-composer** authors/repairs the script itself; **upgrade-canary** checks
whether a Claude Code upgrade moved the runtime surface this debugger reads. **`npx workflow-toolbox report
[runId|latest|<journal-path>]`** is the sibling read of the same journal for a different question — not "why
did it fail?" but "what did it cost, what did it decide, where are the transcripts?": a per-agent
token rollup (reconciled to the run total), a per-agent **token breakdown** (input / output /
cache-read / cache-write, read from each agent's transcript), the decision trail, and best-effort
transcript links. When a run *has* agents (e.g. an `agent-died` you are diagnosing), `workflow-toolbox report`
is where you drill into that agent's cost and open its transcript. The breakdown is a separate
section from the journal cost rollup — the transcript sum (per-turn billed tokens) and the journal
`tokens` aggregate are different measures and are not reconciled.
