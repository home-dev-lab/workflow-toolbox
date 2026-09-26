# Changelog

All notable changes to the `workflow-toolbox` Claude Code plugin are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Lane gates run from the repo root now resolve the pinned pnpm. Corepack resolves the pnpm version by walking up from the working directory, then pnpm checks it against the `--dir` target's own pin; only `toolkit/package.json` carried a `packageManager` field, so `pnpm --dir toolkit <gate>` invoked from the repo root failed for any Corepack user whose default pnpm was not already the toolkit's pin and who had no ancestor directory pinning it either (`configured to use 11.10.0 of pnpm. Your current pnpm is vX.Y.Z`). The root `package.json` now pins the same `pnpm@11.10.0`, checked equal to the toolkit's pin by a new test.
- `WT_SUITE_LOCK_CMD` now names the dedicated `wt-suite-lock-run` executable, so every following word is run literally under the suite lock, including commands named `run`, `status`, or `release`. The administrative `wt-suite-lock` CLI again rejects unknown subcommands with usage. The runner forwards its arguments verbatim on POSIX (`"$WT_SUITE_LOCK_CMD" pnpm test`, no shell re-parsing); on Windows, `cmd.exe` still re-parses `%`, `^` and `&` in an unquoted argument, so a command carrying those characters should be run as `node wt-suite-lock.mjs run -- …` instead. It also tolerates a `run --` (or bare `--`) prefix an older adopted `wt-lane.mjs` still supplies itself, so `adopt --set scripts` need not land before both sides work together — re-adopt `wt-lane.mjs` (`adopt --set scripts`) anyway to pick up the current launcher.
- `wt-suite-lock.mjs` and `lane-egress-proxy.mjs` compared `process.argv[1]` to `import.meta.url` directly to decide whether they were invoked directly; reached through a symlink, that comparison never matched, so the file printed nothing and exited 0 instead of running. Both now use the existing symlink-safe `isInvokedDirectly` guard (`lib/host/entry-guard.mjs`), which every other entrypoint in `plugin/bin` already used.
- `suiteLockCli` (`lib/host/lane-sandbox.mjs`) now also refuses a suite-lock runner file that exists but lost its POSIX execute bit, with "update or reinstall workflow-toolbox" rather than a spawn failure deep inside a lane.
- Lane sandbox (Linux): Codex second opinions and codex lanes had no working shell inside the sandbox since 0.188.0 when the `codex` executable was reached through a symlink. Executable symlinks are now recreated inside the sandbox, pointing at the bound real executable location, so sibling helpers such as `codex-code-mode-host` remain discoverable without exposing the symlink's containing directory. The behavior is generic for symlinked executables, including OpenCode.
- Late read-only executable overlays now preserve binaries beneath private-home remaps without covering a writable bind, private remap target, or protected path. Colliding binary directories narrow to the executable file; colliding Node toolchain prefixes narrow to `bin` and `lib`, with a named refusal if narrowing cannot preserve the boundary or a kept executable link would dangle.

## [0.188.1] - 2026-09-26

### Fixed
- Lane sandbox (Linux): `wt-second-opinion.mjs --route astra` failed on every run since 0.188.0 with `CODEX_HOME points to "/run/user/<uid>/wt-lane-sandbox-…/codex-home", but that path does not exist`. The Codex child was handed its per-run private home by its HOST path, under the runtime directory the sandbox hides by design; it now receives the path that home is bound at inside the sandbox (`~/.codex`). `~/.codex` on the host stays read-only, the refreshed `auth.json` is still written back, and a user-set `CODEX_HOME` is unchanged. A new test asserts, for the Codex and OpenCode profiles, that every path passed with `--setenv` lies under a bind, remap, tmpfs or created directory inside the sandbox.

### Quality

Patch release: measured on the release tree against the 0.188.0 baseline (`pnpm quality:delta`). No ratchet moved beyond noise: duplication fell marginally (2.6450 % -> 2.6449 %), every other judge is unchanged, and line coverage moved -0.01 point with the one-line fix and its new test (thresholds still met).

| Judge | Total before -> after | Delta |
|---|---:|---:|
| Cyclomatic complexity | 127 -> 127 | 0 |
| Cognitive complexity | 266 -> 266 | 0 |
| ESLint warnings | 685 -> 685 | 0 |
| Duplication % | 2.6449833645758702 -> 2.6449314476951313 | 0 |
| Knip issues | 220 -> 220 | 0 |
| Coverage lines % | 81.66 -> 81.65 | -0.01 |

## [0.188.0] - 2026-09-26

### Added
- Run every external lane child (OpenCode launcher, envelope, verifier, observer, intercept hook and skill-fence probes; the Codex companion behind second-opinion) in a bubblewrap sandbox on Linux, built from an allow-list of binds: the worktree, the toolchain and the CLI's own config and credentials are visible, while `~/.ssh`, `~/.claude`, `/run/user/<uid>` secrets and other processes are not. `WT_LANE_SANDBOX_READ`/`WT_LANE_SANDBOX_WRITE` add a path, each launch records its sandbox status, and hosts without a working `bwrap` say so in one line and keep the environment allow-list only. The suite lock now records PID namespaces so a sandboxed lane and the host never reclaim each other's live lock.
- Harden the external-lane sandbox to a full security boundary: isolate the network (`--unshare-all` + `--new-session`) so no host loopback service is reachable, with a `socat` unix-socket relay restoring only the configured local model endpoint; overlay the git pointer/config files read-only and refuse a gitdir outside `<common>/worktrees/` (and harden every host-side git call with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`); give OpenCode private per-run data/cache/state with the shared cache read-only; run Codex on a private per-run `CODEX_HOME` with `~/.codex` read-only; bind the observer and second-opinion working directory read-only and refuse a working directory of `/`, `$HOME` or an ancestor; refuse the launch when a present `bwrap` probe fails (never falling open); detect the sandbox from the user-namespace map and match a lock holder by PID-namespace and start time; and install lane worktrees with `--config.package-import-method=copy`.
- Groovy pack: ship the `groovy-language-server` declaration for `.groovy` as a navigation server (`diagnostics: false`: with no classpath it reports every dependency import as `unable to resolve class`); measured starting as `plugin:workflow-toolbox:groovy` and answering documentSymbol. `.gradle` stays unmapped. Pack declarations may now set `diagnostics: false`.
- Turn deep grounding into an automatic, configurable behavior: a three-layer source registry and `wt-grounding-sources.mjs` discovery CLI, concise prediction-first skill orders with dated fiche refresh rules, a cooldown-aware prompt injection, and an observe-by-default pre-send check with an opt-in once-satisfiable refusal. The check journals would-refuse/refused decisions for later tuning; no always-loaded rule is added.

### Fixed
- Artifact server: the shared, detached server now runs from its own state directory instead of inheriting the working directory of whichever session (or `restart` caller) started it. On Windows a live process's working directory cannot be deleted, so the server, and every PowerShell identity probe it spawns, pinned the first session's project or worktree for the server's whole lifetime.
- `quota-drop.mjs`: the `(now …)` label printed by the quota watcher was built from `currentResetsAt` (the new window's own reported reset time) instead of the actual `nowMs`, so a reset printed as "now" a time hours or days away from the real clock. The label now always reflects `nowMs`; the new window's own reset time, when present, is printed separately under its own `next reported reset …` label. The reset decision itself (which was already keyed off `nowMs`) is unchanged.
- `wt-lane.mjs`: a lane now actually receives `WT_SUITE_LOCK_CMD`. The launcher set it, but the external-model environment allow-list stripped it before the OpenCode child started, so a lane gate could never take the machine-wide suite lock through the documented variable. The adopted launcher (`adopt --set scripts`) pointed the variable at `<config dir>/scripts/wt-suite-lock.mjs`, which is never installed; both launchers now take the CLI from the plugin runtime they load (`suiteLockCli` in `lib/host/lane-sandbox.mjs`), so an adopted copy gets the installed plugin's own file, and a launcher refuses to start a lane when that file is missing. Inside the Linux lane sandbox the plugin root is bound read-only so the CLI and the files it reads at import are reachable; the lock directory stays shared read-write as before. Re-adopt `wt-lane.mjs` to pick up the adopted-launcher half. Known limitation: the value is a quoted command string, so a lane shell must re-parse it (`eval "$WT_SUITE_LOCK_CMD …"` or `sh -c`); `$WT_SUITE_LOCK_CMD cmd` fails under zsh and keeps literal quotes under bash.

### Changed
- SDK runner effort defaults: standard pilots (`pilot_variant`, `sdk_pilot_variant`) and the implementer (`executor_code_variant` left empty) now run at `medium` instead of `high`; GPT Sol implementation keeps `xhigh`. Hard pilots, orchestrators, critics, reviewers and refuters keep `high`. An explicit plugin option, `WT_*_VARIANT` environment value or profile setting still wins. The run summary now records `executor_variants`, the effective effort and its origin for every executor role, resolved the way each lane is launched.
- SDK runner effort defaults: critic, review and refutation executors (`executor_critic_variant`, `executor_review_variant`, `executor_refutation_variant`) now default to `xhigh` instead of `high`. An explicit plugin option, `WT_EXECUTOR_*_VARIANT` environment value or profile setting still wins.
- Java pack: `java` now starts through the plugin's `wt-jdtls` launcher (`node ${CLAUDE_PLUGIN_ROOT}/bin/wt-jdtls.mjs`). When the `jdtls` on PATH is the upstream launcher, it runs it with an absolute `python3`/`python.exe` on a Java 21+ JVM passed through jdtls's own `--java-executable` (JAVA_HOME when it is 21+, else `java` on PATH, else an installed JDK: `WT_JDTLS_JDK_DIRS`, SDKMAN, `/usr/lib/jvm`, `/usr/libexec/java_home`, Program Files, `~/.jdks`), leaving `JAVA_HOME` alone; any other `jdtls` wrapper runs unchanged. A session whose `JAVA_HOME` is Java 17 no longer crash-loops the server; every refusal (no JDK 21+, no jdtls, no Python, a command that cannot start) answers the client's `initialize` with one line naming the cause.
- Split the six large shipped rules into reasoning-focused core files and reviewed `-at-act` halves with adjacent trigger specs; adopt still installs both halves statically when no on-demand engine is present.
- Keep decision-time and report-time obligations in the always-loaded halves, preserve whole paragraphs across the split, and scope on-demand triggers to real command and brief-writing acts.
- Refuse each governed act once before execution, and use one shell-aware command-head pattern across Bash triggers so wrappers, assignments, separators, and quoted command-like text are handled consistently.
- `wt-memory-hygiene`: rationale and field cases are no longer kept beside a rule behind a pointer; the repository history is the record.

### Removed
- The shipped rules' rationale pointer lines (six, in `wt-answer-first-reporting`, `wt-delegation-ladder-at-act`, `wt-durable-fix-at-the-right-level`, `wt-sdlc` and `wt-verify-by-ground-truth-at-act`) and the `plugin/docs/rules-rationale/` bundle they pointed into. Every always-loaded rule gets shorter; the removed text stays in the repository history.
- The adopt `docs` set: `--set all` no longer installs anything under `docs/wt/`, and `--set docs` exits with an explanation. A `<config-dir>/docs/wt/` copy adopted earlier is left untouched and may be deleted.
- The one-off `toolkit/scripts/verify-rules-rationale-split.mjs` verifier and the referential test over the bundle, replaced by an inverse lock: no shipped rule points into a rationale file.

### Quality

Measured on the release tree against the 0.181.0 baseline (`pnpm quality:delta`). No ratchet was loosened: ESLint warnings fell to 685, duplication to 2.64 %, knip issues to 220 and the biggest file by 10 lines; cyclomatic complexity is unchanged, cognitive complexity (+5) and the longest function (+1 line) carry over from 0.187.2. The external-lane sandbox is Linux-only (bubblewrap); macOS and Windows keep the environment allow-list and say so in one line.

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 127 | 0 | 127 -> 127 | plugin/bin/lib/lifecycle-launch.mjs |
| Cognitive complexity | 261 -> 266 | +5 | 261 -> 266 | plugin/bin/lib/lifecycle-launch.mjs |
| Biggest file (lines) | 2729 -> 2719 | -10 | 1747 -> 2084 | - |
| Longest function (lines) | 708 -> 709 | +1 | 426 -> 495 | - |
| Max depth | 7 -> 7 | 0 | 6 -> 6 | - |
| Max params | 7 -> 7 | 0 | 6 -> 7 | - |
| ESLint warnings | 687 -> 685 | -2 | 20 -> 19 | plugin/bin/wt-lane.mjs, plugin/skills/adopt/scripts/install.mjs, plugin/bin/lib/lifecycle-launch.mjs |
| Duplication % | 2.885613003631333 -> 2.6449833645758702 | -0.24 | 150 -> 126 | plugin/skills/adopt/scripts/install.mjs |
| Knip issues | 221 -> 220 | -1 | 5 -> 5 | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 81.66 | +39.66 | - -> - | - |
| Coverage branches % | 40.12 -> 71.99 | +31.87 | 0 -> - | - |
| Coverage functions % | 44.48 -> 83.14 | +38.66 | 0 -> - | - |
| Coverage statements % | 40.62 -> 78.69 | +38.07 | - -> - | - |

## [0.187.2] - 2026-09-25

### Added
- Ship right-sized Agent tool defaults: `wt-implementer-sonnet` for settled test-first increments, `wt-implementer-opus` for judgment-heavy implementation, read-only `wt-reviewer` for adversarial plan or diff review, and low-effort `wt-chores` for board/card work, CI triage, and mechanical summaries. A journaled fail-open Agent pre-tool guard refuses a new absent or `general-purpose` type unless the prompt records an unfenced `general-purpose because: <reason>` sentence, while preserving resumes and decoding host string/structured inputs; its bounded registration names the host-resolvable `workflow-toolbox:wt-*` alternatives.

### Fixed
- Use the shared fail-closed realpath entry guard for every `plugin/bin` CLI and hook, so symlinked, Windows short-path, and versioned plugin-cache invocations execute normally while query- or hash-qualified imports remain inert.
- Recognize adopted rules moved into project or config `rules-on-demand/` directories: checks compare only the adopted body, refreshes preserve the engine-owned frontmatter byte for byte and stay in place, and the SessionStart hook no longer requests a duplicate static install. Static plus on-demand copies are reported as a double load, while directory-symlink aliases resolve as one location.

### Quality

Measured on the release tree against the 0.181.0 baseline (`pnpm quality:delta`). Cognitive complexity rose by 5 and the longest function by 1 line; no ratchet was loosened. ESLint warnings fell to 684 (ceiling 687), duplication, knip issues and the biggest file fell; coverage figures count spawned processes. One test fails on this machine only under host load (`wake-floor-in-flight`, a known procfs scan cap); it is not a regression of this release. The SDK pilot runner remains experimental.

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 125 | -2 | 94 -> 123 | plugin/bin/wt-actionable-snapshot-producer-hook.mjs |
| Cognitive complexity | 261 -> 266 | +5 | 145 -> 124 | - |
| Biggest file (lines) | 2729 -> 2719 | -10 | 2729 -> 2719 | plugin/bin/wt-observe.mjs, toolkit/packages/debugger/src/observe-cli.ts, plugin/bin/wt-verifier-cli-guard-hook.mjs |
| Longest function (lines) | 708 -> 709 | +1 | 426 -> 493 | - |
| Max depth | 7 -> 7 | 0 | 7 -> 7 | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 684 | -3 | 37 -> 36 | plugin/bin/wt-observe.mjs, plugin/bin/wt-lane.mjs, plugin/skills/adopt/scripts/install.mjs |
| Duplication % | 2.885613003631333 -> 2.7010485125169317 | -0.18 | 150 -> 150 | - |
| Knip issues | 221 -> 218 | -3 | - -> - | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 81.13 | +39.13 | - -> 5.64 | - |
| Coverage branches % | 40.12 -> 71.65 | +31.53 | - -> 1.44 | - |
| Coverage functions % | 44.48 -> 82.62 | +38.14 | - -> 3.03 | - |
| Coverage statements % | 40.62 -> 78.24 | +37.62 | - -> 4.83 | - |

## [0.187.1] - 2026-09-25

### Fixed
- The 0.187.0 release CI was red on macOS and Windows; every job is green again on Linux, macOS and Windows. The Windows test step no longer hangs until its timeout: a hook module imported by a test ran its entry and blocked on stdin, and hook modules now run their entry only when invoked directly, compared by real path so a symlinked or short-name invocation still runs. The main-session guard inspects merges with an empty hooks directory and global config on every platform, so a repository's hooks cannot execute. Temporary-path comparisons tolerate macOS `/private/var` aliases and Windows short names, and the lane wait, process-enumeration and orphan-watch fixtures own their process trees.

### Changed
- Start OpenCode and Codex external-model processes with a shared environment allow-list, excluding session Anthropic credentials and unrelated exported secrets; users can explicitly add required non-credential names with `WT_EXTERNAL_MODEL_ENV_ALLOW`. Proxy variables remain available, so credentials embedded in a proxy URL such as `user:password` reach the child. The remaining same-OS-user boundary, including readable credential files and sockets, requires the tracked OS-sandbox follow-up. The quota probe now prefers the active session's `CLAUDE_CODE_OAUTH_TOKEN` and never falls back to saved credentials when that token is refused. A launch that names a model receives that provider's credential and required extras (Azure: key plus resource name), resolved from OpenCode's offline provider registry with a logged `<PROVIDER>_API_KEY` fallback; a registry entry can never authorize another known provider's key or a session Anthropic credential in any letter case. `wt-deep-search` forwards a provider credential only for an explicit model or `OPENCODE_MODEL`; with neither, it passes none, as before.

### Quality

Measured on the release tree against the stored baseline. No ratchet was loosened.

| Judge | Total before -> after | Delta |
|---|---:|---:|
| Cyclomatic complexity | 127 -> 125 | -2 |
| Cognitive complexity | 261 -> 266 | +5 |
| Biggest file (lines) | 2729 -> 2729 | 0 |
| Longest function (lines) | 708 -> 709 | +1 |
| Max depth | 7 -> 7 | 0 |
| Max params | 7 -> 7 | 0 |
| ESLint warnings | 687 -> 687 | 0 |
| Duplication % | 2.89 -> 2.71 | -0.18 |
| Knip issues | 221 -> 218 | -3 |
| Dependency cycles | 2 -> 2 | 0 |
| Coverage lines % | 42 -> 81.06 | +39.06 |

Two judges went the wrong way, both unchanged since 0.187.0: cognitive complexity (+5) and the longest function (+1 line). The release tree's full suite ran beside a concurrent external lane at load average 10: two, then three different process-spawning tests hit their 10-second bounds, and the failing set moved between runs, while the same code passed the clean develop certification (7,597 passed). The SDK pilot runner remains experimental.

## [0.187.0] - 2026-09-24

### Changed
- Run second-opinion's Claude Opus route at `xhigh` effort whatever `--effort` the caller passes; `--effort` now drives only the GPT-6 Astra route.
- Pin the shipped `pilot` and `pilot-orchestrator` agent templates to `effort: medium` (was `high`): pilots arbitrate and implement, while critics keep a higher pinned effort. Re-adopt the agents set to pick it up; a project copy already edited to `medium` is now merely behind, not diverged.
- Extend the shipped ground-truth and durable-fix rules with directives for alternating comparison arms, run-specific gate logs with terminal completion markers, and resolving distributed-rule status from source at a named revision
- Return blocking SDK review/refutation findings and red VERIFY test names to the original TDD implementer through a runner-owned findings file; every fix re-entry requires fresh TDD, review, and refutation evidence, while byte-identical briefs preserve valid receipts. Fix lanes run focused tests, typecheck, and lint before one full VERIFY suite. Review has no fixed cap and escalates on recurrence or two blocking passes without a strict new minimum; clear passes remain recorded. Timeout/error finalization preserves unresolved findings and timed-out worktrees. What is running attributes legacy Harden time and cost to TDD.
- Disable `secret:env:NAME` in `wt-secret-guard`: Claude Code refuses a whole hooks module whose `$.env.get` takes a non-literal name, so the guard loaded nothing in any real session while it read arbitrary variables. A command carrying the form is now refused with that reason and a pointer to `secret:file` or a 1Password reference; the form returns only with a design that names its variables literally. The toolkit suite now runs `claude plugin validate --strict` on every shipped plugin where the binary is available
- Refactor the adopt installer into bounded parsing, settings, audit, managed-item, migration, and command seams while preserving its standalone CLI transcripts and file effects; settings verification now also proves the exact prerequisite values before publication
- SDK pilot review loops now require criterion/task anchors, block only anchored MEDIUM-or-higher findings, route LOW and unanchored findings, review only each later harden diff with prior findings, and stop after three rounds with an explicit question for the parent; critic extensions count as recurrence and empty critics must account for their attacks or retry once
- Require Claude Agent SDK 0.3.280 or newer so the `opus` alias resolves to Opus 5.5; SDK and OpenCode launches now declare role effort explicitly, with high for Opus roles and xhigh for GPT Sol implementation.
- Route hard pilots plus Claude SDK hard critics/refutations to Opus, and replace second-opinion's Fable fallback with a fresh-context Opus consult while retaining Astra as the decorrelated route.
- Split Secret Guard hooks by responsibility and add warn-only secret-file read measurement for original Bash input, Read, and NotebookRead with value-free per-session journals
- Refuse raw secret-bearing MCP, Bash, Write, Edit, and NotebookEdit inputs; repair denied transcript inputs in place by tool-use identifier; mask visible assistant streams; warn on SessionStart replay; and preserve journal records across module reloads

### Fixed
- Preserve an opted-in adopt symlink and its linked-to file when rendering or atomic publication of its managed replacement fails
- Parse red VERIFY failing-test names through the active language pack's Vitest, pytest, or Gradle/JUnit adapter; preserve parameterized pytest node IDs, reject unittest summaries, skip unreadable project directories, and refuse absent, ambiguous, or unknown adapter evidence with an escalation instruction
- Prevent SDK roles from replacing code the runner may execute: active plugin roots, generated role plugins, and selected guard scripts are derived from the prepared role and denied through both tool authorization and sandbox filesystem policy. SDK-role guard crashes now exit non-zero for adapter denial while ordinary host hooks retain their documented fail-open posture. LSP is no longer offered to SDK roles because `typescript-language-server` can select executable TypeScript from the workspace.
- Fail SDK role confinement closed: writer Bash now requires an available sandbox and cannot request per-command escape; guard adapter failures explicitly deny; role deny lists merge with caller policy; initialization rejects undeclared tools; and diagnostics/deletion context tools are removed while plugin-controlled fetch, index, and search services remain documented exceptions.
- Remove `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` from every SDK role and explicitly disallow them at query composition, because code in any supported context-mode language can start a shell outside the role's declared path. Pilot and reader roles have no process-execution tool; writer/executor work uses guarded, sandboxed `Bash`. Initialization receipts now refuse any role that exposes one of the removed tools; the Bash-only pilot guard is no longer described as protecting a pilot role that cannot invoke it.
- Preserve generated content, adopted script snippets, home paths, and Windows separators literally when they contain JavaScript replacement tokens such as `$&`; lint now rejects dynamic `replace` and `replaceAll` replacement strings across plugin and published toolkit sources
- `wt-second-opinion` gives each Astra call private Codex broker state, captures its detached broker while the companion is alive, revalidates process identity before cleanup, and confirms or force-escalates termination on completion, error, supported signals, or process exit; unavailable host cleanup is reported.
- `wt-deep-search` (EXPERIMENTAL): a deep search started with no Exa key and no opencode on PATH is refused at once, naming both remedies and saying ordinary web search still works, instead of returning a handle that fails nine seconds later with a bare exit status; a missing Exa key is recorded as missing, a refused key as refused, and an opencode not-found failure names the program to install
- External lanes refuse to launch below a configurable available-memory floor, and signal-killed children now retain a numeric exit while naming earlyoom, kernel OOM, or an unknown signal cause instead of masquerading as timeout exit 124

### Added
- Add a journaled, warn-only PreToolUse Bash guard for unquoted scalar lists that zsh would pass as one word; same-command `shwordsplit`, non-zsh shells, arrays, explicit splits, and two measured singleton command-substitution shapes stay silent.
- Point every SDK agent prompt at the repository's root `CLAUDE.md` and `AGENTS.md` contributor guides when present, without enabling ambient setting sources or duplicating a shared symlink target

### Fixed
- Close Secret Guard bypasses around reference-wrapped vault values and alternate `op read` arguments; preserve reference value bytes across shell quoting contexts and UTF-8 transcript offsets; authenticate the target JSONL `tool_use` record before repair writes; retain every built-in and known secret across stream boundaries; and reuse the active journal rotation segment

### Known limits
- The SDK pilot runner, its lifecycle server and What is running remain EXPERIMENTAL.
- The environment passed to external-model children (opencode, codex) is not yet restricted by an allow-list in this release; that allow-list ships in a later release.
- Two structural classes found by cross-family review stay open and are tracked: host guards can import helpers a writer role can modify when the worktree is the plugin's own checkout, and the gate-evidence hook runs one git read that can execute a repository-configured fsmonitor. Both already existed in 0.186.0.
- Adopters: `secret:env:NAME` is now refused by `wt-secret-guard`; move to `secret:file:` or `op://`. Re-adopt the agent templates after updating (`install.mjs --set agents --install --dir <project>/.claude/agents`).

### Quality

Measured on the release tree against the 0.181.0 baseline (kept on purpose, not refreshed). Cognitive complexity rose by 5 and the longest function by 1 line (lifecycle-launch.mjs, lifecycle-state-machine.mjs), both under their ratchets; ESLint warnings held at 687, knip fell by 3, duplication fell; coverage rose to about 81 % of lines, measured on the full suite of the release tree (7,462 passed, 20 skipped).

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 125 | -2 | 127 -> 125 | plugin/bin/lib/lifecycle-launch.mjs, plugin/workflows/independent-analysis.js |
| Cognitive complexity | 261 -> 266 | +5 | 261 -> 266 | plugin/bin/lib/lifecycle-launch.mjs, plugin/bin/lib/lifecycle-state-machine.mjs, plugin/workflows/independent-analysis.js |
| Biggest file (lines) | 2729 -> 2729 | 0 | 2176 -> 2234 | - |
| Longest function (lines) | 708 -> 709 | +1 | 708 -> 709 | - |
| Max depth | 7 -> 7 | 0 | 6 -> 6 | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 687 | 0 | 41 -> 39 | plugin/bin/lib/lifecycle-state-machine.mjs, plugin/workflows/independent-analysis.js, plugin/skills/adopt/scripts/install.mjs, plugin/bin/lib/lifecycle-launch.mjs |
| Duplication % | 2.885613003631333 -> 2.7234369006520907 | -0.16 | 432 -> 466 | - |
| Knip issues | 221 -> 218 | -3 | 5 -> 5 | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 80.94 | +38.94 | 0 -> - | - |
| Coverage branches % | 40.12 -> 71.44 | +31.32 | 0 -> - | - |
| Coverage functions % | 44.48 -> 82.41 | +37.93 | 0 -> - | - |
| Coverage statements % | 40.62 -> 78.03 | +37.41 | 0 -> - | - |

## [0.186.0] - 2026-09-22

⚠ **The SDK pilot runner, its lifecycle server and What is running remain EXPERIMENTAL.** This release changes how the runner's plan loop behaves; a full FULL run was measured on it (370 min, no delivery: stopped by the runner's own 6 h limit in the fourth harden round) and the causes are carded, not fixed here.

