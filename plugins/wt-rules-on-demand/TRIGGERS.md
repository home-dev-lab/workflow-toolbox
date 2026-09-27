# On-demand rule frontmatter

Rules live at `<project>/.claude/rules-on-demand/*.md` or `<config dir>/rules-on-demand/*.md`.
Both directories are scanned at context creation. Project rules shadow user rules by basename.
Unknown trigger and compliance keys cause the file to be skipped and a diagnostic logged.
An unregistered `check` name does not prevent delivery: the rule is served and records
`unregistered check` with the name as its reason. Audit all files with
`node scripts/rules.mjs check-rules --dir <rules-on-demand directory> [--json]`.

```yaml
---
on-demand:
  triggers:
    - kind: 'bash'
      regex: 'git\s+push\b'
      flags: 'i'
      mentions: 'false'
      before-first-act: 'true'
    - kind: 'tool'
      tool: '^Agent$'
      input-regex: '"model"'
      unconditional: 'false'
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
`input-regex` narrows a tool trigger to its argument JSON; `mentions: true`
includes read-only Bash mentions; `before-first-act: true` refuses a matching
tool call once, delivering the rule text for a retry. Otherwise the rule rides
along on the result (and cannot govern the call it rode on).
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
per segment, not against the entire shell command.

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
must match bounded JSON argument evidence. For values that can occur in the
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
For the windowed kinds, `window: 3` and `on-close: not applicable` are required;
`flags: i` applies to compliance regular expressions. Rollback reads
`rollback-threshold: 0.8` and `rollback-min-samples: 5`.

Bash triggers mask read-only mentions by default; `mentions: true` opts out.
A rule is served once per main or subagent context, with independent counters;
compaction resets that loop. `time_reserve` explicitly opts into re-serving.
