# Svelte Pack

## What this pack ships

This pack declares the `svelte` language in `pack.json`. Its `.svelte` extension trigger and sole
configuration-file trigger, `svelte.config.js`, select and attach pack context. Generic Vite and
Vitest configuration files do not select it; a Svelte Vite project still matches through `.svelte`
or `svelte.config.js`. Selection does not automatically execute rules, agents, diagnostics, or build
commands. It ships the Svelte-specific
`rules/svelte.md`, SDK-only `agents/critic.md` and `agents/reviewer.md`, the `svelteserver`
declaration in `.lsp.json`, and diagnostic and navigation fixtures under `probe/`.

The generic Vitest TDD and lint/typecheck/build rules already belong to the TypeScript web-family
pack and are not copied here. `rules/svelte.md` covers only Svelte-specific component checking;
consumers whose loader supports family-rule references should use the TypeScript family rules for
the shared guidance.

## Language server

`.lsp.json` declares `svelte`: `command: "svelteserver"`, `args: ["--stdio"]`, and
`extensionToLanguage: {".svelte":"svelte"}`. It also sets `diagnostics: true` and the measured
10,000 ms startup timeout. The declaration fails open when the binary is absent; the missing-arm
probe below is the control for that condition.

On Linux, `svelte-language-server` 0.18.4 from
`https://registry.npmjs.org/svelte-language-server/-/svelte-language-server-0.18.4.tgz` (upstream
source `https://github.com/sveltejs/language-tools`, SHA-256
`3700f0d4af450fd898efd90b29ab7f0c9f5a5c7e8967f5c2cebf528a18341757`) was installed with
`npm install --global --prefix ~/.local svelte-language-server@0.18.4`. The archived tarball is at
`~/.local/share/svelte-language-server/svelte-language-server-0.18.4.tgz` and the command is
`~/.local/bin/svelteserver`.

## Probe

Run `WT_LSP_PROBE_ARCHIVE_ROOT=.claude/reports/1862700000-lsp-probes node
toolkit/scripts/lsp-pack-probe.mjs svelte`. The fixture `probe/probe.svelte` contains one planted
string-to-number error, whose required diagnostic substring is in `probe/expected-diagnostic.txt`.
Navigation fixtures are `probe/nav/definitions.svelte`, `probe/nav/use.svelte`, and
`probe/nav/expected-navigation.json`.

Available arm — PASS (2026-09-12, Linux, `command -v` →
`/home/doublefx/.local/bin/svelteserver`): the harness debug log records a delivered diagnostic and
the session quoted `Type 'string' is not assignable to type 'number'`; 44,202 ms wall time.
Artifacts: `.claude/reports/1862700000-lsp-probes/svelte/available/`.

Missing arm — PASS (same date; `command -v` → not found on the isolated shim PATH): no diagnostic
was delivered and the session ended normally in 50,519 ms. Artifacts:
`.claude/reports/1862700000-lsp-probes/svelte/missing/`.

The generated navigation table is
`.claude/reports/1862700000-lsp-probes/parity-table.md`: diagnostics and symbol overview are
`parity`; symbol lookup, declarations, references, and implementations are `unmeasured` because
the headless sessions reached the harness model-rate limit before issuing their LSP requests.

## Cross-platform verdict

The command must resolve on the Claude Code process PATH; measured on Linux (this machine,
2026-09-12, svelte-language-server 0.18.4); macOS and Windows unmeasured until their probe
artifacts exist.

## Optional assets

`pack.json` registers the Svelte-specific `svelte.md` topic rule and the SDK-only `critic.md` and
`reviewer.md` agents. It intentionally has no duplicated generic TypeScript skills or rules; those
remain optional family assets and do not execute automatically.
