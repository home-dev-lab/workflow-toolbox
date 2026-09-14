# Java Pack

## Selection

The pack declares the `.java` extension and `pom.xml` as its only build-file trigger in `pack.json`.
`build.gradle` and `settings.gradle` belong to the Groovy pack, while their `.kts` variants belong
to Kotlin; a Java Gradle project still selects this pack through its `.java` sources. Selection
behavior is owned by the private pack hooks and is not enforced by this pack.

## What this pack ships

The pack ships Java/JUnit rules, Maven build skills, SDK-only critic and reviewer definitions, one
Java diagnostics declaration, and a Java probe fixture. Groovy and Gradle ownership is in the
Groovy pack.

## Language server

The measured declaration is `jdtls` with `args: []`, `extensionToLanguage: {".java":"java"}`,
`diagnostics: true`, and `startupTimeout: 23000`. Eclipse JDT LS 1.61.0 was installed from
`https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz`
(SHA-256 `338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64`) into
`~/.local/share/jdtls/`, with `~/.local/bin/jdtls` symlinked to `~/.local/share/jdtls/bin/jdtls`.

The launcher requires the `java` first on the Claude Code process `PATH` to be JDK 21 or newer; a
JDK 21 installed elsewhere does not count. The probe's `runtime.txt` records the resolved `java`
and its version. The measurement failed with the default OpenJDK 17.0.9 and passed with Temurin
21.0.9. The Java 21 stdio smoke received `Type mismatch: cannot convert from
int to String` after 7477 ms and reached 719576 KiB peak RSS; artifacts are under
`.claude/reports/1861821660-lsp-probes/java/stdio-smoke/java21/`. The Java 17 failure is archived
beside it under `java17/`.

The TypeScript measurement records that a missing command emits neither diagnostics nor a
missing-command warning in its headless harness and therefore fails open
(`plugin/packs/typescript/README.md:45-59`). Install and expose `jdtls` before relying on Java
diagnostics.

## Probe

Run `node toolkit/scripts/lsp-pack-probe.mjs java`. The available-binary and missing-binary arms
archive under `.claude/reports/1861821660-lsp-probes/java/<arm>/`.

Available arm — PASS (2026-09-12, Linux, `command -v` → `/home/doublefx/.local/bin/jdtls`, Eclipse JDT LS 1.61.0, `java` = Temurin 21.0.9 placed first on the probe's PATH): the harness debug log records `textDocument/publishDiagnostics` received and 1 diagnostic attachment(s) delivered, and the session quoted `Type mismatch`; 44786 ms wall time for the headless session; artifacts `.claude/reports/1861821660-lsp-probes/java/available/` (stdout.log, stderr.log, debug.log, elapsed-ms.txt, command-v.txt, version.txt).

Missing arm — PASS (same date; `command -v` → not found on the shim PATH, `node` and `claude` still resolving): the harness attempted to start the server and failed (`Failed to start LSP server`: the command is absent), no `publishDiagnostics` was received and 0 attachments were delivered, the session ended normally (exit 0, 59084 ms) with no diagnostic and no missing-command message — the declaration fails open; artifacts `.claude/reports/1861821660-lsp-probes/java/missing/`.

The local stdio smoke used `jdtls -data <temporary-directory>` only to isolate its workspace; the
launcher itself supplies a default data directory, so the shipped declaration needs no arguments.
Its Java 17 and Java 21 artifacts are under
`.claude/reports/1861821660-lsp-probes/java/stdio-smoke/`.

## Cross-platform verdict

The command must resolve on the Claude Code process PATH; measured on Linux (this machine,
2026-09-12, Eclipse JDT LS 1.61.0); macOS and Windows unmeasured until their probe artifacts exist.
The command also requires the `java` first on the Claude Code process PATH to be JDK 21 or newer: the passing headless arm ran with a JDK 21 `bin` first on PATH; with the machine default (OpenJDK 17) the launcher exits `jdtls requires at least Java 21` (stdio smoke, `java17/`). A JDK 21 installed elsewhere does not count; inspect the probe's `runtime.txt` for the actual runtime.

## Optional assets

The rules and skills cover JUnit 5, Spock, Maven, and Gradle. SpotBugs, PMD, Checkstyle, and a
formatter are optional project-configured tools. The critic and reviewer are SDK-only definitions.

## Limits

The declaration covers `.java` only. It is independent of pack selection and does not install JDT
LS or a JDK for the Claude Code process.
