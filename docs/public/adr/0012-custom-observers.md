# 12. Custom observers via the composer

Date: 2026-07-18

## Status

Accepted

## Context

The companion Workflow Observatory server already ships an **out-of-band observer**
mechanism: a periodic, cursor-based watcher that tails a run's agent transcripts on disk and
runs a small tool-less "brain" each tick, emitting durable summaries (and a nudge file for an
external watcher). It never touches a live agent process — it reads transcript bytes. Until
now the only way to attach one was by hand: a REST call carrying a mandate and a transcript
or run target.

There was no way for a **workflow** to declare its own observation — "watch my `implementer`
role and, when it would materially help, supply minimal sourced documentation context" — as a
reviewable artifact that travels with the workflow and resolves per machine. That is the same
gap the capability sidecar closed for a workflow's own agent roles (see
[the machine capability registry](../capability-registry.md)), and closing it for observers
raised the same boundary question — workflow-owned *needs* vs machine-owned *providers* — plus
two observer-specific ones: how to target a role when the run's journal carries no role, and
how to deliver context back toward a still-running agent without injecting into it.

## Decision

**D1 — An observer is a workflow-owned `<name>.observer.json` artifact, emitted by the
composer beside the workflow.** It is an `ObserverDefinition` — role/phase selectors, the brain
mandate, the wt-comm message types it may emit, its permitted actions, and its abstract
capability *needs*. It is deliberately NOT a section of the `.workflow.ts` (a pure sandboxed
literal that would need a rebuild to change what is observed) and NOT a fourth key inside
`args.capabilities` (which is machine-owned by decision — an observer definition is
workflow-owned). It is a sibling artifact that varies independently of the script, the same
model as an emitted agent definition. A hand-written definition is supported; the composer's
`scaffoldObserver` emits one through the same shared validator the launch bridge enforces, so
the two can never drift.

**D2 — Targeting is a role/phase selector matched against the transcript's `wt-meta` head
tag, resolved per run at tick time — never the run journal.** The journal carries no role, so
the selector matches the ROLE (and/or phase) segment of the label a toolkit-built agent emits
at the head of its transcript. A transcript with no `wt-meta` tag (a non-toolkit or bare-prompt
run) is unmatchable and degrades to a **named `no-match` state**, visible and never silent.
v0 has **no whole-run content observation** — a bare run-level target tails no content today;
observing an entire run's content is a later design with its own selection/merge semantics.

**D3 — The brain is tool-less by default; abstract `requires` is the only gate to tools,
resolved through the machine capability registry — the same mechanism as agent capabilities.**
A definition declares `requires: [{ need }]` in the open, read-only-retrieval need vocabulary
(`docs-lookup`, `code-intelligence`, …); it never names a concrete tool or a machine path.
The **launcher** resolves each need against the operator's registry and stamps the concrete
resolution onto the observer entry as `args.observers[i].resolution`; any caller-supplied
`resolution` is stripped first (a trust boundary — a definition may not smuggle a resolution
past the registry). The **server never resolves** — it composes the stored resolution into the
brain's query at tick time. A machine that registers no provider degrades the need to a named
fallback; when a required need yields no tool at all, the observer is simply **not attached**.

**D4 — Two security invariants, formalized (the mechanism's two hard constraints).**
- **S1 — Retrieved content is DATA, provenance is required.** An `observer.hint` carries a
  required provenance (a transcript byte-window, or a named provider + ref) or it does not
  validate. A hint **informs; it never instructs** — it is display prose plus its provenance,
  and the observed agent stays the sole arbiter of whether to use it. The brain also treats the
  observed transcript as inert data.
- **S2 — External execution is a declared capability behind an allowlist, never implicit.**
  Tools come only from a positively declared `need` resolved against the operator-owned
  registry — an artifact can never make a machine run a tool it has not registered. Executing a
  local process (`process-exec`) is out of the v0 vocabulary until it has a command-allowlist
  spec; v0 is read-only retrieval only.

**D5 — Two failure regimes, kept distinct.** *Authoring/launch is fail-loud*: a malformed
`args.observers` section returns every violation at once and the run is never launched (parity
with the capabilities section). *Runtime is never-fail*: an **attached** observer never fails a
running run — an unresolved required need degrades to "not attached" plus a noisy record, a
tick failure is recorded and the next tick is independent, a hint that fails validation is
refused and noted in the summary.

**D6 — Delivery toward the observed agent is out-of-band; no injection into a live agent.**
The runner writes a typed wt-comm `observer.hint` into the run's comm directory, and the
observed role is briefed (by the runtime, not by a copied prompt) to consult its hints at
natural boundaries; a nudge family signals a background watcher when hints accumulate.
Synchronous injection (pausing the run at a boundary to inject a hint) is a later primitive,
out of scope for v0. **Honest scope:** the out-of-band proactive path is periodic and
minutes-scale end to end, so it only pays on **long-running** observed agents (TDD
executors, piloted arcs). A short fan-out agent finishes before a hint could be delivered;
covering short agents waits on the synchronous path.

## Consequences

- **Shipped public surface (this repo):** the `ObserverDefinition` schema + shared validator,
  the composer's `scaffoldObserver` emission, the `args.observers` launch bridge, and the
  wt-comm `observer.hint` type (an `observer` role that may produce only `observer.*`, with
  required provenance). The authoring guide is
  `plugin/skills/workflow-composer/references/observer-definitions.md`.
- **Runtime lives in the companion app.** Registering the derived targets, ticking the brain
  (tool-equipped only when needs resolved), and routing outputs ship with the Workflow
  Observatory server. A definition validates and travels regardless of the server; an older
  server ignores the section — see the launcher↔server version-skew note in
  [known-issues](../known-issues.md).
- **Reference example — `docs-butler`.** It watches long-running implementer agents and
  supplies minimal, sourced documentation context when it detects a need. Honest v0 limitation:
  the shipped producer stamps **transcript** provenance only; capability-source provenance
  (`{ need, provider, ref }`) is a design target — stamping it honestly requires the runtime to
  observe the tooled brain's own retrieval calls.
- **Providers are registry examples, never defaults.** Any concrete tool named around this
  mechanism (a docs MCP for `docs-lookup`, a symbolic MCP for `code-intelligence`) is an example
  an operator MAY register on their machine, never a toolkit default and never hard-coded in a
  shipped definition.
