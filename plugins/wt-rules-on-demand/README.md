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

## Agent types that are never refused

Set `WT_ROD_NO_REFUSE_AGENT_TYPES` to the exact agent type names whose tool calls
should skip this plugin's refusal round. Matching rules are still delivered
with the call's result. The trade-off is that the rule arrives **after the act**
and cannot guide that first action. The main loop is never affected; unlisted
and unknown agent types keep the usual refusal behavior.

Put the list in the project's `.claude/settings.json`, or in
`.claude/settings.local.json` for a personal, uncommitted choice:

```json
{ "env": { "WT_ROD_NO_REFUSE_AGENT_TYPES": "my-agent,other-agent" } }
```

The value is one comma-separated string. Names are trimmed, case-sensitive,
and matched exactly; empty entries are ignored. There are no patterns or
wildcards: `"*"` matches only an agent type literally named `*`. An absent or
empty variable means no exemptions. Each project sets its own list; a project
without the variable keeps every refusal.

This uses an environment variable because the host ignores plugin options from
project settings. Project `env` values apply once the folder is trusted. There
is no plugin option for this list. The hooks module has no Node.js globals, so
it reads the variable through the host's environment API each time a spawn or
a refusal needs it, never at load time.

While the engine is enabled, every SessionStart (including resume, clear, and
compact) with a non-empty list prints
`wt-rules-on-demand: rules served after the act for: my-agent, other-agent`
with the configured names. An empty or absent list, or a disabled engine,
prints no such line.

Types are learned from `agent.spawn`, including workflow agents and resumed
agents. After a module reload, a subagent or teammate spawned earlier can be
resolved through `$.agent.list()`. Workflow agents are not in that list, so
one spawned before the module loaded stays subject to refusal unless a later
spawn or resume supplies its type. Identity tracking keeps up to 256 identities,
dropping the earliest recorded first; an evicted identity also needs this fallback.
Only positive lookups are cached. Concurrent lookups for one identity share a
request; unavailable, missing, or timed-out types stay refused and are retried
on the next refusable call. Newer spawn evidence takes precedence over an older
lookup. Once a newer environment read has applied, older reads cannot restore
stale settings. Learned identities reset only when the parsed set of configured
types changes.
Each waived refusal is logged once for that call.

## Delivery and lifecycle

A separate command hook announces when the host unloads the rules-on-demand
engine because its hooks worker was terminated: no at-act rule is then served
or refused. It announces on the next user prompt, session start, or Agent, Task
or SendMessage tool call; hook input over 64 KiB is skipped. The announcement
ends after this plugin's manifest reload, a `/reload-plugins` summary
(it names no plugin), or a fresh process (restart or resume); observed engine
serving or an unconfirmed-call harvest line also confirms recovery. Evidence is
interpreted in transcript order; an unload row does not identify whether the
worker was terminated for a heartbeat miss or repeated hook-budget overruns.
A sub-agent tells its main session. Warnings repeat at most every ten minutes,
but always after compaction while unloaded. Detection scans only the last 4 MiB
on first use, then new complete rows (at most the last 16 MiB per scan); unloads
outside those bounds are not observed. This hook only announces the loss.

Each event hook settles when the host aborts `next.signal`; a signal already
aborted on entry starts no work. A running body continues detached, with its
rejections observed and its recorder slot held until that body actually ends.
Without an abort, the downstream answer or error is preserved.

