# Workflow tool — API reference

This is the authoring reference for Claude Code's **Workflow tool**: the runtime
that runs a JavaScript file you write to orchestrate many fresh-context
subagents under ordinary control flow. Read it when you are writing or fixing a
workflow script.

## How to read the evidence markers

The Workflow tool is a research preview. Some of the surface below is in the
official documentation; some is not documented anywhere but has been confirmed
by running it. Every non-obvious claim carries one of three markers so you know
how far to trust it:

- **[documented]** — stated in Claude Code's official documentation. Stable;
  rely on it.
- **[verified]** — not in any official source, but binary-verified against the
  Claude Code runtime by this plugin's authors. Treat as an **unstable
  surface**: it works today and may change in a future Claude Code release.
- **[observed]** — publicly observable (e.g. by reading bundled workflow
  scripts) but unofficial and unverified by us.

When a marker says [verified], prefer a defensive pattern and re-confirm after a
Claude Code upgrade.

---

## What a workflow is

A workflow moves a multi-step plan into code. With subagents, skills, and agent
teams Claude is the orchestrator — it decides turn by turn what to spawn next,
and intermediate output lands in its context. A workflow inverts that: a script
you (or Claude) write holds the plan, and the runtime executes it in an isolated
environment separate from your conversation. Intermediate results stay in script
variables instead of flowing back into Claude's context. [documented]

Use a workflow when the orchestration is **deterministic** — a predefined code
path — and the model's judgment is only needed at the leaves (inside each
spawned agent). [documented]

> For repeatable, maintained workflows there is a companion TypeScript pattern
> toolkit (`@workflow-toolbox`) that compiles typed patterns to workflow artifacts. See
> `toolkit/README.md`. The rest of this reference describes the raw runtime
> surface every workflow ultimately targets.
>
> **Toolkit-level tuning (not raw runtime) lives in `references/patterns.md`:**
> per-role `<role>Model`/`<role>Effort`/`<role>Type` knobs on every pattern (the
> `<role>Type` routes that role to a subagent type — the cross-family lever); the
> `adversarialVerification` **`verifierType`** option for a cross-family (e.g.
> `codex:codex-rescue` (GPT), or `workflow-toolbox:opencode-verifier` (GLM 5.2 /
> zai-coding-plan)) verifier — genuine decorrelation; and the two
> launch-time config helpers, `withAgentDefaults(rt, defaults)` (wrap `rt` once →
> all downstream agents inherit `model`/`effort`/`agentType`/…) and
> `parseConfig(args)` → `WorkflowConfig`. The raw-runtime primitives those build on
> (`agentType`, `effort`, per-agent `model`) are documented below.

### Research preview — availability and opt-in

[documented] Dynamic workflows are in **research preview**. They:

- require **Claude Code v2.1.154 or later**;
- are available on **all paid plans**, with Anthropic API access, and on Amazon
  Bedrock, Google Cloud Vertex AI, and Microsoft Foundry;
- on **Pro**, must be turned on from the *Dynamic workflows* row in `/config`.

They run in the CLI, the Desktop app, the IDE extensions, non-interactive mode
(`claude -p`), and the Agent SDK. [documented]

To turn workflows **off** (any of these persists): toggle *Dynamic workflows*
off in `/config`; set `"disableWorkflows": true` in `~/.claude/settings.json`;
or set the `CLAUDE_CODE_DISABLE_WORKFLOWS=1` environment variable. An
organization can disable them for everyone via `"disableWorkflows": true` in
managed settings — an **enterprise kill-switch**. [documented]

---

## The Workflow tool's I/O

### Input

The tool accepts these inputs:

- **`script`** — the workflow source, inline.
- **`name`** — the name of a saved workflow to run.
- **`scriptPath`** — a path to a workflow file to run.
- **`args`** — input passed to the script (see *args* below).
- **`resumeFromRunId`** — resume a previous run within the same session.

**`scriptPath` takes precedence** over an inline `script`. [verified]

