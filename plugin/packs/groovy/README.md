# Groovy Pack

## What this pack ships

`pack.json` declares the `groovy` language and selects this pack for `.groovy` and `.gradle`
extensions plus the Groovy-written Gradle files `build.gradle` and `settings.gradle`, and the Spock
configuration file `spock.conf`. The `.kts` Gradle variants belong to Kotlin; projects containing
Groovy still select this pack through `.groovy` or `.gradle`. Selection attaches context; it does
not execute rules, agents, or gates automatically.

The pack supplies `rules/tdd-spock.md` and `rules/lint-typecheck-build.md`, SDK-only
`agents/critic.md` and `agents/reviewer.md`, and the diagnostics and navigation fixtures in
`probe/`. The two rules are intentionally minimal duplications of the Java family guidance: the
current pack manifest only names rules relative to its own directory, so it cannot reference the
Java pack's files.

## Language server

No `.lsp.json` ships. `GroovyLanguageServer/groovy-language-server` was built from source URL
`https://github.com/GroovyLanguageServer/groovy-language-server` at commit
`347d098a928707223ce44b52cc45174a6327a5f3` under
`~/.local/share/groovy-language-server/`; its built
`groovy-language-server-all.jar` SHA-256 is
`cf6e38d9fec6b82ccdb4378eafd711db357fd50ec025ca6e68ddbcb6b6bf4b1e`.
`~/.local/bin/groovy-language-server` launches the jar with `java -jar` and must resolve on PATH.

The attempted declaration used `command: "groovy-language-server"`, `args: []`,
`extensionToLanguage: {".groovy":"groovy", ".gradle":"groovy"}`, `diagnostics: true`, and a
measured `startupTimeout: 30000`. The 2026-09-12 headless available arm resolved the command but
Claude Code never logged `Starting LSP server instance: plugin:workflow-toolbox:groovy`; no
`publishDiagnostics` or diagnostic attachment arrived. The missing arm passed its control (failed
start, no diagnostic, normal exit), but the available arm failed, so declaring the server would
silently claim unavailable diagnostics. Do not add `.lsp.json` until both archived probe arms pass.

## Probe

The attempted command was `node toolkit/scripts/lsp-pack-probe.mjs groovy`. Its planted type error
is `probe/Probe.groovy`; `probe/expected-diagnostic.txt` names the required diagnostic substring;
`probe/nav/` holds the navigation fixtures. Artifacts are archived at
`.claude/reports/1862700000-lsp-probes/groovy/available/` and
`.claude/reports/1862700000-lsp-probes/groovy/missing/`.

Available arm — FAIL (2026-09-12): the binary resolved, but the harness did not start the Groovy
LSP and delivered no planted diagnostic. Missing arm — PASS (same date): the isolated PATH had no
server, no diagnostic arrived, and the session ended normally.

## Cross-platform verdict

The command must resolve on the Claude Code process PATH; measured on Linux (this machine,
2026-09-12, GroovyLanguageServer commit `347d098a928707223ce44b52cc45174a6327a5f3`, built with
Temurin 17.0.9); macOS and Windows unmeasured until their probe artifacts exist.

## Optional assets

The pack supplies two rules and SDK-only critic and reviewer agents named in `pack.json`. It ships
no skills and no language-server declaration. The agents do not execute automatically.
