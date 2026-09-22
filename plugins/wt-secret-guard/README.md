# wt-secret-guard

`wt-secret-guard` replaces detected secrets in inbound deliveries, pasted prompts, and Bash, Read, and MCP tool results with stable tokens. It can rewrite `op://` 1Password references, `secret:env:NAME`, and `secret:file:/path` references before Bash runs.

For an inbound delivery, the guard withholds the credential value before the message is queued while leaving the rewritten message answerable. Its visible notice says that revocation is the only remedy and links to the provider's key page when the detected shape identifies one. This only stops this Claude Code session from spreading the value into commands, files, logs, or further messages. It cannot remove or unsend the original message from Atrium, Remote Control, Slack, another client, or any append-only history where it was already sent.

Its scope is text delivered to this Claude Code session, text the session sends through submitted prompts, and supported tool results. It does not filter text at the point where a human types it in another client.

Known vendor shapes include Brave API keys (`BSA` plus 28 URL-safe characters). UUIDs remain unmasked in ordinary log text, but are masked when immediately used as a credential, including an Exa client constructor or a key, token, secret, or credential assignment. A key with no recognizable shape and no credential context word remains invisible. No entropy threshold that avoids flooding ordinary output can catch every such value, so the guard does not lower its entropy threshold as a fallback.

## Requirements

This is a Claude Code Function Hooks plugin, an early-access API. Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Without Function Hooks, Claude Code does not load this plugin and secret guarding is unavailable.

1Password reference resolution requires the [1Password CLI](https://developer.1password.com/docs/cli/) and a signed-in account. Configure `opBinary` when the CLI executable is not `op`; configure `opAccount` for a non-default account.

The Bash hook resolves a well-formed `op://vault/item/[section/]field` reference when it is an unquoted shell word or the complete contents of a quoted shell word. It leaves references literal in larger quoted strings, heredoc bodies, `op read`/`op inject`/`op run` commands, and commands writing to a `.tpl` destination. Unsupported or ambiguous text is left unchanged rather than risking a broken command; this includes search patterns and references containing shell metacharacters.

## Options

`maskIpAddresses` and `maskEmails` are boolean plugin options and both default to `false`. Enable either option to mask that value class in submitted prompts and Bash, Read, and MCP tool results. IPv4 and IPv6 addresses are covered.

## Context limitation

This marketplace plugin cannot mask secrets already present in `CLAUDE.md` or other first-message context blocks. Claude Code computes those blocks in `prompt.context`, but its prepend-tier security plugin bypasses the entire user-plugin tier for that event. Marketplace plugins are user-tier, so registering a handler appears valid but the handler does not run, including in `-p` sessions. The host still records and sends the original block.

Closing that gap requires host support that lets a user-tier guard participate in `prompt.context`, or deployment of the guard as an administrator-controlled prepend/append-tier plugin. Do not put secrets in instruction files. The guard deliberately does not rewrite instruction source files on disk because doing so would alter project content.

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

Detected values are replaced with stable `secret:<kind>#<id>` tokens before they reach the model. After Claude Code enters a scrubbed submitted prompt, the guard checks both `history.jsonl` and the current session transcript, regardless of prompt origin, and retries for up to 160 ms so a late `queue-operation` enqueue from `-p`/SDK mode is included. It then uses `dd` to compare and overwrite only the detected value's JSON-escaped byte range in place, without truncating or replacing the file. The replacement is the token plus JSON-safe padding when it fits, or an equal-length mask. There is therefore a short interval in which a pasted raw value can exist on disk. If no matching record appears, a record cannot be parsed, the bytes changed before writing, `dd` is unavailable, or the overwrite fails, the guard says once that a raw value may remain; it never includes the value in that notice.

The in-place operation is supported on Linux and macOS, whose `dd` implementations support `bs=1`, `skip`, `count`, `seek`, and `conv=notrunc`. On Windows without a compatible `dd` on `PATH`, scrubbing degrades to the notice above and does not silently claim success.

Prefer `op://...` or `secret:env:NAME` references over pasting raw values. Those references are resolved only when a Bash command runs, so the raw value never passes through the prompt or prompt-history files.
