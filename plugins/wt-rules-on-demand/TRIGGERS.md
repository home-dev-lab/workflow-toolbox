# On-demand rule frontmatter

Rules live at `<project>/.claude/rules-on-demand/*.md` or `<config dir>/rules-on-demand/*.md`.
Both directories are scanned at context creation. Project rules shadow user rules by basename.
Unknown trigger and compliance keys cause the file to be skipped and a diagnostic logged.
An unregistered `check` name does not prevent delivery: the rule is served and records
`unregistered check` with the name as its reason. Audit all files with
`node scripts/rules.mjs check-rules --dir <rules-on-demand directory> [--corpus <commands.json> --time-bound-ms 50] [--json]`.
The corpus is an array of commands (strings or objects with a `command` field);
each Bash/tool trigger and compliance regex is timed on every entry. Any test
exceeding the per-test bound reports `slow` and exits nonzero.

```yaml
---
on-demand:
  triggers:
    - kind: 'bash'
      regex: 'git\s+push\b'
      flags: 'i'
      mentions: false
      before-first-act: true
    - kind: 'tool'
      tool: '^Agent$'
      input-regex: '"model"'
      unconditional: false
    - kind: 'path'
      tool: '^(Edit|Write)$'
      regex: '\.ts$'
    - kind: 'prompt'
      regex: 'review this'
  compliance:
    kind: 'bash-command'
    window: '3'
    on-close: 'not applicable'
    flags: 'i'
    act-regex: 'git\s+push'
    require-regex: 'origin'
    rollback-threshold: '0.8'
    rollback-min-samples: '5'
---
The actual rule text starts here.
```

Trigger keys: `kind` chooses bash/prompt/tool/path; `regex` matches the command,
prompt or path; `tool` matches the tool name; `flags` supplies regular-expression
flags; `unconditional: true` allows a tool trigger without `input-regex`;
the JSON boolean is canonical in migration specs; strings `"true"` and `"false"` are also accepted.
`input-regex` narrows a tool trigger to its argument JSON.
`detector` names a registered, environment-dependent predicate on a tool trigger;
registered detectors: `lsp-symbol-grep`. The tool regex, optional `input-regex`,
and detector must all agree. Unknown names and detectors on other trigger kinds
skip the file with a diagnostic. A detector failure is journaled as a trigger
error and never causes a refusal, even on regex-budget exhaustion. This detector
uses Grep's symbol-shaped pattern and the resolved language-server extensions of
enabled plugins, then removes the extensions in `<config dir>/lsp-hint-skip.json`.
Its availability scan is shared for identical config, canonical cwd and
environment inputs within a context, rescanned when those inputs change,
retried after a failed scan and refreshed after compaction. Unrecognized
target glob syntax, including exclusions, does not qualify for refusal.

```yaml
---
on-demand:
  triggers:
    - kind: 'tool'
      tool: '^Grep$'
      detector: 'lsp-symbol-grep'
      before-first-act: true
  compliance:
    kind: 'next-call'
    tool: '^(?:LSP|Grep)$'
    require-tool: '^LSP$'
    window: '3'
    on-close: 'not applicable'
---
Use the language server for symbol navigation.
```

`next-call` judges the first later call whose tool matches `tool` when that
call starts: `followed` if it also matches `require-tool`, otherwise `not
followed`. A refusal, denial, drop or error after the start does not undo
that choice. Every later call consumes one window unit, even if its tool does
not match. Exhaustion without a match, turn end or compaction records
`on-close`; a terminal window is recorded only once. The live store is
authoritative: transcripts cannot reconstruct either the window or detector
availability. Proof reports detector triggers as environment-dependent and
unprovable from transcripts, rather than counting apparent Greps as matches.

`mentions: true`
includes read-only Bash mentions; `before-first-act: true` refuses a matching
tool call once, delivering the rule text for a retry. Otherwise the rule rides
along on the result: the call is already complete, though declarative checks
measure it and model classification includes its arguments.
`command-head: true` on a Bash trigger matches `regex` at each executable
segment head, after assignments and wrappers (`env`, `timeout`, `setsid`,
`nohup`, `nice`, `exec`, `command`, `stdbuf`) and inside `sh -c`/`bash -c`.
For example, `regex: '^runner run\b'` matches `timeout 30 runner run`
but not `echo "runner run"` or a commit message.

Compliance keys and examples: `kind: check` with `check: agent-model` or
`check: gate-background`; `kind: none` with `reason: not mechanically checkable`;
`kind: model` with `model: haiku` and `prompt: did the call follow the rule?`;
`kind: bash-command` with `act-regex: 'git push'`, `require-regex: 'origin'`
or `require-all: 'origin||main'`; `kind: test-before-edit` with
`test-regex: 'npm test'` and `path-regex: '\.ts$'`.
`bash-command` optionally accepts `exempt-regex: '^lane-run\b'` to mark
matching executable segments `not applicable`; its requirements are checked
per segment, not against the entire shell command. `forbid-pipe: true` makes
a segment piped to another command a violation.

