# wt-secret-guard

`wt-secret-guard` replaces detected secrets in inbound deliveries, pasted prompts, attachments, visible assistant text, and supported tool results with stable tokens. It refuses raw secret-bearing Bash, Write, Edit, NotebookEdit, WebFetch, WebSearch, Agent, Task, and MCP inputs before execution. It can rewrite `op://` 1Password references, `secret:env:NAME`, and `secret:file:/path` references before Bash runs.

For an inbound delivery, the guard withholds the credential value before the message is queued while leaving the rewritten message answerable. Its visible notice says that revocation is the only remedy and links to the provider's key page when the detected shape identifies one. This only stops this Claude Code session from spreading the value into commands, files, logs, or further messages. It cannot remove or unsend the original message from Atrium, Remote Control, Slack, another client, or any append-only history where it was already sent.

Its scope is text delivered to this Claude Code session, text the session sends through submitted prompts, and supported tool results. It does not filter text at the point where a human types it in another client.

Known vendor shapes include Brave API keys (`BSA` plus 28 URL-safe characters). UUIDs remain unmasked in ordinary log text, but are masked when immediately used as a credential, including an Exa client constructor or a key, token, secret, or credential assignment. A key with no recognizable shape and no credential context word remains invisible. No entropy threshold that avoids flooding ordinary output can catch every such value, so the guard does not lower its entropy threshold as a fallback.

## Requirements

This is a Claude Code Function Hooks plugin, an early-access API. Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for both marketplace installs and `--plugin-dir`. Live A/B tests on Claude Code 2.1.278 showed that the flag is required on both paths. Without it, Claude Code does not load the guarding module.

A classic `SessionStart` command prints one inactive-guard notice when the flag is absent. That fallback requires `node` on `PATH`; check it with `node --version`. If Node is unavailable, the notice cannot run, so the launch flag remains the authoritative requirement on every platform.

`node` on `PATH` is also required on Linux and macOS for two protections: the in-place repair of a refused call's transcript record, and the measurement journal. Without it both fail closed: the repair is skipped with a visible notice that the value may remain in the transcript, and journal events are dropped with a notice. The refusal itself does not depend on Node.

