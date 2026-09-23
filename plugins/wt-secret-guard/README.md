# wt-secret-guard

`wt-secret-guard` replaces detected secrets in inbound deliveries, pasted prompts, attachments, visible assistant text, and supported tool results with stable tokens. It refuses raw secret-bearing Bash, Write, Edit, NotebookEdit, WebFetch, WebSearch, Agent, Task, and MCP inputs before execution. It can rewrite `op://` 1Password references, `secret:env:NAME`, and `secret:file:/path` references before Bash runs.

For an inbound delivery, the guard withholds the credential value before the message is queued while leaving the rewritten message answerable. Its visible notice says that revocation is the only remedy and links to the provider's key page when the detected shape identifies one. This only stops this Claude Code session from spreading the value into commands, files, logs, or further messages. It cannot remove or unsend the original message from Atrium, Remote Control, Slack, another client, or any append-only history where it was already sent.

Its scope is text delivered to this Claude Code session, text the session sends through submitted prompts, and supported tool results. It does not filter text at the point where a human types it in another client.

Known vendor shapes include Brave API keys (`BSA` plus 28 URL-safe characters). UUIDs remain unmasked in ordinary log text, but are masked when immediately used as a credential, including an Exa client constructor or a key, token, secret, or credential assignment. **Any value the guard itself put into a command** — through a redaction token, `secret:env:`, `secret:file:` or `op://` — is masked in that command's output whatever it looks like, a UUID or an address included. Overlapping detections are merged before anything is replaced, so one pattern never unmasks what another one covers. Source code keeps an exemption for a credential-named variable assigned a *name* (`const token = fallbackToken`); a *quoted literal* is masked, in a declaration as anywhere else. A key with no recognizable shape and no credential context word remains invisible. No entropy threshold that avoids flooding ordinary output can catch every such value, so the guard does not lower its entropy threshold as a fallback.

## Requirements

This is a Claude Code Function Hooks plugin, an early-access API. Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for both marketplace installs and `--plugin-dir`. Live A/B tests on Claude Code 2.1.278 showed that the flag is required on both paths. Without it, Claude Code does not load the guarding module.

A classic `SessionStart` command prints one inactive-guard notice when the flag is absent. That fallback requires `node` on `PATH`; check it with `node --version`. If Node is unavailable, the notice cannot run, so the launch flag remains the authoritative requirement on every platform.

`node` on `PATH` is also required on Linux and macOS for two protections: the in-place repair of a refused call's transcript record, and the measurement journal. Without it both fail closed: the repair is skipped with a visible notice that the value may remain in the transcript, and journal events are dropped with a notice. The refusal itself does not depend on Node.