Declarative checks use the same window and close keys:

```yaml
  compliance:
    kind: 'tool-input'
    tool: '^mcp__chat__speak$'
    require-input-regex: '"reply_to"\s*:\s*"[^"]+"||"mentions"\s*:\s*\[[^\]]+'
    window: '1'
    on-close: 'not applicable'
```

`require-input-regex` separates required patterns with `||`; every pattern
must match bounded JSON argument evidence. `require-any-input-regex` matches
at least one `||`-separated alternative. Optional `forbid-input-regex` disallows matching argument evidence,
`absent-input-key` requires that input property be absent (even if false), and
`path-regex` narrows the check to file-path arguments.
`input-field` selects a text argument (or `edit-text` for content/new_string/edits;
`||` chooses the first present key). `mask-code: true` removes fenced/inline code
and leading frontmatter. `when-input-regex` makes a nonmatch ungoverned;
`each-line-regex` validates each selected line, while `match-block-regex`
captures each block as group 1 and validates each independently. The optional
`minimum-input-key` / `minimum-input-value` pair checks a numeric argument;
`reject-bash-regex` marks matching executable Bash segments as violations.
For values that can occur in the
same turn as a subject creation, use `turn-correlation` with `tool` (subject
name regex), `id-regex` (capture group 1 over result, then input fallback),
`follow-up-tool` and/or Bash `act-regex`, `value-regex` (capture group 1), and
positive `min-distinct`. For example:

```yaml
  compliance:
    kind: 'turn-correlation'
    tool: '^mcp__board__create_card$'
    id-regex: '"id"\s*:\s*"?(\d{6,})'
    follow-up-tool: '^mcp__board__add_label$'
    act-regex: 'add_label\b'
    value-regex: '"labelId"\s*:\s*"?([^"\s,}]+)'
    min-distinct: '3'
    window: '1'
    on-close: 'not applicable'
```

Only successful result-bearing follow-ups count; shell `for` loops over
values count their listed iterations when the loop's tool result succeeds.
Open turns and missing subject results are recorded as `unresolved`.
`subject-input-key`/`subject-input-regex` narrow which subjects are governed;
`identity-pair: true` requires a later successful follow-up addressed to the
captured subject identity, with that same identity captured from its message.
For the windowed kinds, `window: 3` and `on-close: not applicable` are required;
`flags: i` applies to compliance regular expressions. Rollback reads
`rollback-threshold: 0.8` and `rollback-min-samples: 5`.

