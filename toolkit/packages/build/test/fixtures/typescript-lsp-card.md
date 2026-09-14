# TypeScript pack: ship an LSP declaration for automatic diagnostics only

Add a `.lsp.json` (or `lspServers` in plugin.json) for TypeScript to `plugin/packs/typescript/` so that a session using the pack gets automatic diagnostics after every edit (`<new-diagnostics>` blocks), with `diagnostics: true` and no navigation instruction.

Why (card 1859134904294442411, three measured readings 2026-09-08): diagnostics reach the model with no briefing and caught a real TS2554 in the same turn; LSP navigation never happens unless instructed, and when instructed it costs more turns than the bytes it saves (a turn replays ~176k prefix tokens, a file read costs ~3k). Evidence: `.claude/research/lsp-20260908/.lane/v3/report.md`, `v4/report.md`, fiche `a-plugin-declares-language-servers-in-lsp-json`.

Definition of done:
1. The pack carries the declaration; `typescript-language-server` is NOT vendored: document the install (`npm i -g typescript-language-server typescript`) and make the declaration degrade legibly when the binary is absent (state what the harness prints, measured).
2. A pack README section: what you get (diagnostics after edits), what you do not get by default (navigation), the one-line instruction to opt into navigation, and the measured numbers above.
3. No rule or prompt text asks the model to prefer LSP over Read/Grep.
4. Cross-platform verdict stated (Windows/macOS: PATH resolution of the binary).
5. Gates green; pack tests updated if the pack has a manifest test.

<!-- sr-meta v1 -->
Last-worked: 2026-09-08
Next: write the .lsp.json + README section in a lane; verify a headless run with the pack shows a <new-diagnostics> block after an edit that introduces a type error
<!-- /sr-meta -->

Depends-on: none

## Comment digest (1 comment, 2026-09-10)
Consultation record: claude-mem and Atrium propose a separate opt-in code-navigation skill; it is DISTINCT from this card (diagnostics-only declaration) and does not replace DoD item 3. Historical evidence: .claude/research/lsp-20260908/.lane/v3/report.md and v4/report.md.

## Arbiter scope (main session, 2026-09-11)
- Route: you decide at discovery from the signals; this card names one pack directory (plugin/packs/typescript/), one declaration file and one README section, settled design — state LITE or FULL with the reason.
- Worktree: this directory only; branch card/1859740879-lsp off develop db4a1649. Commit on this branch only in the report phase; no merge, no push, no publish, no global npm install on the machine (DoD item 1 documents the install, it does not perform it).
- Lane: launcher and model fixed by the lifecycle (gpt-5.6-terra); the brief quotes the definition of done verbatim and names the gates: from toolkit/, pnpm test, pnpm typecheck, pnpm lint, each detached with an EXIT= marker in .lane/<gate>.log.
- DoD item 1 "measured": the degraded message when the binary is absent must come from a real headless run, archived under .lane/, not from the docs. If a real run is impossible in the lane, the report says so as PARTIAL, never assumes.
- Report: .lane/pilot-report.md through the lifecycle artifact tool at awaiting_fidelity, five sections plus ## Lessons for the memory.
