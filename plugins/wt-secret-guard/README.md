# wt-secret-guard

`wt-secret-guard` replaces detected secrets in inbound deliveries, pasted prompts, visible assistant text, and Bash, Read, and MCP tool results with stable tokens. It refuses raw secret-bearing Bash, Write, Edit, NotebookEdit, and MCP inputs before execution. It can rewrite `op://` 1Password references, `secret:env:NAME`, and `secret:file:/path` references before Bash runs.

For an inbound delivery, the guard withholds the credential value before the message is queued while leaving the rewritten message answerable. Its visible notice says that revocation is the only remedy and links to the provider's key page when the detected shape identifies one. This only stops this Claude Code session from spreading the value into commands, files, logs, or further messages. It cannot remove or unsend the original message from Atrium, Remote Control, Slack, another client, or any append-only history where it was already sent.

Its scope is text delivered to this Claude Code session, text the session sends through submitted prompts, and supported tool results. It does not filter text at the point where a human types it in another client.

Known vendor shapes include Brave API keys (`BSA` plus 28 URL-safe characters). UUIDs remain unmasked in ordinary log text, but are masked when immediately used as a credential, including an Exa client constructor or a key, token, secret, or credential assignment. A key with no recognizable shape and no credential context word remains invisible. No entropy threshold that avoids flooding ordinary output can catch every such value, so the guard does not lower its entropy threshold as a fallback.

## Requirements

This is a Claude Code Function Hooks plugin, an early-access API. Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for both marketplace installs and `--plugin-dir`. Live A/B tests on Claude Code 2.1.278 showed that the flag is required on both paths. Without it, Claude Code does not load the guarding module.

A classic `SessionStart` command prints one inactive-guard notice when the flag is absent. That fallback requires `node` on `PATH`; check it with `node --version`. If Node is unavailable, the notice cannot run, so the launch flag remains the authoritative requirement on every platform.

1Password reference resolution requires the [1Password CLI](https://developer.1password.com/docs/cli/) and a signed-in account. Configure `opBinary` when the CLI executable is not `op`; configure `opAccount` for a non-default account.

The Bash hook resolves a well-formed `op://vault/item/[section/]field` reference when it is an unquoted shell word or the complete contents of a quoted shell word. It leaves references literal in larger quoted strings, heredoc bodies, `op read`/`op inject`/`op run` commands, and commands writing to a `.tpl` destination. Unsupported or ambiguous text is left unchanged rather than risking a broken command; this includes search patterns and references containing shell metacharacters.

## Options

`maskIpAddresses` and `maskEmails` are boolean plugin options and both default to `false`. Enable either option to mask that value class in submitted prompts and Bash, Read, and MCP tool results. IPv4 and IPv6 addresses are covered.

`secretFileReadWarnings` defaults to `true`. The guard evaluates the original Bash command before reference rewriting and also evaluates Read and NotebookRead paths. A guarded read still executes in this measurement release, but its result carries `WOULD BLOCK; executed in measurement mode`. Set the option to `false` only to diagnose noisy warnings; disabling it is recorded without storing the command or path.

Raw outbound values are refused rather than silently changing a requested destination. Reference-shaped values (`op://`, `secret:env:`, `secret:file:`, `${NAME}`, and existing redaction tokens) pass unchanged. Bash token rehydration and `secret:file:` expansion remain supported: the recorded call contains the reference, but the executed child receives the raw value. This can expose the value through process metadata or child output; returned output is scrubbed, but operating-system process inspection is outside the guard.

## Context limitation

This marketplace plugin cannot mask secrets already present in `CLAUDE.md` or other first-message context blocks. Claude Code computes those blocks in `prompt.context`, but its prepend-tier security plugin bypasses the entire user-plugin tier for that event. Marketplace plugins are user-tier, so registering a handler appears valid but the handler does not run, including in `-p` sessions. The host still records and sends the original block.

SessionStart `additionalContext` from another classic hook is observable as a hook-origin `prompt.attachment`, but Claude Code 2.1.278 does not apply a Function Hook rewrite to the model-visible attachment. Secret Guard therefore emits a warning and a value-free journal record; it does not claim to purge or mask the source consumer store. Remove replayed secrets at that source.

Signed thinking chunks cannot be rewritten. Visible assistant text is held in a bounded stream buffer, masked at character-boundary splits, annotated with the redaction note, and scrubbed again in the final answer. `ui.render` masks old `AssistantMessage` rows only while drawing them and is not a storage guarantee.

Closing that gap requires host support that lets a user-tier guard participate in `prompt.context`, or deployment of the guard as an administrator-controlled prepend/append-tier plugin. Do not put secrets in instruction files. The guard deliberately does not rewrite instruction source files on disk because doing so would alter project content.

## Install

Add the Workflow Toolbox marketplace and install the guard:

```bash
claude plugin marketplace add home-dev-lab/workflow-toolbox
claude plugin install wt-secret-guard@workflow-toolbox
```

Enable the Function Hooks API whenever starting Claude Code:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

## What is stored

Detected values are replaced with stable `secret:<kind>#<id>` tokens before they reach the model. After Claude Code enters a scrubbed submitted prompt, the guard checks both `history.jsonl` and the current session transcript, regardless of prompt origin, and retries for up to 160 ms so a late `queue-operation` enqueue from `-p`/SDK mode is included. A refused outbound call is correlated by `tool_use_id` and its persisted `tool_use.input` is repaired the same way. `turn.step` input masking is additional best-effort defense only; live 2.1.278 tests showed that its rewrite does not alter the persisted denied call.

The storage adapter compares, overwrites, and verifies only the detected value's JSON-escaped byte range in place, without truncating or replacing the file. The replacement is the token plus JSON-safe padding when it fits, or an equal-length mask. POSIX uses `dd conv=notrunc`; Windows selects a PowerShell `FileStream` seek/write adapter. There is therefore a short interval in which a pasted or denied raw value can exist on disk. If no matching record appears, a record cannot be parsed, the bytes changed before writing, the platform writer is unavailable, or verification fails, the guard says once that a raw value may remain; it never includes the value in that notice.

The POSIX operation is supported on Linux and macOS, whose `dd` implementations support `bs=1`, `skip`, `count`, `seek`, and `conv=notrunc`. The Windows adapter has unit coverage behind the platform seam but has not yet passed its required native Windows CI proof; do not claim Windows release readiness until that job proves same-length writes, inode/file identity, concurrent append preservation, files over 4 MiB, literal `.claude` paths, compare-before-write, and post-write verification with host-available PowerShell.

Prefer `op://...` or `secret:env:NAME` references over pasting raw values. Those references are resolved only when a Bash command runs, so the raw value never passes through the prompt or prompt-history files.

Secret-file policy measurements use one append-only NDJSON record stream per session. Records contain fixed policy enums, counts, the host session/tool identifiers, and a salted project identity only. They never contain commands, paths, argument keys, tool names, excerpts, or secret values. A separate identifier-only ledger records review dispositions. The existing `salt`, `detections`, `stats`, and `lastpublishedat` publication contract is unchanged.
