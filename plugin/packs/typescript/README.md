# TypeScript Pack

This pack provides TypeScript-specific rules, skills, and SDK-only critic and reviewer definitions
for the Workflow Toolbox repository.

## Selection

`wt-lifecycle-hooks` selects the pack when a card Discovery block contains a `Language:` value
matching `typescript`. `wt-rules-on-demand` serves the pack's topic rules on `Edit` and `Write`
tool calls targeting `.ts` or `.tsx` paths. Other language values and an absent `Language:` field
do not select this pack.

## Limits

- The pack covers TypeScript and TSX only; it supplies no rules or workflow for other languages.
- SDK-only status is a convention plus the absence of these definitions from `plugin/agents/` and
  `plugin/agent-templates/`; the pack does not enforce SDK invocation at runtime.
- Pack selection attaches context notes and topic rules. It does not execute TDD, gates, or a
  reviewer automatically.

## What this pack ships

This pack provides TypeScript-specific rules, skills, and SDK-only critic and reviewer definitions
for the Workflow Toolbox repository. Its `pack.json` declares `.ts` and `.tsx` triggers, two topic
rules, two skills, and two SDK-only agents.

## Language server

The pack carries `.lsp.json` for `typescript-language-server`; when the Workflow Toolbox plugin is
loaded and the binary is on `PATH`, TypeScript diagnostics are delivered after edits as
`<new-diagnostics>` blocks. Claude Code loads LSP declarations from a plugin root, not a pack
directory, so `plugin/.lsp.json` deliberately mirrors this pack declaration as the loader bridge.
This makes diagnostics available to sessions that load this plugin; it does not make LSP
configuration conditional on pack selection.

The language server is not vendored. Install it separately with:

```sh
npm i -g typescript-language-server typescript
```

Navigation is not requested by this pack. To opt in, a human may paste: "Use the available LSP
navigation tools to look up this symbol and its references."

Measured on Linux, the no-instruction LSP arm produced one TS6133 `<new-diagnostics>` block in 11
turns at 178,823.5 cache-read tokens per turn. The instructed arm used `workspaceSymbol` and
`findReferences`, caught TS2554, and used 25.0% more turns and 95.8% more bytes read than the
no-plugin arm. A later reading measured 44.4% and 55.6% more turns for its instructed arms. See
`.claude/research/lsp-20260908/.lane/v3/report.md` and `v4/report.md`.

The 2026-09-11 missing-binary headless probe still completed its requested edit and printed only:

```ts
function acceptsOne(value: string): string {
  return value
}

acceptsOne()
```

It emitted no `<new-diagnostics>` block or missing-command warning. The declaration therefore
fails open rather than reporting a legible error in this harness; install the command above before
relying on diagnostics. The available-binary probe loaded the server and registered its diagnostics
handler, but likewise did not publish a diagnostic before the headless session ended; see
`.lane/lsp-missing.json`, `.lane/lsp-available.json`, and their debug logs.

`.tsx` files are not mapped yet: `extensionToLanguage` covers `.ts` only, the shape measured on 2026-09-08,
although `pack.json` triggers on `.tsx` too. Mapping `typescriptreact` needs its own probe before it is
added.

## Probe

Run:

```sh
node toolkit/scripts/lsp-pack-probe.mjs typescript
```

The archived artifacts are `.claude/reports/1861821660-lsp-probes/typescript/available/` and
`.claude/reports/1861821660-lsp-probes/typescript/missing/`. The available arm passes only when
`command -v` resolves and a diagnostic naming the planted error arrives.

«PROBE-VERDICT»

The missing arm passes only when no diagnostic arrives and the session ends normally.

«PROBE-VERDICT»

## Cross-platform verdict

The command must resolve on the Claude Code process PATH; measured on Linux (this machine,
2026-09-11, typescript-language-server version unrecorded); macOS and Windows unmeasured until
their probe artifacts exist. This retains the prior requirement that the global npm bin directory
be on PATH and that command discovery is otherwise platform-specific.

## Optional assets

The optional assets listed in `pack.json` are the rules-on-demand topic rules `tdd-vitest.md` and
`lint-typecheck-build.md`, the TDD/lint/build skills `tdd-red-green` and `lint-typecheck-build`,
and the SDK-only agents `critic.md` and `reviewer.md`.

## Adding Another Pack

Follow `docs/public/language-packs.md` for the complete add-a-language recipe.