Saved workflows live in `.claude/workflows/` (shared via the repo) or
`~/.claude/workflows/` (your home directory, visible only to you), and are
invoked by `/name`. [documented]

### Output (async launch)

A launch returns immediately with an async-launch envelope carrying
`status`, `taskId`, `runId`, `transcriptDir`, and `error`. [verified]

> **GOTCHA — always check `WorkflowOutput.error`.** A script that fails its
> syntax check still returns `status: "async_launched"` **with `error` set**,
> and then never runs. Silence is not success — read `error` on every launch.
> [verified]
>
> Note the asymmetry: a `scriptPath` whose `meta` is malformed is rejected
> **synchronously at the tool layer** with a clear message, whereas a faulty
> inline `script` takes the async-launched-with-`error` path above. [verified]

---

## Workflow file anatomy

A workflow file has two parts: a `meta` literal, then the body.

### 1. `meta` — must be the first statement, a pure literal

The very first statement in the file must declare `meta` as a **pure object
literal** — no variables, function calls, spreads, or template strings inside
it. A statement placed before `meta`, or any non-literal value inside it, is
rejected. [verified]

```js
export const meta = {
  name: 'review-changes',        // required, non-empty
  description: 'Review the change set and verify each finding', // required
  whenToUse: 'Before shipping a branch',  // optional — [observed]
  phases: [                      // optional — one entry per phase() call
    { title: 'Review' },
    { title: 'Verify', model: 'haiku', detail: 'Re-run the failing checks' },
  ],
}
```

In TypeScript sources this shape is the `WorkflowMeta` type
(`@workflow-toolbox/build`); `defineWorkflow()` returns a `DefinedWorkflow` —
the carry-through value the build CLI consumes, never constructed by hand.

- **`name`** (required) and **`description`** (required) are documented fields.
  `description` is shown in the permission dialog. [verified]
- **`whenToUse`** and **`phases`** are optional. `whenToUse` is **[observed]**
  (seen in bundled scripts, not officially documented). [observed]
- A `model` on a `phases[]` entry is a **label for the permission dialog only**
  — it does not set the runtime model. The model is set solely by the `model`
  option on the `agent()` call. [observed]
- A `detail` on a `phases[]` entry is a **static per-phase description string**,
  independent of any agent's live output. Observe surfaces it two ways: as a
  **tooltip on the phase box** (every phase, once its title is known), and as
  **inline text inside an empty/skipped phase box** — the case where a phase was
  declared in `meta.phases` but never received an agent, which otherwise renders
  as a bare empty container (see the `loopUntilDone` gotcha in `patterns.md`).
  [observed]

### 2. The body — top-level async, returns the result

After `meta`, the body is plain top-level `async` code. It `await`s the script
primitives below and **returns** the workflow's result value. The orchestrator
itself has **no filesystem or shell access** — any read/write/Bash work must
happen *inside an `agent()`*, where the subagent has the normal tools.
[documented]

---

## The script API

These globals are available in the sandbox. (The `@workflow-toolbox` toolkit binds the same
surface into an explicit `rt` parameter, but the raw names below are what the
runtime exposes.)

### `agent(prompt, opts?) → Promise<string | object | null>`

Spawns one fresh-context subagent.

> **"Fresh-context" means fresh of the CONVERSATION, not a blank slate.** A spawned
> agent does NOT see the launching conversation or the script's variables — so you must
> pass everything it needs *in the `prompt`*. It DOES still load the project's ambient
> knowledge: `CLAUDE.md` (project + user instructions), the auto-memory, and skills. So
> agents already follow project conventions (response language, style) — don't re-inject
> those — but note each agent pays that context cost, so a large fan-out loads it N times.

- Without `schema`, resolves to the agent's final text as a **string**.
- With `schema`, resolves to the **validated object**.
- A skipped or failed agent resolves to **`null`**.

`opts` fields:

