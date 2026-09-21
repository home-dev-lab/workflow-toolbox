# Cross-platform verdict

This verdict covers `src/detect.js`. Linux behavior was run in this worktree; macOS and Windows behavior was source-reviewed with injected platform tests because this machine is Linux.

| System dependency | Linux | macOS | Windows |
| --- | --- | --- | --- |
| `HOME` / `USERPROFILE` / `HOMEDRIVE` + `HOMEPATH` | THROW: no. NAMED UNKNOWN: `mirror.available: false` names `HOME` when absent. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no. NAMED UNKNOWN: `mirror.available: false` names `HOME` when absent. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: `mirror.available: false` names all consulted variables when absent. SILENT PLAUSIBLE VALUE: no. Source-reviewed and injection-tested, not run on Windows. |
| `PATH` | THROW: no. NAMED UNKNOWN: `opencode.available: false` names missing `PATH` or an unsuccessful search; split on `:`. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no. NAMED UNKNOWN: `opencode.available: false` names missing `PATH` or an unsuccessful search; split on `:`. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: `opencode.available: false` names missing `PATH` or an unsuccessful search; split on `;`. SILENT PLAUSIBLE VALUE: no. Source-reviewed and injection-tested, not run on Windows. |
| `PATHEXT` | THROW: no. NAMED UNKNOWN: not consulted. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no. NAMED UNKNOWN: not consulted. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: an unsuccessful extension search returns `opencode.available: false`; absent `PATHEXT` uses the Windows default `.COM;.EXE;.BAT;.CMD`. SILENT PLAUSIBLE VALUE: no. Source-reviewed and injection-tested, not run on Windows. |
| Path separator | THROW: no. NAMED UNKNOWN: none; `/` is selected explicitly. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no. NAMED UNKNOWN: none; `/` is selected explicitly. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: none; `\\` is selected explicitly and either trailing slash is accepted. SILENT PLAUSIBLE VALUE: no. Source-reviewed and injection-tested, not run on Windows. |
| `X_OK` executable mode | THROW: no; access errors are caught. NAMED UNKNOWN: failed access returns `opencode.available: false`. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no; access errors are caught. NAMED UNKNOWN: failed access returns `opencode.available: false`. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: none from `X_OK`; it is deliberately not requested because Windows does not implement that measurement. SILENT PLAUSIBLE VALUE: no; existence plus regular-file type is reported. Source-reviewed and injection-tested, not run on Windows. |
| `.claude-code-docs` mirror directory and manifest | THROW: no under Node's filesystem probes; missing, wrong-type, or unreadable paths return a named `mirror.available: false` reason. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no under Node's filesystem probes; missing, wrong-type, or unreadable paths return a named `mirror.available: false` reason. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no under Node's filesystem probes; missing, wrong-type, or unreadable paths return a named `mirror.available: false` reason. SILENT PLAUSIBLE VALUE: no. Source-reviewed and injection-tested, not run on Windows. |
| `BRAVE_API_KEY` / `BRAVE_SEARCH_API_KEY` | THROW: no. NAMED UNKNOWN: `brave.available: false` names both variables when absent. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no. NAMED UNKNOWN: `brave.available: false` names both variables when absent. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: `brave.available: false` names both variables when absent. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on Windows. |
| `EXA_API_KEY` | THROW: no. NAMED UNKNOWN: `exa.available: false` names the variable when absent. SILENT PLAUSIBLE VALUE: no. Linux-run. | THROW: no. NAMED UNKNOWN: `exa.available: false` names the variable when absent. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on macOS. | THROW: no. NAMED UNKNOWN: `exa.available: false` names the variable when absent. SILENT PLAUSIBLE VALUE: no. Source-reviewed, not run on Windows. |

## The hook twin — `hooks/hooks.js`

A hooks module has no Node, so the hook cannot import `src/detect.js`: it carries its own detection
against the engine's `$.fs` and `$.env` (`providersFor` and `remoteProviders`, `hooks/hooks.js`).
That copy reads `HOME`, then `USERPROFILE`, then `HOMEDRIVE` plus `HOMEPATH`. It selects `\\` for a
drive-letter or UNC home and `/` otherwise.

| dependency, in the HOOK's own detector | Windows |
| --- | --- |
| the home directory | THROW: no. NAMED UNKNOWN: absence names `HOME`, `USERPROFILE`, and `HOMEDRIVE` plus `HOMEPATH`. SILENT PLAUSIBLE VALUE: no. Source-reviewed and injection-tested, not run on Windows. |
| the mirror path | A drive-letter or UNC home is joined with `\\`. The engine's `$.fs` behavior on Windows was source-reviewed and injected, never run on Windows. |

The hook uses the engine's filesystem only to probe and read these paths. That filesystem behavior
has not been executed on Windows, so this is a source-reviewed verdict rather than a runtime claim.