### Changed
- SDK pilot plan loop: adaptive critic rounds (three fixed, then up to six while blocking findings keep narrowing), two independent round-1 critics run in parallel with the union of their findings, recurrence judged on blocking findings only, and the pilot revises only what a blocking finding asked (new section "Revise only blocking critic findings" in the shipped `wt-sdlc.md` rule).
- What is running: each critic stage shows "round N (max M)", the two round-1 critics appear as Critic A / Critic B under their stage, pilot details sit at the top, and the missing-work footer names its cause.
- The orphan watch reports an idle helper process, and `second-opinion` stops the Codex app-server it started.

### Quality

Measured on the release tree against the 0.181.0 baseline (kept on purpose, not refreshed). Cognitive complexity rose by 5 (lifecycle-launch.mjs, the two parallel critics), still under its ratchet; coverage rose by about 35 points of lines with the characterization tests added before tonight's refactors.

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 127 | 0 | 127 -> 127 | - |
| Cognitive complexity | 261 -> 266 | +5 | 261 -> 266 | plugin/bin/lib/lifecycle-launch.mjs |
| Biggest file (lines) | 2729 -> 2729 | 0 | 1747 -> 1894 | - |
| Longest function (lines) | 708 -> 708 | 0 | 708 -> 708 | - |
| Max depth | 7 -> 7 | 0 | 6 -> 6 | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 687 | 0 | 41 -> 39 | plugin/bin/lib/lifecycle-state-machine.mjs |
| Duplication % | 2.885613003631333 -> 2.7541460814661445 | -0.13 | 150 -> 150 | - |
| Knip issues | 221 -> 221 | 0 | 4 -> 5 | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 77.39 | +35.39 | - -> - | - |
| Coverage branches % | 40.12 -> 68.69 | +28.57 | 0 -> - | - |
| Coverage functions % | 44.48 -> 78.56 | +34.08 | 0 -> - | - |
| Coverage statements % | 40.62 -> 74.69 | +34.07 | - -> - | - |

### Added
- Add a host adapter derived from real three-OS captures (`plugin/bin/lib/host/`): question-named operations, per-OS implementations, and a fake that replays the captured bytes BELOW the parsers so the real parsers run. The pid-to-parent-pid family moves behind it with a grep-zero perimeter lock over 212 non-generated source files; a platform that cannot answer returns a named unknown instead of a plausible zero. The Windows process-table capture is preserved as an explicit unavailable rather than invented
- Add `wt-deep-search` (EXPERIMENTAL): a WebSearch substitution answering from the local Claude Code documentation mirror, context7, Brave or Exa, plus a detached deep-research rung that returns a handle and is collected later; zero dependencies, no key required, cross-platform verdict included
- Add dispatch-only Linux, Windows, and macOS host probes for process tables, process-group termination, and real path behavior, with provenance-rich byte-stable evidence artifacts
- Add launch-time reasoning variants for all pilot, orchestrator, and executor roles, with model caps, explicit overrides, unknown-variant refusal and auditable forced overrides

### Fixed
- Terminate timed-out deep-search process families before recording their terminal marker, and restore the combined 64 MiB output ceiling for second-opinion companions with a named overflow failure
- `wt-secret-guard` no longer rewrites source it reads: a declaration line, a diff-prefixed declaration and an assignment bounded by parameter or destructuring punctuation pass through unchanged, while a loose credential assignment in command output is still scrubbed. Reviewed false-positive candidates over 560 repository source files fell from 32 to 5 with the true-positive corpus unchanged; the cost is that output shaped like source can now pass through, and that is stated rather than hidden
- Price Claude Haiku 4.5 and all default routable models from source-backed fallback rows, and make unknown-price run totals name the unpriced models in archives and What is running
- Run host-timing quarantines visibly but non-blockingly under `pnpm test:blocking`, the release-certification and CI entry point, while `pnpm test` remains the full developer suite
- Treat empty and whitespace-only model plugin options as unset in runtime resolution, `wt-config`, and SessionStart configuration context
- Warn at SDK pilot launch when a routing-capable run has no board contract, and end a run partial immediately if `route_finding` is nevertheless attempted

## [0.185.0] - 2026-09-20

### Added
- Add default-off IP-address and email masking options to `wt-secret-guard` for prompts and tool results, and document that Claude Code bypasses user-tier plugins for first-message `prompt.context` blocks
- Queue SDK pilot launches in machine-wide FIFO order until both the configurable active-run cap and host load gate allow admission, with durable queue receipts in What is running and explicit cap-only fallbacks when load is unavailable
- Redesign the EXPERIMENTAL What is running pane around a compact card spine, owner-attributed errors, expandable billed token classes per model, and width-aware summaries
- Add a configurable 30-second running-work collector ceiling with adaptive single-flight polling and a bounded per-user failure journal
- Add source-backed per-model USD run costs to receipts, the cost index, and the live pane
- Resolve run prices by exact provider and model from OpenCode's fresh models.dev cache, with context tiers, read-only plugin-data overrides, dated fallback reasons, subscription and API-equivalent labels, and stale-source warnings
- Show effective plugin configuration, configurable phase models, and orphaned settings

### Fixed
- Capture lifecycle launcher output through private regular files so an immediately exiting launcher cannot lose its `pid=` receipt to platform-specific pipe flushing
- macOS: refresh process-table evidence when lane supervision switches PIDs, preventing a just-finished phase cached during launcher inspection from blocking the next phase
- Require SDK pilots to ground external claims before planning, persist fetched content or its digest with per-claim verdicts, and refuse discovery records that cite unfetched sources
- Name external lanes from their card file, or the first useful brief heading, instead of the shared standing preamble
- Keep the last good What is running snapshot visible through collector failures, show its age and a plain-language retry notice, and clear the notice after recovery
- Ignore coverage temporary directories during running-work scans and keep walk-budget uncertainty on the affected row instead of marking all discovery partial
- The wake floor now stays silent for a Linux background task only while a stable same-user process from the current session holds its task output open for writing. Completed outputs, readers, plugin monitors, foreign sessions, PID reuse, and inaccessible unrelated descriptors cannot suppress the floor.
- On macOS and Windows, unsupported Linux background-task inspection no longer degrades a conclusive wake-floor lane verdict to unknown; it is reported only when lane evidence is itself inconclusive.
- Windows: the What is running collector resolves its shipped model-price table as a native file path, preserving fallback USD prices when no machine-local price catalogue is available.

### Quality

Measured on the release tree against the 0.181.0 baseline (kept on purpose, not refreshed).

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 127 | 0 | 127 -> 127 | - |
| Cognitive complexity | 261 -> 273 | +12 | 261 -> 273 | - |
| Biggest file (lines) | 2729 -> 2729 | 0 | 974 -> 1024 | - |
| Longest function (lines) | 708 -> 704 | -4 | 708 -> 704 | plugin/bin/lib/lifecycle-state-machine.mjs |
| Max depth | 7 -> 7 | 0 | 6 -> 6 | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 686 | -1 | 41 -> 38 | plugin/bin/lib/lifecycle-state-machine.mjs |
| Duplication % | 2.885613003631333 -> 2.76828046399686 | -0.12 | - -> - | - |
| Knip issues | 221 -> 221 | 0 | 4 -> 5 | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 77.16 | +35.16 | - -> - | - |
| Coverage branches % | 40.12 -> 68.47 | +28.35 | - -> - | - |
| Coverage functions % | 44.48 -> 78.35 | +33.87 | - -> - | - |
| Coverage statements % | 40.62 -> 74.52 | +33.9 | - -> - | - |

## [0.184.0] - 2026-09-19

### Fixed
- The elapsed-time wake floor now stays silent while an identity-verified lane owned by the current session is running, launching, or awaiting a decision. Complete evidence with no owned live lane keeps the existing FLOOR line unchanged; unreadable, malformed, capped, or otherwise inconclusive lane evidence fires with an explicit fail-safe annotation. Session-armed background tasks remain outside this signal because the host exposes no attested running/completed distinction; an attested host signal is tracked as follow-up work.
- The pilot contract now requires E2E whenever real processes, files, or a host can exercise a change; absence of a UI alone is rejected unless the report names what was tried
- The EXPERIMENTAL SDK runner now atomically publishes assistant usage while a run is live, and What is running shows per-phase usage, a live run total, and elapsed time while delegated-lane usage is pending. Normal and abnormal runs append one durable cost-index record beside the external archives; final receipts reuse the live messages without double counting.
- Restart the artifact server when it stops while sessions remain registered
- Orphan scans now report only real OpenCode run invocations and ignore executables hosted in the OS temp directory
- Handle plain-text board mutations without orphaning routed cards
- Recognise staging lane directories and test fixtures during orphan scans while preserving warnings for genuinely unattributed OpenCode processes
- The actionability gate can now be refreshed with `wt-actionable-snapshot-refresh.mjs` (the stale message prints its absolute path, runnable as-is) without placing a six-figure Planka result in session context. The command reads strict 10-card pages directly from the local MCP endpoint, refuses changing/incomplete/duplicate pagination, and passes only a proved-complete set to the existing dependency parser and snapshot writer; stale messages now distinguish "not measured recently" from zero actionable cards and print that exact command with an absolute path.
- Windows: the lifecycle archive-containment check compares both paths in their canonical long form, so an archive destination inside the lane can no longer pass because one side was spelled with 8.3 short names; and an artifact-server monitor no longer drops its registration when a busy server answers its health probe late.
- The main guard's refusal now names the override file it actually reads. A marketplace install reads it from the plugin's data directory, while the message used to point at `~/.local/state/wt-main-guard/allow-once.json`, so writing the override where the refusal said had no effect.
- The What is running pane now redraws after its hooks module reloads. Each opened pane carries a registration tag in its host request id, so the replacement module can resume that already-open pane without shared plugin storage or a cross-session `ui.open` call.
- Windows: lane integration now recognises a worktree whose path is spelled with 8.3 short names (`C:\Users\RUNNER~1\…`), and the artifact server no longer narrows the Windows process start-time tolerance below the shared precision, which could declare a live monitor dead and drop its mount.
- The EXPERIMENTAL What is running pane now shows the live serialized test-suite holder from its lock record, including its shortened command, start time, and worktree; dead holders are marked stale and unreadable lock data is marked unknown.
- The delegated-arc watcher now recognizes a transcript's terminal assistant `end_turn` record as a clean finish, keeping completed agents silent while malformed, interrupted, frozen, and vanished agents still fail toward an alert.
- The lesson-harvest Stop hook no longer re-surfaces unchanged lessons when a reader appends a delimited `## Lesson harvest record` section to the report. The hook excludes only that section from its persisted content fingerprint, so lessons added after a harvest still fire.
- Adoption notices now assign stale-copy refresh and edited-copy arbitration to the session instead of asking the owner to decide. The hook remains read-only, supports a `notice-only` single-writer opt-out, and supplies exact directory-scoped install/check or three-way-diff commands; installer writes journal their adopted snapshot and version transition for later read-only comparison.
- Windows now runs the what-is-running collector without placing its large program on the command line, and lane integration compares canonical Git worktree paths with Windows case semantics.
- Adoption staleness notices now quote the exact directory they inspected in their `install.mjs --dir` remedy. A bare `--install` also reuses a sole discovered project or config-profile adoption and refuses to guess when several copies exist, preventing a stale user-level copy from being left behind while a duplicate project copy is created.
- The orchestrator CLI now refuses value-taking flags that are empty, truncated, or followed by another flag instead of silently accepting a missing value.

### Quality

Measured on the release tree against the 0.181.0 baseline (kept on purpose, not refreshed).

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 127 | 0 | 112 -> 127 | plugin/bin/wt-actionable-snapshot-producer-hook.mjs |
| Cognitive complexity | 261 -> 273 | +12 | 261 -> 273 | - |
| Biggest file (lines) | 2729 -> 2729 | 0 | 1747 -> 1894 | - |
| Longest function (lines) | 708 -> 702 | -6 | 708 -> 702 | plugin/bin/lib/lifecycle-state-machine.mjs |
| Max depth | 7 -> 7 | 0 | 6 -> 6 | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 687 | 0 | 41 -> 38 | plugin/bin/lib/lifecycle-state-machine.mjs |
| Duplication % | 2.885613003631333 -> 2.7986340994768226 | -0.09 | 150 -> 150 | - |
| Knip issues | 221 -> 221 | 0 | 8 -> 7 | plugin/bin/lib/artifact-server.mjs |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 77.16 | +35.16 | - -> 11.52 | - |
| Coverage branches % | 40.12 -> 68.47 | +28.35 | - -> 5.57 | - |
| Coverage functions % | 44.48 -> 78.35 | +33.87 | - -> 9.09 | - |
| Coverage statements % | 40.62 -> 74.52 | +33.9 | - -> 10.02 | - |

Read plainly: one judge went the wrong way — cognitive complexity +12 (261 -> 273), from the new wake-floor collector, the secret-guard in-place scrub and the live-cost attribution; no ratchet was loosened. The coverage jump reflects the spawned-process coverage counted since 0.183.0 against the older baseline, not a sudden test surge. The SDK pilot runner and What is running remain EXPERIMENTAL.

## [0.183.1] - 2026-09-18

### Fixed
- The 0.183.0 quality gate failed on every CI system: seven ESLint warnings above the 687 ratchet and one knip issue above 221, introduced by that release and named in its own notes. They are resorbed by behaviour-neutral rewrites (two nested template literals, four nested conditionals, one useless assignment, and one internal helper that no longer needs to be exported); no ratchet was raised and no rule was disabled.
- The test suite no longer reads the machine it runs on: the plugin command-line tools and hooks it launches get a sealed home, config, state, npm and plugin-data directory, and a census test fails when a new test lets a child process inherit them without a stated reason.
- The SDK lifecycle tests no longer fail intermittently under load. Their shared helpers now check every step and stop at the first refusal; their fake gates wait until the file timestamp is really newer than the lane receipt, which a clock that steps back had broken; and fake lanes that are expected to succeed get a realistic wait instead of one second.

### Quality
- Delta measured on the release tree (`pnpm quality:delta`). "Before" is the stored quality baseline, which is still the one recorded at 0.181.0 (it was not refreshed at 0.182.0 or 0.183.0, and is not refreshed now, so no regression gets recorded as the new normal):

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 127 | 0 | 72 -> 77 | - |
| Cognitive complexity | 261 -> 277 | +16 | - -> - | - |
| Biggest file (lines) | 2729 -> 2729 | 0 | - -> - | - |
| Longest function (lines) | 708 -> 694 | -14 | - -> - | - |
| Max depth | 7 -> 7 | 0 | - -> - | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 687 | 0 | 11 -> 11 | - |
| Duplication % | 2.89 -> 2.81 | -0.07 | - -> - | - |
| Knip issues | 221 -> 221 | 0 | - -> - | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 76.96 | +34.96 | - -> - | - |
| Coverage branches % | 40.12 -> 68.12 | +28 | - -> - | - |
| Coverage functions % | 44.48 -> 77.98 | +33.5 | - -> - | - |
| Coverage statements % | 40.62 -> 74.25 | +33.63 | - -> - | - |

- Read plainly: the two ratchets that failed 0.183.0 in CI are back at their ceilings (ESLint 687, knip 221) and `pnpm quality` exits 0 on this tree. Cognitive complexity +16 against the baseline is the debt carried since 0.183.0, unchanged by this patch. Coverage is the instrument repair of 0.183.0.
- Windows: 30 tests in 6 files were red on the 0.183.0 tag run; this patch does not address them.
- SDK Runner status unchanged: EXPERIMENTAL.


### Added
- The second-opinion CLI now accepts `--route auto|astra|fable`, allowing callers to force the existing quota-guarded Fable route or require consented Astra without silent fallback. A route outside those three is refused by the library as well as by the CLI, and a forced-Astra refusal says so when the consent setting could not be read.
- Lifecycle archive publication now verifies that a report's measured-cost block exactly matches its adjacent `cost.json`, refusing stale, unpaired, or unreadable receipts before the destination is published.
- The What is running pane now shows each running SDK lifecycle phase's measured input, output, cache-read, and cache-write tokens, names whether archived cost or live usage supplied them, and drops compact totals before stage words at narrow widths.
- Added `wt-lane.mjs integrate`, which commits a delivered lane from an explicit message file, merges it in a named same-repository worktree, verifies its `.lane/` archive before optional removal, and can authorize, push, dispatch, and inspect an explicitly requested CI branch.

### Fixed
- The second-opinion Fable route now refuses when the quota probe reports no Claude Fable weekly scope; an empty measurement used to read as headroom and the query ran unguarded.
- The What is running pane now sanitizes every string in its returned tree, falls back to an explanatory pane when rendering throws, records bounded persistent render diagnostics, and redraws through its existing refresh timer after a failed or repaired render.
- The What is running pane no longer turns into an empty grey frame after a while: one refresh tick without a render used to be read as "the pane was closed" and stopped it for good, although a tick can land between the end of a collection and the redraw it asked for. Three consecutive misses are now required, a pane the host still renders re-arms itself (never after its own Close control, never in a session that did not open it), and the collector timeout is now actually passed to the host call.
- The delegation-ladder rule no longer tells a session to release a finished sub-agent with a shutdown request: it now says to leave it idle, after two session terminations observed within seconds of that message.
- Destructive one-shot claims, lane integration evidence/removal and CI correlation, Windows suite-lock shims, contradictory run-cost families, and the pilot runner's spawned SDK fixture now fail closed under races and ambiguous inputs.
- The SDK pilot runner no longer aborts at startup when the SDK emits an account-level `rate_limit_event` before its initialization message (seen on a fresh account window); the ordering check still refuses any model message that precedes the receipt.
- The SDK lifecycle now allows three passes in all on both bounded loops (plan ↔ critic, and review/refutation ↔ harden) instead of four: the third refusal ends the run as an archived partial report for its reader to escalate.
- Pilot timeouts now force an SDK abort after a ten-minute phase-boundary grace; Stop-gate proposals reject invalid bounds and future snapshots; lifecycle costs preserve unknowns, rounds, and malformed archives; cost publication checks every generated block; and the merge-target warning handles Git options, quoted refs, option values, and heredocs.
- The What is running pane now labels a card id on rows rendered outside a session (`Card <id>` instead of a bare number), and a test locks that a skipped or not-started stage offers no button even when evidence is recorded for it.
- `wt-lane integrate --dry-run` now prints the resolved lane, target, subjects, archive/removal, and CI authorization plan; real merges use a distinct `merge: <lane subject>` by default (with an override), and refuse to change an integration tree used by the active machine-wide suite unless `--force` is passed.
- SDK pilot timeouts now default by route (90 minutes for LITE, 6 hours for FULL), warn without refusing shorter explicit bounds, and stop at the next lifecycle phase boundary with an archived timeout report and worktree-retention marker instead of injecting an ignorable prompt mid-phase.
- Main-guard one-shot allowances now key consumption to `tool_use_id`, so duplicate hook registrations agree on one Bash call while a later call is refused; SessionStart warns when an enabled marketplace copy overlaps the current plugin root, and the guard now states that API/`gh` deletions are outside its Bash-text coverage.
- Run-cost reconciliation now attributes each lane through its recorded executor/model family, reading Claude usage receipts or matching OpenCode session rows per lane, and reports family-specific unknowns instead of applying the run executor to every lane.
- The suite lock decides the Windows command shell per EXECUTABLE instead of per platform: a `.cmd`/`.bat` shim (including a bare name that PATHEXT resolves to one) still runs through the shell, every other command is spawned directly, so quoted arguments are no longer re-parsed by `cmd.exe`.

### Quality
- Delta since 0.182.0, measured on the release tree (`pnpm quality:delta`):

| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |
|---|---:|---:|---:|---|
| Cyclomatic complexity | 127 -> 127 | 0 | 112 -> 127 | - |
| Cognitive complexity | 261 -> 277 | +16 | 261 -> 277 | - |
| Biggest file (lines) | 2729 -> 2729 | 0 | 1747 -> 1752 | - |
| Longest function (lines) | 708 -> 694 | -14 | 708 -> 694 | plugin/bin/lib/lifecycle-state-machine.mjs |
| Max depth | 7 -> 7 | 0 | 6 -> 6 | - |
| Max params | 7 -> 7 | 0 | 7 -> 7 | - |
| ESLint warnings | 687 -> 694 | +7 | 41 -> 41 | plugin/hooks/hooks.js |
| Duplication % | 2.89 -> 2.81 | -0.07 | 150 -> 150 | - |
| Knip issues | 221 -> 222 | +1 | 4 -> 5 | - |
| Dependency cycles | 2 -> 2 | 0 | - -> - | - |
| Coverage lines % | 42 -> 77 | +35 | - -> - | - |
| Coverage branches % | 40.12 -> 68.19 | +28.07 | - -> - | - |
| Coverage functions % | 44.48 -> 78.08 | +33.6 | - -> - | - |
| Coverage statements % | 40.62 -> 74.29 | +33.67 | - -> - | - |

- Read plainly: the coverage jump is an INSTRUMENT repair, not new tests alone — coverage now counts code exercised through
  spawned processes (lines 42 % -> 77 %), and the vitest thresholds were raised to the measured floor (76.3 / 67.5 / 77.5 /
  73.6). The longest function and duplication went down. THREE judges went the wrong way and no ratchet was loosened for
  them: cognitive complexity +16 (worst 277), ESLint warnings +7 (694, above the 687 ratchet that `pnpm quality:lint`
  enforces — it fails until those seven are resorbed), knip issues +1 (222 against 221). They are debt of this release,
  tracked, not accepted as the new normal.
- SDK Runner status unchanged: EXPERIMENTAL. No real LITE run has ever been made and every real FULL run so far ended
  partial at the plan gate; both lifecycle loops now allow three passes in all.

## [0.182.0] - 2026-09-17

### Added
- Added a recoverable machine-wide suite lock with bounded visible waits, status/release controls, and a lane-exported invocation for serializing outer Vitest runs.
- Bounded SDK pilot runs now atomically leave a worktree-bound `.lane/worktree-retention.json`, and the shipped worktree remover refuses invalid, foreign, open-card, or board-unavailable cleanup until the card reaches `Done` or `NotDoing` (or no longer exists).

### Tooling
- Added coverage as the fifth ratcheted quality judge, generated baseline and release-delta reports, release quality enforcement, and tracker-neutral debt-card output.

