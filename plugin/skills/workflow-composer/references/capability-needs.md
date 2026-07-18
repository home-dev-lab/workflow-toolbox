# Per-role capability needs — the `<name>.capabilities.json` sidecar

Read this when a workflow has a role that needs **more than the bare default** — a
reviewer that should read code symbolically, a researcher that should look up docs — and
you want that provisioning to travel with the workflow **without hard-coding any one
machine's tools**. It is the capability twin of `references/observer-definitions.md`:
observers ride `args.observers`, capabilities ride `args.capabilities`, and both are
emitted by the composer as workflow-owned artifacts of ABSTRACT needs.

The default for a delegated run is **nothing** — bare, and (by design) zero built-in
skills at init. A role gets tools ONLY by declaring an abstract *need*; the machine
resolves that need to a concrete provider at launch. The workflow artifact never names a
provider.

## The three times (authoring → launch → run)

```
AUTHORING (you, in the deliverable)   role → abstract needs + an agent def whose tool
                                      allowlist carries $cap:<need> placeholders
                                      → emitted <name>.capabilities.json (machine-agnostic)
LAUNCH (the user's machine)           wt-observe reads the machine capability registry,
                                      resolves each need → a provider (or a named
                                      degradation), expands the $cap:<need> placeholders,
                                      composes the concrete tools into the delegated run
RUN                                   the role's agent runs with the exact resolved
                                      allowlist + a mechanical "## Capability resolution"
                                      note appended to its prompt
```

You author the FIRST column only. The registry (per machine) and the resolution (per
launch) are not your concern — that boundary is what keeps a published workflow runnable
on a machine that has none of your tools (it degrades to a named fallback, never breaks).

## Step 1 — derive each role's needs (do this as an explicit, inspectable pass)

Go role by role and ask **"what must this role DO that the bare default cannot?"** Write
the answer as a small **per-role needs assessment** — for each tooled role, its needs and
a one-line justification:

```
reviewer   → code-intelligence  (reads a TS diff symbolically, not by text grep)
researcher → docs-lookup, web-search  (pulls external references it cannot infer)
classifier → (none)             (pure reasoning over inline text — stays bare)
```

Keep this assessment as a real intermediate you can read back — the sidecar is its
**projection**, not a black-box one-step emission. Two reasons this matters:

- a role whose whole task arrives inline (classify, score, vote, dedup, synthesize) needs
  NO entry — leave it out and it stays lean/leaf (the bare default holds);
- the assessment is a **pluggable seam**. A future proactive step ("this workflow's shape
  would benefit from an Observer") is designed to *consume* rolesneedsshape and
  propose — it reads roles + needs + shape, it never rewrites your derivation. Author the
  assessment as inspectable data and that step lands without reworking this one.

### The v0 need vocabulary (open, but read-only retrieval only)

| need | a role that wants it | degrades to (when no provider) |
|---|---|---|
| `code-intelligence` | reads/navigates code symbolically | grep/glob/read |
| `docs-lookup` | pulls library/framework docs | web search (if present) else nothing |
| `web-search` | needs the open web | nothing (the need *is* the network fallback) |
| `context-offload` | offloads bulk context out of the window | inline (summarize in-window) |

The vocabulary is open — a new abstract need is fine — but v0 is **read-only retrieval**.
Executing a local binary (`process-exec`) is deliberately out of scope until it has a
command-allowlist spec. A need may carry `optional: true` (run degraded rather than refuse
the launch) and abstract `params` (e.g. `{ language: "ts" }`) — never a path or binary.

## Step 2 — emit the sidecar

```bash
workflow-toolbox scaffold capabilities <spec.json>   # → <name>.capabilities.json
```

(Programmatically, `scaffoldCapabilities(spec: CapabilitiesScaffoldSpec)` in
`@workflow-toolbox/scaffold` returns the same string — same emitter the CLI drives.)

The spec is the sidecar plus a `name` that only names the output file. Set it to the
workflow's `meta.name` so the sidecar sits beside the built `workflows/<name>.js` (the
launcher finds it by that adjacency) — the scaffolder validates the kebab format but
cannot check the match to the workflow (the spec is standalone), so that coupling is
yours to keep. Shape:

