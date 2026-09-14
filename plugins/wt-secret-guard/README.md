# wt-secret-guard

`wt-secret-guard` replaces detected secrets in pasted prompts and Bash, Read, and MCP tool results with stable tokens. It can rewrite `op://` 1Password references, `secret:env:NAME`, and `secret:file:/path` references before Bash runs.

## Requirements

This is a Claude Code Function Hooks plugin, an early-access API. Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Without Function Hooks, Claude Code does not load this plugin and secret guarding is unavailable.

1Password reference resolution requires the [1Password CLI](https://developer.1password.com/docs/cli/) and a signed-in account. Configure `opBinary` when the CLI executable is not `op`; configure `opAccount` for a non-default account.
