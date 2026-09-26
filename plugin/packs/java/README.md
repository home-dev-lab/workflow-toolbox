# Java Pack

## Selection

The pack declares the `.java` extension and `pom.xml` as its only build-file trigger in `pack.json`.
`build.gradle` and `settings.gradle` belong to the Groovy pack, while their `.kts` variants belong
to Kotlin; a Java Gradle project still selects this pack through its `.java` sources. Selection
behavior is owned by the private pack hooks and is not enforced by this pack.

## What this pack ships

The pack ships Java/JUnit rules, Maven build skills, SDK-only critic and reviewer definitions, one
Java diagnostics declaration run through the plugin's `wt-jdtls` launcher, and a Java probe fixture. Groovy and Gradle ownership is in the
Groovy pack.

## Language server

The declaration runs the plugin's own launcher, not `jdtls` directly:
`command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/bin/wt-jdtls.mjs"]`, `extensionToLanguage: {".java":"java"}`,
`diagnostics: true`, `startupTimeout: 23000`. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in an LSP
server's `command`, `args`, `env` and `workspaceFolder`, and the plugin's MCP server already runs through
`node` the same way.

Why a launcher: Eclipse JDT LS refuses a JVM older than 21 (`jdtls requires at least Java 21`) and takes
its JVM from `JAVA_HOME`, then `java` on `PATH`. A session that inherits a Java 17 `JAVA_HOME` therefore
crash-looped the server: exit 1, three restarts, then `exceeded max crash recovery attempts`. `wt-jdtls`
chooses the JVM that RUNS the server and passes it through jdtls's own `--java-executable` option, leaving
`JAVA_HOME` untouched so the project keeps building with its own JDK. The choice, first match wins:

1. `--java-executable` already in the arguments: passed through unchanged;
2. `JAVA_HOME`, when it is Java 21 or newer;
3. the `java` first on `PATH`, when it is Java 21 or newer;
4. an installed JDK 21+, the lowest qualifying major and then its newest release (Java 21 is what the
   server is measured with): SDKMAN (`$SDKMAN_DIR` or `~/.sdkman`, `candidates/java/*`), `/usr/lib/jvm/*`
   on Linux, `/usr/libexec/java_home -v 21+` and `/Library/Java/JavaVirtualMachines` on macOS, the vendor
   folders under `%ProgramFiles%` on Windows, and `~/.jdks` everywhere. `WT_JDTLS_JDK_DIRS` (a
   path-list of directories whose children are JDK homes) replaces these built-in locations.

`node plugin/bin/wt-jdtls.mjs --help` prints this contract. The launcher passes jdtls's own launcher
options through (`-data`, `-configuration`, `--jvm-arg`, `--java-executable`,
`--[no-]validate-java-version`) and refuses any other argument in one line with exit 2.

A version is read from the JDK's `release` file, else from `java -version`. When nothing qualifies, the
launcher starts no JVM. It writes one line naming the requirement, what it found and where it looked, to
stderr (Claude Code's debug log), and returns the same line as the error of the client's `initialize`
request with `retry: false`, then exits 1. Measured on 2026-09-26 with every JDK 21+ hidden: the LSP tool
answered `Error performing documentSymbol: wt-jdtls: Eclipse JDT LS needs Java 21 or newer to run, and
none was found (JAVA_HOME=… is Java 17, `java` on PATH is Java 17; searched …). …`, and Claude Code
started the server once per LSP request, never in a restart loop. `jdtls` itself must still resolve on
the Claude Code process `PATH`; when it does not, the launcher refuses the same way, naming that.

`jdtls` is not bundled. Eclipse JDT LS 1.61.0 was installed from
`https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz`
(SHA-256 `338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64`) into
`~/.local/share/jdtls/`, with its `bin/` reachable on `PATH`. The Java 21 stdio smoke received `Type
mismatch: cannot convert from int to String` after 7477 ms and reached 719576 KiB peak RSS; artifacts are
under `.claude/reports/1861821660-lsp-probes/java/stdio-smoke/java21/`, the Java 17 failure beside it
under `java17/`.

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
launcher itself supplies a default data directory, so the declaration passes jdtls no arguments of its own.
Its Java 17 and Java 21 artifacts are under
`.claude/reports/1861821660-lsp-probes/java/stdio-smoke/`.

## Cross-platform verdict

`wt-jdtls` runs wherever Node runs; its JVM discovery is per platform, all behind
`plugin/bin/lib/host/jdtls-java.mjs`:

- **Linux** — measured on this machine (WSL2, 2026-09-26): `JAVA_HOME` = Temurin 17.0.9, SDKMAN holding
  17, 21.0.4, 21.0.9 and 25; the launcher chose `21.0.9-tem` and a real session answered documentSymbol.
  `/usr/lib/jvm` is read by listing (unit-tested, not exercised here: it is empty on this machine).
- **macOS** — read from source and unit-tested with a fake host, not run: `/usr/libexec/java_home -v 21+`,
  then `/Library/Java/JavaVirtualMachines/*/Contents/Home`, `~/Library/Java/JavaVirtualMachines`, SDKMAN,
  `~/.jdks`. `java_home` failing is not an error: the next location is read.
- **Windows** — read from source and unit-tested, not run: `%ProgramFiles%` / `%ProgramFiles(x86)%` vendor
  folders (`Eclipse Adoptium`, `Java`, `Microsoft`, `Zulu`, `Amazon Corretto`, `BellSoft`, `Semeru`) and
  `~/.jdks`, `java.exe`, `Path` split on `;`. The registry is not read, so a JDK installed elsewhere needs
  `JAVA_HOME`, `PATH` or `WT_JDTLS_JDK_DIRS`. The launcher runs the distribution's `bin/jdtls` Python
  script with `python`, because `jdtls.bat` ends in `pause`; `python` must therefore resolve on `PATH`.
  SDKMAN is not searched on Windows.

No location degrades to a plausible wrong answer: an unreadable directory or version is skipped, and when
nothing qualifies the launcher refuses in one line rather than starting a JVM that jdtls would reject.

## Optional assets

The rules and skills cover JUnit 5, Spock, Maven, and Gradle. SpotBugs, PMD, Checkstyle, and a
formatter are optional project-configured tools. The critic and reviewer are SDK-only definitions.

## Limits

The declaration covers `.java` only. It is independent of pack selection and does not install JDT
LS or a JDK: it only chooses among the JDKs already installed.