| Option | Marker | Meaning |
|---|---|---|
| `schema` | [observed] | JSON Schema. Forces structured output; see below. |
| `model` | [verified] | Per-agent model alias (`'haiku'`/`'sonnet'`/`'opus'`/`'fable'`/`'inherit'`) or a full model ID. Omit to inherit the session model. No validation — a typo is passed through and fails later. **Alias availability is environment- and time-dependent (plan, access windows) — an alias that is not callable where the run executes errors at runtime; verify before pinning a top-tier alias.** |
| `effort` | [verified] | Per-agent reasoning effort: `'low'`/`'medium'`/`'high'`/`'xhigh'`/`'max'`. Omit to inherit the session effort. **Accepted** by the live sandbox — a 27-agent pr-review run (`wf_3263a880-80f`) passed `effort:'low'` on every call with no error; the *behavioral* effect on reasoning depth was not separately measured. `@workflow-toolbox/runtime` types it as `EffortAlias`; patterns expose per-role `<role>Effort` knobs. |
| `label` | [verified] | Display name shown in `/workflows`. Not part of the resume cache key. |
| `phase` | [verified] | Assign this call to a named progress group, overriding the current `phase()` for this call only — useful inside `pipeline()`/`parallel()` stages, where the global phase state would race. |
| `agentType` | [verified] | Run as a registered subagent type (e.g. a specialist reviewer/TDD guide) instead of the default workflow subagent. The type must exist in the **consumer's session registry** — the runtime throws (listing the available types) on an unknown one, and the registry is session-specific, so validate *shape* only, never membership. Composes with `schema` (the forced StructuredOutput tool is injected regardless of the type's own tool allowlist). **Never hard-code a private type (e.g. `magic-claude:*`) as a workflow default** — it breaks other consumers; expose it as an opt-in input defaulting to omit. Specialization is *more thorough but noisier* — flexibility, not a proven quality win; pair a specialist producer with a verify stage that filters its false positives. |
| `isolation: 'worktree'` | [verified] | Run the agent in a fresh git worktree. Expensive — use only when parallel agents mutate files that would otherwise collide. |
| `stallMs` | [verified] | Override this agent's stall timeout. Default is 180 000 ms (3 minutes); the runtime retries a stalled agent up to 5 times. |

> `label`, `model`, `effort`, `agentType`, `isolation`, and `stallMs` are an
> **unstable surface** — they are not in any official documentation. `model`
> and structured output (`schema`) are the two options you tune most.

> **The wt-meta prompt tag.** `defineWorkflow` wraps `rt` with `withPromptTags`
> (`@workflow-toolbox/runtime`), so every `agent()` call carrying a `label` and/or a
> `phase` (explicit or via the current `phase()`) has its prompt prefixed with one
> machine-readable HTML-comment line: `<!-- wt-meta label="…" phase="…" -->`.
> Observability tooling reads it from the agent's transcript to assign the agent to
> its phase and show its real label **live, mid-run** — mid-run, the prompt is the
> only on-disk carrier of that identity. Consequences for authors: agents see the
> comment (models treat it as metadata; echo risk is low), and the prompt text
> changes mean a `resumeFromRunId` across the introduction of this feature re-runs
> previously-cached calls once. Untagged calls (no label, no phase) pass through
> untouched. Parse side: `parsePromptTag(text)` from the same module.
> Live COLUMN assignment additionally needs the tag's phase title to match a
> `meta.phases` title **exactly** — the same by-title contract the sandbox itself
> uses to group phases. A title not in `meta.phases` (or seeded ambiguously)
> degrades to label-only: the agent stays pending until journal reconciliation.

### `parallel(thunks) → Promise<Array<T | null>>` — a barrier

Runs all thunks concurrently and resolves when all finish. A thunk that throws
resolves to **`null`** in its slot; **the call itself never rejects**. [verified]

