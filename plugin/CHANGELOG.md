# Changelog

All notable changes to the `workflow-toolbox` Claude Code plugin are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.145.0] - 2026-08-08

### Added

- `adopt --check` ships X, which replaces a hand-rolled Y: a STALE rule now shows the
  `plugin/CHANGELOG.md` entries between the copy's installed version and the current one,
  instead of just the version numbers moving. A session on a project with a stale adopted
  copy used to see `STALE (installed v0.112.0 < v0.125.2)` and nothing else — thirteen
  versions of delta with no word of what shipped, rationally ignored, which is how a stale
  set stays stale. It now sees the actual headings and bodies, newest first, capped at 10
  entries with an explicit omitted-count when the span is large. Measured on this repo's
  own changelog: 61 of the minor versions between 0.68 and 0.144 carry no `## [x.y.z]`
  heading at all, so a range landing entirely inside that historical gap slices to zero
  headings — rendered plainly, that reads as "nothing changed" at exactly the moment ~100
  versions went past. So the new section distinguishes two shapes a reader can tell apart
  without knowing anything about the gap: "no changes recorded in this range" (the range is
  inside the changelog's recorded span, genuinely empty) versus "NO RECORD for this range"
  (the installed version predates every heading the changelog carries at all). Pure logic
  lives in `plugin/skills/adopt/scripts/changelog-span.mjs`, with a byte-identical inlined
  copy in `install.mjs` itself (which must stay a single relocatable script — its own tests
  copy it alone into a synthetic plugin root) kept honest by a drift-lock test rather than
  an import. Report-only: it never acts, never writes, and the existing `--check`/`--install`
  output for every other state (ABSENT, UP-TO-DATE, EDITED, …) is unchanged.

## [0.144.0] - 2026-08-07

### Added

- `wt-lane-activity.mjs`: a read-only sibling to `wt-lane-probe.mjs` that answers "what is
  this GPT lane actually DOING", not just "is something running on it". `wt-lane-probe.mjs`
  proves WHERE a lane is running (cwd attribution); this reads the two sources it never
  touches — the opencode CLI's own log (names the current sub-task from the latest matching
  line) and its local SQLite session store, opened read-only (running token total + model).
  A stall verdict is emitted only when the process is alive AND both sources independently
  agree nothing moved for the stall window; either source being unreadable, or the two
  disagreeing, reports `unknown` rather than guessing — a single-source stall check inverts
  instead of degrading (measured on a live lane: the store's newest row said `finish:stop`
  26 minutes earlier while the process had been alive 29 and the log showed live sub-agent
  activity — database alone would have called it stuck, elapsed time alone would have called
  it healthy). Every field is a measurement or an explicit `unavailable`/`unknown` reason,
  never a zero standing in for "could not read". Data-dir resolution is Linux-only by
  default (XDG data dir) — macOS/Windows report `dataDirSupported:false` explicitly rather
  than a guessed path; `--data-dir`/`OPENCODE_DATA_DIR` overrides it. `node:sqlite` (Node
  ≥22.5) degrades to a stated `storeReadable:false` reason on this plugin's Node ≥20 floor,
  never a crash. Pilot orchestrator docs (`plugin/agent-templates/pilot-orchestrator.md`)
  point operators to it right after `wt-lane-probe.mjs`.

## [0.143.0] - 2026-08-07

### Added

- `wt-guard-recurrence-hook.mjs`: a SessionStart surface that turns the guard journal's
  recorded firing COUNT into something a session meets unasked. `wt-guard-journal-scan.mjs`
  could already answer "has this guard recurred", but nothing invoked it — a counter nobody
  reads is not a trigger. This hook reuses the scan CLI's parser (now extracted to
  `plugin/bin/lib/guard-journal-read.mjs`, shared by both readers) and speaks only when the
  same guard's firings for the same "reason" (its own `class`, or one shared `(unclassed)`
  bucket per guard) cross the durable-fix rule's own threshold — more than twice in one week.
  It names the count and the guard, never an instruction to reflect, carries the journal's own
  two bounds every time it speaks (event count ≠ confirmed-defect count; only guards wired to
  the journal are counted), and is silent on the common path and on any read failure (missing
  or unreadable journal directory, malformed line, unrecognised record shape) — never an error.

## [0.142.0] - 2026-08-07

### Changed

- `wt-durable-fix-at-the-right-level`: the "mechanise on sight" trigger is now a COUNT, not a
  judgement. The former test — *could a hook/gate/test/check make this impossible to repeat?* —
  was evaluated mid-task by whoever had just worked around the problem, which is the same
  unenforceable shape the ladder forbids in an escalation clause. It now reads: the same guard
  firing for the same reason more than twice in one week means mechanise what it guards, or fix
  the guard.
- The rule now states its own bound explicitly: a count covers RECIDIVISM only, and the first
  occurrence of a class is invisible to it.

## [0.141.1] - 2026-08-07

### Fixed

- **The guard journal shipped in 0.141.0 was polluting its own test suite's real journal.**
  17 of the 19 `toolkit/packages/build/test/*.test.ts` files that spawn a real
  `plugin/bin/*guard*.mjs` process never redirected `WT_GUARD_JOURNAL_DIR`, so every
  `pnpm test` run wrote real records into the operator's own
  `~/.local/state/wt-guard-journal/` (measured: 670 junk records, in bursts of 64, from one
  run). Fixed with two layers rather than 17 edits: a vitest `setupFiles` module
  (`toolkit/test-support/guard-journal-isolation.setup.ts`) makes the redirect the DEFAULT
  for every test worker, so every existing call site that inherits `process.env` (the
  pattern all of them use) is fixed without being touched; a `globalSetup` module
  (`toolkit/test-support/guard-journal-isolation.global-setup.ts`) snapshots the real
  journal directory before and after the whole run and fails the suite loudly if it
  changed, so a future test that bypasses the redirect (e.g. constructs its own `env: {}`)
  cannot silently reintroduce the leak. A full `pnpm test` run now leaves the real journal
  location byte-for-byte unchanged (verified: identical file list and MD5 before/after).



### Added

- **A shared, durable guard-refusal/warning journal, and its read CLI.** Sixteen of the
  eighteen `plugin/bin/*guard*.mjs` guards now call one shared helper,
  `plugin/bin/lib/guard-journal.mjs`, the moment they decide to block or warn — an
  append-only NDJSON line per event, rotated one file per ISO-8601 week under
  `~/.local/state/wt-guard-journal/`. The insight "this recurring defect deserves a
  mechanism" is a judgement call and cannot itself be mechanised; repetition can — this
  turns "I think this happened before" into a number a new read CLI,
  `wt-guard-journal-scan.mjs`, can print per guard for the current week. The write is
  fail-open by construction (same posture as `writeFailOpenTrace()`): every failure mode
  is swallowed inside `recordGuardEvent()`, proven by a test that points the journal at an
  uncreatable directory and asserts the guard's own decision output is unchanged. Two
  files are deliberately not wired — `wt-outbound-guard-hook.mjs` (its own durable
  registry answers a different question) and `wt-stale-date-guard.mjs` (a report CLI, not
  a hook) — named with reasons in a family test that globs `plugin/bin/*guard*.mjs` itself,
  so a future guard shipped without instrumentation fails the suite rather than going
  unnoticed.

### Added

