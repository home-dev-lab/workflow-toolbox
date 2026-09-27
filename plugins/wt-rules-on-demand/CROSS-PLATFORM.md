# Portability inventory

Verdicts here are **read from source** for Windows and macOS; the Node tests and
CLI checks were **run on Linux only**. Line numbers refer to the shipped files.
“Unknown” means a diagnostic or failed report, rather than a clean verdict.

| File:line | Dependency | Failure behavior |
| --- | --- | --- |
| `paths.js:3-21` | `/`-joined rule directories and `HOME`, then `USERPROFILE` fallback | Missing both homes returns null; callers report **unknown**. Windows Node accepts `/` as a separator; drive roots are retained. |
| `hooks/hooks.js:29-66` | Host `$.fs.list/read` instead of Node filesystem; directory entries and names | Missing directory is empty; malformed files log **unknown/skipped**, never served. Static duplicates are blocked, including `wt/`. |
| `hooks/hooks.js:106-115` | Host store get/set, text encoder, archive keys | Verdict-store errors are logged as **unknown**; delivery still returns. Journal write failures are also logged. No project file write. |
| `hooks/hooks.json:1-17` | Host plugin loader expands `CLAUDE_PLUGIN_ROOT`; command hook runs `node` on PATH | Missing Node or unexpanded plugin root **throws** at host launch; no rule is served by that command. |
| `hooks/bash-mention.js:1` | Shell-token parsing, no child process | Conservative masking of read-only mentions; unsupported syntax may **silently** miss a trigger. |
| `hooks/runtime-rule.js:72` | Regular-expression parser, no host OS API | Invalid keys and expressions **throw** and skip rule with log. |
| `hooks/act-checks.js:19-23` | Fixed shell-command vocabulary, no shell execution | Unknown build tools **silently** return no applicable act. |
| `hooks/session-start.mjs:1-8,17-32` | Node `fs`, `path`, URL, config-home fallback | Missing scope reads empty; absent home gives named **unknown**. Runtime enabled option in command hook is supplied via `CLAUDE_PLUGIN_OPTION_ENABLED=true`. |
| `hooks/session-start.mjs:33-68` | Atomic report rename, `wx` stamp; detached `spawn`, process `unref`, watchdog | Spawn failures publish named **failed** report; watchdog kills after 300 seconds (the private real-data run read 512 transcripts in 18.8 seconds); platform-specific detached-process behavior is untested outside Linux. |
| `scripts/quality-watchdog.mjs`, `scripts/kill-worker.mjs` | PID probe, process-group kill signal, polling, atomic report | Timeout or leader exit kills the detached worker's entire process group using negative PID on POSIX; on Windows (or where groups are unavailable) falls back to the worker PID. Failed or timed-out child records **failed**. A recycled PID may delay status until timeout. |
| `scripts/rule-lifecycle-lib.mjs:1-27` | `realpath`, symlink-aware containment, native path separators | Unresolvable parent or unsafe rules location **throws**. |
| `scripts/rule-lifecycle-lib.mjs` | `realpath`, relative symlinks, `readlink`, `symlink`, best-effort lock file created with `wx`, same-directory temporary file and atomic hard `link` publish | Run `migrate`, `revert`, `retire` single-writer per scope; do not run them concurrently on the same scope. The lock catches common accidental overlap but does not guarantee exclusivity across processes or hosts. Mirror permission failures **throw** named mirror path and roll back writes. NTFS supports hard links; FAT/exFAT and some network shares do not. On `EPERM`/`ENOTSUP`/`EXDEV`, exclusive `open(destination, 'wx')` + write + fsync refuses an existing destination. Symlink privilege varies by Windows account. |
| `scripts/rules.mjs:1-8,67-85` | `fs` streams, symlink `stat`, home resolution | Dangling transcript links are named **skipped/unknown**, not silently discarded. |
| `scripts/replay-transcript.mjs:1` | Node filesystem streams | Missing input **throws**; no external binary. |
| `scripts/transcript-verdicts.mjs:1-35` | `git` through `execFile`, `realpath`, native `path.delimiter` config profiles | Git missing or failing is a named coverage **unknown**; no history falls back to ledger. |
| `scripts/transcript-verdicts.mjs:48-69,309-338` | Transcript symlinks and native path components | Read/stat failure is coverage **unknown**; project root inference compares basename component rather than `/` suffix. |
| `scripts/rollback-check.mjs:1-44` | Native path resolution, store file discovery | Missing rules directory or store **throws**; missing store with supplied transcript verdicts reports **unknown** on stderr. |
| `scripts/compliance-report.mjs:1-32` | Node filesystem, config home | Missing store **throws**; no project writes. |
| `scripts/quality-check.mjs:1-58` | `spawnSync` of Node rollback CLI, `realpath`, atomic rename, data directory | Child nonzero or zero transcripts writes **failed**, not clean. Daily path always includes `--dry-run`. |

Node CLIs use native `node:path` for disk paths. The Function Hooks module and
every transitive import avoid Node builtins, using host capabilities instead.
On POSIX a relative `~` is not shell-expanded by Node: home comes from `HOME`
or `USERPROFILE`; no script interprets a literal tilde path.

Additional dependencies: the rollback summary uses Node `crypto` SHA-256 over
the physical project path to keep separate scope filenames; Node provides it on
Windows and macOS as on Linux. Startup compares rule directories with `realpath`
before reporting unchecked scopes, accommodating macOS path aliases and Windows
short names. The proof CLI uses `stat` (which follows directory links on all three
platforms) to reject a missing transcripts directory. Verdict summaries split
both Windows and POSIX path separators to retain only the file basename.
