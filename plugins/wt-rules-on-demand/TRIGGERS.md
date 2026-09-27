# On-demand rule frontmatter

Rules live at `<project>/.claude/rules-on-demand/*.md` or `<config dir>/rules-on-demand/*.md`.
Both directories are scanned at context creation. Project rules shadow user rules by basename.
Unknown trigger and compliance keys cause the file to be skipped and a diagnostic logged.

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

Compliance keys and examples: `kind: check` with `check: agent-model` or
`check: gate-background`; `kind: none` with `reason: not mechanically checkable`;
`kind: model` with `model: haiku` and `prompt: did the call follow the rule?`;
`kind: bash-command` with `act-regex: 'git push'`, `require-regex: 'origin'`
or `require-all: 'origin||main'`; `kind: test-before-edit` with
`test-regex: 'npm test'` and `path-regex: '\.ts$'`.
For the windowed kinds, `window: 3` and `on-close: not applicable` are required;
`flags: i` applies to compliance regular expressions. Rollback reads
`rollback-threshold: 0.8` and `rollback-min-samples: 5`.

Bash triggers mask read-only mentions by default; `mentions: true` opts out.
A rule is served once per main or subagent context, with independent counters;
compaction resets that loop. `time_reserve` explicitly opts into re-serving.
