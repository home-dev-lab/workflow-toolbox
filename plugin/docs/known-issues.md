# Known Issues

## Adopted lane launcher dependency

The adopted `wt-lane.mjs` launcher resolves and imports the installed Workflow Toolbox consent
resolver from `CLAUDE_PLUGIN_ROOT`, `WT_PLUGIN_ROOT`, or the active config directory's
`plugins/installed_plugins.json`. If none is available, or the resolver cannot load, it refuses to
launch. This deliberately prevents an adopted launcher from making a stale or fail-open consent
decision without the plugin.
