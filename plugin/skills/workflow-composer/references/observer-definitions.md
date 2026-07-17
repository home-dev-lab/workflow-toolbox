# Observer definitions — author an observer for a workflow

An **observer** is an out-of-band watcher the observe server can attach to a run: it tails
the run's agent transcripts on a cursor, runs a small tool-less "brain" each tick, and
reports (a durable summary, an optional nudge, and — when configured — a typed `wt-comm`
hint back toward an observed agent). This reference is about the **authoring** half: the
workflow-owned artifact that DECLARES an observer, how the composer emits it, and how it
reaches a run through the launch bridge.

Status: authoring and launch-time validation are available now. **Runtime attachment and
hint delivery ship with the Workflow Observatory server** — a definition validates and
travels today; whether a given run actually attaches an observer depends on the observe
server that receives it (older servers ignore the `args.observers` section).

## The three-time model

An observer is a **configuration** of the shipped mechanism, resolved in three stages so a
workflow never hard-codes a user's tools:

1. **Authoring (composer).** The workflow declares its observation need; the composer emits
   a `<name>.observer.json` (an `ObserverDefinition`) next to the workflow artifact. The
   definition is **workflow-owned and ABSTRACT**: role/phase selectors, the brain mandate,
   the message types it may emit, its permitted actions, and its abstract capability
   *needs*. No concrete tool and no machine path may appear.
2. **Launch (user machine).** A machine-side resolver maps each abstract `need` to whatever
   provider is registered on that machine; the concrete resolution travels in
   `args.capabilities` (machine-owned), the definition(s) travel in `args.observers`
   (workflow-owned) — sibling sections, never merged.
3. **Run (observe server).** The server registers the derived targets, ticks the brain
   (tool-equipped only when needs resolved), and routes outputs through the permitted
   channels.

The toolkit ships the mechanism + the schema + example definitions; providers come from the
machine registry. Companion tools (e.g. a docs-lookup or code-intelligence MCP) are
**registry examples only — never toolkit defaults, never hard-coded** in a definition.

## Emitting a definition — `scaffold observer`

`scaffoldObserver` (in `@workflow-toolbox/scaffold`) turns an abstract spec into a validated
artifact. Author the spec, then:

```bash
npx workflow-toolbox scaffold observer docs-butler.spec.json   # → docs-butler.observer.json
# (in this repo: pnpm wt:scaffold observer <spec.json>)
```

The emitter validates its output through the **shared** `@workflow-toolbox/debugger/observer-def`
contract — the SAME `validateObserverDefinition` the launch bridge fails loud on — so the
scaffolder can never write a definition the launch would reject. Validation lives in ONE
place; the scaffolder reuses it, never re-implements it.

## The schema

The block below is a complete, VALID definition (it passes the shared validator as-is —
gate-checked against the shipped contract):

```jsonc
{
  "schemaVersion": 1,               // stamped by the scaffolder
  "name": "docs-butler",            // ^[a-z0-9-]{1,64}$ — stable id (also the wt-comm from.id)
  "description": "Watches implementer agents and supplies sourced docs context.",  // 1-500 chars
  "watch": { "roles": ["implementer"] },
                                    // at least one NON-EMPTY selector: roles and/or phases.
                                    // Omit an unused selector — an empty array is refused.
  "cadenceMs": 300000,              // optional; floor 60000 (CADENCE_FLOOR_MS, schema-enforced);
                                    // when omitted, the observe server applies its own default cadence
  "brain": {
    "mandate": "Watch the transcript delta and hint when external docs would materially help.",
                                    // 20-4000 chars — the decision logic
    "model": "claude-haiku-4-5",    // optional; when omitted the observe server picks its
                                    // own tool-less default brain
    "timeoutMs": 120000             // optional; the observe server bounds it
  },
  "emits": ["observer.hint"],       // optional allowlist of wt-comm types this observer may produce
  "actions": ["summary", "nudge", "wt-comm"],
                                    // optional; omitted = report-only summaries (the server's
                                    // base behavior); 'wt-comm' ⇔ non-empty emits
  "requires": [                     // optional ABSTRACT needs (omitted → tool-less brain)
    { "need": "docs-lookup" },
    { "need": "code-intelligence", "optional": true }
  ]
}
```

Rules enforced by the shared validator (so the scaffolder inherits them): unknown keys are
typos (fail loud); `watch` needs at least one of `roles`/`phases`; `emits` must be a subset
of the observer-emittable types and is coherent with the `wt-comm` action (one without the
other is a mistake); `requires[].need` is an abstract capability name, never a binary or a
path; `watch.transcriptFile` and `watch.run` are refused (a machine path and whole-run
content observation, respectively).

