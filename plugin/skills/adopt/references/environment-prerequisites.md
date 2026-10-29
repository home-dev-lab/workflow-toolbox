## Account-level environment prerequisites

`adopt` also checks the active config profile's `settings.json` `env` block and, on
`--install`, adds ONLY the plugin prerequisites whose keys are ABSENT there:

- `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` — required for the pilot/orchestrator/executor chain.
  Without it, the remote spawn-depth ceiling can drop below the three nested levels the suite
  uses, and the executor lane can die silently.
- `CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS` — required ONLY when adopting the pilot agents
  set. Without it, Claude Code silently ignores an adopted pilot's `observer:` field, so the
  watchdog never attaches.

Safety contract for settings writes:

- `--check` names missing keys by NAME only. It never prints env values.
- A present key is left intact even when it differs from the managed default.
- The tool writes only the active `CLAUDE_CONFIG_DIR` profile's `settings.json`; if the user
  keeps several profiles, tell them to rerun under each one.
- Before writing an existing settings file, the tool creates a backup, then re-reads the file
  and verifies that no root key or pre-existing env key was lost.
- Traceability is out-of-band: the tool records only the keys it inserted in a profile-local
  sidecar under the `workflow-toolbox/` subdir, because `settings.json` itself must stay strict
  JSON with no banner.
