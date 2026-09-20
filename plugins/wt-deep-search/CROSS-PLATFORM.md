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

## The twin this verdict does NOT cover — `hooks/hooks.js`

A hooks module has no Node, so the hook cannot import `src/detect.js`: it carries its own detection
against the engine's `$.fs` and `$.env` (`providersFor` and `remoteProviders`, `hooks/hooks.js`).
That copy still reads `HOME` alone and still joins with `/`.

| dependency, in the HOOK's own detector | Windows |
| --- | --- |
| the home directory | SILENTLY RETURNS A PLAUSIBLE VALUE: with `HOME` unset it reports the mirror as not installed, which reads exactly like an honest "you have not installed it" |
| the mirror path | source-reviewed only; whether the engine's `$.fs` accepts a forward-slash path on Windows is NOT established here |

⚠ **This is the dangerous third case, and it is stated rather than left to be discovered.** On a
Windows machine with the mirror installed, the fast rung can report it absent and every question
descends to the rung below — a degradation nobody sees, because every lower rung answers correctly.
The two API keys and the fall-through are unaffected: no key is ever required, and a Windows
adopter's searches still work.

Carried on the card as its own item; fixing it needs the engine's behaviour on Windows read rather
than assumed.