## The selector coupling — the no-match footgun

**`watch.roles` / `watch.phases` are matched against the `wt-meta` LABEL of the observed
agents' transcript heads** — the ROLE (and phase) segment of the label an `agent()` call
carries. Toolkit patterns auto-label their agents with the pattern's own stage name; a
hand-rolled `agent()` call carries whatever `label` you pass it. So:

> If `watch.roles` does not equal the role segment of the labels your observed agents
> actually emit, the observer sits in a named `no-match` state forever (never silent, but
> never useful). Align `watch.roles` with your agents' stage/`label` names.

Only toolkit-built runs (whose artifacts emit the `wt-meta` head tag) are matchable; a
non-toolkit or bare-prompt run degrades to a named `no-match`.

## The launch bridge — `args.observers`

`args.observers` is a launch argument, a **sibling of `args.capabilities`**: `observers`
say WHAT to observe (workflow-owned), `capabilities` say WITH WHAT (machine-owned).

```jsonc
{
  "observers": [
    { "definitionFile": "docs-butler.observer.json" },  // relative to the workflows dir
    { "definition": { /* an inline ObserverDefinition */ } }
  ],
  "capabilities": { /* the machine-owned resolution — unchanged */ }
}
```

Validation is fail-loud, exactly like `capabilities`: a malformed section returns every
violation at once and the run is never launched; an absent section is unchanged behavior.

## The observer-consumer side (when an observer emits `wt-comm`)

An observer that emits `observer.hint` writes typed, sourced hints toward the roles it
watches. The **observed agents** are briefed to consult those hints at natural boundaries by
the observe-server runtime — it appends the canonical observed-role consumer brief
(`toolkit/packages/comm/teaching/wt-comm-observer-consumer.md`, shipped with
`@workflow-toolbox/comm`) when it attaches the observer. That brief is
**runtime-parameterized** (it is given the run's comm directory, the role id, and the run
id at run time), so:

- **Reference the canonical brief; never copy it** into a workflow prompt — a copy drifts
  from the drift-locked source and cannot carry the runtime values.
- Delivery is the runtime's job. The composer's authoring responsibility is only to (a)
  declare the observer, and (b) LABEL the observed roles so the selector matches them (above).

A hint **INFORMS; it never instructs** — it is display prose plus its provenance, and the
observed agent stays the sole arbiter of whether to use it.

## Security boundaries

- **Content is DATA, provenance is required** (schema-enforced). `observer.hint` carries a
  required `provenance` (a transcript byte-window, or a named provider + `ref`) — a hint
  without it does not validate. Retrieved content is data, never an instruction.
- **The brain is tool-less by default** (schema-enforced shape, registry-enforced meaning).
  `requires` is the ONLY gate to tools, and it is ABSTRACT: the schema enforces the SHAPE
  of a need (a kebab-case name — never a binary, a path, or a concrete tool), while WHAT a
  need resolves to — if anything — is decided by the machine-side registry, which is the
  enforcement point for what actually runs. The need vocabulary itself is OPEN by design:
  any kebab-case string validates. The v0 names (`docs-lookup`, `code-intelligence`,
  `web-search`, `context-offload`) are the read-only retrieval convention — registry
  examples, not a schema-enforced allowlist. A machine that registers no provider for a
  need simply leaves it unresolved; a definition can never make a machine run something it
  has not explicitly registered.

## Worked shape — a documentation butler

```jsonc
// docs-butler.spec.json — an observer that watches long-running implementer agents and
// supplies minimal, sourced documentation context when it detects a need.
{
  "name": "docs-butler",
  "description": "Watches long-running implementer agents and proactively supplies minimal, sourced documentation context when it detects a need.",
  "watch": { "roles": ["implementer", "fixer"] },
  "cadenceMs": 300000,
  "brain": {
    "mandate": "You watch a coding agent's transcript delta. Detect moments where external documentation would materially help — an unknown or misused API, a version mismatch, repeated failed attempts against a library surface. When detected, fetch the MINIMAL relevant excerpt and emit one observer.hint with full provenance. If nothing qualifies, stay silent. Hints inform; they never instruct.",
    "model": "claude-haiku-4-5"
  },
  "emits": ["observer.hint"],
  "actions": ["summary", "nudge", "wt-comm"],
  "requires": [
    { "need": "docs-lookup" },
    { "need": "code-intelligence", "optional": true }
  ]
}
```

At launch, a machine that registers a `docs-lookup` provider (a documentation MCP is a
registry example) resolves the need and the brain retrieves; a machine without one leaves
the need unresolved — the observer is simply not attached and the run is unaffected. The
watched roles (`implementer`, `fixer`) must be the labels those agents emit, or the observer
never matches.