While enabled, the engine writes small event breadcrumbs under
`<config dir>/plugins/data/wt-rules-on-demand/inflight/`, reusing at most 32 slots
per session across reloads. Coverage is bounded at 32 concurrent calls per
session: a 33rd concurrent call gets no breadcrumb. Completed and harvested
slots are marked in place. Across sessions, the command-hook detector deletes
files whose modification time is over seven days old, inspecting at most 200
files per detector run and advancing a sweep cursor on later runs. Expired
files beyond that batch remain until a later run. Directory enumeration and
sorting still cover the entire directory; pruning also runs if saving watcher
state fails. The cursor lives in `inflight/`, independently of watcher-state
writes, and is ignored by the recorder. A “call did not confirm completion”
progress line after reload means an earlier load left that session's event in
phase `work` or `finally`. Neither phase proves an interruption: a completed
call's trailing writes may not have landed. These lines name the work, tool,
last phase, input-character estimate and start time. Announcements are
at-least-once: the line is logged before marking the slot, and a failed mark
can produce a duplicate line after reload.
The recorder reuses the config directory and session identity resolved by the
engine's own rule loading and journaling; it makes no separate environment or
session-identity reads. Setup scans and marking run in the background after
those values are available. A call made before setup finishes is unrecorded,
including the call that first resolves them. Hooks never wait for recorder
setup or writes: the recorder adds no await or diagnostic read before serving
starts. Once ready, it dispatches the entry breadcrumb write before serving,
but nothing makes that breadcrumb reach disk before the work. A worker loss
can therefore leave no evidence of a call whose write never landed. Finally
and completion writes stay ordered behind the entry write in the background,
with one retry on a failed completion write. Hosts without `fs.write` disable
recording for that module load. Failed own-slot reads leave the background
scan retryable by a later event. Harvest
only merges rows into the pending health batch; it never takes the engine's
shared write turn or issues a store operation. The engine's normal flush
persists the batch. Recorder diagnostics must never stall serving; announcement,
marking and health persistence are best effort rather than one atomic operation.
The health record's `interruptedCalls` retains the newest 20 such events, and
`slowestCalls` lists today's ten longest completed calls in descending wall-time
`ms`, with `work`, `tool`, `inputChars` and completion time `at` (UTC).

Put rules in `<project>/.claude/rules-on-demand/*.md` or
`<config dir>/rules-on-demand/*.md` (`CLAUDE_CONFIG_DIR`, otherwise
`HOME/.claude`, or `USERPROFILE/.claude`). The `adopt` skill installs both rule
halves statically. Move only an `-at-act` half with its adjacent `.spec.json`:

```sh
node /path/to/wt-rules-on-demand/scripts/rules.mjs prove-triggers rule-at-act.md --project /path/to/project --spec rule-at-act.spec.json --transcripts /path/to/transcripts --output proof.json
node /path/to/wt-rules-on-demand/scripts/rules.mjs migrate rule-at-act.md --project /path/to/project --spec rule-at-act.spec.json --proof proof.json
```

A user-scope `migrate --user` first runs a refusal-only static pre-filter in every
profile it writes to (`--config-dir`, each `--mirror-dir`). A non-refusal does not
prove the engine loads or delivers rules: migration is provisional until the engine
is observed serving the rule in that profile. The command reports this limit per
checked profile on stderr, alongside its other `rules:` diagnostics; the stdout
`migrated …` summary is unchanged. It reads the platform's
managed settings first: Linux `/etc/claude-code/managed-settings.json`, macOS
`/Library/Application Support/ClaudeCode/managed-settings.json`, Windows
`C:\Program Files\ClaudeCode\managed-settings.json`, plus visible `*.json` files in the
sibling `managed-settings.d/` directory. Names starting with `.` are ignored.
Absent files/directories are normal;
unreadable directories, dangling policy links, and unreadable or invalid files
are refused by path. Managed values override user values, and sorted drop-ins
override the managed base file. The effective `disableAllHooks: true`
refuses migration. An engine identity disabled in `enabledPlugins` or its
`pluginConfigs["<id>"].options.enabled` cannot authorize migration; a disabled
obsolete identity does not veto an affirmatively enabled replacement. Effective
`pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly: true`,
`allowManagedHooksOnly: true` also
refuse: local evidence does not establish an organization-managed deployment of
this user-installed engine. A top-level `allowManagedModsOnly` is not the guard
option. The effective guard option is checked with managed precedence, like engine
options, but this security guard is managed-only policy: a user guard option alone
does not establish it. `--assume-loaded` remains accepted and recorded in the migration ledger
for compatibility, but does not waive any decision check. Historical health is
never read by this checker and cannot change an outcome.
Effective `disableSideloadFlags: true` refuses inline (`--plugin-dir`)
or unknown engine sources, even with that flag. Installed-source evidence requires
the profile's user installation record and a readable engine manifest whose version
entry sits in its plugin cache (the entry may be a link to a development checkout);
stale records are skipped so later valid records can supply evidence.
Current enabled installations are examined even when old inline health exists;
this check does not call cached plugins organization-managed.
User and managed keys examined by this checker must have their documented boolean/object
types (and the Function Hooks environment flag must be a string); wrong types
refuse with the file, full key path and found type.
Every accepted profile must have a readable user or managed
`pluginConfigs["<serving id>"].options.enabled: true`. The manifest default is
false: missing or malformed enablement is refused even with historical health or
`--assume-loaded`. Readable user/managed settings must list an installed plugin in
`enabledPlugins`, and its installation record and cached manifest must establish
presence. An inline identity instead needs a readable engine manifest at the
running profile's `CLAUDE_PLUGIN_ROOT`; a plugin directory alone does not replace
affirmative enablement. These manifest checks match the engine name only; they do
not validate the loader's schema or hook modules. Even a name-matching manifest
with a string-valued `keywords` field passes the presence check although Claude Code
cannot load it. With neither installed nor inline manifest evidence, migration
is refused. Function
Hooks must be on: Claude Code 2.1.287 and later load mods by default (the running
version is read from the `CLAUDE_CODE_EXECPATH` and `AI_AGENT` variables Claude Code
sets for its commands); an older or unknown build needs
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. A readable user/managed environment value
takes precedence over the process value. Process evidence applies only to the profile
named by `CLAUDE_CONFIG_DIR`, otherwise `HOME/.claude` or `USERPROFILE/.claude`,
compared by resolved real paths. The migrating process cannot establish another
profile's launch version or environment, including a foreign `--config-dir`:
that profile needs the variable in its own readable user/managed settings.

