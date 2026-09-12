# Kotlin Pack

## What this pack ships

`pack.json` declares the `kotlin` language value, selects `.kt` and `.kts` source and script files,
and also selects `build.gradle.kts`, `settings.gradle.kts`, and Maven `pom.xml` build files. Pack
selection and context attachment are owned by the private pack hooks; the manifest does not execute
rules, agents, or tests automatically.

The pack supplies its diagnostics declaration in `.lsp.json`, Kotlin JVM rules in `rules/`, SDK-only
critic and reviewer definitions in `agents/`, and planted diagnostics plus navigation fixtures in
`probe/`. The rules cover JUnit 5 and `kotlin.test`; no skill is shipped because the pack loader
attaches the rule files directly and no Kotlin-specific skill duplication is needed.

## Language server

The declaration is the fallback `fwcd/kotlin-language-server`, exposed as command
`kotlin-language-server`, with `args: []`, `extensionToLanguage: {".kt":"kotlin",
".kts":"kotlin"}`, `diagnostics: true`, and `startupTimeout: 60000` in `.lsp.json`.

JetBrains Kotlin LSP `262.9593.0` was tried first from
`https://download-cdn.jetbrains.com/language-server/kotlin-server/262.9593.0/kotlin-server-262.9593.0.tar.gz`
(SHA-256 `2d99d8e198fbe4aa8f4481e37799724ce94803b4ea12a60b416040e3fcd7cc5e`), installed under
`~/.local/share/kotlin-lsp/`, and exposed as `kotlin-lsp`. Its headless harness log records
`This build of intellij-server has expired` and exit 7, so it cannot be used on this machine.

The fallback `fwcd/kotlin-language-server` 1.3.13 was downloaded from
`https://github.com/fwcd/kotlin-language-server/releases/download/1.3.13/server.zip` (SHA-256
`4fe7d71d087b307c7869036171bd9d8c6a4284cd7c25b89098b0a24eb2d9b6d2`) and installed under
`~/.local/share/kotlin-language-server/`, with `~/.local/bin/kotlin-language-server` linked to its
launcher. A direct stdio smoke emitted `Kotlin Language Server: Version 1.3.13` and `Connected to
client`. The launcher has no `--version` option; its startup message is the version evidence.

The declaration fails open when its command is absent. Do not rely on Kotlin diagnostics until the
two-arm Claude-harness probe below passes; the current measurement was blocked by an API rate limit.

## Probe

Run `node toolkit/scripts/lsp-pack-probe.mjs kotlin`. The fixture is `probe/Probe.kt`, with its
planted `String = 1` type mismatch, `probe/expected-diagnostic.txt`, and navigation sources and
expectations under `probe/nav/`. Artifacts archive under
`.claude/reports/1862700000-lsp-probes/kotlin/<arm>/`.

Available arm - NOT MEASURED (2026-09-12): JetBrains Kotlin LSP started then expired; the fallback
harness attempt was stopped before LSP initialization by Claude API `429`. It did not deliver the
expected `Initializer type mismatch` diagnostic. Archive:
`.claude/reports/1862700000-lsp-probes/kotlin/available/`.

Missing arm - NOT MEASURED (2026-09-12): the fallback harness session encountered the same API
`429`, so it did not meet the normal-exit control criterion. Archive:
`.claude/reports/1862700000-lsp-probes/kotlin/missing/`.

| Capability | Verdict | Evidence |
| --- | --- | --- |
| diagnostics | not measured | Available and missing harness runs were blocked by API 429. |
| symbol-overview | not measured | Not run after the diagnostics control was blocked. |
| symbol-lookup | not measured | Not run after the diagnostics control was blocked. |
| declarations | not measured | Not run after the diagnostics control was blocked. |
| references | not measured | Not run after the diagnostics control was blocked. |
| implementations | not measured | Not run after the diagnostics control was blocked. |

## Cross-platform verdict

The command must resolve on the Claude Code process PATH; measured on Linux (this machine,
2026-09-12, Kotlin Language Server 1.3.13 direct stdio startup). macOS and Windows are unmeasured
until their probe artifacts exist. The Linux Claude-harness measurement is also unmeasured because
the available and missing arms could not complete through the rate-limited API.

## Optional assets

This pack ships `rules/tdd-junit-kotlin-test.md` and `rules/lint-typecheck-build.md`, named by
`pack.json`, plus SDK-only `agents/critic.md` and `agents/reviewer.md`. It ships no skills: the
loader can attach the two topic rules without copying family skills. The agents do not execute
automatically and must not be registered as harness agents.

## Dialects without diagnostics

Gradle Kotlin DSL and Maven build files are owned by this pack's triggers and rules. The Kotlin
server maps `.kts`, but there is no separate diagnostics declaration for Maven XML or a Gradle model.
Add one only after a named server documents its command, args, and extension mapping and its two
archived probe arms pass.