Bash triggers mask read-only mentions by default; `mentions: true` opts out.
A rule is served once per main or subagent context, with independent counters;
compaction resets that loop. `time_reserve` explicitly opts into re-serving.
Compliance windows still pending when the reset runs close with its reason. A
`next`-call window is decided by the call that follows it before anything else
runs, so the first tool call after a compaction the plugin has not yet seen still
decides the windows opened before it; only the windows left pending close with
the compaction reason.
Where the host does not hand `session.compact` to the plugin (a host may forward
it past every plugin a person installs), the main loop finds the compaction in the
session's transcript: the host writes a `compact_boundary` row there for every
compaction, manual or automatic. When the main context is created, the loop notes
where the transcript ends (the end of its last complete line) and never reads what
came before: only boundaries written after that point count. It notes that end
before it reads the conversation for the rules it already holds, so a compaction
that lands between the two leaves a boundary after the noted end. It then reads the rows
added since its last look at every main turn end and, earlier, when the live
window's input tokens are lower than the last reading that had them, or absent
after one (absent counts once, until a reading has tokens again). Only the first
such sign of a turn reads the transcript. While a rule counts as served (held in
the conversation, or served since the last reset), the first triggering event after
a turn end also reads it when no reading has completed since that turn end, so a
boundary written just after a turn-end reading that found nothing, with no sign,
is found before a served rule is withheld. That costs at most one more child per
turn, only in turns where a rule is served, and one when a context is created over
a conversation that holds a rule block; it waits for a reading in progress and is
bounded by the same deadline. Because the host writes the row a little
after the compaction ends, a sign whose reading finds nothing, and every
dispatched `session.compact` of the main loop, starts a re-scan plan: readings
after 0.1, 0.3, 0.7, 1.5, 3.1 and 6.3 seconds. The plan ends as soon as it found
the boundaries it waits for, after its last reading, or 10 seconds after it
started, whichever comes first; a turn end does not end it, and a request made
while it runs joins it rather than starting a second one. A boundary row the loop
has not seen resets the loop as above under the reason `compaction-detected`, so
a compaction is caught at the latest at the end of the turn it happened in, or by
the plan when the row lands after that turn end. What the conversation says
decides nothing: a summary that quotes a served rule does not hide the compaction,
and a block another plugin rewrote, or the host split, with no compaction never
resets anything. A boundary counts once by its identifier. Each reading checks
that the file is the same one (device and inode), at least as long as where the
last reading stopped, and that the 64 bytes before that point are unchanged; when
any of these fails (the transcript replaced, truncated, or truncated and written
again past the old point) it is read again from its start, and there only
boundaries dated after the previous reading began, less 5 seconds, count; when that
re-read stops at its time budget, the readings that continue it keep the same date
filter until one reaches the length the re-read started from; a row
rejected there is not remembered, so the same row written later past the cursor
still counts. On every other reading the row's date plays no part, so a clock set
back does not hide a boundary. Every reading also reads the session id: when it
changed (`/clear` on a host that does not hand the plugin `prompt.context`), the
new session's transcript is noted where it ends and the loop resets under the
reason `session-changed`, journaled under the new session (with any compliance
window it closes). A new id that names the same file (same device and a non-zero
inode) is the same conversation: the id is adopted, the reading continues where it
stood, and nothing resets. Where the filesystem reports inode 0, no two files are
taken for one: a new id always resets and reads the new path. The transcript is
`<config dir>/projects/<session root with every character outside A-Z, a-z, 0-9
and - replaced by ->/<session id>.jsonl`; when it is not there (after `/cd`, or a
path the host shortens), the file named `<session id>.jsonl` is looked for in
every project folder. The reading runs `node` on the plugin's
`scripts/compact-boundary.mjs` as a child process, under a 5 second limit, which
reads only the bytes added since the last reading, for at most 3 seconds: past
that it stops at the last complete line it read, and the next reading resumes
there. A line longer than 256 KiB is skipped, never held (a boundary row is about
1.5 KB), and the next reading resumes past the bytes it dropped, even when a
reading's budget ends inside that line. One reading runs at a time: while a
reading's child is still running past its deadline, a reading reads nothing and
starts no second child. The transcript reading's deadline also covers its
preparation (the session id, root and environment reads): a preparation past it
never starts a child, frees the context for the next reading, and pauses the
readings until the next turn end, so a host read that never answers costs one
deadline per turn. A host that
cannot start a child run reads nothing and says nothing; a transcript that cannot
be read prints one progress line and loses nothing once the loop has noted where
the transcript ended, since the next reading starts where the last good one
stopped; when the transcript cannot be read at the moment the context is created,
the end is noted at the first good reading, and a boundary written before it is
not seen (a dispatched `session.compact` still resets). Each host read on this
path, the live window included, counts as unreadable when it has not answered
within its deadline (2 seconds, 6 for the transcript reading); a live-window
reading past it pauses the mid-turn readings, with one progress line, until a turn
end reads the live window again. Both resets share one queue with
`session.compact`, and one compaction resets once: a dispatched `session.compact`
waits for a reading in progress, and when a boundary was found with nothing served
since, it is skipped; the next boundary found after a dispatched `session.compact`,
within 10 seconds, is that compaction's own, not a second one; every other new
boundary resets. Sub-agent contexts are not checked this way: they end with their turn,
and a sub-agent's own boundary rows are ignored. Each context's journal counts its
resets per reason (`resets`).
Verdicts retain the measurement's opening time (`injectedAt`) and trigger channel; model classification
uses bounded call arguments (including the triggering tool call for tool-delivered
model rules), while persisted verdict evidence keeps only a command head or file
basename. Served `bash-command` and `tool-input` rules judge each matching act
once through compaction, even after their initial window expires; turn-correlation
records only when its rule was served in that context.

Later matching acts do not receive the rule text again. Model rules open a
measurement window for each later matching act, with the same prompt and
`window` budget as the original injection. Each nonempty window costs one more
`$.model.classify` call at close; the judge never decides whether an act may run.
An unchanged retry after the first-act refusal supplies evidence to the
original window, rather than opening a second window for the same act.

Every verdict includes `applicability`: `applicable` (followed or not followed),
`not applicable` (a real act was exempted by the check or judge), `no act`
(nothing for the check to judge), or `unknown` (other outcomes). Empty model
windows close without a judge call. Initial records use `later: false`;
later model, declarative, named-check and turn-correlation records use
`later: true` plus `servedDeliveryId`, the original text-delivery ID. A named
check or a turn-correlation rule has no delivery window: its first record in a
context is the initial one, whatever channel served the text. The reference is
`null` when the text was recovered from conversation history or delivered
without a delivery id. It is a reference, not a claim that the text was
delivered again.