- **Three shell-trap guards ported from private machine-local hooks into the shipped
  plugin, all PreToolUse on Bash, all warn-only.** Every one of these is a property of a
  common shell/tool combination, not of any one machine — every adopter meets it
  unguarded.

  - **`wt-pipestatus-bash-only-guard-hook.mjs`** — warns on a bare `PIPESTATUS` reference:
    bash-only, expands EMPTY with no error under zsh (a piped gate's exit code then reads
    as nothing). Measured against 163 distinct real commands referencing `PIPESTATUS`
    across every session transcript on this machine: 163/163 fired. The guard cannot
    distinguish a genuine reference from prose merely discussing the trap, the same known
    false-positive family as the sibling guards here — ships warn-only.
  - **`wt-find-newermt-format-guard-hook.mjs`** — warns when a `find … -newermt <arg>`
    argument is not ISO-8601: some `find` builds accept only ISO-8601 there, reject a
    natural-language date on stderr, and a swallowed/piped stderr then reads as "no recent
    files" instead of "the date format was rejected". Measured against 555 distinct real
    `find … -newermt` commands: 256 fired, dominated by genuine natural-language/relative
    forms plus a residual class of bare shell-variable arguments the guard cannot evaluate
    — an intentionally conservative posture. Ships warn-only.
  - **`wt-git-commit-backtick-guard-hook.mjs`** — warns on an unescaped backtick inside a
    double-quoted `git commit`/`tag`/`notes` `-m`/`--message` argument: inside double
    quotes a backtick pair IS command substitution, silently splicing empty output into
    the stored message with no error. Measured against 466 distinct real candidates: a
    first pass without heredoc-awareness fired on 16/466, and reading all 16 showed 12
    were the `-m "$(cat <<'EOF' … EOF)"` heredoc-in-command-substitution form — this
    project's own dominant commit convention, where the backtick sits inside a
    quoted-delimiter heredoc body the shell never expands (75% false-positive rate on the
    fired set). Fixed by stripping heredoc bodies before matching, the same technique
    `wt-unquoted-tool-glob-guard-hook.mjs` already uses; re-measured: 4/4 fired, all 4
    genuine, 0 false positives. Ships warn-only (4 true positives over 466 candidates is
    real signal, far short of the scale this repo requires before a guard denies).

  All three registered in `plugin/.claude-plugin/plugin.json`, documented under "Shipped
  Hooks, Guards & Monitors" in `docs/public/known-issues.md`, mapped in
  `toolkit/examples/docs-provenance.ts` (both the shipped-hooks doc-surface entry and the
  per-script mapped list), and covered by a synthetic crash-safety payload each in
  `plugin-hook-crash-safety.test.ts`.

## [0.139.0] - 2026-08-07

### Added

- **`wt-main-guard-hook.mjs` — guards the MAIN session against a set of irreversible Bash
  actions, mirroring `wt-pilot-guard-hook.mjs` for the one actor that guard deliberately
  no-ops on.** `wt-pilot-guard-hook.mjs` guards every subagent but skips any call with no
  `agent_id`, i.e. the main session itself — on the theory that the main session is the
  arbiter that already holds the gate. That was aspirational, not mechanical: nothing
  actually executed when the main session ran `npm publish`, a force-push, a remote branch
  deletion, or a catastrophic `rm -rf` — only prose rules did.

  **Posture is a measured split, not one verdict for the whole guard.** Four classes ship
  blocking (`permissionDecision: 'deny'`): publish, force-push, remote branch deletion, and
  `rm -rf` on the filesystem root or the home directory. Measured against 2,788 distinct real
  Bash commands drawn from every session transcript on this machine: publish 16/16, force-push
  13/13, remote branch deletion 4/4 — 0 false positives across all three; root/home `rm -rf` had
  zero occurrences in the sample and stays blocking structurally (no legitimate use exists).

  Two classes matched the same trigger shapes and measured the opposite way, so they ship
  journal-only instead (allowed, logged, never denied): `rm -rf` on a git repository root was
  10/10 false positives — every match was a disposable clone or a worktree purge about to be
  recreated; `rm -rf` on an unresolvable target (`"$VAR"`, a glob) was 319 candidates, sampled
  and found to be `rm -rf "$VAR"` where `$VAR` was bound earlier in the same multi-line command
  to a scratch path this segment-local classifier cannot see. Both stay detected and journaled
  to `~/.local/state/wt-main-guard/journal.jsonl`, so the gap is visible rather than silent.

  A `git merge` integrating a branch INTO `main`/`master` while on `main`/`master` — the
  opposite direction from what the pilot guard blocks — is journal-only by design, legitimate
  for the arbiter, recorded for traceability. Denials carry a one-time, file-based escape hatch
  (`~/.local/state/wt-main-guard/allow-once.json`, byte-exact match, single-use). See
  `docs/public/known-issues.md` for the full per-class breakdown.

## [0.138.0] - 2026-08-07

### Added

- **`wt-merge-chain-guard-hook.mjs` — warns when a `git merge` is chained with what verifies it.**
  A merge can do nothing — `Already up to date` when run from the wrong tree, or an abort — and the
  commands after it then run on the **unmerged** tree and return 0. Three gates green, three honest
  exit codes, certifying a subject nobody intended to certify.

  ⚠ The exit code cannot detect this, and that is the point: it belonged to the gate, the gate
  genuinely passed, and it answered a question about the wrong **subject**.

  A shipped rule already stated the invariant. Adopters have had that rule for weeks with nothing
  enforcing it — this is the rung below a rule, and the reason the hook exists.

  **Warn-only, and measurement is why rather than caution.** 1,140 real `git merge` commands were
  replayed from every session transcript on this machine — 21,503 files, 172,497 Bash calls scanned
  — against the guard's own executable. 376 matched, and the large majority are the *safe* pattern:
  capture the merge's own exit code or log, then inspect it. A literal "anything after a merge"
  predicate cannot tell that apart from the blind chain, so it stays far short of the 197/0 bar the
  sibling glob guard cleared before earning a deny.

  That replay also found a defect reading had not: a bare word boundary after `merge` matched
  `git merge-base`, `merge-tree` and `merge-file`. It was present in a version that looked correct
  on inspection.

  ⚠ **It covers the CHAINED shape only.** A merge run from the wrong tree — the variant that
  actually recurred four times the day this shipped — is a sibling defect this does not catch, and
  its silence there must not be read as coverage.

## [0.137.0] - 2026-08-07

### Added

- **`wt-var-colon-modifier-guard-hook.mjs` — warns when a colon follows an unbraced parameter
  name.** In zsh that starts a *modifier*, not concatenation: `git show "$s:src/file.ts"` fails with
  `bad substitution`, and the empty result reads as "not found" rather than as an error. Other
  letters mutate the value silently instead of erroring.

  **Two measurements ship in its header, not one**, because the first is what makes the second
  credible. Over 125 distinct commands from real history, each fed to the guard's own executable: an
  ad-hoc 34-letter set gave 22 warnings of which 6 were genuine — **27% precision**. Narrowed to the
  13 letters `man zshexpn` documents, warnings fell to 6, **all 6 genuine**.

  ⚠ **Warn-only despite 100% on that sample**, and the reason ships with it: narrowing raised
  precision without raising recall. An unrecognised letter after the colon does not reliably fall
  back to literal — zsh's parser can skip it and try the next character — and it cannot see inside a
  command substitution. The blocking bar here is the sibling glob guard's 197/0 over 82,015
  commands; this does not clear it and does not pretend to.

  Its exclusions came from measurement rather than design: quoted-delimiter heredocs and
  single-quoted spans — including ones containing nested double quotes, found in a real PowerShell
  invocation — were producing false positives on commit messages that merely *described* the trap.
  An unquoted heredoc delimiter does expand and is still matched; a test pins that, because
  inverting it would silence the guard on a real case.

