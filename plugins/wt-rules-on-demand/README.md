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
Store writes serialize within one process. Health counters accumulate in memory
and flush per turn (also after 60 seconds, 50 calls, or an error); at most one
turn of counters may be lost if the process dies before a flush. Concurrent
sessions sharing a store may lose a measurement: health and served counters
remain **lower bounds** under concurrent sessions.

`quality-check.mjs` adds reporting-only continuous measures to `quality-DATE.json`
and `latest.json`: per-rule trigger misses (unmatched/engine/unattributable),
delivery noise, served versus static bytes (tokens estimated as bytes/4),
scanner-check coverage, migration and adopted-copy drift, unserved follow-through
(delete candidate), served violations (guard candidate), and a volume-based
recheck. Global coverage separates governed acts lacking a scanner check from
unmatched act candidates; engine health includes daily errors, slow calls and
store growth. Suggestions are proposals, never file operations. Each result
uses rule identity `scope:rulesDir:rule`. The raw scan evidence is archived in
`measure-rows-DATE.jsonl` alongside verdicts (14 dated files retained per kind);
`measures-state.json` keeps the stable act IDs seen in the current scan window,
pending new acts, and last run/evaluation times per rule. First run evaluates
all rules; later runs re-evaluate after `--volume N` new observable acts (default
20). A run gap longer than the scan window is reported without stopping accumulation.
Static cost includes only contexts with a timestamp inside that window; undated
contexts are reported separately. Health windows are whole UTC days, include
today, and flag requests beyond the 31-day retained history. Missing health from
any scanned config directory is listed as unrecorded. Conflicting shipped
fingerprints across applicable plugin installs make adopted drift unknown.

Rule verdicts are `OK`, `watch`, `problem`, or `unknown`: `watch` has 1–4
cases and prints **counts only**, never a rate; `unknown` means evidence cannot
decide (including missing health, source or migration history). A rule without a
scanner check reports unmeasurable misses/noise. `--strict-measures` makes the
quality-check CLI exit **3** on incomplete/unknown/watch measures or **4** when
any rule or engine health is a problem (4 takes precedence). Without the option
the daily job retains its previous exit behavior.

The first quality run reports "never" until a check finishes. Later startup
messages name incomplete coverage, unchecked scopes and dry-run rollback reasons.
The scanner can exclude historical delivery block names from runtime proof using
`WT_ROD_NON_PROOF_NAMES` (comma-separated); its CLI also accepts repeatable
`--non-proof-name`. This list is empty by default. Transcript-derived verdicts
drive the daily rollback decision, which stays dry-run. Legacy store rows without
a rule identity are counted and skipped by rollback. The report CLI accepts
repeatable `--rules-dir` to inspect an alternate rule tree.

### In-hook verdict measurement bound

In-hook verdict rows can miss or repeat the verdict of a compliance window whose
settlement races another handler of the same context: concurrent tool calls
closing the same window, or a compaction, MAIN context replacement or turn
completion arriving while a handler of that context is suspended. A lost window
costs one verdict; a repeated one adds one extra verdict per overlapping handler
that closes it, so the error is not bounded by one when many calls overlap.
`scripts/compliance-report.mjs` counts and the follow rate it reports move by
those samples. Follow rates that `scripts/rollback-check.mjs`
reports from in-hook rows move the same way.

Automatic rollback is unaffected: when `scripts/daily-rollback.mjs` applies
(`--apply`), it invokes `scripts/rollback-check.mjs` with `--mechanical-only`
and transcript verdicts.
For the transcript-measured kinds (`check`, `bash-command`, `tool-input`,
`turn-correlation`), transcript rows replace in-hook verdicts. For any other
kind, `--mechanical-only` returns `attention`, never an automatic revert.
A manual `scripts/rollback-check.mjs` run without `--mechanical-only` is
different: it takes every rule's rate evidence from in-hook rows when `--verdicts` is absent,
and the kinds the transcript does not measure (for example `model` and
`next-call`) from in-hook rows when it is present; without `--dry-run` it
can revert, so near a rule's threshold such a shift can change the outcome.

Measure retained serves against verdicts in a read-only snapshot with:

```sh
node scripts/serve-verdict-reconcile.mjs --store /path/to/store.json --archives /path/to/archives --seed-control
```

With `--store`, only the archives named by `--archives` are read; without
`--store`, the store and archives of the current config directory are read.
The store retains only recent session journals: verdicts of a session that is
no longer journalled are counted as unjoinable. The join is a timestamp
heuristic, not an identity: rows carry no delivery ID, no decision ID and no
MAIN context generation, so close re-serves, identical-key verdicts and legacy
journal entries without a rule identity cannot be attributed with certainty.
The script prints these limits with every run.

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
