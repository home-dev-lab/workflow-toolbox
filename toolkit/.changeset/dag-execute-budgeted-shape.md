---
"@workflow-toolbox/patterns": minor
---

New generic `dagExecute` pattern, a persisted DAG artifact format, and budgeted named shapes.

`dagExecute(rt, { nodes, run })` runs an arbitrary `{id, dependsOn}` graph in Kahn-topological
waves, dispatching each wave's independent nodes concurrently via `rt.parallel`. This generalizes
the wave computation `dev-implement.workflow.ts`'s worktree mode already had to build bespoke, into
a reusable package pattern any workflow — or a rung-3 inline fan-out — can call directly. A cycle,
a duplicate node id, or a dangling `dependsOn` reference throws synchronously at entry rather than
silently dropping nodes.

`serializeDagArtifact`/`parseDagArtifact` give rung 3 a persisted, re-readable graph shape: a
`{name, nodes}` descriptor a session can write to disk and a LATER, different session can safely
re-read, with malformed input rejected with a message naming the exact defect (including
graph-level defects — duplicate ids, dangling references — not just per-node shape).

`makeBudgetedShape`/`describeBudgetedShape`/`budgetTotals` let a manually-driven, reduced
execution of a named shape (e.g. a `pr-review` run with 3 lenses and one shared verifier instead
of ~6 lenses and per-finding verification) declare, and render, exactly what was merged, reduced,
or dropped relative to the full reference workflow — a reduction with nothing declared lost is a
config error. A worked `pr-review` example ships in `toolkit/packages/patterns/examples/`.

A measured note on the parallelism claim: a controlled synthetic test confirmed `rt.parallel`'s
concurrent-dispatch mechanism hits its theoretical speedup exactly (1.5x for a 2-wave diamond).
Two small real runs against the production runtime, on a trivial 3-node diamond, were inconclusive
— real per-call latency variance swamps the signal at that scale. `dagExecute`'s value is reuse and
correctness as much as raw speed on a small graph; the payoff grows with wave width and per-node
duration.
