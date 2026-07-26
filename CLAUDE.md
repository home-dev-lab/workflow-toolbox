# Workflow Toolbox — guide for Claude Code

This repo has two halves that stand alone but work together:

- **`plugin/`** — the Claude Code plugin. Ships **ten skills** — `workflow-composer`
  (author), `toolkit-scaffold` (start), `workflow-debugger` (diagnose a run),
  `upgrade-canary` (re-verify the runtime after an upgrade), `independent-analysis`
  (trigger the bias-free analysis workflow when relevant), `deep-grounding`
  (collect + verify evidence against the real sources before asserting/analyzing),
  `pilot-wave` (compose a delegated pilot/orchestrator wave over tracked cards),
  `adopt-rules` (install editable, versioned copies of the bundled rules),
  `planka-tracking` (onboard a project onto a Planka kanban board), and `what-next`
  (propose the logical next step from that board) — the
  **pilot agent suite** (`pilot`, `pilot-orchestrator`, `pilot-watchdog`) that skill drives,
  a `Stop` hook that auto-surfaces a finished run's audit report, a `SessionStart` hook that
  injects the generic delegation ladder where a project does tracked/delegated work, and
  **one bundled workflow**:
  `independent-analysis` (domain-agnostic bias-free multi-lens analysis,
  invocable as `workflow-toolbox:independent-analysis`; a byte-identity mirror of the
  canonical `toolkit/workflows/` artifact — the workflow its same-named skill triggers).
  The dev-workflow family stays out of the plugin (dev-only); independent-analysis
  ships because it helps any analysis task.
- **`toolkit/`** — `@workflow-toolbox`, a compile-time TypeScript pattern library for Workflow
  scripts: `@workflow-toolbox/runtime` (sandbox typings + `FakeRuntime`), `@workflow-toolbox/patterns` (the
  nine patterns + result envelope), `@workflow-toolbox/build` (`defineWorkflow` + the `workflow-toolbox`
  CLI), plus support packages (`std`, `smoke`, `debugger`, `scaffold`). Example
  compositions live in `toolkit/examples/`; their committed `.js` artifacts in
  `toolkit/workflows/` run as-is via the Workflow tool's `scriptPath`.

Run visualization (the live phase→agent DAG, replay, themes) lives in **Workflow
Observatory**, a separate closed-source companion app (free tier for noncommercial
use). The `wt-observe` launcher CLI ships here and starts it when installed.

## Where to read first

- [README.md](README.md) — what this is, install, the nine patterns, quickstart.
- [toolkit/README.md](toolkit/README.md) — the authoring contract, the pattern
  table (when to use / when not to), the result envelope.
- [docs/public/architecture.md](docs/public/architecture.md) — design principles,
  the evidence-tiered runtime facts, guardrails, what was deliberately not built.
- [docs/public/known-issues.md](docs/public/known-issues.md) — open items + the
  research-preview limitations.
- [docs/public/adr/](docs/public/adr/) — the architecture decision records.
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

The full sandbox contract (meta-first pure literal, no imports/Node APIs, no
non-determinism, 512 KB cap) lives in the `workflow-composer` skill
(`plugin/skills/workflow-composer/SKILL.md`) — the linter (`pnpm wt:check` /
`validate-workflow.mjs`) enforces it on the emitted artifact. Author in
TypeScript against `@workflow-toolbox` and let `workflow-toolbox build` emit the
compliant artifact — don't hand-write the bundled `.js`.
