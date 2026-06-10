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
expensive work when the answer is yes (or you pass `--force`).

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
| `2`  | error | surface it |

`canary:version` is **read-only** (it never writes the marker). The gate skips only
when both signals are unchanged AND the last run passed.

### 2 — Run the matrix (only if step 1 said RUN)

```bash
pnpm canary                              # both runtimes; --target system|bundled to narrow
for f in workflows/*.js; do pnpm wt:check "$f" || echo "FAIL $f"; done
```

`pnpm canary` runs smoke + edge against each target, prints a SUMMARY (per-target
Claude Code version, the SDK⇒bundled-CC mapping, installed-vs-latest SDK on npm),
a **WHAT CHANGED SINCE LAST RUN** section, a **WHAT THE CHANGELOG DOCUMENTS**
section (the official Claude Code changelog entries for the measured version range,
with toolbox-relevant lines — workflow/agent/tool/sdk — highlighted as drivers for
fixes or features), and **records the marker itself** (it is the sole writer — there
is no separate record step). Exit **0** = every check on every target passed,
**1** = a check failed, **2** = fatal (auth/binary).

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
  for a `@workflow-toolbox/runtime` review against the toolkit's architecture doc
  (`docs/public/architecture.md`).
- **Rejection-wording drift** (`"..." → "..."`) → the error text changed; a
  `judgeRejection` pattern or a doc may need updating (a fix), or a new guard may be
  worth adding (a feature).
- **`newer SDK available`** in the SUMMARY → `pnpm update @anthropic-ai/claude-agent-sdk`
  to pull the newer SDK + its bundled runtime, then re-run `pnpm canary` to test it.
- A **`wt:check`** failure → a committed artifact drifted from source; rebuild with
  `pnpm wt:build` and re-check byte-determinism.

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

## How it works (for maintenance)

The mechanism lives in the toolkit (it shares the SDK dependency + the tested
message-parsing helpers), not in this skill:

- `version.ts` — pure marker (de)serialization, the gate (`decideRun`), and
  `diffSnapshot` (the change report). Unit-tested.
- `edge.ts` — pure negative-case generators, `judgeRejection`, and
  `canonicalizeReason` (strips volatile taskIds so wording-drift detection is
  signal, not noise). Unit-tested.
- `lib.ts` — pure SDK message readers incl. `readInitVersion` (the measured CC
  version of whatever binary a run drove). Unit-tested.
- `changelog.ts` — pure changelog inspection: parse `## x.y.z` sections, extract the
  `(from, to]` range (numeric compare, gap-version-safe), highlight toolbox-relevant
  lines, and a single `buildChangelogReport` decision table. Unit-tested.
- `changelog-source.ts` — resolves the offline changelog mirror text (impure, held
  out of `pnpm test`); offline-graceful (absent → null, never gates).
- `runtimes.ts` — resolves the targets, the SDK version, and the latest SDK on npm.
- `run.ts` / `edge-canaries.ts` — the live runners (`runSmokeChecks` / `runEdgeChecks`),
  also runnable standalone as `pnpm smoke` / `pnpm canary:edge` against the bundled runtime.
- `canary-all.ts` — the `pnpm canary` orchestrator: matrix → diff → report → record.

The pure halves are covered by `pnpm test`; the live runners are held out (they
spend launches and need auth), exactly like `pnpm smoke`. The headless launch
mechanism is the same one the smoke harness proved.