## [0.136.0] - 2026-08-07

### Fixed

- **The memory-index probe now names what it did NOT verify, on the green path too.** It reported
  `0 unreachable, 0 dangling`, and a session read that as *"the index is fine"*. That is not what
  was checked.

  **Reachable** answers *does a path exist from the index to this fact*. The question that decides
  recall is *would a session know to take that path*. Those are different, and the gap is invisible
  from the probe's side — it prints healthy on precisely the defect it appears to cover. A real
  store sat at two index lines with zero unreachable, green on every run, while one of those lines
  fronted a 103 KB note covering fifteen subjects and naming three of them.

  The probe now states on every run, clean ones included, that it verified reachability and the
  size ceilings and did **not** verify discoverability. On the green path specifically: a bound
  named only in the failure branch is a bound nobody reads, and the whole defect is that a clean
  run reads as full coverage.

  ⚠ **No new metric, and that is a measured decision rather than a scope cut.** All 13 hubs in this
  project's own store under-describe their contents, 6% to 57%, none above 60%. A check firing on
  13 of 13 flags nothing — it is noise that gets switched off and takes any real case with it. The
  condition is normal, not exceptional, which is what makes the honest-wording fix the right one.

  Reported by a session on another project whose store passed both checks continuously while being
  unusable. Worth noting which instrument caught it: the fidelity-checker's routing test, which runs
  only when spawned. The probe, which runs on a hook continuously, is the one with the blind spot.

## [0.135.0] - 2026-08-07

### Added

- **`wt-unquoted-tool-glob-guard-hook.mjs` — ships BLOCKING, which no other new guard does, because
  this one was measured first.** In zsh an unquoted glob passed as a *tool option value* fails two
  ways and **both look like a clean result**: with no match zsh aborts the command before any
  redirection, so nothing runs and the empty output reads as "no hits" or "the feature is absent";
  with a match it expands against the current directory, so `--include=*.ts` silently becomes
  `--include=app.ts` and the search covers one file instead of a tree.

  The failure does not look like a failure. It looks like a finding.

  Measured on material it did not choose: 5,193 session transcripts, 82,015 Bash commands, 206
  distinct after dedup, each fed to the guard's own executable as a real PreToolUse payload —
  **197 true positives, 0 false positives**, 9 correct silences from its heredoc and prose
  exclusions. Those figures are in the file's header so the next reader inherits the evidence
  rather than the conclusion.

  What makes blocking safe is the narrowness of the population, and it is checkable in two regexes:
  only `--include`/`--exclude`/`--include-dir`/`--exclude-dir` and
  `-name`/`-iname`/`-path`/`-ipath`/`-wholename`. An ordinary argument glob (`ls *.ts`,
  `for f in *.md`) cannot match either — and that form is normally correct, so flagging it is
  exactly the false-positive class that gets a guard switched off.

  ⚠ Its non-coverage ships with it, so its silence is not read as coverage: a bare unquoted glob as
  an ordinary argument is deliberately not flagged, and it says nothing about the sibling zsh traps
  — unquoted word-splitting, or `$var:path` read as a parameter modifier.

  Filed as a ticket by a session on another project, which also ran the measurement and rejected the
  tempting shell-level alternative: `unsetopt nomatch` closes the abort half and leaves the
  expansion half, turning a loud failure into a silent wrong answer.

## [0.134.0] - 2026-08-07

### Added

- **`wt-lesson-harvest-hook.mjs` — the lesson harvest now fires by itself.** The extraction already
  shipped as a skill, and a rule already named the script and said when to run it. Neither fired:
  measured here, **0 skill invocations out of 37** came from description matching alone, and the
  rule that names the script records its own failure rate — eight reports carrying three to six
  lessons each, three harvested by hand, the rest never read again.

  Improving the description could not have fixed that: description matching is probabilistic and
  its non-firing is silent, so a better description raises a probability rather than creating a
  trigger. Naming it in a rule had already been tried — that is rung two, auto-loaded and still
  skippable. This is the first rung: something that executes.

  What makes it hook-shaped rather than another instruction is that its trigger needs no judgment —
  a report file exists and is newer than the last run.

  ⚠ **It only surfaces.** It never writes to a knowledge base; that stays with the single session
  integrating the card, which is the constraint the extractor was built around. It names report
  paths and counts rather than lesson text, because a Stop hook's output reaches the human too.

  ⚠ **Honest scope, and the uncovered half is the larger one**: this covers lessons that reached a
  REPORT. A correction arriving mid-conversation has none, and three of the most useful facts of one
  measured night belonged to no card at all.

## [0.133.0] - 2026-08-07

### Fixed

- **The watchdog templates pointed at a file only the maintainer's machine has.** Both instructed
  the observer to read `~/.claude/rules/delegation-lanes.md`, which no adopter possesses. It
  INVERTED rather than failed: the clause exists because observers once flagged a legitimate direct
  CLI invocation by citing a stale paraphrase instead of the live rule, so the fix was "read the
  source, never quote it". For an adopter the pointer resolved to nothing, so the instruction did
  nothing and the observer fell back on the paraphrase — exactly the failure it was written to
  prevent. It worked here, which is why nobody saw it.

  They now point at `wt-delegation-ladder.md`, which adopters receive and which already carries the
  same distinction as its fourth prohibition — including the half that matters most: a direct
  invocation is not the prohibited shape, because invocation is its own provenance. One source of
  truth, one pointer change. The remaining `DD/MM` provenance stamps went in the same pass.

  The durable half is a check refusing any shipped agent template that references a home-anchored
  path, proven RED by adding one. Detection was never the problem — the pointer was plainly
  visible to anyone reading the file — so the fix that matters is the one that fires with nobody
  looking.

## [0.132.0] - 2026-08-07

### Added

- **`wt-autonomy-arm.mjs` — the mandate the autonomy watcher refuses to run without can now be
  declared with a shipped command.** Until now the watcher could name what was missing and no
  adopter had any way to supply it: `mandate=absent` with nothing in the plugin able to write that
  marker. A diagnosis with no remedy.

  Run it to arm, `--disarm` to withdraw, `--status` to report. The exit code carries the verdict so
  a caller need not parse prose. It refuses to guess a session id rather than write a marker
  nothing will ever read.

  ⚠ **It is deliberately not a hook.** A hook stamping the marker at session start would declare a
  mandate for every session whether or not anyone wanted one, reintroducing exactly the noise the
  watcher's gate exists to prevent. Declaring a mandate is an act; this is the act. The marker is
  per session and does not survive a restart — stated rather than worked around, because a mandate
  silently inherited by a later session could keep waking somebody after the intent behind it had
  expired.

### Changed

- **The autonomy watcher's banner now names what supplies each missing precondition**, not just
  which one is missing: the arming command for an absent mandate, the queue-snapshot hook for an
  absent or stale snapshot. Naming the gap without naming its remedy moves a reader from "I cannot
  tell whether this works" to "I know it is broken and not what to do" — better, and still short of
  actionable.

  Raised by a session on another project, which read the 0.130.0 banner, went looking for the tool
  that would arm it, and found none.