1Password reference resolution requires the [1Password CLI](https://developer.1password.com/docs/cli/) and a signed-in account. Configure `opBinary` when the CLI executable is not `op`; configure `opAccount` for a non-default account.

### Supported secret references

The Bash hook expands a small allow-list, and refuses the command outright — with the reason and this list — for anything else it finds. Supported **forms**:

- `op://vault/item/[section/]field`, a literal 1Password reference;
- `op read <literal op:// reference>` with the documented flags `--account`, `--session`, `--config`, `-n`/`--no-newline`, `-f`/`--force`, `--no-color`, `--cache`, and plain redirections; global flags may also come before the verb (`op --account=team read …`). **Changed in round 12:** its reference is prefetched once and the invocation's `op` word is replaced by a printer of the prefetched value, with op read's own output (a trailing newline unless `-n`); flags, redirections and its place in a pipeline or a `"$( )"` stay as written, and the command never reads 1Password a second time. The flags whose output the guard cannot reproduce from a stored value — `-o`/`--out-file`, `--encoding`, `--file-mode`, `--format` — are refused, and so is the form behind a wrapper (`exec op read …`, `timeout 5 op read …`) or as an argument, where the guard cannot put that printer in its place. Quoting that only changes spelling is read as the shell reads it, so `"op" read`, `op 'read'` and `/usr/bin/op read` are this same form; **Round 13:** the options that change how 1Password resolves the reference — `--config`, `--session`, `--cache` — are refused (the prefetch carries `--account` exactly and nothing else, so a command asking for another resolution is not resolved behind its back). **Round 15:** a flag value written glued (`--account=…`) is checked exactly like a spaced one: a reference form or a token there is refused, and only the invocation's own `op://` reference is exempt from the reference scan. **Round 14:** when the command names no `--account`, the configured `opAccount` applies to this form exactly as to a bare reference; a prefetch whose `op` exits with any status other than 0 — or reports none — is a failure, whatever it printed, and the command is refused.
- `secret:env:NAME`, where `NAME` is `UPPER_SNAKE_CASE`. The guard reads the variable from **Claude Code's own environment** and binds that value into the command as data, so the value substituted is always one it knows and masks. A variable the guard cannot read — one set only in a shell profile, say — is refused rather than substituted unseen. A short value is masked wherever it appears in the output, so a reference to a variable holding `true` masks every `true`;
- `secret:file:/absolute/path` with an optional `#line`;

Every value the guard substitutes — a file, an environment variable, a token, a 1Password value — is bound into the command as data. **A value bash cannot carry unchanged is refused** (round 12): a NUL byte, which a command substitution drops, or an unpaired UTF-16 surrogate, which the encoder replaces. The value the command would receive would not be the one the vault masks. **Round 13:** each bound or prefetched value is also registered with the variant a command substitution produces from it — the value with all its trailing newlines removed — so `"$(op read …)"` of a value ending in newlines is masked too. An issued token already present in a text is never scrubbed again, and a token submitted back in a command rehydrates. **Round 15:** a token is never minted equal to the value it stands for, nor to any value the vault holds; and a token spelling that a value held later shares is no longer exempt — the ambiguous text is masked. **Round 14:** only a token this vault actually issued is exempt; a token-SHAPED string that was never issued is ordinary text — masked when it is a known value, detected normally otherwise. The exemption covers the token's own spelling only: a value that straddles a token-shaped run is still masked in output, and still flagged in outbound input, on the part outside the token.
- a redaction token this session issued.

Supported **contexts**, one of which every reference must sit in:

- a bare shell word;
- the complete contents of a single-quoted word;
- the complete contents of a double-quoted word.

A reference inside a command substitution (`"$(printf %s secret:env:NAME)"`) is **no longer a supported context** (round 11, see "The allow-list" below): it is refused. The literal `op read` form inside one stays accepted.

**A heredoc body is not a supported context.** A reference written inside any heredoc body, quoted (`<<'EOF'`) or not (`<<EOF`), stays **literal text** in what the command writes: it is not expanded, not prefetched, and does not refuse the command. The guard cannot tell "inject this secret into a file" from "write a document, a test or a brief that mentions a reference", and the first is exactly the path that puts a secret on disk. To inject secrets into a file, use 1Password's own `op inject`, outside the guard.

The guard ends a heredoc body exactly where bash does, measured against bash 5.2: in an **unquoted** heredoc bash joins a line ending in an odd number of backslashes with the next one *before* comparing it with the delimiter (`text\` then `EOF` does not end the body; `EO\` then `F` does), a quoted delimiter joins nothing, and `<<-` strips leading tabs from the joined line. When it cannot place the end — an unterminated body, a delimiter spelled with `$` such as `<<$'EOF'` — a command that carries a reference anywhere, body included, is refused.

Everything else is refused before the command runs, and the refusal names what was not understood: a reference inside `${...}`, inside backticks or `$'...'`, inside a comment, inside a larger quoted string, preceded by a backslash escape (`\secret:env:NAME`), or in an unterminated quote; an `op read` whose reference is not a literal (`op read $REF`, `"op" read "$REF"`) or that carries an undocumented flag or a second reference; `op inject` or `op run` beside a reference; a reference written to a `.tpl` template destination; an unknown form such as `secret:1p:`; a redaction token this session never issued; and a file reference that cannot be read. A refusal never executes the command and never partially expands it.

A `# comment` after a supported reference ends the line rather than opening unfinished syntax: `printf %s secret:env:NAME # note` is expanded normally. A reference written *inside* the comment is still refused.

### The guard acts on its own forms — and nothing else

The guard acts on the reference forms above and on the literal `op read` words. **A command that carries none of them runs untouched, byte for byte, whatever it contains** — `op`, `op inject`, `op run`, `read`, parameters, loops, functions, substitutions, ANSI-C quoting, backticks. It does not go looking for other ways a shell might end up running `op`. (`op inject` and `op run` are refused only BESIDE a reference.) **Round 13:** with no reference at all, the literal `op read` words make a command the guard's only where the allow-list can place them: inside shell it does not read — a loop, a condition, a case body, a line continuation — they are text, and the command passes untouched (`for x in a; do echo op read foo; done`).

### The allow-list — what a command using these forms may contain (round 11, tightened in rounds 12 to 15)

A command that **does** use one of these forms must fit a small grammar. Anything outside it is refused, and the refusal names the construct and says what the grammar accepts. The grammar:

- **simple commands** joined by `;`, `&&`, `||`, `|`, `&` or a newline;
- **only printable ASCII, space, tab and newline, anywhere** — words, quotes, heredoc delimiters and bodies (round 14): a carriage return, a vertical tab, a form feed, NBSP, every other Unicode space and every control character are refused, because bash reads them as word characters where a naive reader sees blanks (`x` + vertical tab + `# "$(cmd)"` is ONE word to bash, and bash runs the substitution). A form in what would be a heredoc body, beside such a character, counts as used and is refused too. The guard's reader uses bash's own blank set (space, tab, newline) everywhere. Written text outside ASCII (`café`, `—`) beside a form is refused with it: put it in a command without a reference, or in a file;
- **no backslash-newline line continuation** anywhere outside a quoted heredoc body (round 13: `ti\` + newline + `me` is the keyword `time`);
- **a complete command list** (round 15): every `;`, `&`, `&&`, `||` and `|` has a command before it, and the list does not end on `&&`, `||` or `|` — `printf %s <form> &&`, `; ;` and a leading operator are refused. A trailing `;` or `&`, and a line break after `&&`, `||` or `|`, are accepted, as bash accepts them; **shell keywords are recognised in any spelling** — a quoted or escaped `"time"` is refused as a command name too;
- each **command name a literal word** — quoting allowed (`"printf"`, `/usr/bin/printf`) — or a listed wrapper followed, recursively, by a literal command name (below); `exec`, `command` and `builtin` count as wrappers. **Every word from a wrapper up to and including its command is a plain literal** — no `"$X"`, no tilde, no glob, no reference — and a whole `find` invocation is plain words (round 12: an expanded option or action word moves the command position);
- every **word** literal (quoted or not), one of the guard's forms, or a **double-quoted** string holding only literal text and `$NAME` / `${NAME}` — one field whatever the value. An **unquoted** `$NAME` is refused (field splitting moves words, and with them the command position), and so is every other expansion: `${…}` with an operator (`:-`, `#`, `%`, `/`, `^`, `,`, `@`, `!`), `$1`/`$@`/`$?`, a glob, brace expansion, and **any unquoted tilde** (round 12: write the path out, or use `"$HOME"`); Round 13: inside double quotes a `$` is accepted only as `$NAME`, `${NAME}`, or a literal `$` before a blank or the closing quote — `"$[...]"` arithmetic and every other expansion are refused;
- **the guard's forms only as arguments** (and as the value of an assignment prefix): never as the command name, never as a redirection target (round 12);
- **no command substitution** (`$( )`, backticks), process substitution or arithmetic — except the literal `op read` form in `$( )`, double-quoted (`curl -H "Authorization: Bearer $(op read 'op://…')"`) or as the value of an assignment **prefix** (`TOKEN=$(op read 'op://…') gh api …`). `NAME=value` is an assignment only before the command name: as an argument (`export TOKEN=$(…)`, `printf %s A=$(…)`) it is an ordinary word, and an unquoted substitution there is refused — write `export TOKEN="$(op read 'op://…')"` (round 12);
- **redirections with a literal target**; **at most one heredoc**, with a plain delimiter (`EOF`, `'EOF'`, `"EOF"`); an **unquoted** heredoc body may hold no `$` and no backtick at all (round 12: bash joins backslash-newlines before it expands, so `$\` + newline + `(cmd)` is a substitution) — quote the delimiter (`<<'EOF'`) and the body is plain text;
- **no compound command**: no `if`, `case`, `for`, `while`, `until`, `select`, function, `coproc`, `time`, `!`, subshell `( )`, group `{ }`, array, `[[ ]]` or `(( ))`; no `eval`, `source`, `.`, `alias` or `trap`. **`xargs` is refused beside the guard's forms** (round 13): its input becomes words of the command it runs — options, operands, even the command once a wrapper is left open — and no reading of its options bounds that.

Why: rounds 7 to 10 each closed spellings of "a command name the guard cannot read" (a `case` body, a function body, `time -p`, nested heredocs, `${Y:-$(…)}`, an unquoted wrapper operand), and each review found the next one. Bash has more grammar than a deny-list can enumerate, so the guard now accepts a grammar it reads completely and refuses the rest. **If you need anything outside it, write that command without a reference, or move the reference into a simple command of its own.**

The documented `op read` form written where the shell runs it but without a literal reference (`op read "$REF"`, `op --account=team read "$REF"`) is refused too — **where the allow-list can read the command** (round 15: this sentence used to read as universal). Written somewhere the allow-list cannot read — an unquoted parameter (`op read $REF`), a keyword in front (`time op read "$REF"`), a loop or a condition — a reference-free `op read` is out of scope and passes untouched, like the stated limit below; only a command carrying one of the guard's reference forms is refused for its shape. The same words as arguments (`echo op read foo`) are text, not an invocation. Behind a builtin or listed wrapper (`timeout 5 op read secret:env:REF`), the same form is refused when the command carries one of the guard's reference forms: there it would run `op` on a value the guard bound and never prefetched.

#### Listed external wrappers — a fixed list

In a command that uses one of the guard's forms, **the command these wrappers run must be written literally**, and wrappers chain (`env A=1 timeout 5 nice "$CMD"` is refused):

| Wrapper | Grammar the guard reads (from the tool's own `--help` on the reference machine) |
|---|---|
| `env` | `-i`, `-`, `-0`, `-v`, `-u NAME`, `-C DIR`, the signal options, `--`, then `NAME=VALUE` words, then the command. `-S`/`--split-string` is refused: the command is inside a string. |
| `timeout` | `-k`/`--kill-after`, `-s`/`--signal`, `-v`, `--preserve-status`, `--foreground`, then the DURATION, then the command |
| `nice` | `-n N`/`--adjustment`, the obsolete `-N` |
| `nohup` | none (`--`) |
| `stdbuf` | `-i`/`-o`/`-e MODE` and their long forms |
| `setsid` | `-c`, `-f`, `-w` |
| `sudo` | its value options (`-u`, `-g`, `-C`, `-D`, `-p`, `-R`, `-r`, `-t`, `-T`, `-U`, their long forms) and flags; `-e`, `-l`, `-v`, `-K`, `-V` run no command; `-h` is refused (help or host) |
| `doas` | `-a`, `-C`, `-u` values, `-n`, `-s`; `-L` runs none. Not installed on the reference machine: read from doas(1)'s synopsis, not locally |
| `chroot` | `--groups`, `--userspec`, `--skip-chdir`, then NEWROOT, then the command |
| `ionice` | `-c`, `-n` values, `-t`; `-p`, `-P`, `-u` act on running processes (no command) |
| `taskset` | `-a`, `-c`, then the mask; `-p` acts on a running process |
| `find` | the command after each `-exec`, `-execdir`, `-ok`, `-okdir`, until `;` or `{} +`; `{}` as the command is refused |

Short options may be clustered (`-nu root`, `exec -ca label`) and long options abbreviated (`--sig=KILL`), as the tools accept; each cluster is parsed from the tool's own grammar. An option the guard does not know, an ambiguous abbreviation, a replace string it cannot read, or any expanded word before the command is refused beside the guard's forms. A literal command behind any of them, with literal options, passes: `timeout 30 curl "$URL" -u secret:env:C`, `sudo -u app printf %s secret:env:X`. `timeout "$T" …`, `env A="$x" …`, `sudo -u "$USER" …` and `find . -name "$p" …` are refused.

**Every other program that runs its arguments is out of scope, at the same weight as the rule above**: `strace`, `watch`, `flock`, `parallel`, `ssh`, `busybox`, `su -c`, a script of your own. A computed command name inside one of them, even beside the guard's forms, is not refused. The list is fixed on purpose: finding every program that runs its arguments cannot be won from the command text.

If you need `$'\t'`, backticks, a loop or a computed command name in a command, write that command without a reference in it.

#### Out of scope: computed, aliased, eval'd or wrapped `op` invocations

**This is a stated limit, at the same weight as the rule above.** An `op` invocation the guard's own forms do not spell — `CMD=op; "$CMD" read "$REF"`, `eval 'op read "$REF"'`, an alias, a function, `$'op' read`, `/usr/bin/o? read`, or `exec`/`command`/`env` in front of `op read "$REF"` — is **not refused and not prefetched**. So are `op read $REF` and `time op read "$REF"` (round 15: an earlier version of this README said the second was refused; since round 13 a reference-free command the allow-list cannot read passes untouched, and the text now says so). A wrapper outside the listed ones is not examined even in a command that uses one of the guard's forms (see "Listed external wrappers"), and neither is a shell **function or alias** defined earlier under a literal command name: the allow-list reads names, not what the shell resolves them to. Its output is protected only by the pattern detectors and by values already in the vault. A short credential that matches no pattern and was never resolved through a reference this session is not masked in that output.

Several rounds of review showed why the guard stops here: every attempt to find such invocations from the command text was bypassed by the next spelling, and the attempts refused ordinary work (`npm --prefix "$dir" run build`, `rg "$pattern" read`) along the way. A guard that is both bypassable and in the way gets switched off.

### What triggers a real `op` call

**Every `op://` reference the guard expands is prefetched once with a real `op read` before the command runs**, and the command then uses exactly that value — it never calls `op` itself (round 12: a second read could return a rotated value no mask knows). That covers a bare, single-quoted or double-quoted word on the command line and the literal `op read` form — including a reference the command would never use as a credential: a reference inside a string a test is about to save, a reference typed into a `grep` pattern. That is not incidental: the value has to be in the vault before the command runs, or its appearance in the output could not be scrubbed. On a machine where 1Password asks for biometrics, such a command **can raise an unlock prompt**.

A reference inside a **heredoc body** triggers no `op` call at all: heredoc bodies are text (see "Supported secret references").

Two consequences worth knowing before you type one:

- To handle a reference as *text*, write it inside a heredoc body — it passes through untouched with no `op` call — or put it where the guard refuses rather than expands: `${...}`, backticks, `$'...'`, or a larger quoted word.
- **A failed prefetch is remembered for 60 seconds** per account-and-reference, and re-answered from memory without spawning `op` again. The bound holds under concurrency — requests for a reference whose resolution is already running join it instead of spawning their own — and no number of other failures evicts a reference still inside its window. It is also absolute: at most 16 distinct resolutions run at once and at most 1,024 failures are remembered, resolutions still in flight counted against that 1,024; a request past either limit is refused without spawning `op`, and expired entries are dropped at the next access. This bounds a caller that re-enters the failure path to one `op` call per reference per minute; it also means that fixing the underlying cause (signing in, unlocking) and retrying the same reference inside that window is still refused. A *successful* resolution is never cached — the value may have rotated, so it is read again each time.

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