### Fixed
- The What is running pane now shows SDK lifecycle phases without legacy arbiter-cycle stages, names independent review/refutation from frozen lane models, uses neutral word-and-glyph stage states, and no longer reports an empty card branch as merged.
- Artifact-server Windows lifetime fixtures now distinguish clean monitor departure from forced process death instead of killing the detached server with `taskkill /T`; registration sweeps record test-only classifier diagnostics and reject PID reuse by spawn-recorded identity.
- Artifact-server registration sweeps now use conclusive Windows `ESRCH` evidence before the bounded process-table fallback, process-spawning fixtures await monitor pipe closure before removing temporary directories, and the retention HTTP fixture answers torn JSON bodies with 400 instead of throwing.
- dev-implement's cleanup agent now resolves the workflow-toolbox plugin root itself from its own shell (the same CLAUDE_PLUGIN_ROOT/WT_PLUGIN_ROOT/installed_plugins.json fallback the shipped agents use) before running the guarded worktree remover, instead of requiring a launcher-supplied pluginRoot on every path; merged worktrees are retained and reported by path and branch whenever the cleanup agent does not confirm the removal — a refused removal while the card is open (the ordinary case), a failed resolution, or an unanswered cleanup
- Artifact-server Windows fixtures now pin executable-backed Git and Tailscale seams, startup shutdown has a platform-honest test route, dead registrations use process-table evidence instead of retained-handle signalability, and the pilot continuation lock has a process-spawn-aware local timeout.
- Windows process-spawning fixtures now wait for spawn-recorded child identities before removing temporary directories, artifact-server state timeouts name their predicate and captured output, configured Tailscale failures report timing and process status, and the board-client protocol lock treats partial request JSON as incomplete input instead of an uncaught exception.
- The What is running pane now removes ANSI sequences and control characters at its `Text` boundary, cleans log-derived activity in the collector, and shows a reading state before the first collector result instead of reporting a failure.
- Artifact-server registrations now apply their `0600` mode check only on POSIX, while the Windows end-to-end fixture records each spawned server identity for health-independent teardown and includes monitor output in state-timeout diagnostics.
- Artifact-server end-to-end cleanup now identity-checks and terminates the detached Windows process tree before retrying temp-directory removal, and its Tailscale fixture invokes a real executable instead of assuming Windows can execute a `.cmd` file through `execFileSync`.
- The artifact server no longer refuses its state directory on Windows: the POSIX group/other write-bit check is enforced on POSIX platforms only, where Node's synthetic win32 mode had made every Windows start fail with `group- or world-writable`.
- Release-branch pushes now refuse missing, red, or stale gate evidence unless an exact-command main-guard allow-once entry records and authorizes the exception; version-1 records require a one-time refresh after upgrade.
- Artifact-server end-to-end fixtures now preserve native system paths, provide Node-backed Windows command shims, avoid Windows-illegal names, and label POSIX-only mode checks; configured Tailscale binaries no longer fall through to ambient discovery, and Windows process identity reads retry transient misses within their existing timeout bound.
- The artifact-server suite's state watcher canonicalises its temp path before `fs.watch`, so the Windows short-name spelling no longer trips libuv's fs-event assertion and aborts the vitest worker carrying the file.
- The What is running collector now bounds detailed worktree scans, reports partial discovery when capped, and distinguishes its 8-second timeout from exit failures with the exit code and first stderr line.
- Artifact-server tests now verify detached server process identity by PID, start time, argv, and executable before cleanup signals it, preventing Windows PID reuse from terminating the Vitest worker.
- Wake-channel directory watches now canonicalise path aliases before entering libuv, preventing Windows short-name spool paths from aborting the server, and the adopted consent matrix derives its case timeout from all real launcher combinations.
- The queue-not-empty Stop gate now exits silently for a zero-startable queue and for harness retries marked `stop_hook_active`, preventing an allowed stop from looping on block-shaped feedback.
- SDK role initialization receipts no longer require a skill declared `user-invocable: false` (the harness never lists one), and the pilot runner exits after a refused receipt instead of idling with the EXIT marker unwritten.
- SDK role LSP plugins now map .js, .mjs, and .cjs to JavaScript from the same table that drives worktree language detection, so plain .js worktrees are detected and navigable instead of silently unmapped while the receipt reports LSP available.
- Cross-OS process-spawning locks now pin the shipped wake-channel poll source, supply Windows process identity with spawn-recorded argv, await fixture-child exit before bounded teardown retries, and give measured long-running consent and lifecycle cases local timeout margins.
- Windows lane supervision now captures launcher and child identities with bounded `Get-Process` reads and spawn-recorded argv instead of CIM/WMI, rejects PID reuse by image and start time, and keeps the wake-channel polling backstop alive after initialization on Windows.
- Windows lane launcher PID reads now bypass the full CIM table, every PowerShell process read has a 10-second ceiling with unreadable evidence remaining unknown, and cross-OS timing locks follow their provider and polling contracts.
- Concurrent-test guard coverage injects deterministic process listings while retaining a real-machine count-reporting case; wake and artifact-server delivery bounds now follow their configured polling and readiness intervals, and lane capture fixtures derive their retry windows from the capture cadence.
- Windows lane launch identity capture now uses a timeout-bounded single-PID query, records the observed command-shim identity or a named capture timeout, and macOS lifecycle coverage waits for the literal terminal receipt while locking stage ordering.
- macOS process identity refreshes cached snapshots once for a missing PID without restoring polling fork storms, and artifact-server teardown retries bounded concurrent state writes.
- Windows OpenCode envelopes preserve command-shim stdout without detached spawning, terminate timed-out process trees through `taskkill /T`, persist timestamped launcher stages for timeout diagnosis, and cap the 4-vCPU CI runner at two Vitest workers.
- macOS process identity and queue enumeration now reuse 100 ms process-wide snapshots, Vitest leaves one runner core free, and the cross-OS probe preserves separate bounded shard logs instead of saturating the runner.
- Windows OpenCode runner locks now exercise synchronous, detached-pipe, and file-descriptor command-shim launches with output and exit-code diagnostics; envelope fixtures trace whether task children started, and adopted-launcher checks allow for slower Windows identity capture.
- Windows OpenCode test fixtures now mirror npm command shims' direct `%*` forwarding, and adopted-launcher subprocess checks close stdin and report bounded timeout diagnostics.
- Cross-OS CI now bounds every matrix step and always uploads the Vitest log plus a final process table; Windows OpenCode `.cmd` launches preserve product-built flags and paths through `cmd.exe`'s two parsing passes.
- Cross-OS CI now preserves a streaming test log before the job deadline and prints the runner process table; macOS lane identity polls no longer repeat slow `lsof` cwd reads, child cleanup is bounded by observed exit, and Windows `.cmd` OpenCode fixtures retain their arguments without deprecated shell joining.
- macOS lane capture now waits through transient shell identities, canonicalises equivalent cwd spellings, and reports recorded-versus-live identity fields on timeout; adopted launcher and Windows envelope fixtures now lock their installed provider and native command-shim assumptions.
- SDK roles resolve the INSTALLED context-mode plugin (the harness's `installed_plugins.json` entry, then the highest cached version) instead of a pinned version directory, so the first session after a context-mode update no longer fails closed on an absent path.
- macOS supervision now reads untruncated command identities with wide `ps`; Windows supervision reuses one full `Win32_Process` snapshot for 500 ms per worker/child classification, and cross-OS fixtures pin their actual process, path, executable, and signal assumptions.
- macOS lane launches now retry the native process provider before recording identity, report source-specific unavailable capture instead of a synthetic identity, and enumerate queued lane processes with one quote-aware `ps` query; remaining cross-OS fixtures now pin or name their actual host assumptions.
- Windows lane supervision now preserves drive-qualified lifecycle fixture paths, enumerates lane processes with one PowerShell CIM query in the queue gate, installs adopted launchers against native `.cmd`/PATH fixtures, and reliably terminates waiter fixture children before bounded cleanup retries.
- macOS lane lifecycle fixtures now classify live processes through the Darwin provider instead of forcing Linux `/proc`; process evidence pins the C locale, and cross-OS fixtures no longer assume an unconfigured loopback alias, a non-canonical temp spelling, or a short executable path.
- Windows CI fixtures now preserve native PATH/config semantics, use file URLs for dynamic SDK imports, compare canonical path identities, and skip only tests whose evidence is inherently POSIX-only.
- Lane supervision now reads process identity from `ps`/`lsof` on macOS and `Win32_Process` through PowerShell on Windows, while reporting source-specific unknown evidence and refusing unsupported external Windows tree termination legibly.
- Remaining Windows-only test and runtime paths now use file URLs for ESM entry points, canonical path identities and display separators, Node-backed command fixtures, pinned home/config directories, and explicit skips for POSIX-only signal, mode, and permission semantics.
- Windows OpenCode launches now resolve npm `.cmd`/`.bat` shims and invoke them through the command shell across lane, observer, fence, and envelope paths.
- macOS test fixtures now use canonical temporary roots, Tailscale detection accepts a pinned binary for hermetic probes, and `/proc`-dependent coverage skips explicitly outside Linux.
- Cross-platform lifecycle tests now compare canonical directory identities at archive boundaries, inject their process-liveness evidence, and derive assertion paths from the host rather than POSIX literals.
- Lane launcher and observer tests now provide their OpenCode fake through Node-backed POSIX and Windows command shims instead of assuming a `.sh` file on `PATH` is executable.
- Lane supervision routes every process read (`/proc` existence and state) through the injected seam, `wt-lane-wait` canonicalises its `--dir`, and the lifecycle, executor, adoption and waiter fixtures canonicalise their temporary roots, so a symlinked `TMPDIR` (macOS) and a fake pid that exists on the host no longer split a path or an identity.
- Windows subprocess fixtures import ESM sources through `file:` URLs and OpenCode envelope assertions normalise path separators.

### Changed
- Process-spawning test files now share one low-parallelism Vitest project, with AST-based enumeration and a drift check that requires every newly detected file to join the policy.
- The What is running pane now reads SDK stages from `.lane/lifecycle.json`, labels log-derived fallback stages, uses the lifecycle state machine's exported phase vocabulary throughout, and states explicitly that phases are unavailable for plain OpenCode/Codex lanes.
- Claude SDK roles now expose optional TypeScript/JavaScript LSP navigation through their generated
  role plugin when `typescript-language-server` resolves, and record a visible non-fatal absent state
  in logs, lifecycle evidence, and closing-report instructions otherwise.

## [0.181.0] - 2026-09-16

### Tooling
- Added a ratcheted local quality gate for complexity, source size, duplication, dead code, and dependency layering across the toolkit and plugin sources.

### Changed
- Claude SDK pilot, judge, and executor sessions now derive guards, tools, and copied skills from one
  role table: writers receive the selected shipped command guards and context tools, readers receive
  bounded reads plus context search without write/execute tools, and missing profile dependencies
  fail closed instead of starting an unguarded session.
- `@anthropic-ai/claude-agent-sdk` moved from 0.3.260 to 0.3.273 (no code adaptation needed; the upgrade
  canary passed its 66 checks on the new runtime). Notable upstream changes for the SDK runner's design:
  `omitClaudeMd` on an `AgentDefinition` (0.3.271), `pluginDelivery: 'initialize'` (0.3.261), a `Stop` /
  `SubagentStop` / `SessionStart` hook callback that times out now counts as no decision instead of a hook
  failure (0.3.273), and plan-mode writes route through `canUseTool` even under
  `allowDangerouslySkipPermissions` (0.3.269).

### Fixed
- Windows runner: citation candidate/marker reports and the cross-repo typecheck gate print repository-relative
  paths with `/` whatever the host separator (filesystem I/O untouched); the label-intent lens test spawns
  `pnpm.cmd` on Windows.
- The four SDK role test suites are hermetic on a clean machine: `WT_CONTEXT_MODE_ROOT` is honoured only when set
  (the fail-closed check on the resolved root is unchanged) and the tests install a minimal context-mode fixture.

### Quality
- First measured baseline (the ratchets `pnpm quality` enforces from this release on; the next release reports the
  delta): worst cyclomatic complexity 127 (`plugin/bin/lib/lifecycle-launch.mjs` `run`), worst cognitive complexity
  282 (`plugin/bin/lib/pilot-runner-core.mjs` `runPilot`), biggest file 2,729 lines (`plugin/bin/wt-observe.mjs`),
  longest function 709 lines (`plugin/bin/lib/lifecycle-state-machine.mjs`), max depth 7, max params 7, 687 ESLint
  warnings (528 SonarJS), duplication 2.90 % (tests included), 221 knip issues (124 unused exports), 2 frozen
  dependency cycles. SDK Runner status unchanged: EXPERIMENTAL.

## [0.180.0] - 2026-09-16

### Fixed
- The lane-orphan watcher now detects an orphan of its OWN kind — a `wt-lane-orphan-watch` process whose
  working directory was deleted and whose parent is init — and terminates it by exact PID after re-reading
  its identity; a live sibling, an unreadable identity or a non-init parent is reported, never signalled;
  off Linux the detector says `unavailable: /proc required` instead of reporting zero orphans.

### Changed
- The SDK pilot runner documentation now states its EXPERIMENTAL status and the three proofs still
  missing (a complete real FULL cycle, a no-GPT real run, a green cross-OS matrix), so a green
  exit is read as evidence about one run rather than approval of the runner.

## [0.179.0] - 2026-09-16

### Fixed
- SDK pilot exit 0 now means delivered: every card criterion is proven and E2E records a real
  procedure and output. Non-proven outcomes and unrun E2E checks are archived as partial, exit 2,
  and remain partial rather than accepted in orchestrator wave reports.
- SDK lifecycle work can no longer be silently deferred. The runner-owned `route_finding` tool creates
  a labelled, dependent, provenance-bearing card from `--board-contract`, records it in lifecycle
  receipts, enforces named-card report grammar, handles one-round scope contests, and mechanically
  surfaces routed cards in pilot and orchestrator reports.
- Claude executor Bash permissions now reject explicit parent-directory operands such as `cd ..` and
  interpreter `resolve('..', ...)` calls as defense in depth. A real-SDK regression fixture locks the
  SDK sandbox as the filesystem confinement boundary for paths computed beyond lexical inspection.
- The What is running pane now keeps open state inside each session instead of the plugin-wide
  store, and a slow snapshot refresh can no longer make the pane disappear after a toggle click.
- The What is running process section no longer reports `partial (unreadable process records)` when a
  process merely exited between the `/proc` listing and its record reads: a pid directory found absent
  after a null read is counted in `processVanished` and discovery stays complete (every listed pid absent
  still reports `unreadable`: that is the source going away, not a race); a record that still exists and cannot be
  read is still a read failure.
- SDK pilot runs now record a lifecycle partial, publish the standard external archive, and finalize
  summary, usage, transcript, and cost receipts after runner timeouts, repeated no-progress turns,
  or initialized SDK stream failures. Interrupted lifecycle relaunches refuse with one complete reset
  command, and timed-out lanes can be abandoned or extended through the runner-hosted lifecycle tool.
- Orchestrator waves now freeze each card worktree's base as a full commit SHA. Archived diffs,
  fidelity manifests, and wave reports keep using that SHA if the configured base branch advances.
- Lifecycle reports are now archived under the project root instead of inside the card worktree,
  so removing the completed worktree does not destroy its audit archive. `wt-pilot-runner` takes
  `--archive-root <project root>` and defaults to the checkout that owns the worktree; an archive
  root that resolves inside the worktree is refused at construction, before any phase runs.

## [0.178.0] - 2026-09-15

### Changed
- Upgraded the toolkit test runner from Vitest 3 to Vitest 4.1.11.

### Added
- Added per-file rich HTML artifacts via a visible top-of-file marker. Rich pages may run inline
  scripts in an opaque-origin sandbox, while connections and external images remain blocked.
- Added a conditional one-line SessionStart notice that teaches fresh sessions to turn absolute
  report paths into artifact-server links, but reports unknown without link instructions when the
  server cannot be verified.
- Added a warn-only, journalled PreToolUse Bash guard for test starts made while other test-runner
  processes are alive. It excludes its own process ancestry and reports process-enumeration failure
  as unknown rather than silently treating it as a zero count.

### Fixed
- Artifact-server discovery now parses the URL token in real Tailscale Serve status headers that
  carry trailing annotations, while retaining strict endpoint and proxy-mapping validation.
- Artifact-server root indexes now emit relative links so navigation remains under a proxy path
  mount, and Host refusals identify the presented Host without exposing the allow-list.
- Artifact-server HTTPS links now preserve the exact Tailscale Serve hostname, port, and mount path,
  and fall back to the direct tailnet address when the table is ambiguous or maps another service.
- Artifact-server Tailscale detection now resolves the Windows executable through PowerShell and
  `wslpath` on WSL without assuming an install directory, and records whether lookup failed or a
  successful lookup found no tailnet address.
- Guard journal records now classify firings as real, test-origin, or unknown at the shared write
  seam. Recurrence and scan reports show test firings as an explicitly excluded population and keep
  undecidable and pre-change records labelled unknown instead of inflating real recurrence counts.

## [0.177.0] - 2026-09-15

### Added
- Added the on-demand `/wir` What is running pane as a shipped function-hook module. Its generic
  collector carries explicit available, partial, or unknown verdicts, and workflow-toolbox lane,
  executable, service, and branch conventions attach through one registered layout descriptor.

### Fixed
- Process discovery now renders a legible unavailable verdict on unsupported platforms instead of a
  confident empty list. Failed clock-tick, directory, process-record, executable-lookup, and Git
  probes no longer become guessed ages, empty scans, dead processes, or unmerged branches.

### Changed
- `wt-run-gate` now names the tree it certified on the same line as the exit code —
  `tree=<branch>@<short-sha>[ dirty] dir=<absolute path>` — because an exit code answers for the
  COMMAND and never for the SUBJECT: a gate can be genuinely green about a tree nobody intended to
  certify. It degrades legibly rather than omitting the field, since an absent field reads as "the
  same as expected": a directory outside a repository prints `tree=not-a-repo`, and a git that
  cannot be launched prints `tree=unknown`. A tree carrying uncommitted tracked changes is marked
  `dirty`, because a record keyed by a tree signature is not reproducible from the commit alone.
  The two paths that never reach that line — a gate killed by a signal, and one that fails to
  launch — carry the same identity in their own message.

## [0.176.0] - 2026-09-15

### Fixed
- Artifact-server Markdown pages now render GitHub-flavoured pipe tables, including inline markup and
  escaped or code-span pipes, inside a phone-friendly horizontal scroll container.
- SDK lifecycle plan transitions now warn when a sentence claims an existing test, lock, guard, or
  behavior provides coverage without a repo-relative `path:line` citation, or when that citation's
  file or line does not exist. Future-work promises pass untouched. The heuristic remains warn-only
  until 100 independently sourced candidate warnings are audited with zero false positives, and it
  states that citation meaning is not mechanically verified.
- The `delegation-chain` skill no longer calls a `Monitor` persistent. Every watch now carries a
  deadline — at most 30 minutes, 10 in a single-prompt `-p` run — and the harness notifies the
  session to re-arm at expiry, so the skill states the expiry, what an event-less expiry means, and
  that work needing a longer watch belongs in a manifest-declared monitor or a durable record.
- Bounded the OpenCode skill-fence capability cache to its 64 newest results, pruned inside the same
  locked operation that publishes a cache miss. The lock cannot be stolen: it has no staleness
  displacement, so no process can take it from a holder and none can remove a lock it does not own at
  the moment of removal. A crashed holder therefore leaves a lock nobody steals and waiters time out,
  which is a deliberate availability trade rather than two writers in the critical section. Pruning
  refuses any cache directory not carrying the store marker this module writes, and no removal is
  recursive. Older binary/version results are discarded and may require one capability re-probe if
  that exact OpenCode installation is used again.

## [0.175.0] - 2026-09-15

### Added
- Added lifecycle-phase and model cost receipts for SDK pilot runs, archived report summaries, and
  the complete-only `wt-run-cost.mjs` LITE/FULL/HARD aggregator. Cost receipts use streamed assistant
  usage, provider-correct fresh-token formulas, archive-derived wall time, per-log legacy matching,
  family-split aggregate rows, explicit unknown counts, and run-identity deduplication.
- Added repeatable absolute local-plugin options to SDK pilots and orchestrators, with pilot and judge
  initialization receipts required to confirm every configured plugin loaded.
- Added the `sdk-pilot` skill to expose detached evaluation of the not-yet-supported SDK pilot runner.
- Added a versioned SDK-role rules manifest with strict source/heading validation, additive project
  manifests, and exact standing, phase-entry, and lane-brief delivery.
- Added required E2E evidence to pilot reports and required independent-review summaries on FULL runs.
- Added an always-on lane/orphan watcher, owner-mediated timeout decisions, exact-identity orphan
  cleanup, and an append-only lane-supervisor journal. Live work is never killed merely for age or
  silence; no-answer extensions are bounded before the recorded default becomes `abandon`.

### Changed
- SDK lifecycle plans and pilot reports now quote every folded card Definition-of-done criterion under
  `## Acceptance`, with named plan proofs and explicit report outcomes enforced at their edges.
- TDD and harden briefs now include the frontmatter-stripped changelog skill as server-written
  authoritative instructions and fail closed when its source is unavailable.
- Split the verify-by-ground-truth rule's oversized top section into addressable gestures and mapped
  gate, delegate-proof, and causal-attribution guidance to the relevant SDK pilot lifecycle roles.
- SDK pilot critics now receive the server-recorded discovery intake alongside the plan, and SDK
  pilots and orchestrators receive the resolved read-only project knowledge-base index path or an
  explicit absence.
- Claude SDK critic, review, and refutation lanes may Read the resolved knowledge-base index and its
  contained Markdown fiches; OpenCode lanes state when that external index is unavailable.

### Fixed
- Load-sensitive integration tests now synchronize on protocol replies, filesystem state, owned
  process identities, watcher sweep receipts, and child exit/stream closure instead of ambient
  process deltas or short sleeps. The load harness verifies every CPU burner by PID and argv before
  stopping it, and signing fixtures use private keys they create and own. Production test controls
  now announce every active name, quota barriers are bounded, malformed saturation controls retain
  real counting, and receipt/cleanup failures cannot mask watcher or suite outcomes.
- `wt-lane.mjs` now prints and journals the source brief path, age, first Markdown heading,
  and SHA-256 before detaching; refuses briefs older than 10 minutes unless the caller adds
  `--acknowledge-stale-brief`; and gives the worker a hash-verified private snapshot so the
  bytes it obeys cannot differ from the bytes the launcher announced. The age bound is
  configurable with `--max-brief-age`.
- Artifact-server monitors now retry pending startup discovery through the filesystem claim path,
  bounded by attempts, one minute of their own retry work, and a five-minute overall cap, and
  journalled through deferral, failure, attachment, or give-up.
- Run-cost receipts now reconcile output tokens present only in the authoritative Claude SDK terminal
  result into a named `reconciled` field and phase, compare the primary model's SDK usage with that
  result total, and retain otherwise-unattributed sub-model usage by model without claiming an
  independent whole-run output instrument.
- Lane supervision now defaults to warn-only `would-clean` evidence, derives orphanhood only from a
  terminal supervision record plus a gone launcher, bounds default extensions, and stores immutable
  per-run records behind an atomic pointer. Timeout decisions are limited to `extend` and `abandon`;
  relaunching from retained worktree state is an owner-driven abandon followed by a normal fresh
  launch. The lifecycle polls a live `running` worker through its recorded timeout-transition bound
  instead of killing it after a fixed grace. The watcher owner-filters attributable output, emits
  notices independently of guarded audit writes, reports journal failures and unjournaled kills,
  rotates its journal, and retries failures. Promote cleanup to `enforce`
  only after at least 100 audited `would-clean`
  firings show zero live victims. Codex brokers remain observed only because idleness detection is not
  implemented. Existing adopted launchers must be re-adopted after this change.
- Concurrent artifact-server session monitors now coordinate startup through a recoverable filesystem
  claim, preventing duplicate `serve` spawns while allowing a later monitor to replace a dead holder.
- The open-work Stop gate now detects project-scoped detached pilot/lane runners and fresh
  non-terminal launcher-owned lane logs; discovers suite worktrees from a non-Git umbrella;
  bounds process and log reads; reports live harness tasks without counting them because the Stop
  payload cannot distinguish Monitors from background jobs; and re-emits an unchanged idle verdict
  after its 45-minute cooldown.
- The SDK pilot plan check now reads a `### ` heading as a task when no list line sits under it, so a
  plan written with task headings is no longer refused, and a heading task missing its DoD is no longer
  accepted through an unrelated bullet; the refusal names both accepted task shapes.

## [0.174.0] - 2026-09-14

> **Not supported in this release:** the SDK pilot runner (`wt-pilot-runner`), the SDK orchestrator
> (`wt-run-orchestrator`), the Claude SDK executor and the SDK lifecycle server are present in the tree
> but not yet supported: no skill exposes them, a full end-to-end run is not yet proven, and their
> interface may change.
>
> **Default change:** without settings, the harness pilot now runs on Opus (Fable for hard cards) and the
> harness orchestrator on Opus (previously Sonnet for both).

### Changed
- The prompt-cache keepalive monitor is now on by default; set `WT_CACHE_KEEPALIVE_ENABLED=false` to disable
  it. It still acts only on a session idle past its provider threshold.
- SDK pilots now freeze executor family and per-role models with their route: consented runs use GPT
  lanes, while profiles without lane consent use a worktree-confined Claude SDK executor launched with
  its phase as `--role` (critic, review and refutation are read-only). Critic, code, review, and
  refutation models have route- and hard-aware defaults and independent profile overrides
  (`WT_EXECUTOR_CRITIC_MODEL`, `WT_EXECUTOR_CODE_MODEL`, `WT_EXECUTOR_REVIEW_MODEL`,
  `WT_EXECUTOR_REFUTATION_MODEL`). Harness pilot and orchestrator defaults are now Opus, with Fable
  for hard cards (`WT_PILOT_MODEL`, `WT_PILOT_HARD_MODEL`, `WT_ORCHESTRATOR_MODEL`); the SDK runner uses
  its own keys (`WT_SDK_PILOT_MODEL`, `WT_SDK_PILOT_HARD_MODEL`, `WT_SDK_ORCHESTRATOR_MODEL`), all Opus
  by default.
- SDK pilots and the SDK orchestrator read their Planka MCP endpoint from the `planka_mcp_url` plugin
  option (environment fallback `WT_PLANKA_MCP_URL`, empty by default: no board tools) instead of a
  hard-coded port.
- Lane model/skill allow-lists and user-facing artifact-server settings are now Claude Code plugin
  options, resolved consistently before their existing environment fallbacks. String lists use
  comma/newline syntax in plugin settings; test-only artifact-server knobs remain env-only.

### Added
- Added the `wt-secret-guard` Function Hooks plugin to the marketplace: it scrubs secrets from prompts and
  tool results and rewrites 1Password references. Requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and the
  1Password CLI.
- Added `/second-opinion`, a one-call read-only advisor that automatically uses GPT-6 Astra when
  GPT-lane consent and the Codex companion are present, otherwise Claude Fable through the Agent SDK.
  Fable calls fail closed at a configurable weekly scoped-quota ceiling, and detached output records
  route provenance plus a final exit marker.
- External OpenCode lanes now allow only `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`,
  `openai/gpt-5.6-sol`, and `openai/gpt-6-astra` by default. Set the comma- or
  whitespace-separated `WT_LANE_MODELS` allow-list to replace that default; model matching is exact.
- External OpenCode lanes can declare a comma- or whitespace-separated `WT_LANE_SKILLS` allow-list.
  Approved Claude skills are copied into lane-local OpenCode configuration while the Claude-skill fence
  remains forced; `save-memory`, `planka-tracking`, and `what-next` remain unconditionally refused as
  single-writer memory/board skills, including case and `_`/`-` name variants. Every toolbox OpenCode run
  now performs an uncached, bounded `opencode debug skill` check at launch with the run's exact environment,
  directory, and config, and fails closed if effective discovery reports a refused name or the probe fails.
  This is a checked-at-launch filesystem snapshot, not a defense against an actor racing local writes. Materialisation is rebuilt from scratch,
  rejects destination and source symlinks, requires the root frontmatter name to match its directory, and
  rejects nested `SKILL.md` files. Inherited `OPENCODE_CONFIG` is dropped rather than passed through.
- Added a default-on, dependency-free artifact server with per-user port discovery, bind-race
  single-instance startup, owner-only filesystem session registration and automatic last-session shutdown,
  identity-checked status/stop/restart controls, multi-root project-local defaults, URL helpers,
  escaped Markdown/text rendering, sandbox CSP, pinned realpath confinement, Host validation, and a
  non-shrinkable-by-default sensitive-file deny list. When Tailscale is detected it also binds the
  tailnet interface and reports direct or manually configured Tailscale Serve URLs.
- Added an off-by-default prompt-cache keepalive monitor (`WT_CACHE_KEEPALIVE_ENABLED`) that tail-reads the current session transcript,
  applies provider-specific idle thresholds, caps consecutive refreshes, and journals wake outcomes.
- Added the Kotlin JVM language pack with Kotlin/Gradle/Maven triggers, JUnit 5 and `kotlin.test`
  rules, SDK-only review agents, probe fixtures, and a documented fallback from the expired
  JetBrains Kotlin LSP release to `fwcd/kotlin-language-server`.
- Added the Svelte language pack with Svelte/Vite/Vitest selection, SDK-only review agents,
  `svelteserver` diagnostics, archived two-arm probes, and navigation-parity fixtures.
- Added the Groovy language pack with sole `.groovy`/`.gradle`, Gradle, and Spock trigger ownership,
  focused rules, SDK-only review agents, and archived headless probe fixtures. The attempted
  GroovyLanguageServer build did not start in the harness, so no Groovy LSP declaration ships.
- Added the Vue language pack with `.vue`, Vite, Vitest, and Vue TypeScript triggers, local family
  guidance, SDK-only agents, and archived Volar diagnostics/navigation fixtures. Volar 3.3.11 is
  installed under `~/.local`, but its available-binary headless probe initialized without delivering
  the planted diagnostic, so the pack intentionally ships without an `.lsp.json` declaration.
- The observer-pairing guard now archives checker-reported conflicting `meta.json` pairs under the state directory by default, with `WT_OBSERVER_PAIRING_CAPTURE_DIR` available to redirect evidence.
- SDK pilot runner summaries now record the requested model and resolver provenance alongside the
  model reported by the SDK initialization receipt and first assistant turn, explicitly flagging
  agreement, disagreement, or absent SDK evidence.
- `wt:card-cost -- --hops` now reports transcript-derived delegation depth, fan-out width, envelope estimates, async notification/read-back delivery, and message re-ingestion cost.
- Language-pack probes now measure archived native-LSP navigation capabilities through an explicit `--capability` axis and render a cross-language parity table.
- The PR review workflow now adds a `lock-enumeration` lens for changed test files, identifying assertions that enumerate open shared families instead of stating invariants.
- `wt-observe launch` now resolves locally available `definitionFile` observer requirements through the capability registry, while preserving server-side pass-through for unavailable files and refusing root-escaping paths.
- Pipeline nesting limits now use a per-branch remaining-depth budget, so a nested spec can start a fresh downward-only budget with its own `maxPipelineDepth` override without loosening an exhausted ancestor.
- Split the SDK pilot lifecycle server into focused state-machine/tool, launch/attestation, report-edge, and brief-composition modules without changing its MCP export surface or behavior.
- `wt-arc-watch` now surfaces qualified named-teammate idle records from the session spawn registry once, while suppressing records already closed by a later stop.
- Rule-edit horizon notices now cover shipped agent templates, explaining their bare-name adoption and re-adoption horizon.
- Language packs: `plugin/.lsp.json` is now GENERATED from `plugin/packs/*/.lsp.json` by `pnpm packs:lsp` (TypeScript first, then packs alphabetically; duplicate keys and incomplete declarations refused) and locked by a byte-identity test; two new packs, Python (`pyright-langserver`) and Java (Eclipse JDT LS, `jdtls`, JDK 21+ required; Groovy is guidance only, no declaration); one archived two-arm headless diagnostics probe per pack (`node toolkit/scripts/lsp-pack-probe.mjs <pack>`, verdict read from Claude Code's own debug log); the add-a-language recipe `docs/public/language-packs.md` and the pack README template `plugin/packs/README-TEMPLATE.md` with a sections gate.
- Measured wildcard-first Glob and Grep matches through in-worktree symlinks as confined to the worktree by the real SDK.
- Added the headless SDK orchestrator runner: deterministic multi-card pilot waves are judged by one
  read-only, wave-confined SDK session, while code owns receipts, reports, board comments, and all
  merge/publish escalations to main. Card IDs and real paths now fail closed, configured remotes and
  merge ref updates are fenced inside wave worktrees, symlinks prevent judge launch, MCP initialization
  completes its notification handshake, partial board mutations are reconciled in fatal reports, and
  receipts are copied beside the report.
### Fixed
- Artifact-server session monitors now deregister when their parent exits, and servers exit after three
  registration polls when their state directory disappears or `server.json` no longer names their PID,
  preventing orphan processes after an abruptly killed test run.
- `wt-pilot-runner.mjs` now records the launching `CLAUDE_CODE_SESSION_ID` in `.lane/env.log`, overwriting it on each launch like `wt-lane.mjs` and using an empty value when no session id is present.
- SDK pilot and orchestrator entrypoints now resolve one shared Agent SDK install after lane-consent
  checks, searching the development toolkit, target project, `CLAUDE_PLUGIN_DATA`, and global npm root
  in order. Installed-plugin refusals now print a one-line, copy-pastable install command instead of
  naming a missing toolkit directory.
- Adopt now refuses `wt-lane` script checks and installs when its resolved runtime plugin root is missing a module loaded by the transformed launcher.
- Every toolbox-owned OpenCode launch (`wt-lane`, verifier, envelope, intercepted verifier, and observer)
  now shares a forced `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true` child environment, excluding Claude
  Code's single-writer skills while leaving OpenCode and `.agents` skills available. A model-free,
  isolated synthetic-skill probe fails closed when OpenCode stops honoring the fence and caches each
  successful verdict by resolved binary path and version in plugin state; adopted launchers load the
  same helper from their installed plugin.
- `wt-lane.mjs` now records the launching `CLAUDE_CODE_SESSION_ID` in `.lane/env.log`, using an empty value when no session id is present.
- SDK pilot routing now recognizes populated DoD headings; critic rounds retain trusted prior findings,
  ignore fenced fake DoDs, distinguish strictly parsed blocking from non-blocking findings, retain
  deduplicated optional findings from every round, bound report input, require successful receipts for
  advancement, disclose the enforced plan grammar, and report the actual critic-round count when the
  bound is exhausted.
- The actionability Stop gate now blocks only under a live autonomy mandate (or a legibly unreadable
  mandate), limits stale snapshots to one refresh request per snapshot, and journals every block with
  its reason, mandate classification, and consecutive index.
- Pilot and pilot-orchestrator watchdogs now pin `haiku` instead of inheriting the spawning session's
  model: a paired observer receives no model parameter from the spawner, so an unpinned watchdog ran
  on the premium tier. A lock now fails on any `observer:` pairing whose observer lacks a `model:`.
- Removed overlapping language-pack file triggers so Gradle DSL files follow their implementation
  language, Maven selects Java, and Svelte/Vue selection relies on framework-specific files.
- Signature CI now loads its signer policy and checker from the protected PR base ref while checking the PR checkout's commits.
- `wt-lane.mjs` now refuses a `--dir` outside a Git work tree before the consent gate, with an absolute `git worktree add` remedy; `--allow-no-git` remains available for deliberate non-repository lanes.
- `wt-spawn-registry-scan` now reopens a named agent only when a later outbound record or transcript write follows its last stop; a final stop still closes the arc.
- Lifecycle archives are now published by rename only after every summary and validation write, so a failed post-copy validation leaves no published archive.
- **`wt-lane.mjs` worker ends its whole process group on `SIGTERM`/`SIGINT`** (log `EXIT=143`/`130`): a launcher killed by pid used to die alone and leave the detached `opencode` lane running in the worktree, invisible to the caller.
- `wt-memory-index-check` no longer reports an existing subfolder fiche as a false dangling reference.
- SDK pilot runs now route a spent critic or review/refutation round bound to an archived partial report, require
  its exact `Partial:` reason, and return exit code 2 instead of deadlocking on an unavailable edge.
- SDK pilot runs now use `default` permission mode so `canUseTool` enforces worktree read confinement
  and the exact lifecycle/Planka allow-list; dangerous permission bypass is no longer enabled.
- Lane launches now consume read-only runner-owned snapshots outside the worktree and keep the launcher
  worker, `opencode`, and ordinary descendants in the reported process group terminated after receipt or
  timeout; processes that create their own session remain outside this guarantee.
### Fixed
- Lane briefs now require phase-bound `write_artifact` provenance and are recreated exclusively from
  server-held pilot context immediately before launch, with independent patch inputs re-derived then.
### Fixed
- Prospective review and refutation patches now enforce their output limit across the combined
  header, tracked diff, and every untracked-file diff, refusing as soon as the total exceeds it.
### Fixed
- Independent review and refutation now fail closed when their prospective patch cannot be built,
  exceeds the output limit, or has no substantive hunk despite a dirty tree; no brief is left
  launchable after refusal.
- Fidelity bundles apply lifecycle-name classification before handling symlinks. Unmatched symlink
  names now require `--other-file` at freeze, and manifests preserve that classification so verify
  cannot reinterpret an unknown-name symlink as recognized evidence.
### Changed
- The shipped SDLC protocol now requires a real-data, repeatable end-to-end check wherever possible,
  with verbatim output in the report; the closing-report checker accepts named e2e output or a
  reasoned `e2e not run`, and warns without blocking when both are absent.
- Workflow launches now fail loud unless `args.perAgent.model` is a non-empty string: the Workflow PreToolUse guard denies the call, and `wt-observe launch` refuses it unless `--allow-inherited-model` explicitly accepts inheritance.
- Ground-truth verification guidance now treats readings taken in one shared measurement window as
  one reading and requires witness lines selected against the suspected failure mode.
- The dev-implement example now shares its worktree and lane merge safety pipeline without changing emitted prompts.
- The SDK pilot lifecycle is now the runner-hosted `sdk-pilot-lifecycle` MCP server, replacing the
  Function Hook and raw Bash allow-list. It derives and freezes card routing; parses lane verdicts
  from attested reports; generates independent-review briefs from server-owned templates and
  nonce-binds both lane logs and reports; re-checks ancestors and relative glob prefixes through
  symlinks; and uses filesystem tree signature v3, which ignores index-only changes. The lifecycle
  run tool waits for lanes, so `--lane-silence` is removed. Fidelity bundles use canonical manifest
  v2 with exact snapshot-bound entry schemas, coherent commit heads, and length-prefixed signatures;
  `verify` supports `--require-same-tree` and `--require-head` (`--require-clean-tree` is deprecated).
  Lifecycle code is split into server/state, receipts/launch, and report-edge transaction modules;
  an uncertain post-commit HEAD is persisted and reconciled on retry without committing twice. The
  runner now requires `--card-file`, exposes only the exact documented Planka operations, uses
  mailbox-in/report-out owner communication, and supplies independent review with the prospective
  staged, unstaged, and untracked working-tree patch against the construction base.
- SDK pilot runs inject phase-specific continuation prompts when a pilot ends a turn before
  awaiting-fidelity, failing after three consecutive end turns without successful lifecycle progress.
- SDK pilot `critic-brief` artifacts are bound to the critic phase, matching every other lane brief's
  write-brief, run-lane, transition order while retaining the plan digest requirement.
### Fixed
- `wt-run-gate` signatures now invalidate records for content, deletion, mode, type, and symlink-target
  changes; the SDK pilot can write only its lifecycle-gated lane brief and report artifacts.
- SDK pilot completion now requires the correlated lifecycle result to equal the awaiting-fidelity
  receipt; refusal text containing that marker cannot complete a run. Fidelity manifests accept only
  named quality gates, lifecycle phases, integer exits, and typed top-level scalars. Archive success
  summaries are published only after archive creation and final tree-cleanliness validation succeed.
- SDK pilot lifecycle: a `changes-requested` review or refutation must now name at least one
  non-blank finding. An empty findings list was accepted, so a revision round could consume one of
  the bounded rounds while recording no reason for it. A `clear` outcome still carries no findings,
  which is the outcome that legitimately has none.
- Pilot model keys: the resolver and `wt-pilot-models` report the EFFECTIVE model a profile remaps
  an alias to (`ANTHROPIC_DEFAULT_<ALIAS>_MODEL`, process env over settings env), and a raw
  provider name in a `WT_*_MODEL` key is refused with that remedy — a GPT pilot is the same harness
  alias under a remapping profile, not a separate runner.
- `wt-quota-watch.mjs`: a usage percentage that falls between two polls is reported as a RESET
  only when the previously reported reset time has come AND identity continuity is established
  (account fingerprint unchanged, Claude route). Every other drop is `QUOTA DROP … unverified`
  with both reset times: before that time (a manual reset, or a change of account, binding or
  source) and, on the proxy route, after it too ("reset likely but unverified … probe before
  relying on the capacity") — the event type never exceeds the evidence, because a consumer acts
  on the type without reading the caveat. Classifier in `lib/quota-drop.mjs`.
### Added
- Add deterministic pilot-orchestrator intake triage and `wt-intake-triage` CLI: forced route handling,
  one batched strong-model classification, route-up-on-doubt, and an executable fixture lock for inline,
  lane-direct, and pilot work.
- Pilot runner now detects silent executor worktrees, injects a bounded status turn, and records `silence_injections`; pilots continue one `EXIT=124` lane with a diff-preserving brief before reporting a second-timeout PARTIAL.
- Add a SessionStart warning when `.claude/progress.md` has unsynced Planka-buffer entries, directing the session to fold them into the board and purge the section.
- Add `wt-claimed-test-check.mjs`, a warn-only scan for normative documentation claims that lack a plausibly relevant toolkit test.
- Pilot runner accepts an arbiter-written `--card-file`, traces injected turns to stdout, and records their count in `summary.json`.
- `wt-main-guard-hook.mjs` now journals (without denying) `git reset --hard` and `git checkout -f` only when their worktree has uncommitted changes.
- Add adopted standing-authorization and permission-class templates; escalations now consult owner-granted acts and a warn-only Stop hook journals covered and uncovered requests.
- Add a fail-safe `WT_SESSION_ROLE=relay` mode that leaves the five always-on monitors unarmed in relay sessions while preserving principal defaults.
- Add the v2 tracker-neutral queue snapshot contract, including startable, awaiting-owner, and
  unclassified counts; the autonomy watcher now reports a completed mission once per snapshot and
  the stop gate permits that finished mission to end.
- Add spawn-time pilot and orchestrator model profile keys with Anthropic `sonnet` defaults and
  process-environment/settings-profile resolution.
- Warn before an autonomy mandate freshness window expires so sessions can re-arm in time.
- Add `wt-lane-wait.mjs`, an allow-rule-covered Monitor command that waits for a lane worker and its terminal exit marker without printing the lane log.
- Record a redacted environment snapshot in `.lane/env.log` when a lane worker starts.
### Changed
- Run each release-only plugin eval case three times and decide it by a strict majority, reporting
  each case's pass count so transient model outcomes do not decide a release rerun.
### Fixed
- Pass the explicit repository root to bridge-routed `pr-review` reviewers and refuse launches that omit it.
- Replace 105 synchronous hook spawns inside a fixed test timeout with an in-process `writeJournalEntry` journal seam.
- Quota route: a proxy window whose `used_percent` is not a finite number within 0–100 is dropped, and an answer whose windows are all malformed reads as unknown instead of 0 %.
- Make autonomy-watch expiry transition tests deterministic with an injected test clock.
- Keep plugin eval expected-failure fixtures in temporary files instead of mutating the shipped declaration.
- Refuse adopted launcher generation when its consent transformation fragments are missing, duplicated, or leave relative imports behind.
- `wt-actionable-gate-hook` now falls back to transcript and declared-bound evidence when Linux lane detection errors, and names the detection failure in its block.
- Make the actionability-gate hook tests independent of ambient Linux lane detection; test-only.

## [0.173.0] - 2026-09-09

### Release notes
- Docs audit and coverage audit NOT run for this release (rituals suspended by the owner on 2026-09-03 until the thin-envelope campaign completes).
- Cross-family review of the whole range (GPT lane, five lenses + refutation): the five HIGH and two MEDIUM findings are fixed in this release, each with a lock proven red first; six lower findings are deferred and listed on the release card.
- Cross-platform verdicts for the two new plugin binaries: `wt-piped-gate-exit-code-guard-hook.mjs` parses the command text only (one `readFileSync`, no platform call) and behaves the same on Linux, macOS and Windows; `wt-opencode-verify.mjs` resolves the CLI with a POSIX `command -v` and a list of POSIX install paths, so on Windows it refuses with the legible `OPENCODE_UNAVAILABLE` marker unless `opencode` is reachable through those paths — it never returns a plausible verdict where it cannot run. Both read from source; Linux exercised, macOS and Windows not run.
- The TypeScript pack's SDK runner is now a toolkit development utility, not a shipped file (see `docs/public/known-issues.md`); the pack stays experimental.
- Plugin eval gate (`wt-plugin-eval-gate.mjs`, early-access flag on): 4/4 on the final run. Three runs on the same content: run 1 failed on a grader that could not match a line-wrapped command (fixed in this release), run 2 failed once on `opencode-verifier-unavailable` with a single haiku run that narrated instead of calling; the gate's single-run verdict is tracked as unstable (release card).
- npm packages are NOT published by this release; pending changesets are released separately.

### Changed
- Let the plugin eval gate track declared expected failures and reject malformed or expired expiry dates
- Document `<project root>/.claude/worktrees/<name>` as the gitignored convention for new concurrent worktrees.
- Require hand-written executor-lane briefs to request report lessons and harvest each report at its lane integration.
- Require a seam review and merged-tree gates when integrating parallel branches.

### Fixed
- The plugin eval grader for the changelog skill now accepts a command wrapped over several lines;
  `.*` never crossed a newline, so a correct multi-line answer graded as "pattern not found".
- `wt-actionable-gate-hook` now names whether a missing measurement needs its producer wired, is a
  normal no-recent-board-read lag, or reflects a producer that could not read the board; undeclared
  projects remain silent.
- Classify fresh actionability producer failures before missing snapshots or stale heartbeats, so
  tracker failures direct operators to the tracker rather than wiring or normal-lag guidance.
- `opencode-verifier` now invokes one stable `wt-opencode-verify.mjs` command, so a narrow allow
  rule covers the complete call rather than only one segment of its former shell chain.
- `wt-queue-not-empty-gate-hook` now treats recent files in every registered git worktree and a
  fresh non-terminal `.lane/run.log` as in-flight external lane work. A terminal `EXIT=<n>` log and
  a merely live process do not suppress the gate.
- `wt-queue-not-empty-gate-hook` now reports worktree activity as unknown when Git worktree
  enumeration fails, times out, or returns malformed output instead of claiming the root is idle.
- Mask secret-guard-tokenised values before guard-journal persistence
- Mask secret-guard-tokenised values when embedded in guard-journal fields
- Return the bare unavailable marker when the verifier cannot run its Bash probe
- Refuse a successful opencode verifier response that contains an external-directory denial, so the
  bridge can perform its one inlined recovery attempt instead of returning an ungrounded verdict.
- Keep opencode verification read-only by omitting `--auto` from the stable wrapper command.
- Move the TypeScript pack SDK runner into the toolkit, where its Agent SDK development dependency
  is owned, instead of resolving it through a distributed plugin's sibling checkout.
- Make adopted `wt-lane.mjs` import the installed canonical consent resolver and refuse when it cannot be found, rather than carrying a drift-prone inline copy.

### Added
- Add adoptable SDLC engineering protocol rule
- Add the TypeScript pack SDK agent runner as a toolkit development utility
  (`toolkit/scripts/run-typescript-pack-agent.mjs`), not a shipped plugin file
- Add `wt-piped-gate-exit-code-guard-hook.mjs`, a journaled warn-only warning for control-gate
  pipelines whose following `$?` would read the final pipeline element rather than the gate.
- SessionStart adopt checks now report each divergent managed copy as `behind vX` or `ahead of vX`
  and leave the owner or single writer to run the explicit refresh command.

## [0.172.0] - 2026-09-08

### Release notes
- Docs audit and coverage audit NOT run for this release (rituals suspended by the owner on 2026-09-03 until the thin-envelope campaign completes).
- The TypeScript pack ships with its SDK critic/reviewer agents declared but not yet exercised on a real increment (follow-up tracked); treat the pack as experimental.
- npm packages are NOT published by this release; pending changesets (patterns, pipeline-spec major) are released separately.

### Added
- Add an opt-in TypeScript development pack with TDD, gate, and SDK review guidance
- wt-lane launcher accepts --variant <name> and passes it to opencode (effort axis); a malformed name is refused
- Require the five SDLC closing-report sections in the findings checker.
- Add read-only gate-record status checks
- Add warn-only Findings disposition report checker
- Add release-only plugin eval gate
- Add the changelog skill for deterministic release records
- `wt-lane.mjs`: a stable-path adoptable detached external-lane launcher and the `external-lane` skill.

### Fixed
- adopt --check detects shipped content changes under an unchanged version
- `opencode-verifier` now runs the CLI as the bare word `opencode` whenever `command -v opencode` resolved it (`timeout 570 opencode run …`), so a narrow `Bash(timeout 570 opencode run:*)` allow rule can cover the verifier without the auto-mode classifier; the `"$BIN"` form is kept only for a binary found by the installer-path scan, which no allow rule can cover.
- The quota watcher now resolves the session route before polling. Configured CLI Proxy sessions report the bound account's normalized windows; unknown non-Anthropic routes stay explicitly degraded and never fall back to the Claude quota probe.

### Changed
- Make the pilot lifecycle discovery-led with mechanical LITE/FULL routing and bounded exits

## [0.171.0] - 2026-09-07

### Added
- Warn-only PreToolUse spawn-surface guards now journal and surface missing report channels, read-only briefs paired with wide or absent tool allow-lists, Workflow fan-outs inheriting the session model, and subagent self-verification spawns. The capability guard and the new guards share one trusted agent-type tools resolver.

### Changed
- Guard-journal entries now carry sanitised session and agent identities plus process `pid`/`ppid`; scan and SessionStart recurrence summaries report distinct sessions and unattributed firings while retaining firing counts for the recurrence trigger.
- The opencode envelope now keeps task copies, manifests, answers, and logs outside the opencode
  `--dir` working tree, under a unique plugin state directory by default; `WT_ENVELOPE_WORKDIR`
  provides an explicit per-invocation directory.
- Executor-lane consent is now declared as optional plugin `userConfig.executor_lane_consent`
  (boolean, default OFF). The shared resolver reads its persisted account value, requires it to
  agree with an existing `WT_EXECUTOR_LANE_CONSENT` account setting when both exist, and reports
  each source; missing, false, narrowing, or disagreement keeps routing on the SPLIT path.
- Hook-only durable state now resolves through `plugin/bin/lib/plugin-data-dir.mjs` from the active config
  directory's installed-plugin registry, so hooks and shell readers share `plugins/data/workflow-toolbox-<marketplace>/<legacy-root>`.
  An uninstalled inline session may use its matching `CLAUDE_PLUGIN_DATA`; otherwise the XDG fallback remains.
  Legacy entries are carried over per file on every canonical resolution (never overwriting a same-named entry), because an older installed plugin keeps writing the legacy dir until the owner updates it.
- `wt-opencode-envelope.mjs` and the `opencode-envelope` / `opencode-verifier` agents: default model
  `openai/gpt-5.6-luna` (fallback `openai/gpt-5.6-terra`). `openai/gpt-5.4` was withdrawn from Codex/ChatGPT
  accounts on 2026-08-31 ("not supported when using Codex with a ChatGPT account"), so every envelope call that
  relied on the old default failed. Routing rationale: 2026-09-05 measurements (Luna 93.0 SWE-bench Verified at a
  tenth of Terra's quota; both accept 326k input via Codex).

### Added
- `wt-gate-evidence-guard-hook.mjs` refuses declared repository commits touching `plugin/` or `toolkit/` unless every declared gate has a fresh green record for the exact working and staged tree. The first 19 firings warn and journal probation; an explicit `gates: skipped — reason` trailer is journaled as an auditable override.
- `wt-version-guard-hook.mjs` now discovers every staged plugin root and refuses a real `git commit` when its tracked version carriers diverge: `.claude-plugin/plugin.json`, a versioned `package.json`, and matching versioned marketplace entries. It names every carrier, version, and the exact repair; `WT_VERSION_GUARD_MODE=align` is opt-in and stages the highest version. The existing release-record guard is reused unchanged for its separate changelog invariant. Function-hook modules cannot inspect Git's staged index because their runtime forbids Node API imports, so this ships as a command hook only.
- `plugin/usage-manifest.json`: what the plugin consumes from the harness and the Agent SDK (frontmatter keys,
  hook events and payload fields, monitors, SDK query options, env vars, CLI surfaces, invariants) — the input a
  docs/changelog digest is diffed against (common shape with claude-mem, 2026-09-05).

### Fixed
- `shell-text.mjs` is now a compatibility re-export of `command-invocation.mjs`; heredoc and quoted
  text stripping has one implementation and one test file, including `<<-` and quoted delimiters.
- Lane-consent and saturation guards now share `command-invocation.mjs` for heredoc and quoted
  text stripping, so a fixture body mentioning `opencode run` is not mistaken for an invocation.
- `adopt install.mjs` now refuses `--install --dir <rules-or-docs-root>` when adopted `wt/`
  copies already exist, reports flat/nested duplicates as `DUPLICATE` during `--check`, and
  names the safe `--dir <root>/wt` and `--global` remedies.
- `wt-observe start` now names the checkout branch, short commit, and newest served UI bundle before launch, records them in `server.json`, and refuses a non-`main` checkout unless the explicit, loud `--allow-branch` override is passed. `wt-observe status` reports the recorded identity.
- `wt-adopt-check-hook.mjs` (PostToolUse Bash): the adopted-rules drift notice fired on any command whose TEXT
  contained the words `git push` — a card description written through a heredoc, a quoted grep — while no push
  happened (three false firings on 2026-09-05). The pre-filter is now `looksLikePush()`: heredoc bodies and quoted
  strings are dropped and only a `git [-C dir] push` at a command position counts (start, after `&&`/`||`/`;`/`|`/
  `(`/`{`/`$(`/newline, `sudo`/`env`/`VAR=` prefixes allowed). Known-answer selftest
  `wt-adopt-check-hook.selftest.mjs` (12 cases); the hook's entry point now runs only when executed, so the
  selftest can import it.

### Changed

- Raised `@anthropic-ai/claude-agent-sdk` from `^0.3.205` to `^0.3.260` for the upgrade canary. Claude Code 2.1.260 can send a completed task notification before its output file is fully written, so the canary retries a transient partial-file read.
- The opencode envelope now stores each invocation's manifest, task copies, and answers under its workdir-scoped `.wt-envelope/` directory.
- The opencode envelope records each task's requested model and returns a JSON-encoded answer on the successful single-task batch's one `MANIFEST:` line, allowing schema callers to validate the script-owned result; invocation manifests are named `envelope.manifest.json` for manifest readers.

### Added

- **`wt-delegation-ladder` gains a fence-expiry clause.** A brief, rule or card that fences
  something off because a condition holds NOW keeps blocking after that condition ends, because
  nothing re-checks it — and a stale fence reads exactly like a live one, same text, no way for a
  reader to tell which.

  The clause states both halves: name the expiry IN the fence rather than the fence alone, AND give
  it something that re-reads it — record the condition where whatever satisfies it will land, quote
  the source that decides a quoted state, and report rather than lift a fence that is not yours.

  Measured three times in one day on three different surfaces before this was written: a task card
  fixed the same afternoon and left open for two more days; a defect fixed in code and never
  published, so every adopter still met it; and a rule whose own lifting condition had been
  satisfied and recorded elsewhere while the rule still said it had not been proven. Nothing was
  wrong when written; each simply outlived the state it described.

### Added

- **`leaf-readonly` agentType** — a fenced worker type for roles whose output is KNOWLEDGE
  rather than a change (survey, ground, audit, locate, verify-by-reading). It declares an
  explicit `tools:` ALLOW-LIST instead of subtracting from the default surface, and sits
  between `lean` (zero tools) and `leaf` (every tool except messaging).

  The reason it exists is measured, not theoretical: **withholding `Write`, `Edit` and `Bash`
  does not make an agent read-only.** A surface that still carries an MCP server's
  file-writing, shell-executing, record-deleting or message-sending tools still HOLDS all of
  those with none of the three present (the listing and one invocation from it are observed; that
  a write through such a tool completes is an inference, and the allow-list does not depend on it) — and an enumeration of forbidden tools cannot cover a surface
  that grows every time a user installs another MCP server. An allow-list is the only form that
  closes tools nobody has installed yet.

### Changed

- **`wt-delegation-ladder` gains a "read-only is an ALLOW-LIST" clause.** The rule previously
  described read-only enforcement only through the executor-briefing split; it now states the
  invariant (*the agent holds nothing that mutates anything outside its own context*), why a
  deny-list cannot work (an enumeration cannot cover a surface that grows with every installed
  MCP server), that an allow-list may silently deliver less than it declares, and that a newly
  written agent type is not spawnable in the session that wrote it.

- **`leaf`'s description no longer implies a fence it does not provide.** It denies
  `SendMessage` and nothing else; its own guidance previously read "you keep every tool except
  inter-agent messaging" without saying what that breadth includes. Both the description and the
  agent-facing guidance now name the reach explicitly and point a read-only role at
  `leaf-readonly`. No behaviour change: `leaf` keeps exactly the surface it always had, and no
  existing routing moves.

### Notes

- ⚠ An allow-list can deliver LESS than it declares, with no error: `Grep` and `Glob` were
  declared by two different definitions on this harness family and did not arrive. It errs SAFE
  (fewer tools, never more), so the fence holds — but a role must not assume search is
  available, and a caller should verify a spawned agent's ACTUAL surface rather than trust the
  declaration.
- ⚠ A newly added agentType becomes spawnable after a DELAY of roughly ninety minutes, with no
  restart and no announcement. Two readings taken at zero and sixty minutes both returned
  `Agent type not found` and were simply too early — do not read one refusal as impossibility, and
  re-probe instead of concluding.

### Added

- **A task's remaining-work ledger is a claim about the tree, and the briefing guidance now says to
  re-derive it.** A multi-part task carries a running "these remain" list written by whoever last
  touched it; it goes stale the instant a commit lands without a tracker write, and nothing
  announces the drift — the ledger stays confident, specific, and formatted exactly like a verified
  fact. Briefing an executor from a stale one asks for work already done, and the executor is not
  the safeguard: told to fix a defect, it has every reason to build a second mechanism beside the
  first, or to rewrite what exists and silently drop hardening the original carried. The clause
  names the favourable tell — a lane returning a clean tree or a suspiciously small diff — and the
  one command that settles it before the brief is written.

### Added

- **The briefing guidance now carries a platform check.** `wt-delegation-ladder.md`’s “Briefing an
  executor” section told an arbiter to state invariants, traps, evidence format and escalation
  triggers — all of which check a brief against the TASK. Nothing checked it against the PLATFORM,
  and a capability that worked last week reads as furniture. A prescribed remedy can be withdrawn
  while the rule still names it, at which point the brief is wrong BEFORE the executor reads it:
  the agent behaves correctly, cannot comply, and explains — a round trip bought for nothing, and
  the competence of both parties is exactly what hides the cause. The clause covers a tool, a write
  path, an output channel or an agent type, and says to confirm at brief time rather than infer
  from the rule that prescribes it.

### Fixed

- **`opencode-envelope` and `opencode-verifier` no longer die under the Workflow tool (Path A).**
  Both agents located their wrapper script via `${CLAUDE_PLUGIN_ROOT:-$WT_PLUGIN_ROOT}` — a
  two-variable fallback that covers an interactive session (which has `CLAUDE_PLUGIN_ROOT`) and a
  Path B delegated session (which the server backfills with `WT_PLUGIN_ROOT`), but NEITHER
  variable is set for an agent spawned through the Workflow tool. Measured on run `wf_7d40d5d6-086`:
  the path collapsed to `/bin/wt-opencode-envelope.mjs`, `MODULE_NOT_FOUND`, and the agent burned
  its entire `maxTurns: 3` budget on a `find` before returning empty.
- Both definitions now carry a THIRD fallback: when neither variable is set, read the harness's
  own `installed_plugins.json` registry (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json`)
  for the `workflow-toolbox@…` entry's `installPath` — the same content root `CLAUDE_PLUGIN_ROOT`
  would have pointed to. The whole resolution is one self-contained shell expression inside the
  already-required single Bash call, so it costs no extra turn.
  The registry is read through its `{version, plugins}` envelope, with a fallback to the legacy
  flat map, so both shapes resolve. An earlier draft of this fix read only the flat shape and
  therefore threw on every real config directory — the executable lock covering it had been
  written from the same understanding and agreed with it, which is why the lock now builds its
  fixture from the enveloped shape and exercises both branches.

### Changed

- The `opencode-verifier` task-file lock now asserts the PROPERTY of the extractor's happy path —
  that it resolves the plugin root through the same three fallbacks as the retry path — instead of
  pinning the entire shell expression byte-for-byte. The literal form went red on every correction
  to the resolver, including the one that made it work, while its green had never been evidence
  that the path resolved at all. Resolution correctness is locked executably in
  `opencode-plugin-root-resolution.test.ts`.

### Added

- **The raw opencode event stream is kept beside an external call's transcript** (`agent-<id>.opencode.jsonl`),
  because the reader already owns a converter for it — `opencodeEventsToTranscriptLines` emits a
  chained transcript and maps the usage into the shape every agent's header already renders.
  Duplicating any of that in this hook would fork a format that has one owner.
- The hook's own two lines remain the FALLBACK, for a plain-text call that emits no events at all.
- The sidecar is written only when the output genuinely parses as that stream — never as an empty
  file, which would read as "converted to nothing" rather than "not an opencode stream".

### Fixed

- Adopt checks now classify copies by a trailing-whitespace-normalized fingerprint of their
  banner-stripped content across project/global `rules/` and `rules/wt/` locations, report the
  selected location, and distinguish newer divergent copies as ahead/forked rather than behind.
- `wt-merge-chain-guard-hook.mjs` now stays silent while journaling `decision: "silent"` for a chained merge followed only by diagnostic reads; chained gates and unclassified commands continue to warn.
- The shared `wt-queue-gate` state directory now expires recognized stale queue, mandate, cooldown, and defunct-session watch markers opportunistically during normal reads and writes, without deleting unknown records.
- `adopt:migrate --execute --secondary-dir <rules-dir>` now reconciles a second configuration
  directory after verified moves: only symlinks to moved managed files are removed, then one
  absolute `wt -> <primary>/rules/wt` directory symlink is created and verified. A planned move
  without `--secondary-dir` now refuses unless `--ignore-secondary` explicitly accepts the risk,
  preventing a silent broken second configuration.
- `report-contract-lens.ts` is now an explicitly manual tool with the `pnpm wt:report-lens <report-file>` entry point, documentation of its non-automatic status, and a pre-harvest invocation in `lesson-harvest`.
- `wt-queue-not-empty-gate-hook` now detects recent work in live `opencode run` and `codex exec` lanes by reading their Linux `/proc/*/cmdline` `--dir` arguments, including lanes in separate repositories.
- Advisory plugin hooks now stay silent for payloads from Workflow-tool subagents, keeping their reminders and session guidance out of delegated agent context.
- `wt-outbound-guard-hook`: a Workflow-tool subagent on Path A (harness label `workflow-subagent`, session transcript in the hook payload, several runs in the session) was still nudged at SubagentStop and lost its structured return; the exemption now matches the harness label and finds the run by the agent's own transcript file instead of requiring exactly one run.
- **Four guard hooks no longer journal paths or path-derived text from tool input**. `wt-stale-date-guard-hook`, `wt-missing-package-script-guard-hook`, `wt-isolated-spawn-report-path-hook`, and `wt-observer-pairing-guard-hook` now record only class labels plus bounded shape evidence in the guard journal. Their model-facing warnings keep path detail only where the warning would be materially less usable without it.
- The quota watcher now resolves the session route before polling. Configured CLI Proxy sessions report the bound account's normalized windows; unknown non-Anthropic routes stay explicitly degraded and never fall back to the Claude quota probe.

## [0.170.0] - 2026-09-03

### Added

- `WT_GUARD_MODE=observe` for the plugin's warn-only guards: `wt-merge-chain-guard-hook.mjs`,
  `wt-pipestatus-bash-only-guard-hook.mjs`, `wt-find-newermt-format-guard-hook.mjs`,
  `wt-git-commit-backtick-guard-hook.mjs`, `wt-var-colon-modifier-guard-hook.mjs`,
  `wt-missing-package-script-guard-hook.mjs`, `wt-pgrep-env-dump-guard-hook.mjs`,
  `wt-plugin-release-record-guard-hook.mjs`, `wt-isolated-spawn-report-path-hook.mjs`,
  `wt-observer-pairing-guard-hook.mjs`, and `wt-stale-date-guard-hook.mjs`. In observe mode they
  still detect and still journal their events, now stamped with `mode: "observe"` and recorded as
  `decision: "silent"` (never `warned`, so a reader counting `warned` as "the hook spoke" stays
  honest), but emit no model-facing warning text; the default remains `enforce`. The journal reader
  and `wt-guard-journal-scan.mjs --json` count `silent` events (own `silent` column, included in `total`), so
  the recurrence hook keeps seeing a muted guard's firings.

## [0.169.0] - 2026-09-03
> The entry below arrived with a branch merge but its code did NOT: no commit in that merge
> touches the hook it describes. It stays here rather than under a released heading, because a
> changelog that announces work absent from the tree is worse than one that says nothing.

### Added

- **The 13 shipped rules under `plugin/rules/` now carry a fourth adopt-managed set: `docs`.**
  `adopt --set docs` installs `plugin/docs/rules-rationale/*.md` to `<config-dir>/docs/wt/`, with
  the same fingerprint banner and edit-safety as the `rules` set. This is the shipped-rules twin
  of the private user-rule static-prefix cut of 2026-09-02: a rule keeps every directive line, and
  a dated field case or hook-superseded section moves VERBATIM to its rationale doc, leaving one
  pointer line behind. Verified LOSSLESS at cut time with a one-off script,
  `toolkit/scripts/verify-rules-rationale-split.mjs --baseline <pre-cut dir>` (same algorithm as
  the private-rule pass's `verify-split.py`): **13/13 rule/rationale pairs, 0 missing, 0
  duplicated, 0 mid-paragraph splits.** That script is NOT part of `pnpm test` — a frozen
  byte-for-byte baseline is right for a one-time migration proof and wrong for a permanent lock,
  since it would forbid ever legitimately retiring a sentence from a shipped rule again. The
  ongoing gate is `toolkit/packages/build/test/rules-rationale-referential.test.ts`: every
  pointer's `§heading` resolves in its rationale doc, every rationale-doc heading is referenced
  by a pointer, a doc exists for every rule and vice versa, and no rationale-doc line is
  duplicated verbatim in its rule — an invariant that survives future rewrites instead of
  freezing today's prose. Proven red-then-green with a real mutation.
  ⚠ Honest yield: 3 of the 13 rules had a section either hook-superseded or a genuine dated field
  case to move — 393 bytes / 38 tokens of the set's cold-start prefix (≈0.4%, A/B-measured, three
  identical-cache runs per arm); the other 10 fuse directive and evidence in the same paragraph
  throughout and have nothing extractable under the whole-paragraph-only invariant. Two further
  hook-collapse candidates (wt-delegation-ladder's "wrapper never renders its own verdict",
  wt-step-back-architectural's "twin elsewhere") were attempted and REVERTED after an independent
  cross-family review found the named hook's own message does not restate a directive the removed
  text carried — both stay whole rather than shipping a rule that reads as fully covered when it
  is not. This pass is a small correctness gain (the clauses a shipped hook truly does enforce
  mechanically are now named as such) rather than a size gain.

### Fixed
- **Three guards no longer record raw command text in the guard journal** (`wt-merge-chain` recorded the
  merge segment as `reason`, `wt-git-commit-backtick` the flagged commit-message fragment,
  `wt-find-newermt-format` the flagged argument). Found by the adversarial security review of the observe-mode
  change; the merge-chain security lock now forbids the segment text too.
- **Twenty-four capabilities the pre-release coverage audit found undocumented are now described in
  their mapped docs** (quota-probe JSON contract, adopt changelog spans, run-gate `--fail-pattern` and
  authorized-scope shapes, actionable-gate and registry-heartbeat env knobs, static vs dynamic
  orchestrator missions, `STOP_GATE_INTERVAL_MIN`, `leaf-readonly`, `labelRole`, prompt-tag escaping,
  pr-review routing knobs and its `incomplete` verdict).
- **Fourteen doc claims corrected after the pre-release docs audit** (adopt `SKILL.md`: agent copies come from
  `agent-templates/` and there are four of them; `--migrate --execute` is the real move; the merge-chain guard is
  warn-only and its separator set is `&&`, `;`, `|`, `||`, newline; three rationale docs no longer say a warn-only
  hook "enforces").
- **`wt-merge-chain-guard-hook.mjs` records a CLASSIFICATION of the segment that follows a chained
  `git merge`, never the command text.** The record now says whether the trailing segment was a blind
  gate (a real catch) or a read of the merge's own log/exit code (the documented safe pattern), so the
  guard's precision becomes measurable — and no raw shell text, which can carry exported credentials
  on some machines, ever reaches the guard journal.

- **The lesson-harvest hook re-offered reports it had already harvested.** It does keep a registry,
  and the registry is keyed correctly (`path → mtime`) — but the registry FILE and the directories
  it searches were both derived from the raw `cwd`. Since `cwd` changes turn to turn (a worktree, a
  subdirectory, a temp path), every distinct cwd got its own partition, and a run from a deep cwd
  also looked in a `.claude/reports` that does not exist there.
  Measured on one machine: **133 state files, 126 of them an empty object** — 95% of the state was
  written by runs that found nothing to look at.
  Both halves now resolve by exact key first, then by walking REAL ancestors, the way the queue
  snapshot's path resolver already did. The `path → mtime` key is unchanged; the
  `WT_LESSON_HARVEST_STATE` and `WT_LESSON_HARVEST_DIRS` overrides still win.
  ⚠ The state filename now carries a hash suffix, so existing partitions are not read. Effect is a
  ONE-TIME cold start per project: already-harvested reports may be offered once more, then
  remembered correctly. Nothing is lost — the registry only suppresses repeats.
- **`wt-plugin-release-record-guard-hook.mjs`'s remedy no longer asks a branch to bump the
  version.** `no-publish-from-branches.md` forbids a branch from bumping the version at all — the
  bump happens on `main`, at push time, and a branch's changelog entry carries no version heading.
  On any branch other than `main`/`master`, the warning now asks only for a changelog entry under
  `## [Unreleased]` and says so explicitly; the version-bump remedy is unchanged on `main`.
- **`wt-hook-registration-drift-hook.mjs`'s `UserPromptSubmit`/`SessionStart` timeout raised from
  5s to 15s**, matching the two user-level hooks already registered on the same event. Measured
  2026-09-02 on a session restarted right after a plugin rollout: `UserPromptSubmit hook timed out
  after 5s — output discarded` — right after a restart the SessionStart loops load the machine and
  5s was not always enough headroom, even though the hook's own cold wall time measures ~20-25ms on
  this machine (5 runs, before and after). The hook is advisory (registration drift detection), so
  its silent loss on timeout is harmless — which is exactly why it must not keep failing invisibly.
  Also made SessionStart cheaper on repeat: the declared-hooks parse (JSON.parse + a regex sweep
  over the whole plugin manifest) is now cached in the per-session state dir, keyed on the
  manifest's own `mtime`+`size`, so a repeat SessionStart against an unchanged manifest reuses the
  cached set instead of re-parsing it — the parse only re-runs once the manifest has actually
  changed (a plugin reload). A new test locks the hook's cold run under a 2s budget against the
  real manifest and proves the cache reuses the same declared-hooks set across two SessionStart
  calls.

## [0.168.0] - 2026-08-28

### Fixed

- **A guard no longer reads a heredoc body as a command.** A command line carries code and data in
  one string, and nothing textual separates them — mentioning a footgun is not committing one, and
  a regex over a command string cannot tell the difference. Writing a test fixture whose heredoc
  body mentioned an external-CLI invocation was REFUSED by the lane-consent gate, which refuses
  rather than warns, so it blocked correct work outright.

  The fix is at the shared level, not in the guard that shouted: `plugin/bin/lib/shell-text.mjs`
  now holds the ONE implementation of `stripHeredocs` / `stripQuotedSpans`, the two byte-identical
  hand-written copies in `wt-main-guard-hook` and `wt-pilot-guard-hook` import it instead, and
  `stripNonExecutedText` strips heredoc bodies before its character loop.

  ⚠ Order matters and is locked: heredocs FIRST, because a body can contain a quote that would
  otherwise pair with one outside it and swallow real code between them. The lock is paired —
  removing the fix reddens the false-positive row while the "still catches a real invocation" rows
  stay green, so the guard was not blinded to buy the fix.

## [0.167.0] - 2026-08-28

### Added

- **Every external-CLI call now leaves a node behind.** Until now a call made by a wrapper agent
  wrote nothing to disk, so a run surfaced its Claude agents from the journal and never its
  external work. The hook writes the two files a node is built from — and it is the only place
  that can, because hooks are per session: nothing outside the delegated session observes its
  tool calls, while a plugin hook loaded INTO it does.

  Three properties are locked, each proven red by a mutation targeting only itself:

  - the node uses a **derived** id (`<agentId>-lane…`), never `agentId`. The harness writes the
    calling agent's own transcript and meta at `agent-<agentId>.*` in that same directory, so
    using `agentId` truncates the agent's own turns and relabels its node as the external one —
    silently, with nothing raised;
  - two calls with different `tool_use_id` produce **two** nodes, and the same call reported twice
    produces **one**;
  - a token count that could not be measured is **absent, never zero** — a zero renders as a
    measurement nobody made.

### Fixed

- **A test specified a race against itself.** The autonomy-watch expiry case set the mandate
  freshness window to 60 ms and then required a check that SPAWNS A SUBPROCESS to finish inside
  it. It failed 2 of 3 full-suite runs and passed 5 of 5 alone — and passing alone was never a
  control, since it passed alone before the fix too. The window now outlasts a spawn.

## [0.166.0] - 2026-08-28
### Added

- **The actionability producer hook now BOUNDS the spill-file read it was doing unconditionally.**
  The harness can answer a large tool call by writing the response to a file and handing the hook a
  PATH; that path arrives inside the tool response, so reading it unconditionally let an untrusted
  value choose which file the process opened. Four bounds now apply — absolute, canonically inside a
  root the harness actually spills into, a plain file, and under a size cap — in a new
  `plugin/bin/lib/spill-containment.mjs`. It returns null on every refusal and never throws, so the
  caller's contract is unchanged: an unreadable spill stays a recorded failed attempt and no
  snapshot is written from a guess.

  Extracted into `lib/` rather than written inline because the hook EXECUTES at import, so a test
  importing it hangs on a stdin nothing closes. Both bounds are proven red independently: deleting
  the allow-list reddens only the outside-root case, deleting `realpath` reddens only the
  symlinked-directory case.

### Added

- **`wt-delegation-ladder` gains a fence-expiry clause.** A brief, rule or card that fences
  something off because a condition holds NOW keeps blocking after that condition ends, because
  nothing re-checks it — and a stale fence reads exactly like a live one, same text, no way for a
  reader to tell which.

  The clause states both halves: name the expiry IN the fence rather than the fence alone, AND give
  it something that re-reads it — record the condition where whatever satisfies it will land, quote
  the source that decides a quoted state, and report rather than lift a fence that is not yours.

  Measured three times in one day on three different surfaces before this was written: a task card
  fixed the same afternoon and left open for two more days; a defect fixed in code and never
  published, so every adopter still met it; and a rule whose own lifting condition had been
  satisfied and recorded elsewhere while the rule still said it had not been proven. Nothing was
  wrong when written; each simply outlived the state it described.

### Added

- **`leaf-readonly` agentType** — a fenced worker type for roles whose output is KNOWLEDGE
  rather than a change (survey, ground, audit, locate, verify-by-reading). It declares an
  explicit `tools:` ALLOW-LIST instead of subtracting from the default surface, and sits
  between `lean` (zero tools) and `leaf` (every tool except messaging).

  The reason it exists is measured, not theoretical: **withholding `Write`, `Edit` and `Bash`
  does not make an agent read-only.** A surface that still carries an MCP server's
  file-writing, shell-executing, record-deleting or message-sending tools still HOLDS all of
  those with none of the three present (the listing and one invocation from it are observed; that
  a write through such a tool completes is an inference, and the allow-list does not depend on it) — and an enumeration of forbidden tools cannot cover a surface
  that grows every time a user installs another MCP server. An allow-list is the only form that
  closes tools nobody has installed yet.

### Changed

- **`wt-delegation-ladder` gains a "read-only is an ALLOW-LIST" clause.** The rule previously
  described read-only enforcement only through the executor-briefing split; it now states the
  invariant (*the agent holds nothing that mutates anything outside its own context*), why a
  deny-list cannot work (an enumeration cannot cover a surface that grows with every installed
  MCP server), that an allow-list may silently deliver less than it declares, and that a newly
  written agent type is not spawnable in the session that wrote it.

- **`leaf`'s description no longer implies a fence it does not provide.** It denies
  `SendMessage` and nothing else; its own guidance previously read "you keep every tool except
  inter-agent messaging" without saying what that breadth includes. Both the description and the
  agent-facing guidance now name the reach explicitly and point a read-only role at
  `leaf-readonly`. No behaviour change: `leaf` keeps exactly the surface it always had, and no
  existing routing moves.

### Notes

- ⚠ An allow-list can deliver LESS than it declares, with no error: `Grep` and `Glob` were
  declared by two different definitions on this harness family and did not arrive. It errs SAFE
  (fewer tools, never more), so the fence holds — but a role must not assume search is
  available, and a caller should verify a spawned agent's ACTUAL surface rather than trust the
  declaration.
- ⚠ A newly added agentType becomes spawnable after a DELAY of roughly ninety minutes, with no
  restart and no announcement. Two readings taken at zero and sixty minutes both returned
  `Agent type not found` and were simply too early — do not read one refusal as impossibility, and
  re-probe instead of concluding.

### Added

- **A guard for the plugin's own release record.** A commit staging changes under `plugin/`
  while staging neither the version nor this changelog now warns. The published packages have
  enforced the equivalent for a long time — touch a package source without a changeset and
  `changeset-gate` goes red — but the plugin had no counterpart, so a plugin fix could be merged
  and pushed with no bump and reach no adopter, silently. Measured 2026-08-27: exactly that
  happened to the queue-gate guard-journal wiring.
  Ships **warn-only**: a work-in-progress commit that bumps once at the end of a branch, and a
  plugin change with no release surface, both fire it legitimately. Promotion to blocking is a
  separate decision taken from the guard journal's record.

### Note on the version number

This entry carries no version deliberately. `main` and `card/1837086183-lane-artefacts` incremented
their counters independently after forking at 0.160.0, so the same numbers denote different content
on the two sides. Choosing the next number is part of reconciling that fork, not part of this
change.

### Added

- **The briefing guidance now carries a platform check.** `wt-delegation-ladder.md`’s “Briefing an
  executor” section told an arbiter to state invariants, traps, evidence format and escalation
  triggers — all of which check a brief against the TASK. Nothing checked it against the PLATFORM,
  and a capability that worked last week reads as furniture. A prescribed remedy can be withdrawn
  while the rule still names it, at which point the brief is wrong BEFORE the executor reads it:
  the agent behaves correctly, cannot comply, and explains — a round trip bought for nothing, and
  the competence of both parties is exactly what hides the cause. The clause covers a tool, a write
  path, an output channel or an agent type, and says to confirm at brief time rather than infer
  from the rule that prescribes it.

## [0.165.0] - 2026-08-27
- **A task's remaining-work ledger is a claim about the tree, and the briefing guidance now says to
  re-derive it.** A multi-part task carries a running "these remain" list written by whoever last
  touched it; it goes stale the instant a commit lands without a tracker write, and nothing
  announces the drift — the ledger stays confident, specific, and formatted exactly like a verified
  fact. Briefing an executor from a stale one asks for work already done, and the executor is not
  the safeguard: told to fix a defect, it has every reason to build a second mechanism beside the
  first, or to rewrite what exists and silently drop hardening the original carried. The clause
  names the favourable tell — a lane returning a clean tree or a suspiciously small diff — and the
  one command that settles it before the brief is written.

## [0.164.0] - 2026-08-27

### Fixed

- **The stop-gate claimed to have observed an idle worktree when it had not looked.** Its activity
  scan returned a boolean, and THREE different facts collapsed into its `false`: no git root could
  be resolved from the cwd, the bounded walk spent its entry budget before finishing, and the whole
  reachable tree was walked with nothing recent. The emitted line asserted `no recent worktree
  activity` in all three, so a reader — and the decision "may I start something else" that reads it
  — could not tell an observation from an inability to observe.
  The scan now reports WHICH fact it established (`recent` · `idle` · `no-root` · `bounded`), and
  the emitted line names it. **Behaviour is unchanged**: only `recent` suppresses the gate, so the
  hook still speaks in every case it spoke in before — speaking when unsure is deliberate for a
  stop-gate, and the defect was the claim, never the decision.
  ⚠ The silent bail on the INVENTORY path is deliberately UNTOUCHED: its own comment states that
  silence is intentional, and making a per-turn hook speak there would turn every adopter without a
  producer into a permanently red gate.

## [0.163.0] - 2026-08-27

### Added

- **Task tracking: closing a card updates its DESCRIPTION, not only a comment.** The rule said
  where detail belongs and never said to refresh the description when the work lands, so the
  stale pre-work claim stayed on the surface every reader — human or tool — sees by default.
  Measured on an adopter's 51-card board: a fidelity check read descriptions, read zero comments,
  and reported three shipped features as never built. The clause also states that any machine-read
  field convention is parsed from the description, so recording it in a comment looks recorded and
  is invisible.

## [0.162.0] - 2026-08-27

### Fixed

- **Worktree preparation told the wrong actor to run the wrong command.** The concurrent-sessions
  rule instructed the SPAWNED AGENT to rebase its isolated worktree. The pilot guard refuses a
  delegate's own rebase, so the brief ordered something the agent could not do — it relayed and
  waited, costing one round trip per delegate before any work started. The SPAWNER now prepares
  the tree, immediately after the spawn call returns.
- **And the operation itself was wrong for a fresh worktree.** A fresh worktree branches off the
  repository's DEFAULT branch, so `git rebase <integration-tip>` replays upstream's own commits
  onto the integration branch and exits 1 with a conflict. `git reset --hard <tip>` is correct
  while the worktree carries no commits of its own. The discriminator is now stated, because the
  correction inverts later in an arc: once the worktree has its own commits, `reset --hard` would
  destroy them.

### Added

- **The delegation ladder now says adoption is a PRECONDITION, not an adjective.** The pilot pair
  ships as unregistered templates — deliberately, since the harness does not honour `observer:` on
  a plugin-registered agent and a registered pilot would run without its watchdog. A project that
  has not adopted them has no `pilot` to spawn, and nothing said so: the spawn failed after a
  complete brief had already been written. Also records that an adoption is picked up within
  minutes, so the "~90 minutes or a restart" caution applies to hand-written definitions only.

## [0.161.1] - 2026-08-20

### Fixed

- **The stop-gate no longer reads a session driving an external lane as "nothing running".** It
  decided whether work was in flight from subagent transcripts alone, so a session whose turn ends
  with a CLI lane writing inside a worktree looked idle — nothing that lane does passes through a
  tool call the session makes. The gate now also counts recent worktree activity, and the negative
  direction is locked too: `node_modules` writes do not count, and a sibling worktree under an
  umbrella root cannot silence a different session.

## [0.161.0] - 2026-08-20

### Fixed

- **The commit-signature check no longer accuses commits the remote already has, and no longer goes
  blind on the ones it adds.** A range like `<remote>/<branch>..HEAD` answers "what would this push
  add" only while the branch is a straight line; merge the default branch in and the range
  legitimately contains that branch's whole history — other people's commits, unsigned, already
  published. On a repository whose default branch is unsigned, the check refused a push by listing
  120 such commits and proposed rebasing them.
- **The exclusion is scoped to the remote being pushed TO, not to every remote-tracking ref.** A
  bare `--not --remotes` over-corrects in the dangerous direction: on a repository carrying 43
  tracking refs — 31 of them leftovers from a deleted remote, 11 from an archive that is never
  pushed, exactly one a push target — it reported ZERO commits on a range that would genuinely add
  62. A guard that falls silent on precisely what it exists to inspect does not degrade, it inverts.
  The remote is derived from the range's left side and validated against `git remote`; when it
  cannot be established, nothing is excluded and the check over-reports, because a noisy guard is
  recoverable and a mute one is not.

### Changed

- **An escalation now names the option it recommends.** `wt-proactive-decision-making` asked for
  every branch to be presented and stopped there — the bare menu, the one message shape that costs
  a reader more than silence, because they must construct the answer rather than validate one. The
  rule now carries both independent axes, in order: is this theirs at all, and only then, did you
  name what you recommend. It also states plainly which of the two can be mechanised and which
  cannot.

## [0.160.0] - 2026-08-10

### Added

- **The memory index probe now shows how many fiches sit behind each index line.** It verified
  REACHABILITY and said so, but nothing showed how much sat behind a single line — a store can pass
  every check while most of its content is, in practice, unknown to any session reading the index.
- The count is **one hop and member-shaped**, deliberately. A transitive count read 138 on nearly
  every line of a 353-fiche store, because fiches cross-reference each other liberally, and a leaf
  and a 44-member hub then printed the same number.
- The count no longer consults the hub CLASSIFICATION either: that ratio answers "do the hub-only
  checks apply", a different question, and gating on it made a genuine three-member hub report zero.

### Fixed

- **An entry the probe could not measure prints as unmeasured, never as `0`.** A missing
  measurement and a genuine zero are different facts, and collapsing them produced the one number a
  reader takes as measured.
- Unreadable fiches are surfaced as an explicit reason instead of being skipped in silence, so a
  partially-read store cannot render as a fully-measured one.

⚠ This is an EXPOSURE, not a guard: a number with no verdict and no threshold. A discoverability
ratio was considered and rejected — its numerator requires reading a sentence, which would put a
model inside a guard. An index line that fronts three fiches but describes them badly is still
invisible; the probe simply no longer implies otherwise.

## [0.159.2] - 2026-08-10

### Fixed

- **`wt-actionable-snapshot-producer-hook.mjs` now records WHY it could not measure.** It has always
  stayed silent rather than guess from a partial read — correct — but that silence was
  indistinguishable from the hook never firing, not being installed, the project having no board, or
  the tool call not being one it watches.
- The three real conditions are now named separately (unreadable payload, unparseable payload, no
  board pointer), because they have three different remedies and one shared message would rebuild
  the defect this closes.
- The record is bounded, and the bound is asserted by a test: a hook that fills a disk over a long
  session is worse than one that says nothing.

⚠ On a board large enough that every read exceeds the tool-result limit, this hook cannot compute a
snapshot at all — measured at 2,957,161 characters with the narrowest possible query, both filters
silently ignored. **This change does not fix that**; it makes it visible instead of silent, so the
frequency can be counted before deciding whether a fallback is worth its cost. No network access
was added.

## [0.159.1] - 2026-08-10

### Changed

- `plugin/bin/wt-observe.mjs` rebuilt. Its sibling-checkout resolution moved out of the launcher
  into a shared module so a second caller could use it instead of copying it — **no behaviour
  change to `wt-observe` itself**, which is why this is a patch and not a minor.

The second caller is a development-only gate that does not ship: this repo's own `pnpm test` now
compiles the private companion app's consuming surface against this working tree, so a widened type
here fails HERE rather than in whichever repo happens to run its gates next.

## [0.159.0] - 2026-08-10

### Added

- **`wt-wake-floor` — a monitor that measures nothing, so nothing can silence it.** It waits, emits
  one line, and waits again. It reads no queue, no cards, no delegates, no transcript, no git state.
- Registered in `plugin/monitors/monitors.json`, so the harness places it at session start like the
  others; it dies with its session and returns with the next one, and nobody has to re-arm it.

### Why a monitor that knows nothing is worth shipping

`wt-autonomy-watch` fires on a conjunction — live mandate, queued work remains, nothing in flight,
idle long enough. The second term reads a queue snapshot. When that snapshot is stale the term is
unverifiable, the conjunction cannot hold, and the watcher stays quiet.

That is correct behaviour, and it is the problem: **a watcher right to stay quiet and a broken one
emit the same nothing.** Worse, the two correlate — an idle session is precisely one that has
stopped refreshing the inputs its own alarm depends on, so the alarm goes blind as a consequence of
the state it exists to report.

Measured on the development machine: a mandated session stopped with 118 open cards and nothing in
flight; the conditional watcher was armed the entire time and never emitted; no turn came back for
**3 h 24**.

So the conditions are kept, but their role changes: `wt-autonomy-watch` stays above this one and
wakes EARLIER when it can see work, carrying the count and the next item. **It refines; it no
longer authorises.**

### Notes for adopters

- ⚠ **Silent unless a project-scoped autonomous mandate is declared** (`wt-autonomy-arm`). Absent,
  malformed or expired mandate: nothing is ever emitted. Ordinary interactive sessions never hear
  from it.
- That mandate gate is the one thing it reads, and it is deliberately **not a measurement of work**:
  it is a declaration of intent, and unlike a queue snapshot it does not go stale as a side effect
  of the session being idle.
- Cadence defaults to 15 minutes; `--poll <seconds>`, or `WT_WAKE_FLOOR_IDLE_MINUTES` at process
  start.
- ⚠ **An empty wake costs a full turn** that re-reads the session's accumulated context. That is the
  price of not being silenceable, and it is the trade this monitor makes on purpose.

### What its message deliberately does NOT claim

```
FLOOR: N minutes elapsed on my interval. I measure only that — not whether you are idle,
and not whether work remains. Check the queue yourself.
```

An earlier draft said "no turn for N minutes". This process cannot know that — it measures its own
cadence — so a session working steadily would have been told it had been idle. The second sentence
exists because an unconditional ping carries no evidence that anything is pending, and without it
the ping gets read as one.

### ⚠ Not established

That the harness arms this monitor at session start. It follows the same manifest path as the four
existing monitors, which are observably placed thirteen seconds into a session — but this one has
not been through a restart yet, and the end-to-end proof (a turn arriving in the exact state that
failed: mandate live, snapshot stale, nothing in flight) is deliberately left open rather than
assumed.

## [0.158.0] - 2026-08-09

### Added

- **`plugin/bin/wt-wake-channel.mjs` plus `plugin/.mcp.json` — a wake channel, so a process
  OUTSIDE a session can hand that session a turn.** Until now nothing could: there is no session
  id to address and no socket to knock on, and the harness wake reaches only the session that
  LOADED the MCP server. So the doorbell has to live inside the house. An observer stays outside,
  drops a file into a spool directory, and this server — loaded by the observed session — turns
  it into a turn.
- The server speaks JSON-RPC 2.0 over stdio **by hand**. It has to: this plugin ships with zero
  third-party dependencies, so the MCP SDK cannot travel. The framing was grounded against the
  SDK already running on the development machine rather than inferred —
  `dist/esm/shared/stdio.js:9-19` splits the read buffer on `\n`,
  `dist/esm/shared/stdio.js:28-30` serialises as `JSON.stringify(message) + '\n'`.
  Newline-delimited, not LSP `Content-Length`.
- Spool location is `WT_WAKE_SPOOL`, else `${XDG_STATE_HOME:-$HOME/.local/state}/wt-wake-channel/inbox`,
  with a `consumed/` subdirectory; poll interval `WT_WAKE_POLL_MS` (default 5000); diagnostics on
  stderr only, and only under `WT_WAKE_DEBUG`.

### Notes for adopters

- ⚠ **This is the first `mcpServers` entry this plugin has ever declared.** Installing the plugin
  now starts one extra Node process per session. It holds no tools, answers `tools/list` with an
  empty list, and emits nothing at all unless something writes into its spool — but it is a new
  process, and that is worth knowing before upgrading.
- ⚠ **It is inert without a host-side opt-in.** The wake requires the plugin to be listed in the
  machine's `allowedChannelPlugins` (a root-owned managed-settings file) *and* named in the
  session's `--channels` tag at launch. Neither is done by installing. Absent them, the server
  loads, answers the protocol, and never wakes anything.
- ⚠ **What is NOT established**: that Claude Code turns this server's notification into a turn.
  The emission is proven at the process level, and the harness path was measured on the
  development machine through a different plugin — evidence about the harness, not about this
  code. Treat the end-to-end wake as unverified until you see it.

### Design choices worth naming, because each one costs something

- **stdout is the protocol**, so nothing else may ever be written there — one stray byte corrupts
  the stream for the whole session. That is also why the executable is excluded from the
  operator-CLI help sweep: even valid help text would break its transport.
- **A broken spool is silent.** A supervision channel that crashes what it supervises is worse
  than one that stays quiet, so every filesystem failure is swallowed. The cost is that a
  misconfigured spool reports nothing; `WT_WAKE_DEBUG` is the way to see it.
- **Move-then-emit.** A crash between the two must not replay a wake — losing one is recoverable,
  repeating one forever is not.
- **Nothing is emitted before `notifications/initialized`**, so a session never gets a spurious
  wake at startup.

## [0.157.0] - 2026-08-08

### Added

- **`wt-lane-consent-gate-hook.mjs` — a `PreToolUse` hook that ENFORCES the executor-lane
  consent switch (`WT_EXECUTOR_LANE_CONSENT`) at the moment a lane call actually runs**,
  closing the gap the card behind this release was opened for: the switch existed
  (`wt-lane-consent.mjs`, read/write) and disagreement between it and the auto-loaded rules was
  already detected at session start (`wt-lane-consent-check-hook.mjs`), but nothing mechanical
  ever consulted it AT CALL TIME — `opencode-verifier` shells out unconditionally, and the
  pilot-wave skill's "check consent first" step is prose a model can silently skip. The new hook
  fires only on a command that actually invokes the lane (`opencode run` / `codex exec`,
  quote/comment-stripped — the same detection `wt-lane-saturation-hook.mjs` already uses) and
  denies it (`permissionDecision:'deny'`) unless the account/project consent chain resolves to
  consented, naming which level refused.
  ⚠ **Fails CLOSED, not open** — the deliberate exception among this directory's guards: every
  other deny-capable hook here fails OPEN on its own internal error (a broken entry path must
  never itself block a command). A consent gate protects the opposite property — an unreadable
  or malformed settings file must never be silently read as "yes" — so both the 'unknown' branch
  of the underlying consent resolution and this hook's own top-level errors resolve to a denial.
  This does not change what any project's rules describe as policy; it makes the existing opt-in
  switch enforceable at the one place it previously had no effect.

### Added

- **`wt-label-intent-producer-hook.mjs` — a `PostToolUse` hook (matching `mcp__planka__get_board`)
  that mechanically runs `toolkit/scripts/label-intent-lens.ts` on a real board read**, instead
  of relying on the `what-next` skill's own "MANDATORY" prose line telling a model to run it.
  Measured, fresh session, 2026-07-27: that line's anti-false-verdict half held (a session
  correctly refused to claim "zero label gap" without having run the lens), but the "run it"
  half did not reliably trigger the actual invocation — a text instruction can refuse a false
  claim, it cannot make an action happen. The hook shells out to a project's own vendored
  `toolkit/node_modules/.bin/tsx` against the real script as a genuine child process, and
  parses ONLY that script's own printed summary line — it never recomputes the check itself,
  never touches a card or a label, and stays silent (no `additionalContext`) on every failure
  direction: no vendored `toolkit/`, no `tsx` binary, a timeout, unparsable output, or a
  genuinely clean board all produce nothing, never a guessed verdict or manufactured noise.
  New pure module `plugin/bin/lib/label-intent-runner.mjs` (locate `tsx` + the script, run it,
  parse its summary) is unit-tested independently of any real child process, plus an
  integration layer spawning the real hook against a fake-but-executable toolkit fixture.
  Registered in `plugin/.claude-plugin/plugin.json`'s `PostToolUse` hooks. Documented in
  `docs/public/known-issues.md` item 11, and in `plugin/skills/what-next/SKILL.md`'s Step 0,
  which now marks its own long-standing reserved caveat CLOSED for `label-intent-lens.ts`
  specifically (the sibling `card-hygiene-lens.ts` remains skill-invoked only, a named open
  follow-up).

## [0.155.0] - 2026-08-08

### Changed

- **`wt-queue-not-empty-gate-hook.mjs` is now REGISTERED as a Stop hook, alongside
  `wt-actionable-gate-hook.mjs` — resolving the register-or-retire decision the previous
  release (`0.154.0`) left open.** A side-by-side comparison of the two hooks' predicates
  refuted the "superseded" claim this file's own header used to carry: `wt-actionable-gate-hook.mjs`
  is Planka-only, only produces its snapshot from specific unfiltered board reads, requires a
  project-local `depends-on-parser.mjs`, and gives up unconditionally after `BLOCK_MAX=3`
  consecutive blocks; `wt-queue-not-empty-gate-hook.mjs` is tracker-agnostic (any adopter can
  wire a marker writer, on any tracker or none), has no give-up cap, and structurally reaches
  cases the registered hook cannot — no tracker wired, a filtered last board read, a missing
  dependency parser, or a registered-hook snapshot stale past its own give-up ceiling. Ground
  truth on this project's own disk state showed the gap open: the registered hook's snapshot
  was ~29 hours stale (past its 2h staleness window and past its 3-block give-up cap) while 58
  tracked items remained open.

  Removed the corresponding entry from `hook-registration-exclusions.mjs` (it named this as
  "NOT a deliberate exclusion — a register-or-retire decision pending", which is now resolved).
  Both hooks can refuse the same stop when both markers exist for a project — deliberate, not
  a bug, and each throttles independently; their emitted messages were already distinguishable
  before this change (`"Actionability gate: …"` vs `"open work remains, nothing running · N
  open …"`), so no message-text change was needed to tell them apart.

  New test asserts the registration directly against `plugin.json`'s `Stop` array, not merely
  the exclusions map shrinking (`hook-registration-coverage.test.ts`); updated the manifest-shape
  assertions in `actionability-gate.test.ts` and flipped `queue-not-empty-gate.test.ts`'s own
  "does NOT register" test to assert registration.

## [0.154.0] - 2026-08-08

### Added

- **A mechanical gate closes the OTHER arrow of hook registration drift: a shipped
  `plugin/bin/*-hook.mjs` script that `plugin.json` never declares.** The existing
  registration-drift checks (`wt-hook-registration-drift-hook.mjs`,
  `plugin-hook-registration-drift.test.ts`) verify that every DECLARED path resolves to a real
  file — that direction fails loudly, at load time. The opposite direction fails silently: a
  file can exist, carry its own tests and documentation, and simply never run, because nothing
  is broken. That is exactly how `wt-lesson-harvest-hook.mjs` shipped unregistered in `0.134.0`
  (fixed in `0.151.0`) and how `wt-lesson-harvest-hook.mjs`'s sibling audit found a second
  instance, `wt-queue-not-empty-gate-hook.mjs`.

  New: `hook-registration-coverage-core.mjs` derives the shipped hook set from the
  `plugin/bin/` directory (never a hand-maintained list) and compares it against the manifest's
  declared set plus a new exclusions map, `hook-registration-exclusions.mjs` — same shape as
  the existing `docs-provenance.ts` decision list, one entry per deliberately-unregistered
  script with its reason. The gate (`hook-registration-coverage.test.ts`) also refuses a STALE
  exclusion (naming a script that no longer ships) and a REDUNDANT one (naming a script that
  IS declared), so the map itself cannot silently drift from what it claims.

  Two entries are excluded today: `wt-adopt-rules-check-hook.mjs` (a deliberate deprecation
  shim, invoked directly by name rather than through the manifest) and
  `wt-queue-not-empty-gate-hook.mjs` (NOT a deliberate exclusion — a register-or-retire
  decision against `wt-actionable-gate-hook.mjs`, a second Stop hook answering an overlapping
  question, left to the maintainer rather than resolved by this gate).

## [0.153.0] - 2026-08-08

### Added

- **Two brief-quality clauses added to `wt-delegation-ladder.md`'s "Briefing an executor"
  section, ported from a private rule after they proved durable and environment-free.**
  The first: quote a task's definition of done as an unedited block in every brief — a brief
  written from the briefer's own reading, rather than the task's text, can invert a closure
  criterion, and the executor has only the brief to obey. The second: an example shown to
  illustrate a register in a brief gets pasted into the delivered artifact verbatim, because
  the executor cannot tell a demonstrated style from real content — show the shape in a form
  that would be wrong to paste instead.

## [0.152.0] - 2026-08-08

### Fixed

- **`wt-lesson-harvest-hook.mjs` is now actually registered as a Stop hook.** It shipped in
  0.134.0 with its own tests, its own crash-safety coverage, and a known-issues.md entry and
  CHANGELOG line both describing it as already firing "at each turn end" — and
  `plugin/.claude-plugin/plugin.json` never listed it under `hooks.Stop`. Nothing in the harness
  invoked it; the file existing and being tested was not the same fact as it being wired, and
  the shipped prose asserted the latter without checking it.

  Caught the same way the card that reported it was framed: `declaredHookPaths()` against the
  real manifest returned no `/bin/wt-lesson-harvest-hook.mjs` entry under `Stop`, for any event.
  A new test in `hook-registration-guards.test.ts` locks it — RED before this fix (asserted the
  entry, got the three unrelated Stop scripts back), GREEN after.

  ⚠ **Two more `*-hook.mjs` files under `plugin/bin/` are unregistered the same way** —
  `wt-adopt-rules-check-hook.mjs` is a deliberate deprecation shim (documented in its own header,
  invoked directly by name for sessions that snapshotted the old path, never through the
  manifest) and is correctly excluded. `wt-queue-not-empty-gate-hook.mjs` is not: it is actively
  maintained, documented in `known-issues.md` as a Stop hook, and absent from `plugin.json`
  exactly like this one was. Left unfixed here — it is a different mechanism from
  `wt-actionable-gate-hook.mjs` (which IS registered and may or may not supersede it), and
  deciding that needs its own card rather than riding this one's fix.

## [0.151.0] - 2026-08-08

### Added

- **Three private-machine guards ported to the shipped set, warn-only, from an inventory
  that first ruled out most private hooks as machine calibrations.** All three read as
  pure prose/shape heuristics with no machine-specific string:
  - `wt-isolated-spawn-report-path-hook.mjs` (PreToolUse on `Agent`) — warns when an
    isolated spawn's brief names an absolute write/report target that is not already
    inside a worktree, so the spawner is told BEFORE the tree gets reaped that the
    delivery will not land where it looks like it should.
  - `wt-pgrep-env-dump-guard-hook.mjs` (PreToolUse on `Bash`) — warns on a full-listing
    `pgrep`/`ps` (`-a`/`-l`/`-af`/`-ef`/`aux`/`-o args=` without a `-p` filter), which can
    dump an entire wrapped shell's exported environment into the transcript. Its flag
    matcher was hardened during the port: the original regex read any hyphenated
    argument word (`pgrep my-pattern`) as if it contained a flag — fixed to require the
    dash be preceded by whitespace or the string start.
  - `wt-propagation-reminder-hook.mjs` (PostToolUse on `Write`/`Edit`/`MultiEdit`) — asks
    the propagation question (who/when/what/shipped-twin) the moment a shipped or
    machine-tooling path is edited; deliberately silent on `<config-dir>/rules/*.md`,
    already covered by `wt-rule-edit-horizon-hook.mjs`.

  All three are journalled via the shared `recordGuardEvent()` and test-locked in BOTH
  directions (fires on the real case, silent on correct work), proven by a mutation in
  each direction on a copy outside the repo.

### Fixed

- **`capability-scout` (a shipped, `whenToUse`-advertised example workflow) failed
  immediately with `agent type 'code-scout' not found`, on both the Workflow tool and a
  minimal single-stage control run.** Its one agentType (`code-scout`) is a hand-authored
  capability-registry stand-in, resolved ONLY by `wt-observe launch` from the sidecar
  `capability-scout.capabilities.json` — the Workflow tool (Path A) has no capability-
  resolution hook, so an adopter following the workflow's own invitation to "launch it"
  through the ordinary Workflow tool met a hard, unexplained failure on first contact with
  the capability-registry example. Its `whenToUse` now states the `wt-observe launch`
  requirement as its first sentence, in REQUIRES language, instead of a plain suggestion.
  The custom agentType itself is kept — it is the point of the example — rather than
  silently swapped for a stock type, which would have removed the very mechanism the
  workflow exists to demonstrate.
- **New mechanical gate,
  `toolkit/packages/build/test/workflow-agent-resolvability.test.ts`**: every workflow
  under `toolkit/examples/*.workflow.ts` (derived from the directory, never a hardcoded
  list) is checked for a literal, hardcoded `agentType` a stock install cannot resolve.
  A workflow may deliberately require one, named in the test's own
  `JUSTIFIED_NONSTOCK_AGENT_TYPES` map with a reason (mirrors the existing
  `guard-journal-family.test.ts` justified-exclusions shape) — but only when its own
  `whenToUse` states the requirement in its first sentence, checked by the same gate. A
  survey of every shipped example confirmed `capability-scout` was the ONLY one hardcoding
  a non-stock agentType with no user opt-in; every other custom-routing knob in this repo
  (`agentTypes.review`, `agentTypes.verify`, `agentTypes.inventory`, …) is optional,
  probe-gated, and falls back to a stock Claude type by construction.

## [0.150.0] - 2026-08-08

### Added

- **`wt-missing-package-script-guard-hook.mjs` — warns when a `pnpm`/`npm run`/`yarn` command
  invokes a script that isn't defined where it will actually run.** In a workspace, running a
  workspace-root gate (`pnpm test`, `pnpm lint`) from inside a sub-package that doesn't define
  that script fails with a package-manager error and a non-zero exit — and that failure reads,
  most often right after a merge, as a real regression rather than the wrong-directory mistake
  it actually is.

  It tracks `cd`/`&&` chains across the command instead of reading the Bash tool's own reported
  cwd once, so `cd toolkit && pnpm test` resolves against `toolkit`. This tracking exists
  because an earlier, untracked version of this guard (in a private precursor) warned on that
  exact correct command within minutes of shipping — the dominant real shape, missed by a
  verification set written alongside the code it was verifying. Ships **warn-only**: it never
  refuses a command, only names the script, the directory that doesn't define it, and — when an
  ancestor package.json does — where to run it from instead.

  See `docs/public/known-issues.md` for the full contract, including what it deliberately does
  not cover.

## [0.149.0] - 2026-08-08

### Fixed

- **`--help` and `-h` now work on every operator-facing `wt-*` CLI in `plugin/bin/`, instead
  of being refused as an unknown flag.** Eighteen binaries — `wt-arc-watch.mjs`,
  `wt-autonomy-arm.mjs`, `wt-autonomy-watch.mjs`, `wt-check-commit-signatures.mjs`,
  `wt-check-observer-pairing.mjs`, `wt-command-repeat-check.mjs`, `wt-guard-journal-scan.mjs`,
  `wt-lane-activity.mjs`, `wt-lane-consent-check.mjs`, `wt-lane-probe.mjs`,
  `wt-memory-index-check.mjs`, `wt-pilot-card-reconcile.mjs`, `wt-push-scope-check.mjs`,
  `wt-quota-watch.mjs`, `wt-run-gate.mjs`, `wt-spawn-registry-scan.mjs`,
  `wt-stale-date-guard.mjs`, `wt-verdict-cap-check.mjs` — used to exit non-zero on `--help`,
  the same as any typo'd flag; a script probing one of them for availability would read that as
  "broken". They now print their own usage (most of it already existed as a header comment
  nobody saw) and exit 0, while an actually-unknown flag still refuses with a non-zero exit —
  the parser was not made permissive to get there. `wt-debug.mjs`, `wt-observe.mjs`,
  `wt-lane-consent.mjs`, `wt-lane-postdiff-check.mjs`, and `wt-service-watch.mjs` already
  behaved this way and needed no change. `wt-quota-probe.mjs` is the one deliberate exclusion —
  it takes no arguments at all. A new gate, `cli-help.test.ts`, globs `plugin/bin/*.mjs` (minus
  hooks and a named-and-justified exclusion list) so a CLI added later ships this by
  construction, not by remembering to add it.

## [0.148.0] - 2026-08-08

### Fixed

- **`wt-autonomy-arm.mjs --status` no longer says `armed` about a mandate the watcher has
  already refused to fire on.** 0.147.0 keyed the mandate marker on the project so a restart
  can inherit it, but shipped the freshness check TWICE — once in the watcher's own poll and
  banner, once in `--status`'s own report. They drifted immediately: given the same 9-hour-old
  marker at the same instant, the watcher correctly printed `mandate=stale(540min) · CANNOT
  FIRE`, while `--status` still printed `AUTONOMY MANDATE: armed`, because it only ever checked
  whether the file existed, never its age. A person asking "do I still have a mandate?" got a
  confident, wrong answer at the one moment they thought to check. Both readouts now call one
  shared classifier (`plugin/bin/lib/autonomy-mandate.mjs`), so there is no second copy left to
  disagree. `--status` reports exactly one of three states, each with its own exit code: `0`
  armed and live, `3` present but **expired** — past the freshness window, will not fire, named
  with its age and told to re-arm — and `1` no marker at all. `3` is new and distinct from `1`
  on purpose: "no mandate" and "a mandate that will not fire" are different facts a caller may
  need to branch on differently.

## [0.147.0] - 2026-08-08

### Fixed

- **A restart no longer kills your autonomy mandate.** `wt-autonomy-arm.mjs` used to key its
  marker on `CLAUDE_CODE_SESSION_ID` — a restart mints a new session id, so the marker the old
  session wrote became permanently unreachable, and `wt-autonomy-watch.mjs` read
  `mandate=absent` for a session that still believed it held one. Silent, and it never
  recovered on its own; the reported case was three restarts in one day, each one needing a
  manual re-arm nobody remembered to do. The marker is now keyed on the **project**, not the
  session: a restarted session inherits whatever mandate is still fresh for that project, with
  no gesture required. Inheritance is bounded by an 8-hour freshness window
  (`WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES`), read from the marker's own timestamp rather
  than its file mtime, so a mandate declared this afternoon does not still count tonight — and
  when a session picks up a mandate it did not itself declare, the wake and the arming banner
  both say so explicitly (`mandate=present(inherited)`, `inherited from session <id>, mandate
  declared NNmin ago`), rather than waking anyone silently. `wt-autonomy-arm.mjs` gained a
  `--project <dir>` option (defaults to `cwd`) to target a project explicitly.

## [0.146.0] - 2026-08-08

### Fixed

- **A STALE span could look complete while quietly skipping most of what actually shipped —
  the span now says so.** 0.145.0's changelog span (below) guarded only the file's own
  boundary: whether the installed version predated the OLDEST heading in the whole file. That
  misses the sharper case: this repo's own changelog has a real, permanent gap INSIDE its
  recorded span, not only at its edge — 61 of the minor versions between 0.68 and 0.144 never
  got a `## [x.y.z]` heading (a mechanical gate now forces every new release to carry one, but
  history is what it is). Measured: a stale copy at v0.70.0 got a confident, well-formatted
  17-entry span presented as the record for a range that actually spans roughly 75 versions of
  movement — a partial span dressed as a complete one, which is worse than an empty span
  because it doesn't even look suspicious. Every recorded span now reports its own coverage,
  computed only from the two requested versions — never from the file's oldest or newest
  heading, which is exactly the comparison that missed this: `COVERAGE: complete` when every
  version between them has an entry, `COVERAGE: INCOMPLETE — approx. N version(s) … have NO
  changelog entry at all` when some don't, `null` when the two versions don't share a major
  (the arithmetic doesn't apply across a major bump, and this reports "cannot determine" rather
  than guess).

## [0.145.0] - 2026-08-08

### Added

- **A session on a project with a STALE adopted rule now sees what it actually missed, not
  just that it missed something.** `adopt --check` used to report `STALE (installed v0.112.0
  < v0.125.2)` and stop there — a version number moved, nothing said what changed, and a
  session with no way to weigh the delta rationally ignores it, which is how a stale copy
  stays stale. It now prints the real `plugin/CHANGELOG.md` entries for that exact span,
  newest first, so a session reading "0.127.0 ships an always-on autonomy watcher" can decide
  for itself: *I have a hand-rolled equivalent at project level — I can adopt this and delete
  mine.* Capped at 10 entries with an explicit omitted-count on a very large span, so the
  section stays readable without ever dropping a count silently. Report-only: it never writes
  or acts, and every other `--check`/`--install` status (ABSENT, UP-TO-DATE, EDITED, …) is
  unchanged. Pure logic lives in `plugin/skills/adopt/scripts/changelog-span.mjs`, with a
  byte-identical inlined copy in `install.mjs` itself (which must stay a single relocatable
  script — its own tests copy it alone into a synthetic plugin root) kept honest by a
  drift-lock test rather than an import.

## [0.144.0] - 2026-08-07

### Added

- `wt-lane-activity.mjs`: a read-only sibling to `wt-lane-probe.mjs` that answers "what is
  this GPT lane actually DOING", not just "is something running on it". `wt-lane-probe.mjs`
  proves WHERE a lane is running (cwd attribution); this reads the two sources it never
  touches — the opencode CLI's own log (names the current sub-task from the latest matching
  line) and its local SQLite session store, opened read-only (running token total + model).
  A stall verdict is emitted only when the process is alive AND both sources independently
  agree nothing moved for the stall window; either source being unreadable, or the two
  disagreeing, reports `unknown` rather than guessing — a single-source stall check inverts
  instead of degrading (measured on a live lane: the store's newest row said `finish:stop`
  26 minutes earlier while the process had been alive 29 and the log showed live sub-agent
  activity — database alone would have called it stuck, elapsed time alone would have called
  it healthy). Every field is a measurement or an explicit `unavailable`/`unknown` reason,
  never a zero standing in for "could not read". Data-dir resolution is Linux-only by
  default (XDG data dir) — macOS/Windows report `dataDirSupported:false` explicitly rather
  than a guessed path; `--data-dir`/`OPENCODE_DATA_DIR` overrides it. `node:sqlite` (Node
  ≥22.5) degrades to a stated `storeReadable:false` reason on this plugin's Node ≥20 floor,
  never a crash. Pilot orchestrator docs (`plugin/agent-templates/pilot-orchestrator.md`)
  point operators to it right after `wt-lane-probe.mjs`.

## [0.143.0] - 2026-08-07

### Added

- `wt-guard-recurrence-hook.mjs`: a SessionStart surface that turns the guard journal's
  recorded firing COUNT into something a session meets unasked. `wt-guard-journal-scan.mjs`
  could already answer "has this guard recurred", but nothing invoked it — a counter nobody
  reads is not a trigger. This hook reuses the scan CLI's parser (now extracted to
  `plugin/bin/lib/guard-journal-read.mjs`, shared by both readers) and speaks only when the
  same guard's firings for the same "reason" (its own `class`, or one shared `(unclassed)`
  bucket per guard) cross the durable-fix rule's own threshold — more than twice in one week.
  It names the count and the guard, never an instruction to reflect, carries the journal's own
  two bounds every time it speaks (event count ≠ confirmed-defect count; only guards wired to
  the journal are counted), and is silent on the common path and on any read failure (missing
  or unreadable journal directory, malformed line, unrecognised record shape) — never an error.

## [0.142.0] - 2026-08-07

### Changed

- `wt-durable-fix-at-the-right-level`: the "mechanise on sight" trigger is now a COUNT, not a
  judgement. The former test — *could a hook/gate/test/check make this impossible to repeat?* —
  was evaluated mid-task by whoever had just worked around the problem, which is the same
  unenforceable shape the ladder forbids in an escalation clause. It now reads: the same guard
  firing for the same reason more than twice in one week means mechanise what it guards, or fix
  the guard.
- The rule now states its own bound explicitly: a count covers RECIDIVISM only, and the first
  occurrence of a class is invisible to it.

## [0.141.1] - 2026-08-07

### Fixed

- **The guard journal shipped in 0.141.0 was polluting its own test suite's real journal.**
  17 of the 19 `toolkit/packages/build/test/*.test.ts` files that spawn a real
  `plugin/bin/*guard*.mjs` process never redirected `WT_GUARD_JOURNAL_DIR`, so every
  `pnpm test` run wrote real records into the operator's own
  `~/.local/state/wt-guard-journal/` (measured: 670 junk records, in bursts of 64, from one
  run). Fixed with two layers rather than 17 edits: a vitest `setupFiles` module
  (`toolkit/test-support/guard-journal-isolation.setup.ts`) makes the redirect the DEFAULT
  for every test worker, so every existing call site that inherits `process.env` (the
  pattern all of them use) is fixed without being touched; a `globalSetup` module
  (`toolkit/test-support/guard-journal-isolation.global-setup.ts`) snapshots the real
  journal directory before and after the whole run and fails the suite loudly if it
  changed, so a future test that bypasses the redirect (e.g. constructs its own `env: {}`)
  cannot silently reintroduce the leak. A full `pnpm test` run now leaves the real journal
  location byte-for-byte unchanged (verified: identical file list and MD5 before/after).


### Added

- **A shared, durable guard-refusal/warning journal, and its read CLI.** Sixteen of the
  eighteen `plugin/bin/*guard*.mjs` guards now call one shared helper,
  `plugin/bin/lib/guard-journal.mjs`, the moment they decide to block or warn — an
  append-only NDJSON line per event, rotated one file per ISO-8601 week under
  `~/.local/state/wt-guard-journal/`. The insight "this recurring defect deserves a
  mechanism" is a judgement call and cannot itself be mechanised; repetition can — this
  turns "I think this happened before" into a number a new read CLI,
  `wt-guard-journal-scan.mjs`, can print per guard for the current week. The write is
  fail-open by construction (same posture as `writeFailOpenTrace()`): every failure mode
  is swallowed inside `recordGuardEvent()`, proven by a test that points the journal at an
  uncreatable directory and asserts the guard's own decision output is unchanged. Two
  files are deliberately not wired — `wt-outbound-guard-hook.mjs` (its own durable
  registry answers a different question) and `wt-stale-date-guard.mjs` (a report CLI, not
  a hook) — named with reasons in a family test that globs `plugin/bin/*guard*.mjs` itself,
  so a future guard shipped without instrumentation fails the suite rather than going
  unnoticed.

### Added

- **Three shell-trap guards ported from private machine-local hooks into the shipped
  plugin, all PreToolUse on Bash, all warn-only.** Every one of these is a property of a
  common shell/tool combination, not of any one machine — every adopter meets it
  unguarded.

  - **`wt-pipestatus-bash-only-guard-hook.mjs`** — warns on a bare `PIPESTATUS` reference:
    bash-only, expands EMPTY with no error under zsh (a piped gate's exit code then reads
    as nothing). Measured against 163 distinct real commands referencing `PIPESTATUS`
    across every session transcript on this machine: 163/163 fired. The guard cannot
    distinguish a genuine reference from prose merely discussing the trap, the same known
    false-positive family as the sibling guards here — ships warn-only.
  - **`wt-find-newermt-format-guard-hook.mjs`** — warns when a `find … -newermt <arg>`
    argument is not ISO-8601: some `find` builds accept only ISO-8601 there, reject a
    natural-language date on stderr, and a swallowed/piped stderr then reads as "no recent
    files" instead of "the date format was rejected". Measured against 555 distinct real
    `find … -newermt` commands: 256 fired, dominated by genuine natural-language/relative
    forms plus a residual class of bare shell-variable arguments the guard cannot evaluate
    — an intentionally conservative posture. Ships warn-only.
  - **`wt-git-commit-backtick-guard-hook.mjs`** — warns on an unescaped backtick inside a
    double-quoted `git commit`/`tag`/`notes` `-m`/`--message` argument: inside double
    quotes a backtick pair IS command substitution, silently splicing empty output into
    the stored message with no error. Measured against 466 distinct real candidates: a
    first pass without heredoc-awareness fired on 16/466, and reading all 16 showed 12
    were the `-m "$(cat <<'EOF' … EOF)"` heredoc-in-command-substitution form — this
    project's own dominant commit convention, where the backtick sits inside a
    quoted-delimiter heredoc body the shell never expands (75% false-positive rate on the
    fired set). Fixed by stripping heredoc bodies before matching, the same technique
    `wt-unquoted-tool-glob-guard-hook.mjs` already uses; re-measured: 4/4 fired, all 4
    genuine, 0 false positives. Ships warn-only (4 true positives over 466 candidates is
    real signal, far short of the scale this repo requires before a guard denies).

  All three registered in `plugin/.claude-plugin/plugin.json`, documented under "Shipped
  Hooks, Guards & Monitors" in `docs/public/known-issues.md`, mapped in
  `toolkit/examples/docs-provenance.ts` (both the shipped-hooks doc-surface entry and the
  per-script mapped list), and covered by a synthetic crash-safety payload each in
  `plugin-hook-crash-safety.test.ts`.

## [0.139.0] - 2026-08-07

### Added

- **`wt-main-guard-hook.mjs` — guards the MAIN session against a set of irreversible Bash
  actions, mirroring `wt-pilot-guard-hook.mjs` for the one actor that guard deliberately
  no-ops on.** `wt-pilot-guard-hook.mjs` guards every subagent but skips any call with no
  `agent_id`, i.e. the main session itself — on the theory that the main session is the
  arbiter that already holds the gate. That was aspirational, not mechanical: nothing
  actually executed when the main session ran `npm publish`, a force-push, a remote branch
  deletion, or a catastrophic `rm -rf` — only prose rules did.

  **Posture is a measured split, not one verdict for the whole guard.** Four classes ship
  blocking (`permissionDecision: 'deny'`): publish, force-push, remote branch deletion, and
  `rm -rf` on the filesystem root or the home directory. Measured against 2,788 distinct real
  Bash commands drawn from every session transcript on this machine: publish 16/16, force-push
  13/13, remote branch deletion 4/4 — 0 false positives across all three; root/home `rm -rf` had
  zero occurrences in the sample and stays blocking structurally (no legitimate use exists).

  Two classes matched the same trigger shapes and measured the opposite way, so they ship
  journal-only instead (allowed, logged, never denied): `rm -rf` on a git repository root was
  10/10 false positives — every match was a disposable clone or a worktree purge about to be
  recreated; `rm -rf` on an unresolvable target (`"$VAR"`, a glob) was 319 candidates, sampled
  and found to be `rm -rf "$VAR"` where `$VAR` was bound earlier in the same multi-line command
  to a scratch path this segment-local classifier cannot see. Both stay detected and journaled
  to `~/.local/state/wt-main-guard/journal.jsonl`, so the gap is visible rather than silent.

  A `git merge` integrating a branch INTO `main`/`master` while on `main`/`master` — the
  opposite direction from what the pilot guard blocks — is journal-only by design, legitimate
  for the arbiter, recorded for traceability. Denials carry a one-time, file-based escape hatch
  (`~/.local/state/wt-main-guard/allow-once.json`, byte-exact match, single-use). See
  `docs/public/known-issues.md` for the full per-class breakdown.

## [0.138.0] - 2026-08-07

### Added

- **`wt-merge-chain-guard-hook.mjs` — warns when a `git merge` is chained with what verifies it.**
  A merge can do nothing — `Already up to date` when run from the wrong tree, or an abort — and the
  commands after it then run on the **unmerged** tree and return 0. Three gates green, three honest
  exit codes, certifying a subject nobody intended to certify.

  ⚠ The exit code cannot detect this, and that is the point: it belonged to the gate, the gate
  genuinely passed, and it answered a question about the wrong **subject**.

  A shipped rule already stated the invariant. Adopters have had that rule for weeks with nothing
  enforcing it — this is the rung below a rule, and the reason the hook exists.

  **Warn-only, and measurement is why rather than caution.** 1,140 real `git merge` commands were
  replayed from every session transcript on this machine — 21,503 files, 172,497 Bash calls scanned
  — against the guard's own executable. 376 matched, and the large majority are the *safe* pattern:
  capture the merge's own exit code or log, then inspect it. A literal "anything after a merge"
  predicate cannot tell that apart from the blind chain, so it stays far short of the 197/0 bar the
  sibling glob guard cleared before earning a deny.

  That replay also found a defect reading had not: a bare word boundary after `merge` matched
  `git merge-base`, `merge-tree` and `merge-file`. It was present in a version that looked correct
  on inspection.

  ⚠ **It covers the CHAINED shape only.** A merge run from the wrong tree — the variant that
  actually recurred four times the day this shipped — is a sibling defect this does not catch, and
  its silence there must not be read as coverage.

## [0.137.0] - 2026-08-07

### Added

- **`wt-var-colon-modifier-guard-hook.mjs` — warns when a colon follows an unbraced parameter
  name.** In zsh that starts a *modifier*, not concatenation: `git show "$s:src/file.ts"` fails with
  `bad substitution`, and the empty result reads as "not found" rather than as an error. Other
  letters mutate the value silently instead of erroring.

  **Two measurements ship in its header, not one**, because the first is what makes the second
  credible. Over 125 distinct commands from real history, each fed to the guard's own executable: an
  ad-hoc 34-letter set gave 22 warnings of which 6 were genuine — **27% precision**. Narrowed to the
  13 letters `man zshexpn` documents, warnings fell to 6, **all 6 genuine**.

  ⚠ **Warn-only despite 100% on that sample**, and the reason ships with it: narrowing raised
  precision without raising recall. An unrecognised letter after the colon does not reliably fall
  back to literal — zsh's parser can skip it and try the next character — and it cannot see inside a
  command substitution. The blocking bar here is the sibling glob guard's 197/0 over 82,015
  commands; this does not clear it and does not pretend to.

  Its exclusions came from measurement rather than design: quoted-delimiter heredocs and
  single-quoted spans — including ones containing nested double quotes, found in a real PowerShell
  invocation — were producing false positives on commit messages that merely *described* the trap.
  An unquoted heredoc delimiter does expand and is still matched; a test pins that, because
  inverting it would silence the guard on a real case.

## [0.136.0] - 2026-08-07

### Fixed

- **The memory-index probe now names what it did NOT verify, on the green path too.** It reported
  `0 unreachable, 0 dangling`, and a session read that as *"the index is fine"*. That is not what
  was checked.

  **Reachable** answers *does a path exist from the index to this fact*. The question that decides
  recall is *would a session know to take that path*. Those are different, and the gap is invisible
  from the probe's side — it prints healthy on precisely the defect it appears to cover. A real
  store sat at two index lines with zero unreachable, green on every run, while one of those lines
  fronted a 103 KB note covering fifteen subjects and naming three of them.

  The probe now states on every run, clean ones included, that it verified reachability and the
  size ceilings and did **not** verify discoverability. On the green path specifically: a bound
  named only in the failure branch is a bound nobody reads, and the whole defect is that a clean
  run reads as full coverage.

  ⚠ **No new metric, and that is a measured decision rather than a scope cut.** All 13 hubs in this
  project's own store under-describe their contents, 6% to 57%, none above 60%. A check firing on
  13 of 13 flags nothing — it is noise that gets switched off and takes any real case with it. The
  condition is normal, not exceptional, which is what makes the honest-wording fix the right one.

  Reported by a session on another project whose store passed both checks continuously while being
  unusable. Worth noting which instrument caught it: the fidelity-checker's routing test, which runs
  only when spawned. The probe, which runs on a hook continuously, is the one with the blind spot.

## [0.135.0] - 2026-08-07

### Added

- **`wt-unquoted-tool-glob-guard-hook.mjs` — ships BLOCKING, which no other new guard does, because
  this one was measured first.** In zsh an unquoted glob passed as a *tool option value* fails two
  ways and **both look like a clean result**: with no match zsh aborts the command before any
  redirection, so nothing runs and the empty output reads as "no hits" or "the feature is absent";
  with a match it expands against the current directory, so `--include=*.ts` silently becomes
  `--include=app.ts` and the search covers one file instead of a tree.

  The failure does not look like a failure. It looks like a finding.

  Measured on material it did not choose: 5,193 session transcripts, 82,015 Bash commands, 206
  distinct after dedup, each fed to the guard's own executable as a real PreToolUse payload —
  **197 true positives, 0 false positives**, 9 correct silences from its heredoc and prose
  exclusions. Those figures are in the file's header so the next reader inherits the evidence
  rather than the conclusion.

  What makes blocking safe is the narrowness of the population, and it is checkable in two regexes:
  only `--include`/`--exclude`/`--include-dir`/`--exclude-dir` and
  `-name`/`-iname`/`-path`/`-ipath`/`-wholename`. An ordinary argument glob (`ls *.ts`,
  `for f in *.md`) cannot match either — and that form is normally correct, so flagging it is
  exactly the false-positive class that gets a guard switched off.

  ⚠ Its non-coverage ships with it, so its silence is not read as coverage: a bare unquoted glob as
  an ordinary argument is deliberately not flagged, and it says nothing about the sibling zsh traps
  — unquoted word-splitting, or `$var:path` read as a parameter modifier.

  Filed as a ticket by a session on another project, which also ran the measurement and rejected the
  tempting shell-level alternative: `unsetopt nomatch` closes the abort half and leaves the
  expansion half, turning a loud failure into a silent wrong answer.

## [0.134.0] - 2026-08-07

### Added

- **`wt-lesson-harvest-hook.mjs` — the lesson harvest now fires by itself.** The extraction already
  shipped as a skill, and a rule already named the script and said when to run it. Neither fired:
  measured here, **0 skill invocations out of 37** came from description matching alone, and the
  rule that names the script records its own failure rate — eight reports carrying three to six
  lessons each, three harvested by hand, the rest never read again.

  Improving the description could not have fixed that: description matching is probabilistic and
  its non-firing is silent, so a better description raises a probability rather than creating a
  trigger. Naming it in a rule had already been tried — that is rung two, auto-loaded and still
  skippable. This is the first rung: something that executes.

  What makes it hook-shaped rather than another instruction is that its trigger needs no judgment —
  a report file exists and is newer than the last run.

  ⚠ **It only surfaces.** It never writes to a knowledge base; that stays with the single session
  integrating the card, which is the constraint the extractor was built around. It names report
  paths and counts rather than lesson text, because a Stop hook's output reaches the human too.

  ⚠ **Honest scope, and the uncovered half is the larger one**: this covers lessons that reached a
  REPORT. A correction arriving mid-conversation has none, and three of the most useful facts of one
  measured night belonged to no card at all.

## [0.133.0] - 2026-08-07

### Fixed

- **The watchdog templates pointed at a file only the maintainer's machine has.** Both instructed
  the observer to read `~/.claude/rules/delegation-lanes.md`, which no adopter possesses. It
  INVERTED rather than failed: the clause exists because observers once flagged a legitimate direct
  CLI invocation by citing a stale paraphrase instead of the live rule, so the fix was "read the
  source, never quote it". For an adopter the pointer resolved to nothing, so the instruction did
  nothing and the observer fell back on the paraphrase — exactly the failure it was written to
  prevent. It worked here, which is why nobody saw it.

  They now point at `wt-delegation-ladder.md`, which adopters receive and which already carries the
  same distinction as its fourth prohibition — including the half that matters most: a direct
  invocation is not the prohibited shape, because invocation is its own provenance. One source of
  truth, one pointer change. The remaining `DD/MM` provenance stamps went in the same pass.

  The durable half is a check refusing any shipped agent template that references a home-anchored
  path, proven RED by adding one. Detection was never the problem — the pointer was plainly
  visible to anyone reading the file — so the fix that matters is the one that fires with nobody
  looking.

## [0.132.0] - 2026-08-07

### Added

- **`wt-autonomy-arm.mjs` — the mandate the autonomy watcher refuses to run without can now be
  declared with a shipped command.** Until now the watcher could name what was missing and no
  adopter had any way to supply it: `mandate=absent` with nothing in the plugin able to write that
  marker. A diagnosis with no remedy.

  Run it to arm, `--disarm` to withdraw, `--status` to report. The exit code carries the verdict so
  a caller need not parse prose. It refuses to guess a session id rather than write a marker
  nothing will ever read.

  ⚠ **It is deliberately not a hook.** A hook stamping the marker at session start would declare a
  mandate for every session whether or not anyone wanted one, reintroducing exactly the noise the
  watcher's gate exists to prevent. Declaring a mandate is an act; this is the act. The marker is
  per session and does not survive a restart — stated rather than worked around, because a mandate
  silently inherited by a later session could keep waking somebody after the intent behind it had
  expired.

### Changed

- **The autonomy watcher's banner now names what supplies each missing precondition**, not just
  which one is missing: the arming command for an absent mandate, the queue-snapshot hook for an
  absent or stale snapshot. Naming the gap without naming its remedy moves a reader from "I cannot
  tell whether this works" to "I know it is broken and not what to do" — better, and still short of
  actionable.

  Raised by a session on another project, which read the 0.130.0 banner, went looking for the tool
  that would arm it, and found none.

## [0.131.0] - 2026-08-07

### Changed

- **The four pilot agent definitions are rewritten in a telegraphic register — 11% smaller, with
  every content unit accounted for.** These files are read by an agent under pressure that must act
  correctly on the first read, so the gain came from STRUCTURE, not from shortening words: prose
  describing a set of cases and their outcomes became tables, state-transition explanations became
  imperative sequences, and duplicated incident explanations collapsed into one causal chain.

  The largest single reduction, `pilot-watchdog.md` at 51%, is one prose list of tells becoming a
  seven-row evidence table. Its warning markers, headings and list items are unchanged in number,
  and the wrapper-versus-direct-invocation nuance survives intact, including the clause that tells
  an observer to stay silent when its digest cannot distinguish the two.

  ⚠ **Abbreviation was tried and rejected.** An intermediate attempt reached 5% by substituting
  symbols for words (`+`, `w/`, `w/o`). That buys bytes by making each sentence slower to parse,
  which is the opposite of what these files are for.

  Four content locks in the test suite — assertions that a specific normative clause is still
  present and still says what it said — caught an earlier attempt that had rephrased them. They are
  the reason this rewrite can be trusted to have preserved meaning rather than merely counted units.

## [0.130.0] - 2026-08-07

### Fixed

- **`autonomy-watch` now says whether it can actually fire.** It had the exact defect it exists to
  remove elsewhere: an unarmed watcher and a watcher with nothing to report produced the identical
  observation — nothing. A session could not tell "running and quiet because all is well" from
  "running and structurally unable to ever fire here", and the second is the common case: the
  monitor needs a mandate marker the session must write and a queue snapshot the stop gate must
  have written, and both are absent by default.

  It now writes one line at arming, on the same stream as its wakes, naming the idle threshold, the
  poll interval, and the LIVE state of both preconditions — plus `CANNOT FIRE` when either is
  missing. The line prints in every session including ordinary interactive ones with no mandate,
  which is deliberate: `mandate=absent` is precisely the reading worth seeing, and a banner
  suppressed in that case would be silent in the only situation it exists for.

  `absent`, `unreadable` and `stale` are reported as three distinct states rather than collapsed,
  because they call for three different actions — write a snapshot, fix a malformed one, refresh an
  old one. Freshness is read from the snapshot's own `at` field, the same way the polling code reads
  it, never from file mtime: a banner that judged freshness differently from the code it describes
  would announce `fresh` about a snapshot the watcher itself treats as stale, and a banner that lies
  about why the watcher is quiet is worse than no banner.

  Reported by a session on another project, which went looking for the monitor on disk, found it
  running, and could not determine from any output whether it had ever been able to do anything.

## [0.129.0] - 2026-08-07

### Added

- **`adopt --set autonomy` — a project can now adopt an autonomy mandate the same way it adopts
  the rules.** The new `plugin/autonomy/AUTONOMY.md` is a project-agnostic template: it names no
  tracker product, no board, no path and no per-machine quirk, and where a project must supply its
  own facts — what may leave the machine, which branch is protected — it asks for them by name
  rather than assuming any one setup's.

  Its purpose is structural rather than documentary. An autonomy mandate written into a `/loop`
  prompt is authored once and is stale within the hour; written into a FILE the wake re-reads, the
  instruction that matters most — re-arm the wakeup as the last action of the turn — is read at the
  moment it must be executed. The adopted copy carries the same versioned banner and content
  fingerprint as the rules set, so a stale copy is detectable after a plugin bump and a locally
  edited one is never overwritten without `--force`.

### Changed

- **The adopt engine derives its set list instead of repeating it.** `--set all`, the unknown-set
  error, the `--dir` rejection and the "these other sets exist too" advisory all read from the
  `SETS` map, so a future set needs none of those five edits. The advisory in particular was
  written for exactly two sets and would have been wrong in every branch with three; it now names
  the untouched sets with correct grammar for one, two or more.

  `renderItem`'s banner choice is inverted rather than extended — plain-markdown prepend is now the
  default any new kind receives, instead of silently falling into the frontmatter-aware path meant
  for agent definitions. Behaviour for the `rules` and `agents` sets is unchanged.

## [0.128.0] - 2026-08-07

### Fixed

- **The delegated-arc watcher now says WHOSE delegate it is alarming about.** Two of its sweeps
  had different scopes and only one was project-scoped: transcript staleness reads this project's
  sessions, while the liveness sweeps read `~/.local/state/wt-liveness`, which every project on
  the machine shares. A session was therefore woken by a `WAITING-ON-SPAWNER` line for a delegate
  belonging to a different project, with nothing in the line to say so and nothing it could do
  about it. Emissions now carry `(foreign to this project)` when the record's agent id is not
  among the watcher's own transcripts, and `(project unknown)` for a record that declares no
  correlation key at all — those being different states, not two shades of one.

  It **labels rather than filters**, deliberately: `lib/liveness.mjs` must never suppress a real
  stall because a side input could not be checked, and liveness records carry no project field,
  so a filter would silently drop exactly the records that lack one. The emission count is
  unchanged and a test asserts it, so the label can never quietly become a filter.

  The identifier set is derived only when the transcript baseline is replaced, never per poll —
  measured at ~710 ms for 1606 transcript metadata parses on a real project, which a 60-second
  poll loop would otherwise pay to recompute an identical answer.

## [0.67.0] - 2026-08-03

### Added

- **`wt-lane-probe.mjs` — verify that a delegate's work is really being routed to its executor
  lane WHILE it runs, instead of asking the delegate afterwards.** It reads the working directory
  of each live lane process and matches it against the worktrees of the delegates currently
  running. A statement in a report is the testimony of the party under check; a live process's
  cwd is an execution trace that party does not write. Keep BOTH: they fail differently — an
  in-flight sweep sees nothing if it lands between two invocations, a report-time check sees
  nothing if the report is wrong. The orchestrator definition calls it and archives the result.
  ⚠ A cwd proves work is happening in a tree; it does **not** prove the delegate that owns the
  tree is alive — a dead delegate leaves its lane running.

- **`lesson-harvest` skill — find a closure report's own lessons section, mechanically.** Every
  delegate closure report already carries one; nobody was harvesting them. Measured on one
  night's eight reports: **3 to 6 reusable lessons each**, of which three were harvested by hand.
  ⚠ It DETECTS and EXTRACTS; it never writes to a knowledge base — that stays with whatever
  single writer owns it. And it distinguishes "no section at all" (a malformed report — read it
  yourself) from "the section says none" (a decided, empty value): a silence is not a declared
  absence.

- **`stale-card-sweep` skill + `toolkit/scripts/stale-card-sweep.ts` — the ADD-side symmetric of
  the reversal sweep.** When something is REMOVED, sweeping what still cites it is already
  standard practice. When something is ADDED, nothing sweeps what still ASKED for it — so a
  tracked item stays open after a sibling's implementation already covered it, and someone
  redoes the work. Measured cost of its absence, on the night it was built: a delegate spawned
  on an already-shipped item, returning an empty branch.
  ⚠ Two staged layers, deliberately: the mechanical one shortlists by the closing diff's changed
  files (words fail — the same idea gets written five different ways and a keyword search returns
  a zero that reads as "does not exist"); the judgment layer decides. **Below ~200 open items the
  tool tells you to read them all instead** — reading everything cannot miss a reformulation, a
  filter can. The filter is a degradation accepted for volume, never an improvement.

### Changed

- **`wt-delegation-ladder.md` gains three harness facts that were nowhere in the shipped set**,
  each of which produces a silent false negative — you conclude a delegate is dead when it is not.
  The addressing contract (short name is the normal route and keeps working after completion; the
  raw id is the fallback); **a resumed delegate is invisible in the interactive agent list**,
  which is what makes the failure expensive; and **a delegate's transcript is a different file
  from the session's own** — a freshness watcher armed on the session file measures the SESSION's
  writes, so it reports "active" for as long as the session keeps talking. It can never fire, and
  its silence is indistinguishable from a healthy delegate. Plus the naming/observer trade-off
  stated as a three-way choice rather than a prescription.

- **`wt-checkpoint-and-compaction.md`: a resource limit is a door, not a loss.** Do not stop
  early to avoid being cut off — with durable state an interrupted arc resumes, while budget left
  unspent inside a window is gone. The tell is a sentence forming in your own reasoning ("I won't
  start anything else, there's only N% left"), and the question at that moment is not "can I
  finish?" but "is there budget left to spend?". Stated for the single-account case explicitly,
  because that is the objection that would make an adopter dismiss it: what makes the cut harmless
  is the durability of the work, never a spare budget.

## [0.66.0] - 2026-08-02

### Added

- **`wt-stale-date-guard.mjs` — flags an operational deadline in markdown prose once it has
  passed, without flagging the far more common dated FACT that never expires.** The motivating
  case: a rule carried "the next usable account is <date>" for four days past that date, read as
  current the whole time, because a rule file is a snapshot with no expiry mechanism — a past
  date reads exactly like a future one.
  The hard part is not the arithmetic, it is the classification: on one real 27-file corpus, **54
  of 54** dates were provenance ("measured on …", "(name, DD/MM)"). A guard that cannot tell them
  apart emits 54 false alarms on its first run and gets disabled within the week. Three keyword
  tiers, checked in priority order — **acknowledged-past** ("l'échéance est passée", "no longer",
  "discontinued") wins over **deadline** ("jusqu'au", "valid until") wins over **provenance** —
  with the window bounded to the sentence rather than a flat character radius. A date matching
  none of the three is reported as UNKNOWN, never silently dropped and never silently treated as
  a deadline.
  ⚠ **Honest scope:** zero unknowns on the corpus it was tuned against is not evidence of
  generalisation, and one provenance marker was added narrowly to close the last case on that
  corpus. On prose it has not seen, UNKNOWN is the intended output, not a metric to drive to
  zero. Standalone CLI — not wired into any hook or CI.

- **A mechanical guard against private tracker identifiers on the shipped surface.** It walks
  `plugin/`, `docs/public/` and the README on every run rather than checking a list of known
  files, so a file nobody thought of is covered by construction.

### Fixed

- **40 private tracker identifiers removed from the shipped surface**, replaced by what they
  referred to rather than deleted — provenance mentions went UP (542 → 551), which is the control
  separating a rewrite from an erasure. A reader outside the machine that hosts the board could
  not resolve `card #<id>`; it was a bare identifier with no referent. Three of the forty lived in
  byte-identity-mirrored artifacts and were fixed at their true source, not in the copies.

## [0.65.0] - 2026-08-02

### Fixed

- **`wt-arc-watch` no longer reports a cleanly-finished agent as stale.** Its "has this agent
  stopped?" check anchored on the transcript's last record, but a PAIRED observer (the
  `observer:` watchdog) writes its own `{type:"observer-ref"}` heartbeats into that same
  transcript file, on its own polling cadence. Those records carry no `uuid`, `parentUuid`,
  `role` or `message` — they are not part of the turn chain at all — yet they moved the anchor
  forward by up to 46 seconds, pushing a genuine stop record outside the acceptance window.
  Measured across one session's 105 stop-matched agents: **all 51** whose naive gap fell in the
  5.89s–46.3s band had an `observer-ref` as their literal last line, and **all 51** fell back
  inside the existing 1000 ms tolerance once those are excluded. Zero exceptions.
  ⚠ **The tolerance constant is unchanged, deliberately.** Re-deriving a larger one would have
  spanned the same 1–46 s range and silently masked genuine mid-turn deaths, with no way left to
  tell the two apart — the failure this module's own header warns against. The anchor now takes
  the **maximum over non-observer-ref records** rather than walking back from the end, so an
  interleaved heartbeat cannot hide a genuinely later turn either.
  ⚠ **Known scope:** locked by tests against real captured record shapes and proven red before
  green, but **not yet observed in production** — the running watcher is the previously published
  build. The both-directions check after adoption: a cleanly-finished agent must stop producing
  `STALE`, and an agent that died mid-turn must still produce it.

- **`--audit-overlap` names the direction of every divergence.** A `DRIFT` line used to read
  `(missing)` without saying which side it was missing FROM, leaving the reader to supply the
  half that decides what to do. Each per-line entry now reads `(missing from shipped template)`
  or `(missing from project copy)`, and the summary adds a direction breakdown alongside the
  existing `drift` count. Verdicts and exit codes are byte-identical to the previous build on the
  same input — only what the audit SAYS changed, never what it decides.

## [0.64.0] - 2026-08-02

### Added

- **`wt-check-observer-pairing.mjs` accepts `--agent-id`** and correlates by the raw agent id
  first, falling back to `--name` only when no id is given. `--name` is now optional. This
  closes the coverage limitation disclosed in 0.63.0: an **anonymously spawned** agent has no
  name to match on, and anonymous is precisely the mode a lane-delegating agent must use —
  harness-managed `isolation` deletes a worktree whose agent has yielded to an external
  executor, so that agent's tree is empty at the exact moment the reaper looks at it. Every
  verdict now carries a `matchedBy` field (`id` or `name`) so a reader can see what the result
  rests on rather than inferring it.

### Fixed

- **The pairing check no longer returns `unknown` for the majority of real spawns.** It gated
  its mtime-correlation branch on `taskKind === 'async'`, a value the harness does not appear
  to write: across every `.meta.json` on one machine (1687 files), 546 carried
  `in_process_teammate`, **zero** carried `async`, and the remaining 1141 carried no `taskKind`
  at all. An absent `taskKind` is now treated as the async-shaped case, while the literal
  `'async'` keeps working for fixtures and any future explicit writer.
- **A private tracker card id no longer appears in the shipped `pilot-orchestrator`
  definition.** The surrounding claim is unchanged — it now states the measurement rather than
  citing an identifier an adopter cannot resolve. ⚠ **Known and not fixed here:** other shipped
  files still carry such identifiers as provenance markers; replacing them with their substance,
  behind a mechanical guard over the whole shipped surface, is tracked separately.

## [0.63.0] - 2026-08-02

### Added

- **`wave-fidelity-checker` — an end-of-arc agent that reads a wave report and checks its
  claims against the primary sources**, refute-first, reporting CONFIRMED / REFUTED /
  UNVERIFIABLE per claim. Ships with `plugin/bin/wt-check-observer-pairing.mjs`, which reads
  the harness's own `.meta.json` (`isObserver`) rather than transcript content.
  ⚠ **Two limitations, both known and neither fixed in this release.** The pairing check
  hard-requires a `--name` and therefore cannot verify an agent spawned **anonymously** — which
  is the mode a lane-delegating agent must use, since harness-managed `isolation` deletes a
  worktree whose agent has yielded to an external executor. And the checker has been exercised
  on exactly **one** real report: a verifier observed only passing is indistinguishable from one
  that always passes. It did flag two underspecified claims and an unfilled placeholder on that
  run, which is the only evidence so far that it discriminates at all.

### Fixed

- **A cleanly-finished agent is no longer reported as stuck forever.** The spawn registry
  correlated a `spawn` record to its `stop` record **by name only** — but the two ends do not
  always use the same name: a spawn made with an explicit `name:` and an ordinary
  `subagent_type` records the NAME on the spawn and the TYPE on the stop
  (`{"child":"aa877…","name":"s-fence-125"}` versus
  `{"agentId":"aa877…","name":"general-purpose"}`). The raw agent id is identical on both
  sides and was not being used, so the entry never closed and only a manual `--ack` could
  clear it. Fixed by correlating on the raw `agentId` first, with name/type as fallback.
  Measured across 422 spawn records in 20 journals: 272 already matched by id, **149 were
  name-correlation misses**, and exactly one was a genuine unrecorded death.
- **The arc watcher no longer treats "silent" as "dead".** It fired on every normally-finished
  agent. It now corroborates a stale transcript against the outbound-guard journal before
  alerting, and — the part that matters — only accepts a `stop` record that can account for the
  CURRENT silence: a single agent writes one stop record **per turn boundary**, not one per
  lifetime, so an old clean stop from an earlier turn proves nothing about a later silence. The
  backward tolerance (1 s) is derived from the measured distribution rather than chosen: 45 real
  negative samples, one at −0.021 s, then an empty 5.87 s gap, then 44 from −5.894 s down. It is
  a separator between two observed populations, not a safety margin — if the gap closes it must
  be re-derived, never widened.
- **A card whose pilot dies before its intake is no longer invisible.** New
  `plugin/bin/wt-pilot-card-reconcile.mjs` compares claimed cards against live pilots.
- **`adopt`'s `install.mjs`: a flag with no effect in the current mode is now
  REFUSED, not silently ignored.** `--user-dir` was parsed and stored in every mode but only
  ever read inside `--audit-overlap` — under `--check`/`--install` it did nothing, and the
  target silently fell back to `--dir`/cwd. A near-miss: a session ran `--check --user-dir
  <adopted path>` from the `workflow-toolbox` checkout, got a confident "all agents ABSENT"
  for a directory nobody adopts into, and the tool's own closing line invited `--install` —
  which would have written agent files into the public repo. Fixed with a mode → flag table
  checked once after parsing: any flag whose stored value differs from its default but isn't
  read by the resolved mode fails fast, naming the flag, the mode, and (for `--user-dir`) the
  correct `--dir` alternative. The sweep also catches the same asymmetry on `--dir`,
  `--global`, `--force`, and `--replace-symlinks` under `--audit-overlap`, where none of them
  were read either.
- **A gate's reported exit code can no longer be a wrapper's, not the gate's own.** A task
  notification once reported `exit 0` for a batch where `pnpm typecheck` had actually failed
  with `exit 2` — the code read back was a chained wrapper's trailing `echo`, not the gate.
  Added `plugin/bin/wt-run-gate.mjs`: runs exactly one command with no shell (nothing for a
  later command to chain onto), writes its real exit code to a file of its own the instant the
  process returns, and — given `--fail-pattern` — cross-checks that code against the captured
  log so a 0-but-the-log-shows-an-error mismatch is reported as INCONSISTENT and forced
  non-zero rather than trusted. `wt-verify-by-ground-truth.md` and the pilot agent template
  both now state the corollary explicitly: the code you read must belong to the gate, never to
  something that ran after it, and a second signal (the tool's own summary/failure count)
  should be read beside it.

### Documentation

- **Known issue #9**: the spawn-registry heartbeat's repeated `Stop` block on an unacknowledged
  open+silent+stale entry (one block per fresh turn, not one-and-done) is now written down as an
  intentional design choice, with the way out (`--ack <name>`) — see `docs/public/known-issues.md`.

## [0.47.0] - 2026-07-27

### Added

- **Registry heartbeat (`wt-registry-heartbeat-hook.mjs`, on `Stop`)** — the spawn-registry
  scan is now invoked periodically with nothing to arm. `Stop` fires at the end of every turn
  for the whole life of a session, so no cron, timer, or remembered `/loop` is involved. On a
  hit it BLOCKS the stop, handing the finding to something that can ACT rather than to a log
  file nobody opens. Fails OPEN on every error path (bad stdin, missing/timed-out scan), and a
  re-entered stop (`stop_hook_active`) informs without ever blocking twice — a guard able to
  hang a session shut would be a worse defect than the silence it watches for. Thresholds are
  env-overridable (`WT_REGISTRY_HEARTBEAT_QUIET_MIN`,
  `WT_REGISTRY_HEARTBEAT_STALE_TRANSCRIPT_MIN`).
- The scan now names what UNTRACKABLE spawns were doing (type, model, purpose) instead of
  printing a bare count — a number without its set cannot tell a reader whether the lost
  tracking matters. Retroactive: the fields were already on disk.
- Spawn records carry `effortRequested` (deliberately not `effort`: the `Agent` tool exposes no
  such parameter today, so it is `null` everywhere and fills itself in if one appears, with no
  code change). Its value is that "pin model AND effort at every spawn" stops being an
  unverifiable instruction — a null in the registry is now mechanical evidence it was skipped.

### Fixed

- **Silence alone was the wrong liveness model.** The first cut blocked on message-silence, which
  in this system describes the NOMINAL population: a pilot reading code or running a suite says
  nothing for half an hour. A guard that fires on healthy agents is switched off within days and
  is then mute when it matters. Flagging now additionally requires the agent's own transcript to
  have stopped growing (`--stale-transcript-min`, decoupled from the message threshold). An agent
  silent but still writing is reported as `confirmedAlive` and never blocks. The converse is
  deliberately NOT claimed: a frozen transcript is not proof of death (an agent awaiting a
  background executor writes nothing), so the finding stays a question.
- Unnamed spawns no longer fabricate a correlatable name from the raw child id. The child reports
  itself under its TYPE, so the fabricated name could never match — leaving every anonymous spawn
  an open "ghost" forever (observed: an agent finished 9h earlier reported as silent for 551
  minutes). Trackability is now decided from the EXPLICIT spawn name, on the read side too, so
  registries already written with the old format are handled without a migration.

## [0.46.0] - 2026-07-27

### Removed

- **BREAKING — the `workflow-toolbox:pilot` / `workflow-toolbox:pilot-orchestrator` agent
  types no longer exist.** The pilot suite now ships as unregistered templates under
  `plugin/agent-templates/` and reaches a session only as an adopted project copy under its
  bare name (`pilot`, `pilot-orchestrator`), installed by `adopt --set agents --install`.
  Reason: Claude Code silently ignores the `observer:` frontmatter on a plugin-REGISTERED
  agent, so a namespaced pilot spawned fine and ran with NO watchdog attached and no warning
  anywhere. Telling users to prefer the bare name was not enough — a guarantee that depends on
  typing the right name at every spawn is not a guarantee. Removing the type removes the
  unwatched path instead of deprecating it. **Adoption is now a prerequisite: without it there
  is no pilot to spawn at all.** The other shipped agents (`leaf`, `lean`, `opencode-verifier`,
  `fidelity-checker`, `index-groomer`) are unaffected — they declare no observer, so plugin
  registration serves them correctly, and workflow routing to `workflow-toolbox:leaf` /
  `workflow-toolbox:lean` is unchanged.

### Added

- `adopt`: `--global` targets the config directory, resolving `CLAUDE_CONFIG_DIR`
  itself (falling back to `~/.claude` only when unset) instead of requiring the caller to
  build that path and pass it via `--dir`. A hand-built `~/.claude` is correct on a default
  machine and silently wrong on one running a second config profile, where the report then
  describes a directory nobody meant. Composes with `--set all`; mutually exclusive with
  `--dir`.

### Changed

- `adopt`: `STALE` now tracks CONTENT, not the version number. Previously every
  release marked every adopted copy stale, including copies byte-identical to the shipped
  file — so a release touching one skill's prose made a dozen untouched rules announce
  themselves as out of date. A warning that cries wolf on each release is not read on the
  release that matters. `AHEAD` is still reported first and is never short-circuited by
  matching content: a copy claiming a version the plugin does not have is an install
  anomaly, which identical text does not explain away.

## [0.45.1] - 2026-07-26

### Fixed

- `adopt`: the skill described the bundled rules as already injected ambiently by the
  `SessionStart` hook, presenting adoption as the "persistent, editable alternative". That
  reading is wrong and consequential — a plugin's `rules/` directory is inert, and the hook
  emits only a six-line digest of the delegation ladder. Every other bundled rule reaches a
  session ONLY once adopted. The skill now states plainly that adopting is what puts the
  rules in force, not merely what makes them editable.
- `adopt`: `--check` on a directory whose entries are symlinks (a supported setup —
  two config dirs sharing one rule set) reported `nothing to do.`, which reads as "up to
  date". A symlinked entry is never compared for staleness and a later `--install` there
  silently refreshes nothing. The advisory now names where the managed copies actually live
  and how to refresh them.

## [0.44.2] - 2026-07-26

### Added

- `pilot-orchestrator`: a mechanical CLOSE-OUT gate on declaring a tier/mission COMPLETE,
  separate from the ordinary per-card re-scan — fixes the observed failure where an
  orchestrator counted its cards once at intake, created cards of its own mid-wave, then
  stopped on that stale initial count while dozens of cards remained open. The gate:
  (1) re-query the tracker live by CRITERIA (labels + lists), never from a list held in
  memory — a criteria query catches what was born since intake, a remembered id list
  cannot, by construction; (2) two staggered live re-queries separated by a NAMED,
  overridable interval (`STOP_GATE_INTERVAL_MIN`, default 10 minutes) — declare COMPLETE
  only if both come back empty; (3) fail-closed on the gate itself — a failed query, an
  unparseable read, or a surprising count means NOT complete; (4) the orchestrator's own
  self-created/absorbed cards are explicitly IN the set the gate re-queries, whatever the
  mission's original shape; (5) the stop announcement must state both probes' timestamps,
  criteria, and counts — "the board is empty" alone is not an acceptable closing statement.
  Applied identically to the plugin source, the `launch-agents` byte-identical mirror, and
  the adopted project copy (which additionally keeps its approved `model: opus` override).

## [0.44.1] - 2026-07-26

### Added

- `pilot-orchestrator-watchdog`: a new, short observer definition paired with
  `pilot-orchestrator` via `observer:` — tells scoped to the ARBITER's own duties
  (under-specified brief, arbitration on a pilot's summary instead of the real artefact,
  integration credited without a re-gate read, a number reported without its set, an
  escalation omitted on a named trigger), never the sibling pilot watchdog's TDD/gate/diff
  tells. Declared, with the pairing's actual mechanism stated in the file: the SPAWN MODE
  governs attach (a named/`in_process_teammate` spawn never attaches; an async/anonymous
  spawn — including one launched by `main` via the Agent tool, which is how
  `pilot-orchestrator` is normally launched — attaches reliably), not the launcher identity
  as an earlier hypothesis had it. Direct confirmation for the orchestrator role specifically
  does not exist yet (no orchestrator relaunched since the declaration was added), and the
  file says so at that exact scope.
- `pilot-orchestrator` now declares, at its Report step, a duty to invoke an independent
  end-of-arc fidelity check on its own wave report against the real board+repo state before
  filing it — the check agent itself is not built here (no general-purpose wave-report
  checker exists yet; tracked as a separate follow-up card) and the report must say plainly
  when the check was not performed rather than silently skip it.

## [0.44.0] - 2026-07-25

### Added

- `adopt --audit-overlap --set agents`: a coherence gate for adopted pilot-suite
  project copies. Compares BOTH directions (an added/changed line, and a shipped line
  silently DELETED from the project copy) so a copy cannot go CLEAN by dropping a
  safety clause instead of contradicting it; scoped to `agents` only (`rules` copies
  stay additions-only, per their own "editable copy" contract). ABSENT-copy and
  unapproved-drift both fail; an approved per-pair `model:` override line does not.

### Changed

- `pilot-orchestrator` now runs a mission-driven wave loop: a fail-closed stop test
  that treats `Blocked` as still-OPEN (never conflating a stalled, human-decision-
  pending tier with a genuinely COMPLETE one — reported via the existing
  `partial(<done>/<blocked ids>, <why>)` exit), Blocked-and-continue handling for
  human-decision cards (never ends the mission while another in-scope card remains),
  and per-selection reporting.
- `pilot` now treats heavy increments without a consented executor lane as a split:
  the arbiter stays on design/plan/arbitration and spawns a cheaper executor, never
  self-implementing on its own tier.
- `pilot-wave` now resolves `EXECUTOR_LANE` by both bridge availability and explicit
  `WT_EXECUTOR_LANE_CONSENT`; availability alone no longer authorizes the lane.

## [0.42.0] - 2026-07-22

### Added

- This changelog, backfilled from 0.41.0.
- Coverage-audit documentation pass over the shipped skills: `workflow-composer`'s
  references now document `scaffoldWorkflow`/`ScaffoldSpec`/`ScaffoldStep` (programmatic
  scaffolding), `parseDigest`'s tolerant-parsing contract plus the `LOOP_STAGE`/
  `isLoopIterLabel` loop-attribution markers, and the `BundleResult`/
  `BundlePipelineResult` return shapes of the programmatic build entry points;
  `upgrade-canary` documents `resumePrompt` (the resume counterpart to
  `launchPrompt`).

## [0.41.1] - 2026-07-21

### Added

- `adopt` skill: an opt-in installer that writes editable, versioned, fingerprinted
  copies of the cross-cutting delegation rules and the pilot agent definitions into a
  project, and can later detect and refresh stale copies against the plugin's shipped
  originals.
- `opencode-verifier` agent: a schema-relay mode for schema-bearing roles, so a role that
  expects structured output can route through the cross-family verifier without losing
  its schema contract.

### Fixed

- The pilot suite's review-response hardening: a plugin-level, self-scoped `PreToolUse`
  guard hook denies the pilot suite's reflex destructive Bash commands (an unnamed-remote
  `git push`, a force/delete/mirror push, a package-publish command, a broad process
  kill) while no-opping for the main session and every other agent; untrusted-input
  boundary prose was added to the pilot/orchestrator/pilot-wave docs (cards, comments,
  subordinate reports, and executor-lane output are DATA, never obeyed as instructions);
  `pilot-watchdog`'s tool allowlist is fenced to its read-only contract; the
  cross-family-bridge probe now also scans common rc-file install directories, not PATH
  alone.
- `adopt --install` no longer overwrites a user's own edits to an adopted copy (a
  content-fingerprint check, with `--force` to override deliberately); the fingerprint's
  known blind spot (an edit glued directly onto the banner line) is documented.
- A pilot spawned from a plugin install now resolves its **project-local** copy correctly
  when one has been adopted (workaround composability with `adopt`), and the
  observer-pairing limitation for plugin-installed (non-adopted) pilots is documented.
- `pilot-watchdog`'s capability fence keeps the `ObserverReport` channel open (an earlier
  fence had closed it).
- `pilot-wave` now **proposes** the watchdog-enabling project copy to the user rather than
  instructing them to install it themselves.
- The delegated-run settle-watch contract (the spawner-side half — how a spawning session
  detects and reconciles a pilot/orchestrator run that settled while unattended) is
  documented in the `pilot-wave` skill.

## [0.41.0] - 2026-07-20

### Added

- The delegated dev-loop agent suite, shipped generalized for end users: `pilot`,
  `pilot-orchestrator`, and `pilot-watchdog` agent definitions (the pilot always travels
  paired with its `pilot-watchdog` observer), plus the `pilot-wave` composer skill that
  resolves the environment brief (knowledge-base index, task tracker, executor-lane
  probe, worktree/report directories, quota posture) and composes the
  orchestrator/pilot spawn prompt with explicit model elevation.
- Four rule-cores ported inline into the shipped agent definitions: step-back-to-the-
  shared-root plus a Rule-of-Three duplication survey and ground-the-premise discipline
  (`pilot`); the proportionate verification ladder (`pilot` + `pilot-orchestrator`); two
  concurrent-worktree gotchas (`pilot`); and a fire-only-when-it-pays plus
  pre-commit-prediction discipline for the workflow-composer premise-quality reference.
- A conditional `SessionStart` hook that injects a generic, cost-model-neutral delegation
  ladder — calibrated to the host machine (it probes `PATH` for cross-family bridges) —
  as a silent no-op where no tracked/delegated-work markers are present, and fail-safe
  silent on malformed or cwd-less hook input.

Earlier releases predate this changelog.