## [0.131.0] - 2026-08-07

### Changed

- **The four pilot agent definitions are rewritten in a telegraphic register — 11% smaller, with
  every content unit accounted for.** These files are read by an agent under pressure that must act
  correctly on the first read, so the gain came from STRUCTURE, not from shortening words: prose
  describing a set of cases and their outcomes became tables, state-transition explanations became
  imperative sequences, and duplicated incident explanations collapsed into one causal chain.

  The largest single reduction, `pilot-watchdog.md` at 51%, is one prose list of tells becoming a
  seven-row evidence table. Its warning markers, headings and list items are unchanged in number,
  and the wrapper-versus-direct-invocation nuance survives intact, including the clause that tells
  an observer to stay silent when its digest cannot distinguish the two.

  ⚠ **Abbreviation was tried and rejected.** An intermediate attempt reached 5% by substituting
  symbols for words (`+`, `w/`, `w/o`). That buys bytes by making each sentence slower to parse,
  which is the opposite of what these files are for.

  Four content locks in the test suite — assertions that a specific normative clause is still
  present and still says what it said — caught an earlier attempt that had rephrased them. They are
  the reason this rewrite can be trusted to have preserved meaning rather than merely counted units.

## [0.130.0] - 2026-08-07

### Fixed

- **`autonomy-watch` now says whether it can actually fire.** It had the exact defect it exists to
  remove elsewhere: an unarmed watcher and a watcher with nothing to report produced the identical
  observation — nothing. A session could not tell "running and quiet because all is well" from
  "running and structurally unable to ever fire here", and the second is the common case: the
  monitor needs a mandate marker the session must write and a queue snapshot the stop gate must
  have written, and both are absent by default.

  It now writes one line at arming, on the same stream as its wakes, naming the idle threshold, the
  poll interval, and the LIVE state of both preconditions — plus `CANNOT FIRE` when either is
  missing. The line prints in every session including ordinary interactive ones with no mandate,
  which is deliberate: `mandate=absent` is precisely the reading worth seeing, and a banner
  suppressed in that case would be silent in the only situation it exists for.

  `absent`, `unreadable` and `stale` are reported as three distinct states rather than collapsed,
  because they call for three different actions — write a snapshot, fix a malformed one, refresh an
  old one. Freshness is read from the snapshot's own `at` field, the same way the polling code reads
  it, never from file mtime: a banner that judged freshness differently from the code it describes
  would announce `fresh` about a snapshot the watcher itself treats as stale, and a banner that lies
  about why the watcher is quiet is worse than no banner.

  Reported by a session on another project, which went looking for the monitor on disk, found it
  running, and could not determine from any output whether it had ever been able to do anything.

## [0.129.0] - 2026-08-07

### Added

- **`adopt --set autonomy` — a project can now adopt an autonomy mandate the same way it adopts
  the rules.** The new `plugin/autonomy/AUTONOMY.md` is a project-agnostic template: it names no
  tracker product, no board, no path and no per-machine quirk, and where a project must supply its
  own facts — what may leave the machine, which branch is protected — it asks for them by name
  rather than assuming any one setup's.

  Its purpose is structural rather than documentary. An autonomy mandate written into a `/loop`
  prompt is authored once and is stale within the hour; written into a FILE the wake re-reads, the
  instruction that matters most — re-arm the wakeup as the last action of the turn — is read at the
  moment it must be executed. The adopted copy carries the same versioned banner and content
  fingerprint as the rules set, so a stale copy is detectable after a plugin bump and a locally
  edited one is never overwritten without `--force`.

### Changed

- **The adopt engine derives its set list instead of repeating it.** `--set all`, the unknown-set
  error, the `--dir` rejection and the "these other sets exist too" advisory all read from the
  `SETS` map, so a future set needs none of those five edits. The advisory in particular was
  written for exactly two sets and would have been wrong in every branch with three; it now names
  the untouched sets with correct grammar for one, two or more.

  `renderItem`'s banner choice is inverted rather than extended — plain-markdown prepend is now the
  default any new kind receives, instead of silently falling into the frontmatter-aware path meant
  for agent definitions. Behaviour for the `rules` and `agents` sets is unchanged.

## [0.128.0] - 2026-08-07

### Fixed

- **The delegated-arc watcher now says WHOSE delegate it is alarming about.** Two of its sweeps
  had different scopes and only one was project-scoped: transcript staleness reads this project's
  sessions, while the liveness sweeps read `~/.local/state/wt-liveness`, which every project on
  the machine shares. A session was therefore woken by a `WAITING-ON-SPAWNER` line for a delegate
  belonging to a different project, with nothing in the line to say so and nothing it could do
  about it. Emissions now carry `(foreign to this project)` when the record's agent id is not
  among the watcher's own transcripts, and `(project unknown)` for a record that declares no
  correlation key at all — those being different states, not two shades of one.

  It **labels rather than filters**, deliberately: `lib/liveness.mjs` must never suppress a real
  stall because a side input could not be checked, and liveness records carry no project field,
  so a filter would silently drop exactly the records that lack one. The emission count is
  unchanged and a test asserts it, so the label can never quietly become a filter.

  The identifier set is derived only when the transcript baseline is replaced, never per poll —
  measured at ~710 ms for 1606 transcript metadata parses on a real project, which a 60-second
  poll loop would otherwise pay to recompute an identical answer.

## [Unreleased]

### Changed — BREAKING

- **The `adopt-rules` skill is renamed to `adopt`. The old name is REMOVED, not aliased.**
  The skill has always installed two sets — the cross-cutting RULE files and the pilot
  AGENT-definition copies (`--set rules|agents|all`) — and nothing in its name said the second
  existed. The name is what a reader uses to decide whether a step applies to them, so having
  been told "the rules are adopted" a reasonable reader concludes the agent copies were handled
  too. Observed: the rules were adopted, the agents were not, and the gap surfaced only because
  someone thought to ask — a question, not a mechanism. The un-run half looked exactly like a
  completed one.

  Renamed along with it, so no citation points at a dead name: the skill directory
  (`plugin/skills/adopt-rules/` → `plugin/skills/adopt/`), its engine
  (`scripts/install-rules.mjs` → `scripts/install.mjs`), and its SessionStart hook
  (`bin/wt-adopt-rules-check-hook.mjs` → `bin/wt-adopt-check-hook.mjs`).

  **Migration**: invoke `workflow-toolbox:adopt` instead of `workflow-toolbox:adopt-rules`; update
  any script that calls the engine by path. Already-adopted copies are untouched and keep working
  — their banners are re-stamped on the next `--install`. No deprecation shim ships: an alias
  would keep the misleading name alive, which is the whole defect.

### Added

