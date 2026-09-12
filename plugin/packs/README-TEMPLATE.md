# <Pack name> Pack

Replace every placeholder and instruction in this file with pack-specific, checkable prose before publishing the pack.

## What this pack ships

State the language name, the manifest language value, and every shipped asset category. Point each claim to the relevant `pack.json` field and to the file or directory that supplies the listed asset. State the trigger extensions from `pack.json` and distinguish pack selection/context attachment from automatic execution.

## Language server

Name the server declaration in `.lsp.json` and state its `command`, `args`, and `extensionToLanguage` values exactly. Give the separately verified install line for each platform where it is known, with the source or probe artifact that verifies it. Explain that the declaration fails open when the binary is absent, and cite the fail-open measurement in the TypeScript pack README until this pack has its own measurement.

## Probe

Record the command `node toolkit/scripts/lsp-pack-probe.mjs <pack>` with the real pack name substituted. Give the repository-relative archived artifact path `.claude/reports/1861821660-lsp-probes/<pack>/<arm>/`. Describe both arms and their PASS criteria: `available` passes only when `command -v` resolves and a diagnostic naming the planted error arrives; `missing` passes only when no diagnostic arrives and the session ends normally. Put the observed verdict for each arm on its own checkable line tied to its archived artifact.

## Cross-platform verdict

Use this measurement wording, replacing the bracketed evidence with the actual machine, date, and binary version: the command must resolve on the Claude Code process PATH; measured on Linux ([machine], [date], [binary version]); macOS and Windows unmeasured until their probe artifacts exist. Do not replace the measurement statement with a claim that the server “works on” a platform.

## Optional assets

For each optional asset that exists, name it and cite its entry in `pack.json`: rules-on-demand topic rules, TDD/lint/build skills, and SDK-only agents. State explicitly when any category is absent. Do not imply that an optional asset is required or executes automatically.

## Dialects without diagnostics

When a dialect is covered by triggers and rules but has no language server, state that the dialect is owned by this pack’s triggers and rules and has no `.lsp.json` entry. State the mechanical follow-up condition: add diagnostics only after a named server has documented command, args, and extension mapping and passing archived probes on both arms.