```jsonc
{
  "name": "pr-review",
  "roles": {
    "reviewer": { "agent": "wf-reviewer", "needs": [ { "need": "code-intelligence", "params": { "language": "ts" } } ] }
  },
  "agents": {
    "wf-reviewer": {
      "description": "Diff-grounded reviewer.",
      "prompt": "You are wf-reviewer. …",
      "model": "sonnet",
      "tools": ["Read", "$cap:code-intelligence"]   // placeholder — resolved at launch
    }
  }
  // optional: "skillOverrides": { "deep-research": "off" }, "disableBundledSkills": false
}
```

**Machine-agnostic is enforced, not just advised.** The emitter runs the SAME lint the
launch resolver enforces (the launch guard delegates its machine-agnostic pass to that one
function — they cannot drift), and refuses to write a sidecar that carries a concrete
`mcp__…` tool in EITHER tool channel (`tools` allowlist OR `disallowedTools` denylist), an
`mcpServers` field or ANY other unmodelled field on an agent def (only
`description`/`prompt`/`tools`/`disallowedTools`/`model`/`effort`/`maxTurns` are allowed —
an unknown key is a smuggling channel), a `$cap:<need>` whose need the role never declared
(typo), or an agent with no `tools` allowlist at all (an omitted allowlist would inherit
every ambient tool — the opposite of least privilege). If you hand-write the sidecar
instead of scaffolding it, the launch runs that identical check, so a smuggled provider
still fails loud — the emitter lint is just the earlier, friendlier copy.

## Step 3 — make the role actually ADOPT the tool

Provisioning a tool is not adopting it: a role handed both a symbolic tool and plain grep
tends to reach for grep out of habit. Two levers, both in your hands at authoring time:

1. **Remove the alternative from the allowlist.** This is the strong, proven lever — a
   `code-intelligence` role's `tools` should list `$cap:code-intelligence` and NOT `Grep`.
   When the need resolves, only the provider's tools are added; the degraded fallback
   (grep/glob) is added ONLY when there is no provider, so the role can't drift back to
   text search on a machine that has the real tool.
2. **Repeat the instruction in the TASK prompt, not only the system prompt.** State
   "use the symbolic tools to navigate; do not fall back to text search" in the per-call
   prompt. The launcher also appends a mechanical `## Capability resolution` section per
   resolved need, but your task-level instruction is what actually steers behavior.

## Recommended companions (recommend, never require)

Document the machine tools a workflow *pairs well with* as **companions**, not
dependencies — e.g. a symbolic code-intelligence MCP for `code-intelligence`, a docs MCP
for `docs-lookup`. Name them as examples the user MAY install and register in their
machine capability registry; whether any given tool is present is environment- and
time-dependent, so never assume one is there and never bake a provider name into the
shipped sidecar or a coded default. A workflow with an abstract need runs on a bare
machine by degrading to the named fallback — that is the contract, and the companion note
is only a "you'll get more if you also have X" hint.

The registry itself — its file format, location, the `WT_CAPABILITY_REGISTRY` path
override, and how an operator registers a provider — is the machine/operator side, out of
scope for you as an author. It is documented in `docs/public/capability-registry.md`.

## Path A (in-session Workflow tool) — not covered by the sidecar

The sidecar + resolver target the DELEGATED path (`wt-observe launch`). In an in-session
Workflow-tool run the host session already carries its own MCP, tool names differ, and
there is no launcher hook to resolve against — so for Path A, fence a role with a project
`.claude/agents/<name>.md` agentType and an exact allowlist instead (the same
least-privilege idea, a different mechanism). See `references/model-and-agent-routing.md`
for the agentType fence.