- **`wt-hook-registration-drift-hook.mjs` — a SessionStart/UserPromptSubmit detector for stale in-memory hook registrations.** At SessionStart it snapshots the exact `${CLAUDE_PLUGIN_ROOT}` hook paths the manifest declared for THIS session; on later prompts it re-checks that snapshot against the filesystem and, if any recorded path has since disappeared, emits one attributed notice naming the missing hook file(s). It does NOT close the underlying failure — the hook whose file went missing still crashes with the same unattributed bare loader stack trace on its own next invocation, because the module-not-found error happens before any JS runs and nothing can intercept it. What this adds is a *separate*, one-time, delayed notice on the next prompt, so the session at least learns which of its own registrations went stale instead of only seeing anonymous console noise. Its own limits, stated plainly rather than left implicit: it cannot repair a stale registration (only a session restart picks up the corrected manifest); it cannot detect its OWN file going missing (if this hook itself is renamed or deleted, the running session's next invocation of it fails the same unattributed way, symmetric to every other hook — the existing shim convention from the `wt-adopt-check-hook.mjs` rename applies here too, should this file ever be renamed); and two `UserPromptSubmit` invocations racing the same session's report-once state, or two colliding sanitized session ids, are theoretical, low-likelihood gaps not covered by a lock (Claude Code serializes `UserPromptSubmit` per session, and session ids are UUIDs that do not collide under the sanitization scheme already shared with `wt-outbound-guard-hook.mjs`).

- **`wt-observer-pairing-guard-hook.mjs` — a PostToolUse Agent hook that asks the shipped
  pairing checker what ACTUALLY attached, instead of warning from a spawn-shape guess.** It only
  runs for agent definitions that declare `observer:` in an adopted/project-visible copy, then
  delegates to `wt-check-observer-pairing.mjs` on the spawned agent's real subagent metadata.
  Clean `pass` outcomes stay silent; contradictory `observerTaskId` links and genuine no-pairing
  reads surface with the checker's own reason. The guard does not reintroduce a named-spawn rule:
  the ownership link (or its absence) decides, and the checker's existing mtime fallback remains
  only for records where no link is present.

- **`wt-shipped-twin-check-hook.mjs` — a PostToolUse Write/Edit advisory that raises the
  shipped-twin question on conventional local Claude config surfaces.** It never guesses the
  pairing, stays silent for out-of-scope paths, and throttles itself to once per session per
  directory so the reminder does not turn into background noise.

- **`wt-adopt-rules-check-hook.mjs` is back as a DEPRECATION SHIM, and every registered hook
  path is now locked.** Renaming a hook file breaks every session that is ALREADY RUNNING: the
  manifest is read at session start, so the old path lives on in memory after the file is gone,
  and node dies in the module loader before any hook code — so the hook cannot even emit its own
  `FAILED OPEN` trace. The only symptom is a loader line per tool call that names no hook.
  Measured after the `adopt-rules` → `adopt` rename: **725 failures inside one session**, roughly
  an hour to attribute, because every reproduction attempt invoked the file that exists.
  The shim delegates by side-effecting import (same process, same stdin, same exit code) and
  traces under its OWN name rather than the delegate's. Two locks keep it honest: every
  `${CLAUDE_PLUGIN_ROOT}` path in the manifest must resolve — asserted over the whole manifest,
  not a name list, with a non-vacuity check so an extraction bug cannot pass it silently — and
  the shim's stdout must equal the current hook's for the same payload. Remove the shim, its
  provenance entry and its crash-safety case one release after the rename.
  ⚠ Scope, stated so the shim is not over-credited: it helps a rename that ships one. It does
  nothing for a hook deleted outright, and no repo-level check can see inside a running process,
  which is where the broken state actually lives.

## [0.67.0] - 2026-08-03

### Added

- **`wt-lane-probe.mjs` — verify that a delegate's work is really being routed to its executor
  lane WHILE it runs, instead of asking the delegate afterwards.** It reads the working directory
  of each live lane process and matches it against the worktrees of the delegates currently
  running. A statement in a report is the testimony of the party under check; a live process's
  cwd is an execution trace that party does not write. Keep BOTH: they fail differently — an
  in-flight sweep sees nothing if it lands between two invocations, a report-time check sees
  nothing if the report is wrong. The orchestrator definition calls it and archives the result.
  ⚠ A cwd proves work is happening in a tree; it does **not** prove the delegate that owns the
  tree is alive — a dead delegate leaves its lane running.

- **`lesson-harvest` skill — find a closure report's own lessons section, mechanically.** Every
  delegate closure report already carries one; nobody was harvesting them. Measured on one
  night's eight reports: **3 to 6 reusable lessons each**, of which three were harvested by hand.
  ⚠ It DETECTS and EXTRACTS; it never writes to a knowledge base — that stays with whatever
  single writer owns it. And it distinguishes "no section at all" (a malformed report — read it
  yourself) from "the section says none" (a decided, empty value): a silence is not a declared
  absence.

- **`stale-card-sweep` skill + `toolkit/scripts/stale-card-sweep.ts` — the ADD-side symmetric of
  the reversal sweep.** When something is REMOVED, sweeping what still cites it is already
  standard practice. When something is ADDED, nothing sweeps what still ASKED for it — so a
  tracked item stays open after a sibling's implementation already covered it, and someone
  redoes the work. Measured cost of its absence, on the night it was built: a delegate spawned
  on an already-shipped item, returning an empty branch.
  ⚠ Two staged layers, deliberately: the mechanical one shortlists by the closing diff's changed
  files (words fail — the same idea gets written five different ways and a keyword search returns
  a zero that reads as "does not exist"); the judgment layer decides. **Below ~200 open items the
  tool tells you to read them all instead** — reading everything cannot miss a reformulation, a
  filter can. The filter is a degradation accepted for volume, never an improvement.

### Changed

- **`wt-delegation-ladder.md` gains three harness facts that were nowhere in the shipped set**,
  each of which produces a silent false negative — you conclude a delegate is dead when it is not.
  The addressing contract (short name is the normal route and keeps working after completion; the
  raw id is the fallback); **a resumed delegate is invisible in the interactive agent list**,
  which is what makes the failure expensive; and **a delegate's transcript is a different file
  from the session's own** — a freshness watcher armed on the session file measures the SESSION's
  writes, so it reports "active" for as long as the session keeps talking. It can never fire, and
  its silence is indistinguishable from a healthy delegate. Plus the naming/observer trade-off
  stated as a three-way choice rather than a prescription.

- **`wt-checkpoint-and-compaction.md`: a resource limit is a door, not a loss.** Do not stop
  early to avoid being cut off — with durable state an interrupted arc resumes, while budget left
  unspent inside a window is gone. The tell is a sentence forming in your own reasoning ("I won't
  start anything else, there's only N% left"), and the question at that moment is not "can I
  finish?" but "is there budget left to spend?". Stated for the single-account case explicitly,
  because that is the objection that would make an adopter dismiss it: what makes the cut harmless
  is the durability of the work, never a spare budget.

## [0.66.0] - 2026-08-02

### Added

- **`wt-stale-date-guard.mjs` — flags an operational deadline in markdown prose once it has
  passed, without flagging the far more common dated FACT that never expires.** The motivating
  case: a rule carried "the next usable account is <date>" for four days past that date, read as
  current the whole time, because a rule file is a snapshot with no expiry mechanism — a past
  date reads exactly like a future one.
  The hard part is not the arithmetic, it is the classification: on one real 27-file corpus, **54
  of 54** dates were provenance ("measured on …", "(name, DD/MM)"). A guard that cannot tell them
  apart emits 54 false alarms on its first run and gets disabled within the week. Three keyword
  tiers, checked in priority order — **acknowledged-past** ("l'échéance est passée", "no longer",
  "discontinued") wins over **deadline** ("jusqu'au", "valid until") wins over **provenance** —
  with the window bounded to the sentence rather than a flat character radius. A date matching
  none of the three is reported as UNKNOWN, never silently dropped and never silently treated as
  a deadline.
  ⚠ **Honest scope:** zero unknowns on the corpus it was tuned against is not evidence of
  generalisation, and one provenance marker was added narrowly to close the last case on that
  corpus. On prose it has not seen, UNKNOWN is the intended output, not a metric to drive to
  zero. Standalone CLI — not wired into any hook or CI.

- **A mechanical guard against private tracker identifiers on the shipped surface.** It walks
  `plugin/`, `docs/public/` and the README on every run rather than checking a list of known
  files, so a file nobody thought of is covered by construction.

### Fixed

- **40 private tracker identifiers removed from the shipped surface**, replaced by what they
  referred to rather than deleted — provenance mentions went UP (542 → 551), which is the control
  separating a rewrite from an erasure. A reader outside the machine that hosts the board could
  not resolve `card #<id>`; it was a bare identifier with no referent. Three of the forty lived in
  byte-identity-mirrored artifacts and were fixed at their true source, not in the copies.

## [0.65.0] - 2026-08-02

### Fixed

- **`wt-arc-watch` no longer reports a cleanly-finished agent as stale.** Its "has this agent
  stopped?" check anchored on the transcript's last record, but a PAIRED observer (the
  `observer:` watchdog) writes its own `{type:"observer-ref"}` heartbeats into that same
  transcript file, on its own polling cadence. Those records carry no `uuid`, `parentUuid`,
  `role` or `message` — they are not part of the turn chain at all — yet they moved the anchor
  forward by up to 46 seconds, pushing a genuine stop record outside the acceptance window.
  Measured across one session's 105 stop-matched agents: **all 51** whose naive gap fell in the
  5.89s–46.3s band had an `observer-ref` as their literal last line, and **all 51** fell back
  inside the existing 1000 ms tolerance once those are excluded. Zero exceptions.
  ⚠ **The tolerance constant is unchanged, deliberately.** Re-deriving a larger one would have
  spanned the same 1–46 s range and silently masked genuine mid-turn deaths, with no way left to
  tell the two apart — the failure this module's own header warns against. The anchor now takes
  the **maximum over non-observer-ref records** rather than walking back from the end, so an
  interleaved heartbeat cannot hide a genuinely later turn either.
  ⚠ **Known scope:** locked by tests against real captured record shapes and proven red before
  green, but **not yet observed in production** — the running watcher is the previously published
  build. The both-directions check after adoption: a cleanly-finished agent must stop producing
  `STALE`, and an agent that died mid-turn must still produce it.

- **`--audit-overlap` names the direction of every divergence.** A `DRIFT` line used to read
  `(missing)` without saying which side it was missing FROM, leaving the reader to supply the
  half that decides what to do. Each per-line entry now reads `(missing from shipped template)`
  or `(missing from project copy)`, and the summary adds a direction breakdown alongside the
  existing `drift` count. Verdicts and exit codes are byte-identical to the previous build on the
  same input — only what the audit SAYS changed, never what it decides.

## [0.64.0] - 2026-08-02

### Added

- **`wt-check-observer-pairing.mjs` accepts `--agent-id`** and correlates by the raw agent id
  first, falling back to `--name` only when no id is given. `--name` is now optional. This
  closes the coverage limitation disclosed in 0.63.0: an **anonymously spawned** agent has no
  name to match on, and anonymous is precisely the mode a lane-delegating agent must use —
  harness-managed `isolation` deletes a worktree whose agent has yielded to an external
  executor, so that agent's tree is empty at the exact moment the reaper looks at it. Every
  verdict now carries a `matchedBy` field (`id` or `name`) so a reader can see what the result
  rests on rather than inferring it.

### Fixed

- **The pairing check no longer returns `unknown` for the majority of real spawns.** It gated
  its mtime-correlation branch on `taskKind === 'async'`, a value the harness does not appear
  to write: across every `.meta.json` on one machine (1687 files), 546 carried
  `in_process_teammate`, **zero** carried `async`, and the remaining 1141 carried no `taskKind`
  at all. An absent `taskKind` is now treated as the async-shaped case, while the literal
  `'async'` keeps working for fixtures and any future explicit writer.
- **A private tracker card id no longer appears in the shipped `pilot-orchestrator`
  definition.** The surrounding claim is unchanged — it now states the measurement rather than
  citing an identifier an adopter cannot resolve. ⚠ **Known and not fixed here:** other shipped
  files still carry such identifiers as provenance markers; replacing them with their substance,
  behind a mechanical guard over the whole shipped surface, is tracked separately.

## [0.63.0] - 2026-08-02

### Added

- **`wave-fidelity-checker` — an end-of-arc agent that reads a wave report and checks its
  claims against the primary sources**, refute-first, reporting CONFIRMED / REFUTED /
  UNVERIFIABLE per claim. Ships with `plugin/bin/wt-check-observer-pairing.mjs`, which reads
  the harness's own `.meta.json` (`isObserver`) rather than transcript content.
  ⚠ **Two limitations, both known and neither fixed in this release.** The pairing check
  hard-requires a `--name` and therefore cannot verify an agent spawned **anonymously** — which
  is the mode a lane-delegating agent must use, since harness-managed `isolation` deletes a
  worktree whose agent has yielded to an external executor. And the checker has been exercised
  on exactly **one** real report: a verifier observed only passing is indistinguishable from one
  that always passes. It did flag two underspecified claims and an unfilled placeholder on that
  run, which is the only evidence so far that it discriminates at all.

### Fixed

- **A cleanly-finished agent is no longer reported as stuck forever.** The spawn registry
  correlated a `spawn` record to its `stop` record **by name only** — but the two ends do not
  always use the same name: a spawn made with an explicit `name:` and an ordinary
  `subagent_type` records the NAME on the spawn and the TYPE on the stop
  (`{"child":"aa877…","name":"s-fence-125"}` versus
  `{"agentId":"aa877…","name":"general-purpose"}`). The raw agent id is identical on both
  sides and was not being used, so the entry never closed and only a manual `--ack` could
  clear it. Fixed by correlating on the raw `agentId` first, with name/type as fallback.
  Measured across 422 spawn records in 20 journals: 272 already matched by id, **149 were
  name-correlation misses**, and exactly one was a genuine unrecorded death.
- **The arc watcher no longer treats "silent" as "dead".** It fired on every normally-finished
  agent. It now corroborates a stale transcript against the outbound-guard journal before
  alerting, and — the part that matters — only accepts a `stop` record that can account for the
  CURRENT silence: a single agent writes one stop record **per turn boundary**, not one per
  lifetime, so an old clean stop from an earlier turn proves nothing about a later silence. The
  backward tolerance (1 s) is derived from the measured distribution rather than chosen: 45 real
  negative samples, one at −0.021 s, then an empty 5.87 s gap, then 44 from −5.894 s down. It is
  a separator between two observed populations, not a safety margin — if the gap closes it must
  be re-derived, never widened.
- **A card whose pilot dies before its intake is no longer invisible.** New
  `plugin/bin/wt-pilot-card-reconcile.mjs` compares claimed cards against live pilots.
- **`adopt`'s `install.mjs`: a flag with no effect in the current mode is now
  REFUSED, not silently ignored.** `--user-dir` was parsed and stored in every mode but only
  ever read inside `--audit-overlap` — under `--check`/`--install` it did nothing, and the
  target silently fell back to `--dir`/cwd. A near-miss: a session ran `--check --user-dir
  <adopted path>` from the `workflow-toolbox` checkout, got a confident "all agents ABSENT"
  for a directory nobody adopts into, and the tool's own closing line invited `--install` —
  which would have written agent files into the public repo. Fixed with a mode → flag table
  checked once after parsing: any flag whose stored value differs from its default but isn't
  read by the resolved mode fails fast, naming the flag, the mode, and (for `--user-dir`) the
  correct `--dir` alternative. The sweep also catches the same asymmetry on `--dir`,
  `--global`, `--force`, and `--replace-symlinks` under `--audit-overlap`, where none of them
  were read either.
- **A gate's reported exit code can no longer be a wrapper's, not the gate's own.** A task
  notification once reported `exit 0` for a batch where `pnpm typecheck` had actually failed
  with `exit 2` — the code read back was a chained wrapper's trailing `echo`, not the gate.
  Added `plugin/bin/wt-run-gate.mjs`: runs exactly one command with no shell (nothing for a
  later command to chain onto), writes its real exit code to a file of its own the instant the
  process returns, and — given `--fail-pattern` — cross-checks that code against the captured
  log so a 0-but-the-log-shows-an-error mismatch is reported as INCONSISTENT and forced
  non-zero rather than trusted. `wt-verify-by-ground-truth.md` and the pilot agent template
  both now state the corollary explicitly: the code you read must belong to the gate, never to
  something that ran after it, and a second signal (the tool's own summary/failure count)
  should be read beside it.

### Documentation

- **Known issue #9**: the spawn-registry heartbeat's repeated `Stop` block on an unacknowledged
  open+silent+stale entry (one block per fresh turn, not one-and-done) is now written down as an
  intentional design choice, with the way out (`--ack <name>`) — see `docs/public/known-issues.md`.

## [0.47.0] - 2026-07-27

### Added

- **Registry heartbeat (`wt-registry-heartbeat-hook.mjs`, on `Stop`)** — the spawn-registry
  scan is now invoked periodically with nothing to arm. `Stop` fires at the end of every turn
  for the whole life of a session, so no cron, timer, or remembered `/loop` is involved. On a
  hit it BLOCKS the stop, handing the finding to something that can ACT rather than to a log
  file nobody opens. Fails OPEN on every error path (bad stdin, missing/timed-out scan), and a
  re-entered stop (`stop_hook_active`) informs without ever blocking twice — a guard able to
  hang a session shut would be a worse defect than the silence it watches for. Thresholds are
  env-overridable (`WT_REGISTRY_HEARTBEAT_QUIET_MIN`,
  `WT_REGISTRY_HEARTBEAT_STALE_TRANSCRIPT_MIN`).
- The scan now names what UNTRACKABLE spawns were doing (type, model, purpose) instead of
  printing a bare count — a number without its set cannot tell a reader whether the lost
  tracking matters. Retroactive: the fields were already on disk.
- Spawn records carry `effortRequested` (deliberately not `effort`: the `Agent` tool exposes no
  such parameter today, so it is `null` everywhere and fills itself in if one appears, with no
  code change). Its value is that "pin model AND effort at every spawn" stops being an
  unverifiable instruction — a null in the registry is now mechanical evidence it was skipped.

### Fixed

- **Silence alone was the wrong liveness model.** The first cut blocked on message-silence, which
  in this system describes the NOMINAL population: a pilot reading code or running a suite says
  nothing for half an hour. A guard that fires on healthy agents is switched off within days and
  is then mute when it matters. Flagging now additionally requires the agent's own transcript to
  have stopped growing (`--stale-transcript-min`, decoupled from the message threshold). An agent
  silent but still writing is reported as `confirmedAlive` and never blocks. The converse is
  deliberately NOT claimed: a frozen transcript is not proof of death (an agent awaiting a
  background executor writes nothing), so the finding stays a question.
- Unnamed spawns no longer fabricate a correlatable name from the raw child id. The child reports
  itself under its TYPE, so the fabricated name could never match — leaving every anonymous spawn
  an open "ghost" forever (observed: an agent finished 9h earlier reported as silent for 551
  minutes). Trackability is now decided from the EXPLICIT spawn name, on the read side too, so
  registries already written with the old format are handled without a migration.

## [0.46.0] - 2026-07-27

### Removed

- **BREAKING — the `workflow-toolbox:pilot` / `workflow-toolbox:pilot-orchestrator` agent
  types no longer exist.** The pilot suite now ships as unregistered templates under
  `plugin/agent-templates/` and reaches a session only as an adopted project copy under its
  bare name (`pilot`, `pilot-orchestrator`), installed by `adopt --set agents --install`.
  Reason: Claude Code silently ignores the `observer:` frontmatter on a plugin-REGISTERED
  agent, so a namespaced pilot spawned fine and ran with NO watchdog attached and no warning
  anywhere. Telling users to prefer the bare name was not enough — a guarantee that depends on
  typing the right name at every spawn is not a guarantee. Removing the type removes the
  unwatched path instead of deprecating it. **Adoption is now a prerequisite: without it there
  is no pilot to spawn at all.** The other shipped agents (`leaf`, `lean`, `opencode-verifier`,
  `fidelity-checker`, `index-groomer`) are unaffected — they declare no observer, so plugin
  registration serves them correctly, and workflow routing to `workflow-toolbox:leaf` /
  `workflow-toolbox:lean` is unchanged.

### Added

- `adopt`: `--global` targets the config directory, resolving `CLAUDE_CONFIG_DIR`
  itself (falling back to `~/.claude` only when unset) instead of requiring the caller to
  build that path and pass it via `--dir`. A hand-built `~/.claude` is correct on a default
  machine and silently wrong on one running a second config profile, where the report then
  describes a directory nobody meant. Composes with `--set all`; mutually exclusive with
  `--dir`.

### Changed

- `adopt`: `STALE` now tracks CONTENT, not the version number. Previously every
  release marked every adopted copy stale, including copies byte-identical to the shipped
  file — so a release touching one skill's prose made a dozen untouched rules announce
  themselves as out of date. A warning that cries wolf on each release is not read on the
  release that matters. `AHEAD` is still reported first and is never short-circuited by
  matching content: a copy claiming a version the plugin does not have is an install
  anomaly, which identical text does not explain away.

## [0.45.1] - 2026-07-26

### Fixed

- `adopt`: the skill described the bundled rules as already injected ambiently by the
  `SessionStart` hook, presenting adoption as the "persistent, editable alternative". That
  reading is wrong and consequential — a plugin's `rules/` directory is inert, and the hook
  emits only a six-line digest of the delegation ladder. Every other bundled rule reaches a
  session ONLY once adopted. The skill now states plainly that adopting is what puts the
  rules in force, not merely what makes them editable.
- `adopt`: `--check` on a directory whose entries are symlinks (a supported setup —
  two config dirs sharing one rule set) reported `nothing to do.`, which reads as "up to
  date". A symlinked entry is never compared for staleness and a later `--install` there
  silently refreshes nothing. The advisory now names where the managed copies actually live
  and how to refresh them.

## [0.44.2] - 2026-07-26

### Added

- `pilot-orchestrator`: a mechanical CLOSE-OUT gate on declaring a tier/mission COMPLETE,
  separate from the ordinary per-card re-scan — fixes the observed failure where an
  orchestrator counted its cards once at intake, created cards of its own mid-wave, then
  stopped on that stale initial count while dozens of cards remained open. The gate:
  (1) re-query the tracker live by CRITERIA (labels + lists), never from a list held in
  memory — a criteria query catches what was born since intake, a remembered id list
  cannot, by construction; (2) two staggered live re-queries separated by a NAMED,
  overridable interval (`STOP_GATE_INTERVAL_MIN`, default 10 minutes) — declare COMPLETE
  only if both come back empty; (3) fail-closed on the gate itself — a failed query, an
  unparseable read, or a surprising count means NOT complete; (4) the orchestrator's own
  self-created/absorbed cards are explicitly IN the set the gate re-queries, whatever the
  mission's original shape; (5) the stop announcement must state both probes' timestamps,
  criteria, and counts — "the board is empty" alone is not an acceptable closing statement.
  Applied identically to the plugin source, the `launch-agents` byte-identical mirror, and
  the adopted project copy (which additionally keeps its approved `model: opus` override).

## [0.44.1] - 2026-07-26

### Added

- `pilot-orchestrator-watchdog`: a new, short observer definition paired with
  `pilot-orchestrator` via `observer:` — tells scoped to the ARBITER's own duties
  (under-specified brief, arbitration on a pilot's summary instead of the real artefact,
  integration credited without a re-gate read, a number reported without its set, an
  escalation omitted on a named trigger), never the sibling pilot watchdog's TDD/gate/diff
  tells. Declared, with the pairing's actual mechanism stated in the file: the SPAWN MODE
  governs attach (a named/`in_process_teammate` spawn never attaches; an async/anonymous
  spawn — including one launched by `main` via the Agent tool, which is how
  `pilot-orchestrator` is normally launched — attaches reliably), not the launcher identity
  as an earlier hypothesis had it. Direct confirmation for the orchestrator role specifically
  does not exist yet (no orchestrator relaunched since the declaration was added), and the
  file says so at that exact scope.
- `pilot-orchestrator` now declares, at its Report step, a duty to invoke an independent
  end-of-arc fidelity check on its own wave report against the real board+repo state before
  filing it — the check agent itself is not built here (no general-purpose wave-report
  checker exists yet; tracked as a separate follow-up card) and the report must say plainly
  when the check was not performed rather than silently skip it.

## [0.44.0] - 2026-07-25

### Added

- `adopt --audit-overlap --set agents`: a coherence gate for adopted pilot-suite
  project copies. Compares BOTH directions (an added/changed line, and a shipped line
  silently DELETED from the project copy) so a copy cannot go CLEAN by dropping a
  safety clause instead of contradicting it; scoped to `agents` only (`rules` copies
  stay additions-only, per their own "editable copy" contract). ABSENT-copy and
  unapproved-drift both fail; an approved per-pair `model:` override line does not.

### Changed

- `pilot-orchestrator` now runs a mission-driven wave loop: a fail-closed stop test
  that treats `Blocked` as still-OPEN (never conflating a stalled, human-decision-
  pending tier with a genuinely COMPLETE one — reported via the existing
  `partial(<done>/<blocked ids>, <why>)` exit), Blocked-and-continue handling for
  human-decision cards (never ends the mission while another in-scope card remains),
  and per-selection reporting.
- `pilot` now treats heavy increments without a consented executor lane as a split:
  the arbiter stays on design/plan/arbitration and spawns a cheaper executor, never
  self-implementing on its own tier.
- `pilot-wave` now resolves `EXECUTOR_LANE` by both bridge availability and explicit
  `WT_EXECUTOR_LANE_CONSENT`; availability alone no longer authorizes the lane.

## [0.42.0] - 2026-07-22

### Added

- This changelog, backfilled from 0.41.0.
- Coverage-audit documentation pass over the shipped skills: `workflow-composer`'s
  references now document `scaffoldWorkflow`/`ScaffoldSpec`/`ScaffoldStep` (programmatic
  scaffolding), `parseDigest`'s tolerant-parsing contract plus the `LOOP_STAGE`/
  `isLoopIterLabel` loop-attribution markers, and the `BundleResult`/
  `BundlePipelineResult` return shapes of the programmatic build entry points;
  `upgrade-canary` documents `resumePrompt` (the resume counterpart to
  `launchPrompt`).

## [0.41.1] - 2026-07-21

### Added

- `adopt` skill: an opt-in installer that writes editable, versioned, fingerprinted
  copies of the cross-cutting delegation rules and the pilot agent definitions into a
  project, and can later detect and refresh stale copies against the plugin's shipped
  originals.
- `opencode-verifier` agent: a schema-relay mode for schema-bearing roles, so a role that
  expects structured output can route through the cross-family verifier without losing
  its schema contract.

### Fixed

- The pilot suite's review-response hardening: a plugin-level, self-scoped `PreToolUse`
  guard hook denies the pilot suite's reflex destructive Bash commands (an unnamed-remote
  `git push`, a force/delete/mirror push, a package-publish command, a broad process
  kill) while no-opping for the main session and every other agent; untrusted-input
  boundary prose was added to the pilot/orchestrator/pilot-wave docs (cards, comments,
  subordinate reports, and executor-lane output are DATA, never obeyed as instructions);
  `pilot-watchdog`'s tool allowlist is fenced to its read-only contract; the
  cross-family-bridge probe now also scans common rc-file install directories, not PATH
  alone.
- `adopt --install` no longer overwrites a user's own edits to an adopted copy (a
  content-fingerprint check, with `--force` to override deliberately); the fingerprint's
  known blind spot (an edit glued directly onto the banner line) is documented.
