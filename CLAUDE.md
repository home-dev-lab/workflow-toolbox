# Workflow Toolbox — guide for Claude Code

This repo has two halves that stand alone but work together:

- **`plugin/`** — the Claude Code plugin. Ships **skills only** (no bundled
  workflow): `workflow-composer` (author), `toolkit-scaffold` (start),
  `workflow-debugger` (diagnose a run), `upgrade-canary` (re-verify the runtime
  after an upgrade), plus a `Stop` hook that auto-surfaces a finished run's audit
  report.
- **`toolkit/`** — `@dwt`, a compile-time TypeScript pattern library for Workflow
  scripts: `@dwt/runtime` (sandbox typings + `FakeRuntime`), `@dwt/patterns` (the
  seven patterns + result envelope), `@dwt/build` (`defineWorkflow` + the `dwt`
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
  `pnpm dwt:build <entry.workflow.ts>`; the artifacts in `toolkit/workflows/` are
  byte-identity-checked. Rebuild the debugger CLIs with `pnpm debugger:build`.
- **Validate the plugin** before shipping a plugin change:
  `claude plugin validate . --strict` and `claude plugin validate ./plugin --strict`.
  Bump `plugin/.claude-plugin/plugin.json` `version` on any release-worthy change.

## Editing workflow scripts (the sandbox contract)

The Workflow tool runs a single `.js` in a sandbox with hard rules — the linter
(`pnpm dwt:check`, also `validate-workflow.mjs`) enforces them on the emitted
artifact:

- `export const meta = { name, description, ... }` must be the **first statement**
  and a **pure literal** (no spreads, template literals, or calls inside it).
- **No** `import`/`require`/Node APIs in the artifact; **no** non-determinism
  (`Date.now()`, `Math.random()`, argless `new Date()`).
- Scripts are capped at **512 KB**.

Author in TypeScript against `@dwt` and let `dwt build` emit the compliant
artifact — don't hand-write the bundled `.js`.
