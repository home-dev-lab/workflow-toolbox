This reference belongs to the workflow-composer skill; all paths are relative to the skill directory (the parent of references/).

## The raw authoring path (one-offs)

Hand-write the `.js` when the job is a one-off, fits none of the nine patterns, or
the toolkit's build chain is unavailable.

### File anatomy

**1. `meta` first, pure literal.** The very first statement must declare `meta` as a
plain object literal — no variables, function calls, spreads, or template strings
inside it, and nothing before it:

```js
export const meta = {
  name: 'review-changes',                          // required, non-empty, kebab-case
  description: 'Review the change set and verify each finding',  // required; shown in dialog
  phases: [{ title: 'Collect' }, { title: 'Decide' }],          // optional, one per phase()
};
```

A `model` on a `phases[]` entry is a label for the permission dialog only — it does
**not** set the runtime model. The model is set solely by the `model` option on the
`agent()` call.

**2. The body — top-level async.** After `meta`, the body is plain top-level `async`
code that `await`s the runtime globals and **returns** the result value. The
orchestrator has no filesystem or shell — file/Bash work happens *inside* an
`agent()`, where the subagent has the normal tools.

The globals: `agent(prompt, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`,
`phase(title)`, `log(message)`, `budget`, `workflow(nameOrRef, args?)`, `args`. Full
signatures and option tables are in `references/api-reference.md`.

### Choosing the topology

| Want | Shape | Primitive |
|---|---|---|
| Each item flows on its own through stages | **pipeline (default)** | `pipeline(items, stageA, stageB)` |
| A later stage needs *all* items together (dedup, ranking, total count, "stop once N") | **barrier** | `parallel(thunks)` then cross-item logic |
| Iterate an unknown number of rounds until the work runs dry | **loop** | `while` with a **typed** stop condition |

Default to **pipeline** — a fast item reaches the last stage while a slow one is still
in the first; nobody idles. Only insert a `parallel()` barrier for a genuine
cross-item need. Use a **loop** only when iteration adds value and the size is unknown
up front (a known fixed list is just a `map`), and give every loop a hard stop — a
counter (`while (found < 10)`) or a budget guard (`while (budget.total && budget.remaining() > 50_000)`).

### Schemas, model tiering, and agent routing — the digest

- **Schema at EVERY consumed boundary**, with anti-capitulation bounds
  (`minLength`/`maxLength`) — never blindly trust a raw string.
- **Model tiering:** mechanical/classify → cheap tier; synthesis/consolidation →
  medium; verifiers/judges → the strong model as a quality FLOOR.
- **Per-role effort mirrors the model choice** (low mechanical / high verifiers).
- **agentType routing:** default = the standard subagent, always. Launch-time
  requests travel in `args.agentTypes.<role>` (probe-resolved at entry, graceful
  fallback reported in the result's `probe`). Cross-family routing is something
  the composer PROPOSES to the user (plan-aware, decorrelate producer/verifier by
  FAMILY) — never silently applied, never silently skipped.
- **agentType is ALSO a capability fence** — deny by REMOVING tools in the agent
  definition, never by instruction alone.
- **Pure-reasoning stages should shed the ambient context.** A stage whose prompt is
  100% inline (classify / vote / score / dedup / synthesize — no "read the repo/diff" /
  "run git" instruction anywhere in it) pays the full ambient tool/skill injection on
  every spawn for capabilities it cannot use. TS compositions: route exactly those call
  sites through `withLeanRouting` (selective — a separate lean-defaulting runtime, never
  blanket; `withLeafFence` stays the blanket default and the scaffold wires it in). Raw
  sandbox scripts (no imports available): pass `agentType: 'workflow-toolbox:lean'` on
  the call's opts — safe whenever this plugin is installed, which is the case if you are
  reading this skill.
- **Repository-reading stages should use the read-only runtime.** The criterion is
  *reads the repository and produces no change*: TS compositions obtain a separate
  read-only-defaulting runtime with `withReadOnlyRouting`, then route exactly those call
  sites through it. It mirrors `withLeanRouting`'s selective probe-and-degrade behavior
  and resolves to `workflow-toolbox:leaf-readonly` (`Read`, `Grep`, and `Glob` only).
  Keep any stage that writes, edits, or runs a command on the normal leaf-fenced runtime.

**Read [references/model-and-agent-routing.md](references/model-and-agent-routing.md)
BEFORE tuning schemas, models, effort, or any agentType routing** — it carries the
full rules, the measured evidence (reviewer A/B, GLM-Lite concurrency), the
cross-family proposal protocol, and the capability-fence how-to.

### Starting points

- **Templates** (skeletons to fill in): `assets/templates/fan-out.template.js`,
  `pipeline.template.js`, `loop.template.js`.
- **Runnable raw examples** (complete, working): `assets/examples/verify-findings.js`
  (refute-first triple-verification of claims passed via `args`) and
  `assets/examples/repo-health-snapshot.js` (fan-out per repo area + synthesis barrier).
- **Example agentType definitions** (copy-and-wire): `assets/examples/agents/reviewer.md`
  and `assets/examples/agents/verifier.md` — a diff-grounded multi-lens reviewer and a
  refute-first verifier, both read-only and fenced against `SendMessage`. See
  `assets/examples/agents/README.md` for wiring into `pr-review`'s `agentTypes.review` /
  `agentTypes.verify`.