- A pilot spawned from a plugin install now resolves its **project-local** copy correctly
  when one has been adopted (workaround composability with `adopt`), and the
  observer-pairing limitation for plugin-installed (non-adopted) pilots is documented.
- `pilot-watchdog`'s capability fence keeps the `ObserverReport` channel open (an earlier
  fence had closed it).
- `pilot-wave` now **proposes** the watchdog-enabling project copy to the user rather than
  instructing them to install it themselves.
- The delegated-run settle-watch contract (the spawner-side half — how a spawning session
  detects and reconciles a pilot/orchestrator run that settled while unattended) is
  documented in the `pilot-wave` skill.

## [0.41.0] - 2026-07-20

### Added

- The delegated dev-loop agent suite, shipped generalized for end users: `pilot`,
  `pilot-orchestrator`, and `pilot-watchdog` agent definitions (the pilot always travels
  paired with its `pilot-watchdog` observer), plus the `pilot-wave` composer skill that
  resolves the environment brief (knowledge-base index, task tracker, executor-lane
  probe, worktree/report directories, quota posture) and composes the
  orchestrator/pilot spawn prompt with explicit model elevation.
- Four rule-cores ported inline into the shipped agent definitions: step-back-to-the-
  shared-root plus a Rule-of-Three duplication survey and ground-the-premise discipline
  (`pilot`); the proportionate verification ladder (`pilot` + `pilot-orchestrator`); two
  concurrent-worktree gotchas (`pilot`); and a fire-only-when-it-pays plus
  pre-commit-prediction discipline for the workflow-composer premise-quality reference.
- A conditional `SessionStart` hook that injects a generic, cost-model-neutral delegation
  ladder — calibrated to the host machine (it probes `PATH` for cross-family bridges) —
  as a silent no-op where no tracked/delegated-work markers are present, and fail-safe
  silent on malformed or cwd-less hook input.

Earlier releases predate this changelog.
