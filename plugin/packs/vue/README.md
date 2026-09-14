# Vue Pack

## What this pack ships

`pack.json` declares language `vue`, selecting this pack only for `.vue` files. No build or
configuration file, including Vite, Vitest, or `tsconfig.json`, selects it; a Vue project still
matches through its `.vue` components. Selection attaches pack context; it does not execute rules,
skills, agents, or diagnostics automatically. The pack ships rules, TDD and gate skills, SDK-only
`agents/critic.md` and `agents/reviewer.md`, and diagnostics and navigation probe fixtures under
`probe/`.

The rules are minimal local copies of the TypeScript-family TDD and gate guidance. The current
private pack loader addresses rule files inside the selected pack and has no cross-pack reference,
so the copies are required; their duplication and scope are named in each rule file.

## Language server

Volar was installed under `~/.local`: `@vue/language-server` 3.3.11 from
`https://registry.npmjs.org/@vue/language-server/-/language-server-3.3.11.tgz`, SHA-256
`dbd73606bc0691431fceb5aa5d278af0178d39c1154ca6878c526e704cf00594`. The executable is
`~/.local/bin/vue-language-server`, a symlink to the package's `bin/vue-language-server.js`.

No `.lsp.json` is shipped. The attempted declaration used `command: "vue-language-server"`,
`args: ["--stdio"]`, `extensionToLanguage: {".vue":"vue"}`, `diagnostics: true`, and a 20,000
ms startup timeout. Volar 3.3.11 initialized in 534 ms on the available-binary probe but did not
publish the planted diagnostic in either attempt, including an explicit strict `tsconfig.json`.
Shipping that declaration would fail open with no diagnostic, so it is deliberately withheld.

## Probe

The attempted command was `PATH="$HOME/.local/bin:$PATH" WT_LSP_PROBE_ARCHIVE_ROOT="$PWD/.claude/reports/1862700000-lsp-probes" node toolkit/scripts/lsp-pack-probe.mjs vue`.
The fixture is `probe/probe.vue`, with its planted type mismatch named by
`probe/expected-diagnostic.txt`; `workspace-modules.txt` provides TypeScript and `tsconfig.json`
enables strict checking. Navigation fixtures are under `probe/nav/`.

Available arm — FAIL (2026-09-12, Linux, Volar 3.3.11): the debug log records successful server
initialization but no `textDocument/publishDiagnostics` notification or diagnostic attachment;
artifacts are `.claude/reports/1862700000-lsp-probes/vue/available/`.

Missing arm — PASS (same date): with `vue-language-server` absent from the shim PATH, the session
ended normally with no diagnostic; artifacts are
`.claude/reports/1862700000-lsp-probes/vue/missing/`.

## Cross-platform verdict

The command must resolve on the Claude Code process PATH. Measured on Linux (this machine,
2026-09-12, Volar 3.3.11), but diagnostics were not delivered, so no LSP declaration is shipped.
macOS and Windows are unmeasured until their probe artifacts exist.

## Optional assets

`pack.json` lists local TDD and gate rules, matching skills, and SDK-only critic and reviewer
agents. They are optional context assets and do not execute automatically. Diagnostics are absent
until a named server has documented command, arguments, extension mapping, and passing archived
available and missing probe arms.
