# Source registry

The registry is a JSON array. Each entry has:

```json
{
  "family": "tickets",
  "query": "mcp__jira__search*",
  "holds": "Decisions and delivery status recorded in tickets.",
  "applies_when": "ticket|status|decided",
  "stale_after_days": 3
}
```

`family`, `query`, `holds`, and `stale_after_days` are required. `applies_when` is an
optional case-insensitive regular expression over the current prompt. `query` is either an
MCP tool-name glob or a shell command template containing `{{query}}`.

Registries merge by `family` in this order:

1. Plugin defaults in `config/grounding-sources.json`.
2. The user file selected by the `grounding_sources` plugin option. Without that option, the
   fallback is `grounding-sources.json` under `CLAUDE_CONFIG_DIR` or `~/.claude`.
3. The project file `.claude/grounding-sources.json`, which may add families but cannot replace
   plugin or user families. Project recipes are untrusted suggestions: read them before running
   them. They are labelled `[untrusted project recipe]` by `list`, and project family names are
   labelled `[untrusted project]` in injected context.

Run `wt-grounding-sources.mjs list` to see the merged entries, their winning layer, and a
`missing` flag when the required binary or configured MCP server is unavailable. Run
`wt-grounding-sources.mjs init` to create the user file from MCP names found in local Claude
configuration and supported binaries found on `PATH`; it never overwrites. Use
`init --dry-run` to inspect the proposed file without writing it.

The prompt reminder cooldown is the `grounding_prompt_cooldown` plugin option (default 5).
Set `grounding_pre_send` to `observe` (the default), `refuse`, or `off`. Observe mode journals
the decision and evidence without blocking. Refuse mode blocks an ungrounded outbound call once;
the identical retry passes. Add outbound MCP tool globs with `grounding_outbound_tools` as a
comma- or newline-separated list.

Portability: Node path APIs handle native separators. A missing or unreadable registry layer is
ignored rather than guessed. A missing `PATH` entry or binary is reported as `missing`. An
unreadable transcript degrades to the named value `unknown` and the outbound check passes; it
never silently reports a plausible "queried" or "not queried" value. Transcript discovery is
not guessed by the plugin: hooks consume the host-provided `transcript_path`.

The shipped shell recipes use POSIX shell spelling (parameter expansion and quoted globs). On Windows without a
POSIX-compatible shell, use MCP recipes or replace them in the user layer with native commands;
the plugin never executes recipes itself. It only recognizes evidence structurally by executable
and key flags.