### Pre-launch verification limits

`--settings`, launch flags (`--safe-mode`, `--bare`, `--setting-sources`, which can
exclude user settings), project/local settings of whichever repository is opened,
macOS MDM, Windows registry and server-delivered policy are **not decidable before
launch** by this checker. An inherited version/Function Hooks environment after
`CLAUDE_CONFIG_DIR` or HOME is rebound is also not decidable before launch; realpath
comparison alone does not establish where that inherited evidence originated.
See the tracked follow-up **migration proven by observed serving** for these
launch-time conditions. Refusals/warnings name unexamined sources; they do not
establish that the effective launch policy permits the engine. Verify effective
settings for every intended launch; earlier activity proves only the launches
that wrote it.

Affirmative enablement in readable managed settings can leave a profile unrefused
before its first activity, even with an absent user settings file. An existing
invalid or unreadable user file, including a dangling settings link, refuses by filename. Enablement
delivered only through unexamined launch-time policy still needs the observed
serving follow-up.

Repeat `--mirror-dir <dir>` for each mirror, and `--assume-loaded <dir>` for each
hand-verified profile. One flag value is one literal path, including commas;
comma-separated lists are not supported. This also applies to `revert`,
`rollback-check.mjs`, and `daily-rollback.mjs` mirror flags. A mirror sharing the
primary's static `rules/` directory but using separate `rules-on-demand/` storage
is refused before a migration moves anything. Share both directories (with the
on-demand target already present), or use separate static directories with
per-file links, before migrating. The command does not repair or rewrite a
user-owned mirror layout.

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
retrying passes. Refusal, ride-along and prompt delivery omit only a recognized
first-line adopt provenance stamp and its following one or two line breaks;
all other body text, including HTML comments and named markers, is preserved.
Ride-along rules accompany the result; declarative Bash-command
and tool-input checks measure that call, and model classification includes it.
The rule cannot guide that call's already-completed action. A model compliance
classifier is measurement-only and often answers “not applicable”. The
served text is not injected again for later matching acts in the same context,
but those acts are still measured. Each later matching act of a model rule
opens a window with that act and the same configured following-call budget;
closing it costs one more `$.model.classify` call. The refused attempt is not
an executed act: its retry supplies the initial window's evidence and does not
open a duplicate later window.

Every stored verdict has an `applicability` label: `applicable` for followed or
not followed, `not applicable` for an observed act exempted by the check or
judge, `no act` for an empty check window, and `unknown` for other outcomes.
An empty model window records `no act` without calling the judge. Initial
records have `later: false`; later-act records have `later: true` and
`servedDeliveryId`, linking to the injection that delivered the text. This
later window's `injectedAt` timestamps the start of its measurement.
Named checks and
turn-correlation open no delivery window, so their first record in a context
is the initial one and each later record is `later: true`. The delivery
reference is `null` for text recovered from conversation history or delivered
without a delivery id. The compliance report shows
the four applicability counts and the later-record count per rule. Legacy
not-applicable rows have unknown applicability because their cause is ambiguous.

The `agent-model` check counts a spawn without a `model` argument as not followed
even when an agent definition pins it.
`gate-background` recognises a fixed build-command vocabulary. A refusal on an
Agent spawn inside a subagent was missed in one real session (under investigation).
Store writes serialize within one process. Health counters accumulate in memory
and flush per turn (also after 60 seconds, 50 calls, or an error); at most one
turn of counters may be lost if the process dies before a flush. Concurrent
sessions sharing a store may lose a measurement: health and served counters
remain **lower bounds** under concurrent sessions.

