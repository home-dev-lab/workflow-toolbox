# Workflow Toolbox — guide for Claude Code

This repo has two halves that stand alone but work together:

- **`plugin/`** — the Claude Code plugin. Ships **five skills** — `workflow-composer`
  (author), `toolkit-scaffold` (start), `workflow-debugger` (diagnose a run),
  `upgrade-canary` (re-verify the runtime after an upgrade), `independent-analysis`
  (trigger the bias-free analysis workflow when relevant) — plus a `Stop` hook that
  auto-surfaces a finished run's audit report, and **one bundled workflow**:
  `independent-analysis` (domain-agnostic bias-free multi-lens analysis,
  invocable as `workflow-toolbox:independent-analysis`; a byte-identity mirror of the
  canonical `toolkit/workflows/` artifact — the workflow its same-named skill triggers).
  The dev-workflow family stays out of the plugin (dev-only); independent-analysis
  ships because it helps any analysis task.
- **`toolkit/`** — `@workflow-toolbox`, a compile-time TypeScript pattern library for Workflow
  scripts: `@workflow-toolbox/runtime` (sandbox typings + `FakeRuntime`), `@workflow-toolbox/patterns` (the
  seven patterns + result envelope), `@workflow-toolbox/build` (`defineWorkflow` + the `workflow-toolbox`
  CLI), plus support packages (`std`, `smoke`, `debugger`, `scaffold`). Example
  compositions live in `toolkit/examples/`; their committed `.js` artifacts in
  `toolkit/workflows/` run as-is via the Workflow tool's `scriptPath`.

## Where to read first

- [README.md](README.md) — what this is, install, the seven patterns, quickstart.
- [toolkit/README.md](toolkit/README.md) — the authoring contract, the pattern
  table (when to use / when not to), the result envelope.
- [docs/public/architecture.md](docs/public/architecture.md) — design principles,
  the evidence-tiered runtime facts, guardrails, what was deliberately not built.
- [docs/public/known-issues.md](docs/public/known-issues.md) — open items + the
  research-preview limitations.
- [docs/public/adr/](docs/public/adr/) — the five architecture decision records.
- `plugin/skills/workflow-composer/SKILL.md` (+ `references/`) — the authoring
  guide and API reference for workflow scripts.

## Working in this repo

Gates run from `toolkit/` (Node ≥ 20, pnpm):

```bash
cd toolkit
pnpm install
pnpm test && pnpm typecheck && pnpm lint
```

- **No build step for the source** — packages are consumed as TypeScript via
  `tsx`/`vitest`. `pnpm lint` is eslint flat config (`.mjs` is linted; `.js` is
  ignored).
- **Committed artifacts are generated, not hand-edited.** Rebuild a workflow with
  `pnpm wt:build <entry.workflow.ts>`; the artifacts in `toolkit/workflows/` are
  byte-identity-checked. Rebuild the debugger CLIs with `pnpm debugger:build`.
  The bundled plugin workflow `plugin/workflows/independent-analysis.js` is a
  byte-identity **mirror** of its canonical `toolkit/workflows/` artifact — after
  rebuilding that composition, refresh the mirror with `pnpm mirror:plugin-workflow`
  (the `plugin-bundle-identity` gate fails if it drifts). The bundled study sources
  under `plugin/skills/workflow-composer/assets/examples/toolkit/` are likewise
  byte-identity copies of `toolkit/examples/` (same gate).
- **Validate the plugin** before shipping a plugin change:
  `claude plugin validate . --strict` and `claude plugin validate ./plugin --strict`.
  Bump `plugin/.claude-plugin/plugin.json` `version` on any release-worthy change.

## Editing workflow scripts (the sandbox contract)

The Workflow tool runs a single `.js` in a sandbox with hard rules — the linter
(`pnpm wt:check`, also `validate-workflow.mjs`) enforces them on the emitted
artifact:

- `export const meta = { name, description, ... }` must be the **first statement**
  and a **pure literal** (no spreads, template literals, or calls inside it).
- **No** `import`/`require`/Node APIs in the artifact; **no** non-determinism
  (`Date.now()`, `Math.random()`, argless `new Date()`).
- Scripts are capped at **512 KB**.

Author in TypeScript against `@workflow-toolbox` and let `workflow-toolbox build` emit the compliant
artifact — don't hand-write the bundled `.js`.