> Pass **thunks, not promises**: `[() => agent(...), () => agent(...)]`, never
> `[agent(...), agent(...)]`. Bare calls start immediately and defeat the
> concurrency limiter. The result array has holes by design — `.filter(Boolean)`
> before you use it. [observed]

### `pipeline(items, ...stages) → Promise<unknown[]>` — no barrier

Streams each item independently through all stages (no barrier between stages).
Each stage callback receives **`(prev, originalItem, index)`** — the previous
stage's result, the original input item, and the item index. [verified]

A stage that **throws drops that item to `null`** and skips the item's remaining
stages; other items are unaffected. As with `parallel`, the result array has
`null` holes — filter them. [verified]

### `phase(title)` — progress group

Starts a named progress group; later `agent()` calls join it. Use the same
`title` strings as in `meta.phases`. [verified]

### `log(message)` — narrator line

Emits a single line above the progress tree. [verified]

### `budget` — token budget for the turn

| Member | Meaning |
|---|---|
| `budget.total` | The user-set token target, or `null` if none was set. |
| `budget.spent()` | Output tokens spent this turn. |
| `budget.remaining()` | `max(0, total − spent())`, or **`Infinity`** when `total` is `null`. |

`agent()` throws once `spent() >= total`. The pool is **shared** across all
workflows running in the same turn. [verified]

> **Infinity trap.** With no target set, `budget.remaining()` is `Infinity`. An
> open-ended loop guarded only by `budget.remaining()` then never stops and
> sprints into the lifetime agent cap. Open-ended loops need a hard stop — a
> counter (`while (found < 10)`) or a guard that checks `budget.total` first
> (`while (budget.total && budget.remaining() > 50_000)`). [verified]

### `workflow(nameOrRef, args?) → Promise<unknown>` — nesting

Runs another workflow inline and returns its result. **One nesting level only**
— calling `workflow()` inside a child throws. [verified]

### `args` — the input

Whatever was passed as the tool's `args` input. If `args` was omitted, the
global is **`undefined`**. [documented]

> **Normalize before use.** Claude passes structured `args` (lists/objects) so
> the script can call array/object methods directly. But a **string `args`
> arrives JSON-encoded** — a string input reaches the script *including its
> surrounding quotes*. Decode/normalize a string arg before using it.
> [verified]

---

## Structured output via JSON Schema

Pass a JSON Schema as `agent(prompt, { schema })` and the agent is **forced** to
return a validated object matching it: the runtime builds a hidden structured-
output tool from the schema, validates the reply (AJV), and makes the agent
**retry on a mismatch**. `agent()` returns the parsed object directly — no
`JSON.parse`. [observed]

Use `schema` for any result a later line of JavaScript reads a field off of.
Keep schemas small and `required`-tight.

### Guard against schema capitulation (multi-field structured output) [observed]

An agent that gets several StructuredOutput validation rejections in a row can
**capitulate** — submit minimal junk that technically validates (`{"summary":"test",
"riskAreas":["a","b"]}`) and let it propagate downstream. It is invisible in telemetry:
the retries are intra-conversation, so the journal `attempt` stays `1`; only the agent's
raw transcript shows it. The trigger is a **long free-text field generated FIRST that
starves a required short sibling** — the model spends its budget on the prose, the JSON
closes before the required field, rejection, repeat, give up. Three cheap defenses, all
worth applying to any `schema` with ≥2 required properties where one is long-form:

1. **Order the `Return {...}` template with the SHORT / required fields FIRST, the long
   free-text field LAST.** It is the GENERATION order that matters, not the schema's
   property order — put `"riskAreas"` before `"summary"`, `"verdict"` before `"reason"`.
2. **Bound the long field** — `minLength` (a one-word junk value stops validating) and
   `maxLength` (a runaway turns into an actionable "too long" rejection instead of a
   silent "missing sibling"). e.g. `summary: { type: 'string', minLength: 12, maxLength:
   1200 }`.
