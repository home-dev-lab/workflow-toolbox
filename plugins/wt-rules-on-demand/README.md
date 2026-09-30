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

Offline judgment (EXPERIMENTAL, measurement-only) uses separate files, never
the compliance store or rollback archives:

```sh
node scripts/judge-cases.mjs extract --projects-dir <config-dir>/projects --rules-dir <rules-dir> --out <judge-output-dir>
node scripts/judge-cases.mjs judge --cases <path-printed-by-extract> --out <judge-output-dir> --model haiku
node scripts/judge-cases.mjs score --judges <path-printed-by-judge> --labels labels-a.jsonl --labels labels-b.jsonl
```

`extract` accepts repeatable `--projects-dir`, `--transcript` (including
`subagents/*.jsonl`), `--rules-dir`, optional `--rule <substring>` and
`--from-verdicts <jsonl>`. Each unmatched existing verdict is reported on stderr.
The served body is retained alongside the current rule file hash. The historical
trigger is provisionally evaluated from the last committed version of the rule
at or before the serve timestamp; the case names that commit. A commit alone
does not prove which trigger was active in the session. Missing history, an
ambiguous owner, a malformed record, or an evaluator error similarly makes
`triggerState` unknown. An owned, non-empty excerpt with only provisional
historical trigger provenance can reach the model with that uncertainty named;
ambiguous ownership or missing evidence is code-decided `undecidable`.
For each governed call the excerpt includes its preceding prompt and assistant
text, arguments and result, with compaction markers and line-numbered gaps.
Arguments/results are capped at 1,200 characters each and the excerpt at 12,000
characters; the case records truncation and dropped-act count. Only the model
can return `not applicable`, on non-empty evidence; code never decides a negative.
The extract summary compares raw served blocks to cases produced, including
serves beyond the quality scanner's refusal bound.
`judge` defaults to concurrency 2 (override `--concurrency`) and writes under
`<config-dir>/plugins/data/wt-rules-on-demand/judge/` unless `--out` chooses a
directory. Every extract and judge run creates a new exclusive file in a fresh
run directory and prints its path. To resume, pass the previous judge file as
`--previous <file>`; a new output file contains only the remaining cases.
It checks the installed CLI's `--help` for the isolation flags before invoking
`claude -p` with zero tools and a temporary cwd. Override the binary with
`--binary` or `WT_ROD_JUDGE_CLI`. `--config-dir` selects output and lookup
locations only. Supply a separate, disposable authenticated Claude profile with
`--judge-config-dir` or `WT_ROD_JUDGE_CONFIG_DIR`: create that directory and
authenticate the Claude CLI against it beforehand (for example, run the CLI's
login command with `CLAUDE_CONFIG_DIR` set to that directory). Neither the CLI
help probe nor the judge process inherits the caller's credentials, identity,
model overrides, hooks, plugins, or config directory. Existing files and
symlinked output directories are refused. Labels have
`caseId`, `label` and `labeller` (include `rule` for per-rule reporting when a
case lacks a judge row); score counts every multiply-labelled case for agreement,
but only agreed cases with judge rows for precision/recall. A judge file with
multiple predictions for one case (for example, changed evidence or two model
runs) must be split before scoring.

### In-hook verdict measurement bound

Each served compliance window now has a `deliveryId`, `deliverySeq` (taken at
injection) and `servingSeq` (the serving call's admission). Its journal entry
and any window verdict share those fields. Every verdict has a `verdictId` and
`actSeq` (the deciding call's admission, or a lifecycle close sequence). A
per-act verdict can list windows it ended in `discharged`; turn end, compaction
and eviction record a context `lastClose`. Sequence numbers are process-local;
the ID prefix identifies that process's registration. No new store key is used.

The readers join by ID and session before counting. Identical `verdictId`s
within a session are storage copies; legacy rows without IDs remain counted.
Rows without a `verdictId` create no delivery claims, even if they carry delivery fields.
For each delivery, three rules apply: a delivery with **zero surviving claims**
is unjudged; for **multiple claims**, the earliest valid `actSeq` wins (then
decision time and input order), dropping other own-claim rows; a claim with
`actSeq < deliverySeq` is void unless that act served the window. A dropped row
loses its other discharge claims too. `compliance-report.mjs` adds `unjudged`,
`duplicateRows`, `discarded` and `copies` per rule, appending these columns to
the text output. `rollback-check.mjs` filters in-hook verdicts through the same
join before applying its usual identity and rollback rules, and reports dropped
row totals to stderr. On a legacy store, the new counts are zero.
When reading multiple stores, shared session contexts retain all journals,
deduplicating entries with a delivery ID while retaining ID-less entries. Close
markers keep the larger sequence within a registration, or the later timestamp
across registrations.

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
The legacy timestamp-based `JOIN` remains for comparison. `EXACT` reports the
archive reach bound, `archivesRead`, `outOfReach`, MAIN `withId` and `withoutId`,
`duplicateIds`, `discardedIds`, `voidedIds`, `conflicting`,
`unjudgedSettled`, `unjudgedOpen`, `dischargedBySameAct`, agent settled/open
and duplicate/discarded buckets, `copies`, `legacyIdenticalLines`,
`withoutDelivery` (`sessionMissing`, `idMissing`) and `ambiguous`. Each bucket
has a count, denominator and rate. The headline `anomaly` is the union of
MAIN duplicate, discarded, conflicting and settled-unjudged deliveries divided
by reachable MAIN deliveries with IDs; `anomalyUpper` additionally includes
open windows, agents, voided deliveries and unmatched IDs. `--seed-control`
checks duplicate, settled, open and copied-row counter changes.
The duplicate and settled controls also require the headline anomaly count to
increase by exactly one; open and copy controls require it to stay unchanged.
Every control checks that the baseline and seeded headline rate equal count
divided by denominator, with no rate (null) when the denominator is zero.
The open control seeds the newest retained MAIN context after all its retained
close markers and existing verdict acts.

When stores share a context, their close markers are retained by token, keeping
the highest sequence for each token. Any retained marker can settle a delivery:
a same-token marker must have a greater sequence, and a different-token marker
must have a strictly later timestamp. This classification is independent of
store order; `lastClose` remains readable as a representative marker.

Archived verdict rows bound what is observable: deliveries older than the
oldest archived decision are `outOfReach`, rather than unjudged. A context's
later close (or a newer MAIN generation) distinguishes settled missing verdicts
from open windows; `open` also includes a process that died without a later
close. The settled classification assumes one live process per session context.
An already-written evaluate verdict may precede a same-act window drop;
that delivery remains visible as unjudged. Serial calls issued together in one
model message cannot be distinguished from later calls; a call that only
consumes a window count writes no row for the act-before-delivery check, and a
refused call can settle other rules' windows. Legacy serves without IDs cannot
be joined exactly. Each verdict row grows by roughly 100 bytes, bringing
rotation at the 3.5 MB limit sooner and shortening the history held by 14
archives. The script prints these limits on every run.

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