1Password reference resolution requires the [1Password CLI](https://developer.1password.com/docs/cli/) and a signed-in account. Configure `opBinary` when the CLI executable is not `op`; configure `opAccount` for a non-default account.

### Supported secret references

The Bash hook expands a small allow-list, and refuses the command outright — with the reason and this list — for anything else it finds. Supported **forms**:

- `op://vault/item/[section/]field`, a literal 1Password reference;
- `op read <literal op:// reference>` with the documented flags `--account`, `-o`/`--out-file`, `--encoding`, `--file-mode`, `--format`, `--session`, `--config`, `-n`/`--no-newline`, `-f`/`--force`, `--no-color`, `--cache`, and plain redirections. The invocation is left as written and its reference is prefetched. The command word and the verb are read as the shell reads them, so `"op" read`, `op 'read'` and `/usr/bin/op read` are the same invocation as `op read` and earn the same validation — and the same refusal;
- `secret:env:NAME`, where `NAME` is `UPPER_SNAKE_CASE`;
- `secret:file:/absolute/path` with an optional `#line`;
- a redaction token this session issued.

Supported **contexts**, one of which every reference must sit in:

- a bare shell word, including inside `$( )`;
- the complete contents of a single-quoted word;
- the complete contents of a double-quoted word;
- a line of an **unquoted** heredoc body.

Everything else is refused before the command runs, and the refusal names what was not understood: a reference inside a quoted heredoc (`<<'EOF'`, `<<"EOF"`), inside `${...}`, inside backticks or `$'...'`, inside a comment, inside a larger quoted string, preceded by a backslash escape (`\secret:env:NAME`), or in an unterminated quote; an `op read` whose reference is not a literal (`op read $REF`, `"op" read "$REF"`) or that carries an undocumented flag or a second reference; `op inject` or `op run` beside a reference; a reference written to a `.tpl` template destination; an unknown form such as `secret:1p:`; a redaction token this session never issued; and a file reference that cannot be read. A refusal never executes the command and never partially expands it.

A `# comment` after a supported reference ends the line rather than opening unfinished syntax: `printf %s secret:env:NAME # note` is expanded normally. A reference written *inside* the comment is still refused.

## Options

`maskIpAddresses` and `maskEmails` are boolean plugin options and both default to `false`. Enable either option to mask that value class in submitted prompts and Bash, Read, and MCP tool results. IPv4 and IPv6 addresses are covered.

`secretFileReadWarnings` defaults to `true`. The guard evaluates the original Bash command before reference rewriting and also evaluates Read and NotebookRead paths. A guarded read still executes in this measurement release, but its result carries `WOULD BLOCK; executed in measurement mode`. Set the option to `false` only to diagnose noisy warnings; disabling it is recorded without storing the command or path.

Raw outbound values are refused rather than silently changing a requested destination. Exact reference spans (`op://`, `secret:env:`, `secret:file:`, `${NAME}`, and existing redaction tokens) pass unchanged, but do not exempt adjacent raw values. Bash token rehydration and `secret:file:` expansion bind encoded data to fixed shell code rather than evaluating the secret as shell source. The executed child still receives the raw value. This can expose the value through process metadata or child output; returned output is scrubbed, but operating-system process inspection is outside the guard.

Outbound detection also matches raw values already held in the in-memory vault and their base64 encodings. It does not reconstruct values split across fields or expressions, and it does not decode arbitrary encodings; those remain detection-evasion limits.

## Context limitation

This marketplace plugin cannot mask secrets already present in `CLAUDE.md` or other first-message context blocks. Claude Code computes those blocks in `prompt.context`, but its prepend-tier security plugin bypasses the entire user-plugin tier for that event. Marketplace plugins are user-tier, so registering a handler appears valid but the handler does not run, including in `-p` sessions. The host still records and sends the original block.

Every `prompt.attachment` is scrubbed before forwarding. For SessionStart `additionalContext` from another classic hook, Secret Guard also emits a warning and a value-free journal record. Claude Code 2.1.278 did not propagate a Function Hook rewrite to the model-visible attachment in the measured probe, so model-side propagation remains unproven; it does not claim to purge or mask the source consumer store. Remove replayed secrets at that source.

Signed thinking chunks cannot be rewritten. Visible assistant text is emitted under one invariant: it never carries a raw run of eight or more characters of any value that is known to the vault or detected when that text leaves the guard. The cut between "emit now" and "hold" is pushed out of every secret span rather than chosen by length, so a value can never be released as two halves; at least 512 characters are held back so no detector match is cut in two, and a run that reaches the end of the buffer is held until the stream ends. Text carrying no such run is emitted unchanged, possibly later and across different chunk boundaries. Masking carries the redaction note once per stream and one journal record, and the final answer is scrubbed again. Fragment matching uses the confidential part of a detected value, not the key name around it, so ordinary words such as `password` are not masked; a value shorter than eight characters and a known credential UUID with no credential context are matched whole, as elsewhere. Oversized unresolved blocks are held and masked rather than emitted raw. `ui.render` masks old `AssistantMessage` rows only while drawing them and is not a storage guarantee.

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

Detected values are replaced with stable `secret:<kind>#<id>` tokens before they reach the model. After Claude Code enters a scrubbed submitted prompt, the guard checks both `history.jsonl` and the current session transcript, regardless of prompt origin, and retries for up to 160 ms so a late `queue-operation` enqueue from `-p`/SDK mode is included. A refused outbound call is correlated by `tool_use_id` and its persisted `tool_use.input` is repaired the same way. Tool-input `turn.step` chunks are deliberately not rewritten, because replacing raw values with rehydratable tokens before `tool.call` would bypass refusal.

The storage adapter reads only a bounded tail, compares file identity, and overwrites and verifies only the detected value's JSON-escaped byte range in place, without truncating or replacing the file. A partial trailing record is retried. The replacement is the token plus JSON-safe padding when it fits, or an equal-length mask. POSIX uses `dd conv=notrunc`. There is therefore a short interval in which a pasted or denied raw value can exist on disk. If no matching record appears, a record cannot be parsed, the file identity or bytes changed before writing, the platform writer is unavailable, or verification fails, the guard says once that a raw value may remain; it never includes the value in that notice.

The POSIX operation is supported on Linux and macOS, whose `dd` implementations support `bs=1`, `skip`, `count`, `seek`, and `conv=notrunc`. Windows remains unproven until native CI establishes same-length writes, file identity, concurrent append preservation, files over 4 MiB, literal `.claude` paths, compare-before-write, and post-write verification with host-available PowerShell.

Prefer `op://...` or `secret:env:NAME` references over pasting raw values. Those references are resolved only when a Bash command runs, so the raw value never passes through the prompt or prompt-history files.

Secret-file policy measurements use one append-only NDJSON record stream per session. Records contain fixed policy enums, counts, the host session/tool identifiers, and a salted project identity only. They never contain commands, paths, argument keys, tool names, excerpts, or secret values. A separate identifier-only ledger records review dispositions. The existing `salt`, `detections`, `stats`, and `lastpublishedat` publication contract is unchanged.

Additional limits: values split across expressions or encoded in forms other than a known vault value's base64 can evade detection; signed thinking is immutable; and `ui.render` changes display only, not stored content. Denied subagent calls are refused, but persisted subagent transcript repair remains unavailable until the host-specific transcript location is measured.
