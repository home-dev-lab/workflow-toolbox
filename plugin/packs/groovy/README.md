# Groovy Pack

## What this pack ships

`pack.json` declares the `groovy` language and selects this pack for `.groovy` and `.gradle`
extensions plus the Groovy-written Gradle files `build.gradle` and `settings.gradle`, and the Spock
configuration file `spock.conf`. The `.kts` Gradle variants belong to Kotlin; projects containing
Groovy still select this pack through `.groovy` or `.gradle`. Selection attaches context; it does
not execute rules, agents, or gates automatically.

The pack supplies `rules/tdd-spock.md` and `rules/lint-typecheck-build.md`, SDK-only
`agents/critic.md` and `agents/reviewer.md`, the diagnostics and navigation fixtures in
`probe/`, and `.lsp.json`, which declares `groovy-language-server` for `.groovy` files. The two rules are intentionally minimal duplications of the Java family guidance: the
current pack manifest only names rules relative to its own directory, so it cannot reference the
Java pack's files.

## Language server

The pack declares `groovy-language-server` with `args: []`, `extensionToLanguage: {".groovy":"groovy"}`,
`diagnostics: true`, and `startupTimeout: 30000`. The server is not bundled; `groovy-language-server` must
resolve on the Claude Code process `PATH`. The measured build is
`GroovyLanguageServer/groovy-language-server` from `https://github.com/GroovyLanguageServer/groovy-language-server`
at commit `347d098a928707223ce44b52cc45174a6327a5f3`, whose `groovy-language-server-all.jar` (SHA-256
`cf6e38d9fec6b82ccdb4378eafd711db357fd50ec025ca6e68ddbcb6b6bf4b1e`) is started by a one-line
`exec java -jar <jar>` script named `groovy-language-server`. It runs on Java 17: it has no Java 21 floor.

This replaces the 2026-09-12 decision not to declare it. That headless arm never logged `Starting LSP
server instance: plugin:workflow-toolbox:groovy`. Since then, a real session on 2026-09-24 started the
same server as `plugin:groovy-lsp:groovy` and answered documentSymbol, and on 2026-09-26 a test-profile
session loading this plugin logged `Starting LSP server instance: plugin:workflow-toolbox:groovy`,
initialized it in 1315 ms, and answered documentSymbol on `probe/nav/definitions.groovy` with
`Greeter`, `greet`, and `FriendlyGreeter`.

`.gradle` is deliberately NOT mapped. On an ordinary `build.gradle` (a `plugins {}` block, dependencies,
and an `import org.gradle.api.tasks.testing.logging.TestExceptionFormat`), the server reported `unable to
resolve class org.gradle.api.tasks.testing.logging.TestExceptionFormat` and returned the single symbol
`build` (stdio probe, 2026-09-26): it has no Gradle API on its classpath, so with diagnostics on, every
build-script edit would inject a false error. `.gradle` stays a pack trigger for rules and context only.

## Probe

The diagnostics probe command is `node toolkit/scripts/lsp-pack-probe.mjs groovy`. Its planted type error
is `probe/Probe.groovy`; `probe/expected-diagnostic.txt` names the required diagnostic substring;
`probe/nav/` holds the navigation fixtures. The 2026-09-12 artifacts are archived at
`.claude/reports/1862700000-lsp-probes/groovy/available/` (FAIL: the harness did not start the server) and
`.claude/reports/1862700000-lsp-probes/groovy/missing/` (PASS: no server on PATH, no diagnostic, normal
exit). The two-arm diagnostics probe has not been re-run since the declaration was added; the evidence
for this declaration is the documentSymbol session above.

## Cross-platform verdict

The command must resolve on the Claude Code process `PATH`, and the `java` it runs must be one the jar
supports. Measured on Linux only (this machine, 2026-09-26, the commit above, Temurin 17.0.9 first on
`PATH`). macOS and Windows are unmeasured: the declaration itself carries nothing platform-specific, but
the `groovy-language-server` launch script is the installer's to provide on each platform (on Windows a
`.cmd`/`.bat` wrapper that runs `java -jar`).

## Optional assets

The pack supplies two rules, SDK-only critic and reviewer agents named in `pack.json`, and the
`groovy` language-server declaration. It ships no skills. The agents do not execute automatically.
