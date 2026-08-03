---
name: upgrade-canary
description: >-
  Re-verify that Claude Code's Workflow-tool runtime still behaves the way the
  @workflow-toolbox toolkit depends on, after a Claude Code upgrade — and report what changed.
  Invoke when the user upgraded (or might have upgraded) Claude Code and asks
  whether the workflow toolkit / committed artifacts still work, when they say
  "run the upgrade canary", "did the update break the workflows", "re-check the
  runtime surface", "what changed in the runtime", or before cutting a plugin
  release. The canary is version-triggered: the full check runs only when the
  `claude` CLI or the Agent SDK version changed since it last passed (or when
  forced), so it is cheap to invoke often. It tests TWO runtimes — the user's
  interactive `claude` binary AND the SDK-bundled one — and reports their version
  delta + any behavior drift, which can drive fixes or feature work. This is a
  MAINTAINER tool — it runs against this repo's `toolkit/` dev tree and needs
  local Claude Code subscription auth; it is not meant for end users who only
  installed the plugin. Out of scope: authoring or debugging a specific failing
  workflow run (that is the workflow-composer / workflow-debugger skill).
argument-hint: "[--force] [--target system|bundled|both]"
---

# Upgrade canary — re-verify the runtime after a Claude Code upgrade

Claude Code's Workflow tool is a **research preview**: parts of the surface the
`@workflow-toolbox` toolkit relies on (the 512 KB script cap, the "`meta` must be the first
statement" rule, the bundled-artifact launch path) are locally-verified, not
publicly contracted, and can drift on an upgrade. This canary re-checks that
surface, on **both runtimes you actually use**, so a breakage — or a behavior
change worth adopting — is surfaced here, deliberately.

It is **version-triggered, not scheduled**. Claude Code updates almost daily; the
canary first asks "did the runtime change since it last passed?" and only does the
expensive work when the answer is yes, when you pass `--force` — or when the last
recorded verdict is a FAIL, which forces a re-run until green even with no version
change (a real regression is never silently suppressed by an unchanged version).

> **Maintainer tool.** Every command below runs from this repo's `toolkit/`
> directory and drives the real runtime via the Agent SDK under your local Claude
> Code subscription (the SDK reuses `~/.claude` credentials — no API key). The
> canary harness lives in `@workflow-toolbox/smoke`, a **private** workspace
> package that is not published to npm — so unlike `workflow-toolbox scaffold/build/check/
> debug/report`, this skill is **not expected to run from a consumer project**.
> It is not runnable from an end-user plugin install either, which ships only the
> built artifacts, not `toolkit/`. If `toolkit/` is absent, say so and stop.

## The two runtimes

`@workflow-toolbox` workflows run in **two** Claude Code binaries that drift independently:

| Target | Binary | Version source | Track |
| --- | --- | --- | --- |
| **system** | your interactive `~/.local/bin/claude` | `claude --version` | auto-updates ~daily |
| **bundled** | the one shipped inside `@anthropic-ai/claude-agent-sdk` | the run's init message | moves only on `pnpm update` |

They are routinely a patch apart (e.g. system 2.1.167 while the SDK bundles 2.1.168).
The canary runs the checks against **both** and reports each one's measured Claude
Code version, so you see exactly which runtime any breakage or change belongs to.

## What it verifies, per runtime

- **smoke** (positive): launches every committed `toolkit/workflows/*.js` and
  round-trips a real `@workflow-toolbox`-built artifact — proves a VALID artifact still bundles,
  launches, runs, and returns its envelope (the bundling chain, `meta` serialization,
  sandbox globals).
- **edge** (negative): launches deliberately-invalid scripts and asserts the
  runtime still **rejects** them — (a) over the 512 KB cap, (b) a statement before
  `meta`. If an upgrade silently ACCEPTS one, that is the regression this catches.
- **wt:check** (static): lints the committed artifacts (integrity, not runtime).

**Known gap (state it):** the `name`-registry-keyed-by-`meta.name` behavior is NOT
canaried (side-effectful, not headlessly checkable, and least load-bearing — `workflow-toolbox
build` keeps filename == `meta.name`). Check it by hand if needed.

## Steps

### 1 — Decide whether to run (cheap gate)

```bash
cd toolkit && pnpm canary:version        # add --force to bypass the gate
```

| exit | meaning | do |
|------|---------|----|
| `0`  | SKIP — `claude` CLI + SDK unchanged since the last PASS | report "runtime unchanged since `<version>` (last verified `<date>`), nothing to do" and **stop** |
| `3`  | RUN — a version changed, the last run failed, or no marker | go to step 2 |
| any other | the gate itself crashed (a thrown error — the gate only ever exits `0` or `3` deliberately) | surface it |

`canary:version` is **read-only** (it never writes the marker). The gate skips only
when both signals are unchanged AND the last run passed.

### 2 — Run the matrix (only if step 1 said RUN)

```bash
pnpm canary                              # both runtimes; --target system|bundled to narrow
for f in workflows/*.js; do pnpm wt:check "$f" || echo "FAIL $f"; done
```

`pnpm canary` runs smoke + edge against each target, prints a SUMMARY (per-target
Claude Code version, the SDK⇒bundled-CC mapping, installed-vs-latest SDK on npm),
a **WHAT CHANGED SINCE LAST RUN** section, an **AGENT SCHEMA DRIFT** section (the SDK
`AgentDefinition` field set + the least-privilege `Options` fields, diffed against a
committed baseline — the SDK type is the ground-truth PROXY for Claude Code's `.md`
frontmatter parser), a **WHAT THE CHANGELOG DOCUMENTS**
section (the official Claude Code changelog entries for the measured version range,
with toolbox-relevant lines — workflow/agent/tool/sdk — highlighted as drivers for
fixes or features), and **records the marker itself** (it is the sole writer — there
is no separate record step). Exit **0** = every check on every target passed,
**1** = a check failed, **2** = fatal (auth/binary).

### The full canary family

`pnpm canary` runs the matrix; each member is individually runnable when you want
to re-verify one claim (all from `toolkit/`):

| Command | Re-verifies |
|---|---|
| `pnpm smoke` | a VALID committed artifact still launches and completes through the real runtime |
| `pnpm canary:edge` | the runtime still REJECTS what it must (the 512 KB cap; a statement before `meta`) |
| `pnpm canary:nesting` | `workflow()` composes one level deep — and still throws beyond that level |
| `pnpm canary:budget` | budget semantics across two strictly-sequential orchestrator launches |
| `pnpm canary:version` | the cheap gate above (CLI/SDK versions + last verdict vs the marker) — read-only |
| `pnpm canary:agents` | which SDK agent-definition fields the runtime honors (feeds the tested least-privilege recipe builder in `smoke/src/least-privilege.ts`) |
| `pnpm canary:observer` | whether the EXPERIMENTAL `observer:` agent-pairing surface actually attaches at runtime (see below) |
| `pnpm wt:calibrate` | records real-run token signals and derives a grounded `budgetFloor` estimate |
| `tsx packages/smoke/src/capabilities-probe.ts` | the per-run capabilities channel (launch `args` → each agent's declared capabilities) end-to-end |

### 3 — Report and act

Relay the SUMMARY and, crucially, the **WHAT CHANGED** section — it is the point of
the run and may drive work:

- **A version delta** (`bundled: 2.1.167 → 2.1.168`) with all checks green → the
  runtime moved but nothing broke; note it, and skim the changelog for new Workflow
  capabilities worth adopting.
- **A CHECK FLIP** (`... pass → FAIL`) → a regression on that runtime. A **smoke**
  flip means a valid artifact no longer runs; an **edge** flip means the runtime
  stopped rejecting something it must (a contract change). Capture the reason; this
  is the input for the workflow-composer / **workflow-debugger** skill, and
  for a `@workflow-toolbox/runtime` review against the toolkit's
  [architecture doc](https://github.com/home-dev-lab/workflow-toolbox/blob/main/docs/public/architecture.md)
  (`docs/public/architecture.md` in the repo).
- **Rejection-wording drift** (`"..." → "..."`) → the error text changed; a
  `judgeRejection` pattern or a doc may need updating (a fix), or a new guard may be
  worth adding (a feature).
- **`newer SDK available`** in the SUMMARY → `pnpm update @anthropic-ai/claude-agent-sdk`
  to pull the newer SDK + its bundled runtime, then re-run `pnpm canary` to test it.
- A **`wt:check`** failure → a committed artifact drifted from source; rebuild with
  `pnpm wt:build` and re-check byte-determinism.
- **AGENT SCHEMA DRIFT** (an `AgentDefinition` field ADDED / REMOVED / renamed, or a
  least-priv `Options` field MISSING) → the least-privilege agent surface drifted. A
  REMOVAL/rename of a field we USE is also caught by typecheck (the probe derives
  `QueryOptions` from the live SDK types); an **ADDED** field is the gap typecheck can't
  see (additions never break the build). When the section flags drift, **sync all three
  in one commit** — the report names them:
  1. **`AGENT_DEFINITION_BASELINE`** (and, if a least-priv field changed,
     `OPTIONS_LEAST_PRIV_BASELINE` / `leastPrivilegeOptions`) in
     `packages/smoke/src/agent-schema.ts` — the committed record of the schema we've
     accounted for;
  2. the **scaffold emitter** `scaffoldAgent` (`packages/scaffold/src/scaffold.ts`) +
     its `AgentScaffoldSpec`, so a genuinely useful new field can be emitted (and add it
     to `SCAFFOLD_HANDLED_AGENT_FIELDS` so the canary stops flagging it as unhandled);
  3. the **composer's agent-creation guidance** (`workflow-composer/SKILL.md`, the
     "Specialist agent types" section) if the new field changes how an agent should be
     defined.
  Not every added field is worth adopting — decide per field; but the baseline MUST be
  updated regardless (even just to acknowledge a field we deliberately ignore), or the
  section keeps re-flagging it every run.

Cross-read the **WHAT THE CHANGELOG DOCUMENTS** section against the deltas above: it
lists what Anthropic's official changelog records for the `(last-verified, current]`
version range, highlighting lines that touch the workflow/agent/tool/sdk surface. A
CHECK FLIP that lines up with a documented change is *explained* (adopt or adapt to
it); a flip with **nothing** in the changelog is an undocumented drift worth a closer
look. A highlighted line with all checks still green is a candidate new capability to
adopt. The section is informational only — it never changes the canary's verdict, and
it degrades to a one-line note if the changelog can't be fetched (it is pulled
best-effort from the official Claude Code CHANGELOG with a short timeout — offline
or any network failure simply skips the section). On a downgrade or an unmoved version it says so and shows nothing.

### The observer-agent-pairing probe (`pnpm canary:observer`)

An `AgentDefinition.observer?: string` names another agent type as a read-only
background observer of the agent that carries it — the observer gets periodic
activity digests and reports via the `ObserverReport` tool, but never
participates in the task. This is what the pilot suite's `pilot-watchdog` /
`pilot-orchestrator-watchdog` pairing relies on. It is **experimental,
undocumented, and gated at process start** by
`CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1` — absent, the field is silently
ignored — so this probe exists to catch a silent SDK-upgrade regression on it,
the same way `pnpm canary:agents` catches one on tool/skill/MCP fencing.

Standalone (like `canary:agents`, NOT folded into `pnpm canary`'s per-runtime-target
matrix — see the module header in `packages/smoke/src/observer-canaries.ts` for why).
Run it directly:

```bash
CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1 pnpm canary:observer
```

Without the env var it reports every leg `NOT_MEASURED` and spends zero live
launches — it never silently assumes "attached" or "not attached" just because
the feature couldn't be exercised.

Five legs, each a THREE-state verdict (`ATTACHED` / `NOT_ATTACHED` / `NOT_MEASURED`
— never collapsed to a boolean, so "couldn't measure" never reads as "broken"):

| Leg | What it checks |
|---|---|
| `observer-flag-present` | the feature gate env var — always informational, `ok:true` either way |
| `observer-positive-control` | an ANONYMOUS spawn (no `name`) — reliably attaches in every mode tested to date. A `NOT_ATTACHED` here is a **hard** failure: every other leg becomes uninterpretable, so the runner skips them (reports them `NOT_MEASURED`, reason "skipped") instead of pretending they still mean something |
| `observer-report-tool` | mechanical assertion: the observer's `ObserverReport` call succeeds (folded from the SAME run as the positive control) |
| `observer-sendmessage-refused` | mechanical assertion: `SendMessage` is REFUSED for the observer even when declared in its `tools:` — this is the documented, CORRECT contract ("an observer must never participate in the task"); only an unexpected SUCCESS is a regression |
| `observer-named-headless` | a SEPARATE run, named spawn, in THIS headless/`query()` harness — a SECONDARY signal only, explicitly labeled as such in its own detail text. It is NOT a reproduction of the interactive-CLI "named spawn rebuilds its AgentDefinition and drops the observer pairing" bug (that mechanism is specific to the in-process "teammate" path an interactive session takes for a named spawn; a headless SDK session does not go through it) |

Detection reads the parent session's OWN SDK message stream — never subagent
transcript files off disk — via two signals: (a) `subagent_type` tagging on
assistant/user messages (the same mechanism `sdk-agent-probe.ts` proved), and
(b) the harness-emitted `origin.kind` ENVELOPE (`'observer-activity'` on a
digest delivered TO an observer, `'observer'` on a report delivered FROM one).
The envelope, never the payload text, is what is matched — a detector that
greps for a literal marker string it also planted would be a guaranteed false
positive (a documented trap from the manual PoC this probe replaces).

An observed-agent prompt forces 3 sequential tool calls before this probe will
trust a "no digest seen" result as a genuine `NOT_ATTACHED` rather than "too
few turns to produce one" (`MIN_OBSERVED_TOOL_CALLS` in `observer.ts`) — a
missing digest after fewer than 3 observed tool calls is always `NOT_MEASURED`.

**Known harness quirk worth knowing before re-tuning this probe**: the SDK's
`Agent` tool defaults `run_in_background` to `true`, and even with it forced
`false`, the tool's own `tool_result` can arrive as an early acknowledgment
*before* the spawned agent's own tool calls appear in the stream — a parent
prompt that replies as soon as the tool call "returns" ends the whole session
(and the still-running subagent + its observer) prematurely. The prompt in
`observer-canaries.ts` works around this by making the parent poll via
`Bash sleep` in a loop until it has explicit confirmation the spawned agent
actually finished, rather than trusting the tool_result alone.

## How it works (for maintenance)

The mechanism lives in the toolkit (it shares the SDK dependency + the tested
message-parsing helpers), not in this skill:

- `version.ts` — pure marker (de)serialization, the gate (`decideRun`), and
  `diffSnapshot` (the change report). Unit-tested.
- `agent-schema.ts` — pure `AgentDefinition` / `Options` schema-drift detection:
  `extractTypeFields` (TypeScript-AST field extraction from the SDK `.d.ts` — never a
  regex, so an inline-object field can't corrupt the set), the committed
  `AGENT_DEFINITION_BASELINE` / `OPTIONS_LEAST_PRIV_BASELINE` / `SCAFFOLD_HANDLED_AGENT_FIELDS`,
  `diffSchema`, and `formatSchemaDrift` (the report wording). Unit-tested. The impure
  reader (`readLiveSchema` in `canary-all.ts`, fed by `runtimes.getSdkTypesPath`) locates
  and reads the installed SDK's `sdk.d.ts`; a missing source degrades to "unavailable",
  never a throw or a gate.
- `edge.ts` — pure negative-case generators, `judgeRejection`, and
  `canonicalizeReason` (strips volatile taskIds so wording-drift detection is
  signal, not noise). Unit-tested.
- `lib.ts` — pure SDK message readers incl. `readInitVersion` (the measured CC
  version of whatever binary a run drove). Also `resumePrompt(scriptPath, runId, args?)`
  — the RESUME counterpart to `launchPrompt`: embeds `scriptPath` +
  `resumeFromRunId: runId` (+ `args` when given) as one exact JSON literal so a live
  runner can re-invoke the Workflow tool against an existing run and have completed
  `agent()` calls replay from the journal cache instead of re-running. Used by a caller
  that drives a resume round-trip (the resume-parity canary pins that an UNFORKED resume
  of the original SDK session preserves this cache across a process kill). Unit-tested.
- `changelog.ts` — pure changelog inspection: parse `## x.y.z` sections, extract the
  `(from, to]` range (numeric compare, gap-version-safe), highlight toolbox-relevant
  lines, and a single `buildChangelogReport` decision table. Unit-tested.
- `changelog-source.ts` — resolves the offline changelog mirror text (impure, held
  out of `pnpm test`); offline-graceful (absent → null, never gates).
- `runtimes.ts` — resolves the targets, the SDK version, the latest SDK on npm, and
  `getSdkTypesPath` (the installed SDK's `sdk.d.ts`, for the schema-drift check).
- `run.ts` / `edge-canaries.ts` — the live runners (`runSmokeChecks` / `runEdgeChecks`),
  also runnable standalone as `pnpm smoke` / `pnpm canary:edge` against the bundled runtime.
- `canary-all.ts` — the `pnpm canary` orchestrator: matrix → diff → report → record.
- `observer.ts` — pure message-shape readers (`readObserverSignals`), the immutable
  tally fold (`foldObserverSignal`), and the three-state verdict logic
  (`classifyAttachment`, `observerReportAssertion`, `sendMessageRefusalAssertion`)
  behind `pnpm canary:observer`. Unit-tested. `observer-canaries.ts` is the live
  runner (`runObserverCanaries`, standalone — not part of the `pnpm canary` matrix
  loop; see its own module header for why).

The pure halves are covered by `pnpm test`; the live runners are held out (they
spend launches and need auth), exactly like `pnpm smoke`. The headless launch
mechanism is the same one the smoke harness proved.