The host refuses a store whose whole JSON text exceeds 4 MiB (4,194,304
characters), so every key the hook writes has a budget in that same measure
(`hooks/store-budget.js`): verdict lines 1.2M, sessions 2.0M, served counters
0.2M, health 50k, keys this version never writes 50k, leaving about 0.69M free.
Before its first write the hook brings every other over-budget key back under
its budget, so a store already at the limit takes the next write of any kind. A key
over its budget is cut to 60% of it: the oldest verdict lines, the contexts with
the oldest activity (the one being written last; alone over the budget, it moves
out and restarts empty) or the rules served longest ago are first written to
`rod-store-archive-<ms>-<n>.json` (store keys) or
`compliance-verdicts-archive-<ms>-<n>.jsonl` (verdict lines) in the quality data
directory, then removed from the store. An archive is never deleted after a
rejected store write (the write may have committed); only a file whose own write
failed is removed, so no reader parses a partial archive. After a refused write the
next write of that key starts from the value the refused one tried, as long as the
store still holds what it held at the refusal, so nothing the archive already
counts is counted again from the rolled-back value; a reload of the hook in
between starts from the store. Every context and
served counter carries a segment id (`seg`), new when it is created and when it
restarts empty after an eviction; a unit from before segments gets
`legacy:<session>:<context>` (or `legacy:served:<rule>`) when archived.
`rollback-check`, `compliance-report`, `serve-verdict-reconcile` and
`quality-check` read those archives AFTER reading the store (an eviction in
between leaves a segment in both places, never in neither) and JOIN the copies
of each segment, wherever they come from (the store, its mirrors given as several
`--store`, archives, a crash or a second session leaving the same segment twice):
counters take their per-key maximum, rows their union by identity (delivery id;
for trigger errors the event id `eid` the hook stamps on every new row, drawn
like segment ids from a random owner and a per-load counter, never from the
stored context; else the
row itself, kept as many times as one copy holds it, so identical id-less rows
written before event ids reconcile by the most any one copy holds), governed acts
their maximum count, `last` the latest. The
join gives one result whatever the order, number or timing of the copies. Its
precondition is that copies of one segment come from one writer: two sessions
incrementing one counter from the same copy keep one increment (the store's
pre-existing cross-session lost update). The distinct segments of a context are
then SUMMED (counters added, rows concatenated, governed acts merged by rule
identity, close markers merged). An archive that does not parse is skipped, named
on stderr and in the reader's JSON (`unreadableArchives`), never fatal: its rows
are still in the store. A context larger than one archive part (3 MB, under the
host's 4 MiB file limit) is written as several pieces stamped
`split: { id, index, of }`; readers join the copies of one piece (an archive file
copied, read twice), then concatenate the pieces of one split back into
the one context before any join (a split with a piece missing is read from the
pieces present, as one copy, and named in `unreadableArchives`). With `--store <snapshot>`, `compliance-report` and
`rollback-check` read store-key archives only from `--store-archives <dir>`, none
without it; with no `--store` they read the config directory's. Verdict archives
keep their newest files up to 49 MB on disk, the verdict history the earlier
14 × 3.5 MB rotation kept. Store-key archives are never deleted: they hold the
only copy of what left the store, about 0.2 MB a day on the measured store.

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
node scripts/judge-cases.mjs judge --cases <path-printed-by-extract> --out <judge-output-dir> --model sonnet
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
characters; the case records `truncated` (anything cut), and separately
`excerptBudgetHit` (the 12,000-character budget dropped later lines, or cut a
first line longer than the whole budget) and `itemsCut` (how many single items
were cut at 1,200 characters, counted where the cut is made), plus the
dropped-act count. Most cut excerpts lose only item tails, not whole lines. Only the model
can return `not applicable`, on non-empty evidence; code never decides a negative.
The extract summary compares raw served blocks to cases produced, including
serves beyond the quality scanner's refusal bound.
`judge` defaults to the `sonnet` model (override `--model`) and to concurrency 2
(override `--concurrency`). On labelled real transcripts, `haiku` called most
cases it decided wrongly, including violations where none occurred, so it is no
longer the default. The judge is still measurement-only: on held-out labelled
cases `sonnet` is right on most cases it decides, but it leaves many cases
undecidable from the excerpt and finds few of the real violations. It writes under
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
but only agreed cases with judge rows for precision/recall. It also prints a
violation-detector line, in which `followed` and `not applicable` both count as
no violation: violation precision and recall, no-violation precision, and the
share of determinate cases the judge decided. A violation called on a case the
labellers agreed is `undecidable` counts against violation precision: a warning
the evidence cannot support is a false alarm. A judge file with
multiple predictions for one case (for example, changed evidence or two model
runs) must be split before scoring.

### In-hook verdict measurement bound

Each served compliance window now has a `deliveryId`, `deliverySeq` (taken at
injection) and `servingSeq` (the serving call's admission). Its journal entry
and any window verdict share those fields. Every verdict has a `verdictId` and
`actSeq` (the deciding call's admission, or a lifecycle close sequence). A
per-act verdict can list windows it ended in `discharged`; turn end, compaction
and eviction record a context `lastClose`; a compaction also counts in the
context's `resets` by reason (`compaction` when the host dispatched
`session.compact`, `compaction-detected` when the main loop found a new
compaction boundary in the session's transcript, `session-changed` when the
session id changed under the main loop, after `/clear`). Sequence numbers are
process-local;
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
rotation sooner; archives are kept by volume (49 MB), so the rows of history
kept do not depend on how often the store rotates. The script prints these
limits on every run.

Run `node /path/to/wt-rules-on-demand/scripts/daily-rollback.mjs` once a day
from a host timer or cron job; the plugin ships no scheduler. This entry point
checks the user rules and configured followed projects, and defaults to dry-run.
The nightly run also measures the static instruction prefix across profiles and
recently used projects, without moving rule files. Its latest measurement lives
at `<config dir>/plugins/data/wt-rules-on-demand/quality/static-prefix-latest.json`
for each profile; SessionStart reports an over-limit, incomplete or stale result.
Run `node scripts/prefix-size.mjs --config-dir <config dir> --json` to inspect it
independently. The prefix CLI exits 0 (ok), 2 (near limit), 3 (unknown) or 4
(over limit); the nightly CLI exits 4 for an over-limit prefix when rollback
itself succeeded, and 1 for unknown or failed measurement.
The measurement runs after the night's reverts, so a rule moved back to static
counts the same night. A file over the per-file limit is left out of the harness's
combined count but still loaded: the check reports it, with `loadedChars`, and is
at least near the limit. The session-start line describes the session's own
check and adds one line when a check elsewhere is over the limit.
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

## Running the plugin's tests

Run `node --test` from this plugin directory. The suite also runs from a
standalone vendored copy. Checkout integration tests use
`test/external-test.mjs`: when the toolbox's `plugin/rules/` or the sibling
`wt-secret-guard` module is absent, each affected test visibly skips with
`toolbox dependency absent` and the relative and resolved dependency path.
With those dependencies present, the same tests run their original assertions.
Only `ENOENT` is skipped; unreadable, malformed or broken dependencies fail.
The refusal tests that use only this plugin run in both layouts.

New checkout dependencies must use `externalTest(relativePath, import.meta.url)`
and read or import the URL supplied to its test callback. The suite's
`external-boundary.test.mjs` scans test sources recursively for unguarded
checkout-relative URL construction, imports and literal filesystem reads.
This is a source regression check, not a filesystem sandbox: dynamically
assembled paths and arbitrary data flow still need review.

## Provisional migrations

New migrations carry `state: 'provisional'` and their migration time in the
scope's ledger. Confirmation requires the engine's own `identityActivity`
record to show a serve of that exact rule identity and migration generation **strictly after** migration
in every required profile. An engine health record or a predicted setting does
not confirm a migration. The hook records `loadedAt` when it loads a rule and
`servedAt` when it delivers one; the first write of each field in each process
is unconditional, then writes are throttled to ten minutes. A generation token
in generated frontmatter is echoed in load/serve records, so a session caching
an earlier rule body cannot confirm a later migration. Live store copies
and store-key archives retain the later timestamp of each field independently.
Load and serve updates are flushed together once per hook. A failed activity
write is reported and retried after ten minutes, retaining the original observed
instants; it does not trigger an immediate retry or health-write loop. Each write
carries a reporting-capability timestamp; a leftover activity key alone does not
establish that the current engine can report loads. Writers re-read and merge
timestamp maxima before writing; the host's get/set API still leaves a narrow
read-to-write race, which can lose evidence and lead to static restoration.

User migrations record the primary profile and only mirrors that lost static
delivery (a shared static directory or a removed static link). Independent
static copies do not need confirmation. The recorded list governs both evidence
and restoration; omitting a mirror from a later command does not remove it from
the requirement. Project migrations record the migrating profile and use the
union of those recorded profiles and the profiles passed to the check
(`rollback-check --profile-dir`, repeatable; the nightly run passes all its
`--config-dir` profiles). A profile is exposed only if its transcripts show a
post-migration session with `cwd` inside the project, including nested worktrees.
Project confirmation waits until the window ends. A required profile whose
exposure evidence is missing stays named in an attention outcome; transcript
cleanup or an omitted argument cannot remove a recorded profile. Exposure reads
only the project's own transcript slug, streams recent files line by line,
skips and counts malformed lines, and caches results across rules in a check.

The default window is **168 hours**. Pass `--serve-window-hours <hours>` (finite,
nonnegative, including zero) to `daily-rollback`, `rollback-check`, or
`quality-check` to override it. After the window:

- All required profiles served: an applying run writes a matching `confirm`
  ledger row; the existing compliance rollback still governs the rule.
- Any required profile neither loaded nor served: an applying nightly run
  restores the rule to static delivery, including recorded mirror links, and
  records the reason in the rollback report and revert notifications.
- Every profile loaded, but some never served: the rule stays provisional and
  reports `attention` with “loaded but never served”. This avoids moving a rule
  back merely because its trigger has not fired.
- Unreadable or unattributed activity evidence, an older engine lacking load records, missing
  recorded profiles, or physically shared evidence directories or files
  (including symlinks and hard links): the check
  reports attention and neither confirms nor automatically restores from that
  evidence. A rule physically owned by another profile is refused restoration.

Activity records identify the writer's physical profile and engine-run capability,
so copying a store into another profile cannot establish that profile's serve.
Capability is evaluated within each store/writer observation. Health calls carry
writer-run counts, so another store's new engine or another run in the same store
cannot remove uncertainty about unattributed calls, even within the same day.
An applying project check appends generation-bound `require` ledger rows for
additional required profiles. Later checks and locked confirmation use the
union of migration and requirement rows, even if a caller omits a profile.

The nightly provisional pass runs **before transcript-coverage checks** and
continues across failed scopes. Reports include `provisional`, `confirmed`,
`wouldRevert`, and `failed` buckets. Dry runs annotate `wouldConfirm` without
writing a ledger row or moving a file. A missing provisional on-demand file or
directory is a named delivery-loss error and fails the daily run. Failed
restoration also fails the run and reaches the notification channel. Every
rollback, including compliance rollback after confirmation, restores recorded
mirrors together with explicitly supplied mirrors.
The pass inspects supplied profile ledgers together with physical on-demand
owners' ledgers, every explicitly selected project, and followed projects from
every supplied profile. Discovered provisional projects excluded from applying
rollback are named as attention. Child checks have a two-minute timeout and a
16 MiB output limit; resource failures are named and fail the scope.
Activity and project exposure are observed once per profile/project per rollback
process, then evaluated against each rule's cutoff. Exposure streams root and
descendant transcript slugs and verifies every record's physical cwd.
SessionStart reads revert notifications
from both the hook data directory and the host timer's profile data directory,
including when restoration removed the last on-demand rule. It also reads the
latest nightly outcomes from both data directories. Would-revert, attention and
restoration failures are printed in nightly text output and at startup.
An existing nightly report that cannot be read or parsed produces a named
startup line; an absent report remains silent.

**Schedule the nightly command from a host timer with `--apply` for automatic
restoration.** A profile whose hooks cannot load cannot start its own rollback.
With `WT_ROD_REAL_REVERT` unset and no applying host timer, checks only report:
they neither confirm in the ledger nor restore files. The plugin supplies no
scheduler. `rollback-check --provisional-only` can evaluate this safety criterion
without verdict files or compliance measurements.

This is a one-shot migration check, not a guarantee for every later launch.
Safe mode, disabled hooks, and MDM, registry or server-delivered policy can
prevent confirmation, regardless of where their settings live. Changing these
conditions after confirmation is outside this check. Profiles first exposed
after a project confirmation, profiles neither recorded at migration nor
supplied to the nightly run, and
unrecorded shared static directories are also outside its bound. Legacy migrate
rows written by older lifecycle tools have no provisional state and retain
their previous rollback behavior. Migration and activity times assume the same
host clock; lifecycle locking remains the best-effort guard described above.
