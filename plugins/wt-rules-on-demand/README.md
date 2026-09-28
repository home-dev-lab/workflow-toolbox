# WT Rules on Demand (EXPERIMENTAL)

This Function Hooks plugin serves Markdown rule files when a matching tool call
or prompt happens. It is disabled by default (`enabled: false`); with no rules
in either on-demand directory it prints nothing and starts no quality job (apart
from the Function Hooks-disabled notice). Enable Function Hooks with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and set the plugin's `enabled` userConfig
to `true`. Claude Code exports this option to the startup hook as
`CLAUDE_PLUGIN_OPTION_ENABLED`; the same switch controls delivery and the daily
quality check. When rules exist but the switch is off, startup reports their count.
See [TRIGGERS.md](TRIGGERS.md).

Put rules in `<project>/.claude/rules-on-demand/*.md` or
`<config dir>/rules-on-demand/*.md` (`CLAUDE_CONFIG_DIR`, otherwise
`HOME/.claude`, or `USERPROFILE/.claude`). The `adopt` skill installs both rule
halves statically. Move only an `-at-act` half with its adjacent `.spec.json`:

```sh
node /path/to/wt-rules-on-demand/scripts/rules.mjs prove-triggers rule-at-act.md --project /path/to/project --spec rule-at-act.spec.json --transcripts /path/to/transcripts --output proof.json
node /path/to/wt-rules-on-demand/scripts/rules.mjs migrate rule-at-act.md --project /path/to/project --spec rule-at-act.spec.json --proof proof.json
```

An explicit `--no-proof "reason"` marks the rule unproven. `revert` returns a
rule to static; `retire <rule.md> --reason "reason"` archives it without deleting
its content. Only explicit CLI actions move rule files. The daily quality check
is always dry-run; results live at `<CLAUDE_PLUGIN_DATA>/quality/latest.json` when `CLAUDE_PLUGIN_ROOT` resolves to this plugin's own root,
otherwise at `<config dir>/plugins/data/wt-rules-on-demand/quality/latest.json`.
The separate main plugin's `wt-delegation-ladder-hook.mjs` inserts a fixed short
ladder summary on startup, not a rule file. Keep the ladder CORE half static;
only `-at-act` halves belong here. A duplicate static/on-demand basename is
reported as loaded twice and the on-demand copy is not served only when their normalised bodies match. Different bodies with the same basename are reported and served.

`before-first-act: true` refuses the first matching call with the rule text;
retrying passes. Ride-along rules accompany the result; declarative Bash-command
and tool-input checks measure that call, and model classification includes it.
The rule cannot guide that call's already-completed action. A model compliance
classifier is measurement-only and often answers “not applicable”. The
`agent-model` check counts a spawn without a `model` argument as not followed
even when an agent definition pins it.
`gate-background` recognises a fixed build-command vocabulary. A refusal on an
Agent spawn inside a subagent was missed in one real session (under investigation).
Store writes serialize within one process; concurrent sessions sharing a store
 may lose a measurement.

The first quality run reports "never" until a check finishes. Later startup
messages name incomplete coverage, unchecked scopes and dry-run rollback reasons.
The scanner can exclude historical delivery block names from runtime proof using
`WT_ROD_NON_PROOF_NAMES` (comma-separated); its CLI also accepts repeatable
`--non-proof-name`. This list is empty by default. Transcript-derived verdicts
drive the daily rollback decision, which stays dry-run. Legacy store rows without
a rule identity are counted and skipped by rollback. The report CLI accepts
repeatable `--rules-dir` to inspect an alternate rule tree.

Run `node /path/to/wt-rules-on-demand/scripts/daily-rollback.mjs` once a day
from a host timer or cron job; the plugin ships no scheduler. This entry point
checks the user rules and configured followed projects, and defaults to dry-run.
To permit evidence-gated reversions, pass `--apply` explicitly. A host can
inspect rules before deployment with `rules.mjs check-rules --dir <rules-dir>
--corpus <commands.json> --time-bound-ms 50`; each slow regex test is reported
and causes a nonzero exit.

Rule files are limited to 256 KiB (bytes) and regex subjects to their first
16 Ki characters, identically in the hook and transcript/proof matching. Refusal
deliveries, and the refusal itself, are detected across the first 256 Ki
characters of the result while stored result evidence remains limited to
16 Ki characters. Patterns with a repeated
group whose sole element is unbounded-quantified (such as `^(a+)+$`
or `(?:\d*)*`), or a repeated alternation with branches starting with the same
decidable literal character (such as `(a|ab)*`), are rejected at parse time.
Nested unbounded groups are also rejected, including repeated command-head
scanners with repeatable quoted/unquoted alternatives. Other ambiguous
character classes and repeated adjacent atoms are not checked. This is a
heuristic, **not** a proof of regex safety; other catastrophic patterns remain
possible. Further hardening is tracked separately. Run lifecycle commands
(`migrate`, `revert`, `retire`) single-writer per scope: do not run them concurrently
on the same scope. The lock file is a best-effort guard against accidental
overlap, not an exclusivity guarantee across processes or hosts. An apparently
dead local owner or remote owner older than five minutes may be reclaimed with
a warning; a held lock is reported after two seconds.
