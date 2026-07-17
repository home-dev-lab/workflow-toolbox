# Observing a workflow run (Workflow Observatory)

> **Scope / status.** Run visualization lives in **Workflow Observatory**, the localhost
> companion app of this plugin (free tier for noncommercial use; distribution being set
> up — see the repo README). It is **not** part of the shipped plugin itself: the plugin
> bundles the `wt-observe` launcher, which starts the app **once a Workflow Observatory
> installation is present on the machine** (the upcoming binary distribution, or a local
> checkout — without one, `wt-observe start` reports it cannot locate the server, which
> is expected). This reference teaches
> how to launch a workflow so you can *watch it unfold* and how to read the result,
> **and is candid about what it cannot show.** Everything below is grounded in real runs
> against the server, not assumptions.

The server (`wt-observe start`, on `http://localhost:5174`) renders a run as a
**phase → agent DAG**. There are two ways to see a run: **live** (as it executes) and
**post-mortem** (replayed from disk after it finishes).

## Live — delegated SDK launch (the rich pathway)

The **server** launches the workflow through the Claude Agent SDK and owns the stream, fanning
the live model out to every viewer.

- **Launch:** `POST /api/launch { script, args? }` → `{ runId }`, then `GET /api/stream?runId=…`
  (SSE). Or the browser **Launcher**.
- **Fidelity: full.** The SDK's `workflow_progress` carries, per agent, the real
  `phaseIndex` + `phaseTitle`, `tokens`, `state`, and the phase→agent **edges** — so you get the
  workflow's **true DAG**, phase titles included. Phase indices here are **1-based**
  (`phase('Generate')` → index 1).
- **Constraint:** `script` must resolve inside the server's allowlisted workflow roots:
  every dir listed in `OBSERVE_WORKFLOWS_DIR` (colon-separated — several dirs are allowed),
  plus the app's own bundled `workflows/` root. So this is the path for **committed,
  compiled** workflows (author in `.workflow.ts`, build, point `OBSERVE_WORKFLOWS_DIR` at
  the output dir, then launch the artifact by name). No arbitrary-path exec.

This is the only pathway that shows the genuine per-pattern structure *as it happens* — so it is
the meaningful way to **watch** a pattern run. An **inline / non-compiled** fan-out you drive
from a conversation has no `.js` to delegate, so it has **no live UI** — *compile to observe*.

## Post-mortem — disk replay (any finished run)

Every completed run is reconstructed from its on-disk journal + transcripts, no launch needed:
`GET /api/runs[?project=<slug>]` lists recent runs and `GET /api/runs/:runId` returns the patch
log + raw transcripts. The **RunPicker** — a grouped-by-project/date combobox with a hover/focus
detail popover — reads `GET /api/timeline` (runs + pipelines merged) and drives both. This works
for **any** finished run — including the ones you launch from your own session with the Workflow
tool — and rebuilds the same rich phase→agent model (phases, agents, tokens, message bodies) from
what the runtime wrote at completion.

## The nine patterns, observed

Via the live SDK pathway (or disk replay of a finished run) each pattern shows its genuine
structure — phases, edges, tokens — because that data comes from the SDK stream / journal, not a
guess. That is the meaningful way to "see" a pattern run.

## The two wire protocols observe parses

Both live in `@workflow-toolbox/runtime` (sandbox-pure, bundled into artifacts), and
each side — toolkit emit, observe parse — imports the same module, so the formats
cannot drift apart silently:

- **Phase digests** (`digest.ts`) — each pattern `log()`s one structured line per phase
  (`formatDigest`/`parseDigest`; shapes `PhaseDigest`, plus the emit-side-typed
  `TypedPhaseDigest` used by `emitDigest` so each pattern's counts vocabulary is checked
  at the call site): the emitting pattern's `stage`, the phase title, branches
  taken/notTaken, and per-pattern counts. Observers parse these to annotate each phase
  with what the pattern actually did.
- **Prompt tags** (`prompt-tag.ts`) — `defineWorkflow` wraps the runtime with
  `withPromptTags`, prefixing every labeled/phased agent prompt with one HTML-comment
  marker line (`<!-- wt-meta label="…" phase="…" -->`; `buildPromptTag`/`parsePromptTag`).
  Mid-run, an attached run has label/phase on disk nowhere else — the tag is what lets a
  live observer assign each agent to its phase column from the moment it spawns, instead
  of waiting for the terminal journal.

## Quick recipes

- **Watch a saved/compiled workflow live:** build it into `toolkit/workflows/` (or point
  `OBSERVE_WORKFLOWS_DIR` at it), then `POST /api/launch { script }` (or the Launcher) and open
  `/api/stream?runId=…`. Full DAG.
- **Inspect a finished run (incl. your own Workflow-tool runs):** open the RunPicker (it reads
  `/api/timeline`), pick the run — the full model is replayed from disk.
- **Educate the user on the limit:** live observation requires a **compiled artifact** the
  server can launch; an inline workflow run in your own session is observable only **after** it
  finishes, via disk replay.

## Removed: the hook-fed own-session pathway

An earlier pathway (path B) tried to observe a workflow running in your **own** terminal session
*live*, via Claude Code lifecycle hooks POSTed to the dev server. It was **removed** because it
was coarse by construction — hooks carry only `{ session_id, agent_id, agent_type }`, so there
are **no edges, phases, or tokens**; runs were session-keyed (two workflows in one session
merged), and an `agent_type` reused across phases collapsed into one column. The retrospective —
everything tried (prefix filter, `p<N>` name encoding, declared shape, `agent_type→phase` map,
the `declare-shape` CLI) and why it was dropped — is
Workflow Observatory ADR 0006 (an observe-product decision record, shipped with that
product's own repository). Net today:
**live = compiled artifact via the SDK; own-session / inline = disk replay after it finishes.**
