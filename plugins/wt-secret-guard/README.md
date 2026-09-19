# wt-secret-guard

`wt-secret-guard` replaces detected secrets in pasted prompts and Bash, Read, and MCP tool results with stable tokens. It can rewrite `op://` 1Password references, `secret:env:NAME`, and `secret:file:/path` references before Bash runs.

## Requirements

This is a Claude Code Function Hooks plugin, an early-access API. Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Without Function Hooks, Claude Code does not load this plugin and secret guarding is unavailable.

1Password reference resolution requires the [1Password CLI](https://developer.1password.com/docs/cli/) and a signed-in account. Configure `opBinary` when the CLI executable is not `op`; configure `opAccount` for a non-default account.

## Install

Add the Workflow Toolbox marketplace and install the guard:

```bash
claude plugin marketplace add home-dev-lab/workflow-toolbox
claude plugin install wt-secret-guard@workflow-toolbox
```

Enable the Function Hooks API when starting Claude Code:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

## What is stored

Detected values are replaced with stable `secret:<kind>#<id>` tokens before the prompt reaches the model. After Claude Code enters the scrubbed prompt, the guard checks both `history.jsonl` and the current session transcript, regardless of prompt origin, and retries for up to 160 ms so a late `queue-operation` enqueue from `-p`/SDK mode is included. It then uses `dd` to compare and overwrite only the secret's JSON-escaped byte range in place, without truncating or replacing the file. The replacement is the token plus JSON-safe padding when it fits, or an equal-length mask. There is therefore a short interval in which a pasted raw value can exist on disk. If no matching record appears, a record cannot be parsed, the bytes changed before writing, `dd` is unavailable, or the overwrite fails, the guard says once that a raw secret may remain; it never includes the value in that notice.

The in-place operation is supported on Linux and macOS, whose `dd` implementations support `bs=1`, `skip`, `count`, `seek`, and `conv=notrunc`. On Windows without a compatible `dd` on `PATH`, scrubbing degrades to the notice above and does not silently claim success.

Prefer `op://...` or `secret:env:NAME` references over pasting raw values. Those references are resolved only when a Bash command runs, so the raw value never passes through the prompt or prompt-history files.