3. **A downstream degenerate guard in the script** — a cheap heuristic (a required field
   under N trimmed chars, or array items all ≤2 chars) that pushes a `warning` + `rt.log`,
   **never fatal** when a later stage re-derives from source (a reviewer re-reads the diff
   regardless). Detection beats silent trust.

---

## Determinism rules

The runtime is deterministic so that a run can be resumed and replayed.
Non-deterministic calls — **`Date.now()`** and **`Math.random()`** — are banned
and break resume. [verified] An **argless `new Date()`** is banned on the same
grounds (`new Date(someTimestamp)` with an explicit argument is fine); the
tool's own description lists all three as throwing inside a workflow, and the
bundled linter flags them. [observed] Do not seed branching or values from
wall-clock time or randomness; derive ordering from the data instead — pass
timestamps in via `args` and stamp results after the workflow returns.

---

## Caps and limits

| Limit | Marker | Detail |
|---|---|---|
| Concurrent agents | [documented] | Up to **16** at once (fewer on machines with limited CPU cores). |
| Lifetime agents | [documented] | **1,000** agents total per run — prevents runaway loops. |
| Items per call | [observed] | A single `parallel()` / `pipeline()` call accepts at most **4,096** items; passing more is an explicit error, not a silent truncation (per the tool's own description). |
| Script size | [verified] | **512 KB** (524 288 bytes — `MAX_WORKFLOW_BYTES` in `@workflow-toolbox/build`, which the `workflow-toolbox check` linter enforces pre-launch). On the `script`/`scriptPath` path the tool **rejects** an oversized script before launch ("exceeds 524288 bytes"). On the `name` path the oversized file is **silently excluded** from the registry — no error anywhere, the workflow is just absent. |
| Mid-run input | [documented] | None. Only agent permission prompts can pause a run; for sign-off between stages, run each stage as its own workflow. |
| FS / shell | [documented] | The script itself has no filesystem or shell access; agents do. |

---

## The name registry

Saved workflows are resolved by `name`, and the registry is **keyed by
`meta.name`, not the filename** — a file `foo.js` whose `meta.name` is
`"foo-named"` resolves only as `foo-named`. [verified]

The registry **refreshes lazily mid-session**: a freshly installed file may not
be invokable by `name` for a few turns. Right after install, **`scriptPath` is
the reliable invocation path** — it always works with no install step.
[verified]

---

## Journal / resume semantics

The runtime tracks each agent's result as the run progresses, which makes a run
**resumable within the same session** via `resumeFromRunId`. [documented]

On resume, **unchanged `agent()` calls are served from the journal cache** (same
session only) — only missing or failed work re-runs; finished analysis is not
redone. [verified]

> **Exhaustion-as-checkpoint.** A run that stops early (e.g. a budget-floor cut)
> returns its **partial result**. Relaunching with `resumeFromRunId` and a
> higher (or no) target replays the completed `agent()` calls from cache and
> pays only for the missing work. Treat "ran out" as a checkpoint, not a loss.
> [verified]

---

## A note on failure modes

Agents can die mid-reasoning at their context limit, and the dying agent's last
mid-thought text **arrives as a normal-looking completion** — there is no error.
This is a known limitation, not a fixable bug. Defend in layers: put a `schema`
on every result a later line reads from; verify against fresh evidence; keep
each agent's scope small; and always check `WorkflowOutput.error` and relaunch
with `resumeFromRunId`. Trust no agent's self-report. [verified]

---

## Validate before you run

Lint a workflow file against the parser's hard rules **before** spending a run:

```bash
node scripts/validate-workflow.mjs <path-to-workflow.js>
```

It checks the 512 KB size limit, the `meta`-first / pure-literal rule, and the
banned non-deterministic calls. Exit 0 = clean (warnings allowed); exit 1 =
errors found. [verified]

In a project with the `@workflow-toolbox` packages installed, `npx workflow-toolbox check
<artifact.js>` runs the same rules (maintainers in the toolbox repo use the
`pnpm wt:check` script equivalent).
