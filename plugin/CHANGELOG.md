# Changelog

All notable changes to the `workflow-toolbox` Claude Code plugin are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.170.0] - 2026-09-03

### Added

- `WT_GUARD_MODE=observe` for the plugin's warn-only guards: `wt-merge-chain-guard-hook.mjs`,
  `wt-pipestatus-bash-only-guard-hook.mjs`, `wt-find-newermt-format-guard-hook.mjs`,
  `wt-git-commit-backtick-guard-hook.mjs`, `wt-var-colon-modifier-guard-hook.mjs`,
  `wt-missing-package-script-guard-hook.mjs`, `wt-pgrep-env-dump-guard-hook.mjs`,
  `wt-plugin-release-record-guard-hook.mjs`, `wt-isolated-spawn-report-path-hook.mjs`,
  `wt-observer-pairing-guard-hook.mjs`, and `wt-stale-date-guard-hook.mjs`. In observe mode they
  still detect and still journal their events, now stamped with `mode: "observe"` and recorded as
  `decision: "silent"` (never `warned`, so a reader counting `warned` as "the hook spoke" stays
  honest), but emit no model-facing warning text; the default remains `enforce`. The journal reader
  and `wt-guard-journal-scan.mjs --json` count `silent` events (own `silent` column, included in `total`), so
  the recurrence hook keeps seeing a muted guard's firings.

## [0.169.0] - 2026-09-03
> The entry below arrived with a branch merge but its code did NOT: no commit in that merge
> touches the hook it describes. It stays here rather than under a released heading, because a
> changelog that announces work absent from the tree is worse than one that says nothing.

### Added

- **The 13 shipped rules under `plugin/rules/` now carry a fourth adopt-managed set: `docs`.**
  `adopt --set docs` installs `plugin/docs/rules-rationale/*.md` to `<config-dir>/docs/wt/`, with
  the same fingerprint banner and edit-safety as the `rules` set. This is the shipped-rules twin
  of the private user-rule static-prefix cut of 2026-09-02: a rule keeps every directive line, and
  a dated field case or hook-superseded section moves VERBATIM to its rationale doc, leaving one
  pointer line behind. Verified LOSSLESS at cut time with a one-off script,
  `toolkit/scripts/verify-rules-rationale-split.mjs --baseline <pre-cut dir>` (same algorithm as
  the private-rule pass's `verify-split.py`): **13/13 rule/rationale pairs, 0 missing, 0
  duplicated, 0 mid-paragraph splits.** That script is NOT part of `pnpm test` — a frozen
  byte-for-byte baseline is right for a one-time migration proof and wrong for a permanent lock,
  since it would forbid ever legitimately retiring a sentence from a shipped rule again. The
  ongoing gate is `toolkit/packages/build/test/rules-rationale-referential.test.ts`: every
  pointer's `§heading` resolves in its rationale doc, every rationale-doc heading is referenced
  by a pointer, a doc exists for every rule and vice versa, and no rationale-doc line is
  duplicated verbatim in its rule — an invariant that survives future rewrites instead of
  freezing today's prose. Proven red-then-green with a real mutation.
  ⚠ Honest yield: 3 of the 13 rules had a section either hook-superseded or a genuine dated field
  case to move — 393 bytes / 38 tokens of the set's cold-start prefix (≈0.4%, A/B-measured, three
  identical-cache runs per arm); the other 10 fuse directive and evidence in the same paragraph
  throughout and have nothing extractable under the whole-paragraph-only invariant. Two further
  hook-collapse candidates (wt-delegation-ladder's "wrapper never renders its own verdict",
  wt-step-back-architectural's "twin elsewhere") were attempted and REVERTED after an independent
  cross-family review found the named hook's own message does not restate a directive the removed
  text carried — both stay whole rather than shipping a rule that reads as fully covered when it
  is not. This pass is a small correctness gain (the clauses a shipped hook truly does enforce
  mechanically are now named as such) rather than a size gain.

### Fixed
- **Three guards no longer record raw command text in the guard journal** (`wt-merge-chain` recorded the
  merge segment as `reason`, `wt-git-commit-backtick` the flagged commit-message fragment,
  `wt-find-newermt-format` the flagged argument). Found by the adversarial security review of the observe-mode
  change; the merge-chain security lock now forbids the segment text too.
- **Twenty-four capabilities the pre-release coverage audit found undocumented are now described in
  their mapped docs** (quota-probe JSON contract, adopt changelog spans, run-gate `--fail-pattern` and
  authorized-scope shapes, actionable-gate and registry-heartbeat env knobs, static vs dynamic
  orchestrator missions, `STOP_GATE_INTERVAL_MIN`, `leaf-readonly`, `labelRole`, prompt-tag escaping,
  pr-review routing knobs and its `incomplete` verdict).
- **Fourteen doc claims corrected after the pre-release docs audit** (adopt `SKILL.md`: agent copies come from
  `agent-templates/` and there are four of them; `--migrate --execute` is the real move; the merge-chain guard is
  warn-only and its separator set is `&&`, `;`, `|`, `||`, newline; three rationale docs no longer say a warn-only
  hook "enforces").
- **`wt-merge-chain-guard-hook.mjs` records a CLASSIFICATION of the segment that follows a chained
  `git merge`, never the command text.** The record now says whether the trailing segment was a blind
  gate (a real catch) or a read of the merge's own log/exit code (the documented safe pattern), so the
  guard's precision becomes measurable — and no raw shell text, which can carry exported credentials
  on some machines, ever reaches the guard journal.

- **The lesson-harvest hook re-offered reports it had already harvested.** It does keep a registry,
  and the registry is keyed correctly (`path → mtime`) — but the registry FILE and the directories
  it searches were both derived from the raw `cwd`. Since `cwd` changes turn to turn (a worktree, a
  subdirectory, a temp path), every distinct cwd got its own partition, and a run from a deep cwd
  also looked in a `.claude/reports` that does not exist there.
  Measured on one machine: **133 state files, 126 of them an empty object** — 95% of the state was
  written by runs that found nothing to look at.
  Both halves now resolve by exact key first, then by walking REAL ancestors, the way the queue
  snapshot's path resolver already did. The `path → mtime` key is unchanged; the
  `WT_LESSON_HARVEST_STATE` and `WT_LESSON_HARVEST_DIRS` overrides still win.
  ⚠ The state filename now carries a hash suffix, so existing partitions are not read. Effect is a
  ONE-TIME cold start per project: already-harvested reports may be offered once more, then
  remembered correctly. Nothing is lost — the registry only suppresses repeats.
- **`wt-plugin-release-record-guard-hook.mjs`'s remedy no longer asks a branch to bump the
  version.** `no-publish-from-branches.md` forbids a branch from bumping the version at all — the
  bump happens on `main`, at push time, and a branch's changelog entry carries no version heading.
  On any branch other than `main`/`master`, the warning now asks only for a changelog entry under
  `## [Unreleased]` and says so explicitly; the version-bump remedy is unchanged on `main`.
- **`wt-hook-registration-drift-hook.mjs`'s `UserPromptSubmit`/`SessionStart` timeout raised from
  5s to 15s**, matching the two user-level hooks already registered on the same event. Measured
  2026-09-02 on a session restarted right after a plugin rollout: `UserPromptSubmit hook timed out
  after 5s — output discarded` — right after a restart the SessionStart loops load the machine and
  5s was not always enough headroom, even though the hook's own cold wall time measures ~20-25ms on
  this machine (5 runs, before and after). The hook is advisory (registration drift detection), so
  its silent loss on timeout is harmless — which is exactly why it must not keep failing invisibly.
  Also made SessionStart cheaper on repeat: the declared-hooks parse (JSON.parse + a regex sweep
  over the whole plugin manifest) is now cached in the per-session state dir, keyed on the
  manifest's own `mtime`+`size`, so a repeat SessionStart against an unchanged manifest reuses the
  cached set instead of re-parsing it — the parse only re-runs once the manifest has actually
  changed (a plugin reload). A new test locks the hook's cold run under a 2s budget against the
  real manifest and proves the cache reuses the same declared-hooks set across two SessionStart
  calls.

## [0.168.0] - 2026-08-28

### Fixed

- **A guard no longer reads a heredoc body as a command.** A command line carries code and data in
  one string, and nothing textual separates them — mentioning a footgun is not committing one, and
  a regex over a command string cannot tell the difference. Writing a test fixture whose heredoc
  body mentioned an external-CLI invocation was REFUSED by the lane-consent gate, which refuses
  rather than warns, so it blocked correct work outright.

  The fix is at the shared level, not in the guard that shouted: `plugin/bin/lib/shell-text.mjs`
  now holds the ONE implementation of `stripHeredocs` / `stripQuotedSpans`, the two byte-identical
  hand-written copies in `wt-main-guard-hook` and `wt-pilot-guard-hook` import it instead, and
  `stripNonExecutedText` strips heredoc bodies before its character loop.

  ⚠ Order matters and is locked: heredocs FIRST, because a body can contain a quote that would
  otherwise pair with one outside it and swallow real code between them. The lock is paired —
  removing the fix reddens the false-positive row while the "still catches a real invocation" rows
  stay green, so the guard was not blinded to buy the fix.

## [0.167.0] - 2026-08-28

### Added

- **Every external-CLI call now leaves a node behind.** Until now a call made by a wrapper agent
  wrote nothing to disk, so a run surfaced its Claude agents from the journal and never its
  external work. The hook writes the two files a node is built from — and it is the only place
  that can, because hooks are per session: nothing outside the delegated session observes its
  tool calls, while a plugin hook loaded INTO it does.

  Three properties are locked, each proven red by a mutation targeting only itself:

  - the node uses a **derived** id (`<agentId>-lane…`), never `agentId`. The harness writes the
    calling agent's own transcript and meta at `agent-<agentId>.*` in that same directory, so
    using `agentId` truncates the agent's own turns and relabels its node as the external one —
    silently, with nothing raised;
  - two calls with different `tool_use_id` produce **two** nodes, and the same call reported twice
    produces **one**;
  - a token count that could not be measured is **absent, never zero** — a zero renders as a
    measurement nobody made.

### Fixed

- **A test specified a race against itself.** The autonomy-watch expiry case set the mandate
  freshness window to 60 ms and then required a check that SPAWNS A SUBPROCESS to finish inside
  it. It failed 2 of 3 full-suite runs and passed 5 of 5 alone — and passing alone was never a
  control, since it passed alone before the fix too. The window now outlasts a spawn.

## [0.166.0] - 2026-08-28
### Added

- **The actionability producer hook now BOUNDS the spill-file read it was doing unconditionally.**
  The harness can answer a large tool call by writing the response to a file and handing the hook a
  PATH; that path arrives inside the tool response, so reading it unconditionally let an untrusted
  value choose which file the process opened. Four bounds now apply — absolute, canonically inside a
  root the harness actually spills into, a plain file, and under a size cap — in a new
  `plugin/bin/lib/spill-containment.mjs`. It returns null on every refusal and never throws, so the
  caller's contract is unchanged: an unreadable spill stays a recorded failed attempt and no
  snapshot is written from a guess.

  Extracted into `lib/` rather than written inline because the hook EXECUTES at import, so a test
  importing it hangs on a stdin nothing closes. Both bounds are proven red independently: deleting
  the allow-list reddens only the outside-root case, deleting `realpath` reddens only the
  symlinked-directory case.


### Added

- **`wt-delegation-ladder` gains a fence-expiry clause.** A brief, rule or card that fences
  something off because a condition holds NOW keeps blocking after that condition ends, because
  nothing re-checks it — and a stale fence reads exactly like a live one, same text, no way for a
  reader to tell which.

  The clause states both halves: name the expiry IN the fence rather than the fence alone, AND give
  it something that re-reads it — record the condition where whatever satisfies it will land, quote
  the source that decides a quoted state, and report rather than lift a fence that is not yours.

  Measured three times in one day on three different surfaces before this was written: a task card
  fixed the same afternoon and left open for two more days; a defect fixed in code and never
  published, so every adopter still met it; and a rule whose own lifting condition had been
  satisfied and recorded elsewhere while the rule still said it had not been proven. Nothing was
  wrong when written; each simply outlived the state it described.

### Added

- **`leaf-readonly` agentType** — a fenced worker type for roles whose output is KNOWLEDGE
  rather than a change (survey, ground, audit, locate, verify-by-reading). It declares an
  explicit `tools:` ALLOW-LIST instead of subtracting from the default surface, and sits
  between `lean` (zero tools) and `leaf` (every tool except messaging).

  The reason it exists is measured, not theoretical: **withholding `Write`, `Edit` and `Bash`
  does not make an agent read-only.** A surface that still carries an MCP server's
  file-writing, shell-executing, record-deleting or message-sending tools still HOLDS all of
  those with none of the three present (the listing and one invocation from it are observed; that
  a write through such a tool completes is an inference, and the allow-list does not depend on it) — and an enumeration of forbidden tools cannot cover a surface
  that grows every time a user installs another MCP server. An allow-list is the only form that
  closes tools nobody has installed yet.

### Changed

- **`wt-delegation-ladder` gains a "read-only is an ALLOW-LIST" clause.** The rule previously
  described read-only enforcement only through the executor-briefing split; it now states the
  invariant (*the agent holds nothing that mutates anything outside its own context*), why a
  deny-list cannot work (an enumeration cannot cover a surface that grows with every installed
  MCP server), that an allow-list may silently deliver less than it declares, and that a newly
  written agent type is not spawnable in the session that wrote it.

- **`leaf`'s description no longer implies a fence it does not provide.** It denies
  `SendMessage` and nothing else; its own guidance previously read "you keep every tool except
  inter-agent messaging" without saying what that breadth includes. Both the description and the
  agent-facing guidance now name the reach explicitly and point a read-only role at
  `leaf-readonly`. No behaviour change: `leaf` keeps exactly the surface it always had, and no
  existing routing moves.

### Notes

- ⚠ An allow-list can deliver LESS than it declares, with no error: `Grep` and `Glob` were
  declared by two different definitions on this harness family and did not arrive. It errs SAFE
  (fewer tools, never more), so the fence holds — but a role must not assume search is
  available, and a caller should verify a spawned agent's ACTUAL surface rather than trust the
  declaration.
- ⚠ A newly added agentType becomes spawnable after a DELAY of roughly ninety minutes, with no
  restart and no announcement. Two readings taken at zero and sixty minutes both returned
  `Agent type not found` and were simply too early — do not read one refusal as impossibility, and
  re-probe instead of concluding.

### Added

- **A guard for the plugin's own release record.** A commit staging changes under `plugin/`
  while staging neither the version nor this changelog now warns. The published packages have
  enforced the equivalent for a long time — touch a package source without a changeset and
  `changeset-gate` goes red — but the plugin had no counterpart, so a plugin fix could be merged
  and pushed with no bump and reach no adopter, silently. Measured 2026-08-27: exactly that
  happened to the queue-gate guard-journal wiring.
  Ships **warn-only**: a work-in-progress commit that bumps once at the end of a branch, and a
  plugin change with no release surface, both fire it legitimately. Promotion to blocking is a
  separate decision taken from the guard journal's record.

### Note on the version number

This entry carries no version deliberately. `main` and `card/1837086183-lane-artefacts` incremented
their counters independently after forking at 0.160.0, so the same numbers denote different content
on the two sides. Choosing the next number is part of reconciling that fork, not part of this
change.

### Added

- **The briefing guidance now carries a platform check.** `wt-delegation-ladder.md`’s “Briefing an
  executor” section told an arbiter to state invariants, traps, evidence format and escalation
  triggers — all of which check a brief against the TASK. Nothing checked it against the PLATFORM,
  and a capability that worked last week reads as furniture. A prescribed remedy can be withdrawn
  while the rule still names it, at which point the brief is wrong BEFORE the executor reads it:
  the agent behaves correctly, cannot comply, and explains — a round trip bought for nothing, and
  the competence of both parties is exactly what hides the cause. The clause covers a tool, a write
  path, an output channel or an agent type, and says to confirm at brief time rather than infer
  from the rule that prescribes it.

## [0.165.0] - 2026-08-27
- **A task's remaining-work ledger is a claim about the tree, and the briefing guidance now says to
  re-derive it.** A multi-part task carries a running "these remain" list written by whoever last
  touched it; it goes stale the instant a commit lands without a tracker write, and nothing
  announces the drift — the ledger stays confident, specific, and formatted exactly like a verified
  fact. Briefing an executor from a stale one asks for work already done, and the executor is not
  the safeguard: told to fix a defect, it has every reason to build a second mechanism beside the
  first, or to rewrite what exists and silently drop hardening the original carried. The clause
  names the favourable tell — a lane returning a clean tree or a suspiciously small diff — and the
  one command that settles it before the brief is written.

## [0.164.0] - 2026-08-27

### Fixed

- **The stop-gate claimed to have observed an idle worktree when it had not looked.** Its activity
  scan returned a boolean, and THREE different facts collapsed into its `false`: no git root could
  be resolved from the cwd, the bounded walk spent its entry budget before finishing, and the whole
  reachable tree was walked with nothing recent. The emitted line asserted `no recent worktree
  activity` in all three, so a reader — and the decision "may I start something else" that reads it
  — could not tell an observation from an inability to observe.
  The scan now reports WHICH fact it established (`recent` · `idle` · `no-root` · `bounded`), and
  the emitted line names it. **Behaviour is unchanged**: only `recent` suppresses the gate, so the
  hook still speaks in every case it spoke in before — speaking when unsure is deliberate for a
  stop-gate, and the defect was the claim, never the decision.
  ⚠ The silent bail on the INVENTORY path is deliberately UNTOUCHED: its own comment states that
  silence is intentional, and making a per-turn hook speak there would turn every adopter without a
  producer into a permanently red gate.

## [0.163.0] - 2026-08-27

### Added

- **Task tracking: closing a card updates its DESCRIPTION, not only a comment.** The rule said
  where detail belongs and never said to refresh the description when the work lands, so the
  stale pre-work claim stayed on the surface every reader — human or tool — sees by default.
  Measured on an adopter's 51-card board: a fidelity check read descriptions, read zero comments,
  and reported three shipped features as never built. The clause also states that any machine-read
  field convention is parsed from the description, so recording it in a comment looks recorded and
  is invisible.

## [0.162.0] - 2026-08-27

### Fixed

- **Worktree preparation told the wrong actor to run the wrong command.** The concurrent-sessions
  rule instructed the SPAWNED AGENT to rebase its isolated worktree. The pilot guard refuses a
  delegate's own rebase, so the brief ordered something the agent could not do — it relayed and
  waited, costing one round trip per delegate before any work started. The SPAWNER now prepares
  the tree, immediately after the spawn call returns.
- **And the operation itself was wrong for a fresh worktree.** A fresh worktree branches off the
  repository's DEFAULT branch, so `git rebase <integration-tip>` replays upstream's own commits
  onto the integration branch and exits 1 with a conflict. `git reset --hard <tip>` is correct
  while the worktree carries no commits of its own. The discriminator is now stated, because the
  correction inverts later in an arc: once the worktree has its own commits, `reset --hard` would
  destroy them.

### Added

- **The delegation ladder now says adoption is a PRECONDITION, not an adjective.** The pilot pair
  ships as unregistered templates — deliberately, since the harness does not honour `observer:` on
  a plugin-registered agent and a registered pilot would run without its watchdog. A project that
  has not adopted them has no `pilot` to spawn, and nothing said so: the spawn failed after a
  complete brief had already been written. Also records that an adoption is picked up within
  minutes, so the "~90 minutes or a restart" caution applies to hand-written definitions only.

## [0.161.1] - 2026-08-20

### Fixed

- **The stop-gate no longer reads a session driving an external lane as "nothing running".** It
  decided whether work was in flight from subagent transcripts alone, so a session whose turn ends
  with a CLI lane writing inside a worktree looked idle — nothing that lane does passes through a
  tool call the session makes. The gate now also counts recent worktree activity, and the negative
  direction is locked too: `node_modules` writes do not count, and a sibling worktree under an
  umbrella root cannot silence a different session.

## [0.161.0] - 2026-08-20

### Fixed

- **The commit-signature check no longer accuses commits the remote already has, and no longer goes
  blind on the ones it adds.** A range like `<remote>/<branch>..HEAD` answers "what would this push
  add" only while the branch is a straight line; merge the default branch in and the range
  legitimately contains that branch's whole history — other people's commits, unsigned, already
  published. On a repository whose default branch is unsigned, the check refused a push by listing
  120 such commits and proposed rebasing them.
- **The exclusion is scoped to the remote being pushed TO, not to every remote-tracking ref.** A
  bare `--not --remotes` over-corrects in the dangerous direction: on a repository carrying 43
  tracking refs — 31 of them leftovers from a deleted remote, 11 from an archive that is never
  pushed, exactly one a push target — it reported ZERO commits on a range that would genuinely add
  62. A guard that falls silent on precisely what it exists to inspect does not degrade, it inverts.
  The remote is derived from the range's left side and validated against `git remote`; when it
  cannot be established, nothing is excluded and the check over-reports, because a noisy guard is
  recoverable and a mute one is not.

### Changed

- **An escalation now names the option it recommends.** `wt-proactive-decision-making` asked for
  every branch to be presented and stopped there — the bare menu, the one message shape that costs
  a reader more than silence, because they must construct the answer rather than validate one. The
  rule now carries both independent axes, in order: is this theirs at all, and only then, did you
  name what you recommend. It also states plainly which of the two can be mechanised and which
  cannot.

## [0.160.0] - 2026-08-10

### Added

- **The memory index probe now shows how many fiches sit behind each index line.** It verified
  REACHABILITY and said so, but nothing showed how much sat behind a single line — a store can pass
  every check while most of its content is, in practice, unknown to any session reading the index.
- The count is **one hop and member-shaped**, deliberately. A transitive count read 138 on nearly
  every line of a 353-fiche store, because fiches cross-reference each other liberally, and a leaf
  and a 44-member hub then printed the same number.
- The count no longer consults the hub CLASSIFICATION either: that ratio answers "do the hub-only
  checks apply", a different question, and gating on it made a genuine three-member hub report zero.

### Fixed

- **An entry the probe could not measure prints as unmeasured, never as `0`.** A missing
  measurement and a genuine zero are different facts, and collapsing them produced the one number a
  reader takes as measured.
- Unreadable fiches are surfaced as an explicit reason instead of being skipped in silence, so a
  partially-read store cannot render as a fully-measured one.

⚠ This is an EXPOSURE, not a guard: a number with no verdict and no threshold. A discoverability
ratio was considered and rejected — its numerator requires reading a sentence, which would put a
model inside a guard. An index line that fronts three fiches but describes them badly is still
invisible; the probe simply no longer implies otherwise.

## [0.159.2] - 2026-08-10

### Fixed

- **`wt-actionable-snapshot-producer-hook.mjs` now records WHY it could not measure.** It has always
  stayed silent rather than guess from a partial read — correct — but that silence was
  indistinguishable from the hook never firing, not being installed, the project having no board, or
  the tool call not being one it watches.
- The three real conditions are now named separately (unreadable payload, unparseable payload, no
  board pointer), because they have three different remedies and one shared message would rebuild
  the defect this closes.
- The record is bounded, and the bound is asserted by a test: a hook that fills a disk over a long
  session is worse than one that says nothing.

⚠ On a board large enough that every read exceeds the tool-result limit, this hook cannot compute a
snapshot at all — measured at 2,957,161 characters with the narrowest possible query, both filters
silently ignored. **This change does not fix that**; it makes it visible instead of silent, so the
frequency can be counted before deciding whether a fallback is worth its cost. No network access
was added.

## [0.159.1] - 2026-08-10

### Changed

- `plugin/bin/wt-observe.mjs` rebuilt. Its sibling-checkout resolution moved out of the launcher
  into a shared module so a second caller could use it instead of copying it — **no behaviour
  change to `wt-observe` itself**, which is why this is a patch and not a minor.

The second caller is a development-only gate that does not ship: this repo's own `pnpm test` now
compiles the private companion app's consuming surface against this working tree, so a widened type
here fails HERE rather than in whichever repo happens to run its gates next.

## [0.159.0] - 2026-08-10

### Added

- **`wt-wake-floor` — a monitor that measures nothing, so nothing can silence it.** It waits, emits
  one line, and waits again. It reads no queue, no cards, no delegates, no transcript, no git state.
- Registered in `plugin/monitors/monitors.json`, so the harness places it at session start like the
  others; it dies with its session and returns with the next one, and nobody has to re-arm it.

### Why a monitor that knows nothing is worth shipping

`wt-autonomy-watch` fires on a conjunction — live mandate, queued work remains, nothing in flight,
idle long enough. The second term reads a queue snapshot. When that snapshot is stale the term is
unverifiable, the conjunction cannot hold, and the watcher stays quiet.

That is correct behaviour, and it is the problem: **a watcher right to stay quiet and a broken one
emit the same nothing.** Worse, the two correlate — an idle session is precisely one that has
stopped refreshing the inputs its own alarm depends on, so the alarm goes blind as a consequence of
the state it exists to report.

Measured on the development machine: a mandated session stopped with 118 open cards and nothing in
flight; the conditional watcher was armed the entire time and never emitted; no turn came back for
**3 h 24**.

So the conditions are kept, but their role changes: `wt-autonomy-watch` stays above this one and
wakes EARLIER when it can see work, carrying the count and the next item. **It refines; it no
longer authorises.**

### Notes for adopters

- ⚠ **Silent unless a project-scoped autonomous mandate is declared** (`wt-autonomy-arm`). Absent,
  malformed or expired mandate: nothing is ever emitted. Ordinary interactive sessions never hear
  from it.
- That mandate gate is the one thing it reads, and it is deliberately **not a measurement of work**:
  it is a declaration of intent, and unlike a queue snapshot it does not go stale as a side effect
  of the session being idle.
- Cadence defaults to 15 minutes; `--poll <seconds>`, or `WT_WAKE_FLOOR_IDLE_MINUTES` at process
  start.
- ⚠ **An empty wake costs a full turn** that re-reads the session's accumulated context. That is the
  price of not being silenceable, and it is the trade this monitor makes on purpose.

### What its message deliberately does NOT claim

```
FLOOR: N minutes elapsed on my interval. I measure only that — not whether you are idle,
and not whether work remains. Check the queue yourself.
```

An earlier draft said "no turn for N minutes". This process cannot know that — it measures its own
cadence — so a session working steadily would have been told it had been idle. The second sentence
exists because an unconditional ping carries no evidence that anything is pending, and without it
the ping gets read as one.

### ⚠ Not established

That the harness arms this monitor at session start. It follows the same manifest path as the four
existing monitors, which are observably placed thirteen seconds into a session — but this one has
not been through a restart yet, and the end-to-end proof (a turn arriving in the exact state that
failed: mandate live, snapshot stale, nothing in flight) is deliberately left open rather than
assumed.

## [0.158.0] - 2026-08-09

### Added

- **`plugin/bin/wt-wake-channel.mjs` plus `plugin/.mcp.json` — a wake channel, so a process
  OUTSIDE a session can hand that session a turn.** Until now nothing could: there is no session
  id to address and no socket to knock on, and the harness wake reaches only the session that
  LOADED the MCP server. So the doorbell has to live inside the house. An observer stays outside,
  drops a file into a spool directory, and this server — loaded by the observed session — turns
  it into a turn.
- The server speaks JSON-RPC 2.0 over stdio **by hand**. It has to: this plugin ships with zero
  third-party dependencies, so the MCP SDK cannot travel. The framing was grounded against the
  SDK already running on the development machine rather than inferred —
  `dist/esm/shared/stdio.js:9-19` splits the read buffer on `\n`,
  `dist/esm/shared/stdio.js:28-30` serialises as `JSON.stringify(message) + '\n'`.
  Newline-delimited, not LSP `Content-Length`.
- Spool location is `WT_WAKE_SPOOL`, else `${XDG_STATE_HOME:-$HOME/.local/state}/wt-wake-channel/inbox`,
  with a `consumed/` subdirectory; poll interval `WT_WAKE_POLL_MS` (default 5000); diagnostics on
  stderr only, and only under `WT_WAKE_DEBUG`.

### Notes for adopters

- ⚠ **This is the first `mcpServers` entry this plugin has ever declared.** Installing the plugin
  now starts one extra Node process per session. It holds no tools, answers `tools/list` with an
  empty list, and emits nothing at all unless something writes into its spool — but it is a new
  process, and that is worth knowing before upgrading.
- ⚠ **It is inert without a host-side opt-in.** The wake requires the plugin to be listed in the
  machine's `allowedChannelPlugins` (a root-owned managed-settings file) *and* named in the
  session's `--channels` tag at launch. Neither is done by installing. Absent them, the server
  loads, answers the protocol, and never wakes anything.
- ⚠ **What is NOT established**: that Claude Code turns this server's notification into a turn.
  The emission is proven at the process level, and the harness path was measured on the
  development machine through a different plugin — evidence about the harness, not about this
  code. Treat the end-to-end wake as unverified until you see it.

### Design choices worth naming, because each one costs something

- **stdout is the protocol**, so nothing else may ever be written there — one stray byte corrupts
  the stream for the whole session. That is also why the executable is excluded from the
  operator-CLI help sweep: even valid help text would break its transport.
- **A broken spool is silent.** A supervision channel that crashes what it supervises is worse
  than one that stays quiet, so every filesystem failure is swallowed. The cost is that a
  misconfigured spool reports nothing; `WT_WAKE_DEBUG` is the way to see it.
- **Move-then-emit.** A crash between the two must not replay a wake — losing one is recoverable,
  repeating one forever is not.
- **Nothing is emitted before `notifications/initialized`**, so a session never gets a spurious
  wake at startup.

## [0.157.0] - 2026-08-08

### Added

- **`wt-lane-consent-gate-hook.mjs` — a `PreToolUse` hook that ENFORCES the executor-lane
  consent switch (`WT_EXECUTOR_LANE_CONSENT`) at the moment a lane call actually runs**,
  closing the gap the card behind this release was opened for: the switch existed
  (`wt-lane-consent.mjs`, read/write) and disagreement between it and the auto-loaded rules was
  already detected at session start (`wt-lane-consent-check-hook.mjs`), but nothing mechanical
  ever consulted it AT CALL TIME — `opencode-verifier` shells out unconditionally, and the
  pilot-wave skill's "check consent first" step is prose a model can silently skip. The new hook
  fires only on a command that actually invokes the lane (`opencode run` / `codex exec`,
  quote/comment-stripped — the same detection `wt-lane-saturation-hook.mjs` already uses) and
  denies it (`permissionDecision:'deny'`) unless the account/project consent chain resolves to
  consented, naming which level refused.
  ⚠ **Fails CLOSED, not open** — the deliberate exception among this directory's guards: every
  other deny-capable hook here fails OPEN on its own internal error (a broken entry path must
  never itself block a command). A consent gate protects the opposite property — an unreadable
  or malformed settings file must never be silently read as "yes" — so both the 'unknown' branch
  of the underlying consent resolution and this hook's own top-level errors resolve to a denial.
  This does not change what any project's rules describe as policy; it makes the existing opt-in
  switch enforceable at the one place it previously had no effect.

### Added

- **`wt-label-intent-producer-hook.mjs` — a `PostToolUse` hook (matching `mcp__planka__get_board`)
  that mechanically runs `toolkit/scripts/label-intent-lens.ts` on a real board read**, instead
  of relying on the `what-next` skill's own "MANDATORY" prose line telling a model to run it.
  Measured, fresh session, 2026-07-27: that line's anti-false-verdict half held (a session
  correctly refused to claim "zero label gap" without having run the lens), but the "run it"
  half did not reliably trigger the actual invocation — a text instruction can refuse a false
  claim, it cannot make an action happen. The hook shells out to a project's own vendored
  `toolkit/node_modules/.bin/tsx` against the real script as a genuine child process, and
  parses ONLY that script's own printed summary line — it never recomputes the check itself,
  never touches a card or a label, and stays silent (no `additionalContext`) on every failure
  direction: no vendored `toolkit/`, no `tsx` binary, a timeout, unparsable output, or a
  genuinely clean board all produce nothing, never a guessed verdict or manufactured noise.
  New pure module `plugin/bin/lib/label-intent-runner.mjs` (locate `tsx` + the script, run it,
  parse its summary) is unit-tested independently of any real child process, plus an
  integration layer spawning the real hook against a fake-but-executable toolkit fixture.
  Registered in `plugin/.claude-plugin/plugin.json`'s `PostToolUse` hooks. Documented in
  `docs/public/known-issues.md` item 11, and in `plugin/skills/what-next/SKILL.md`'s Step 0,
  which now marks its own long-standing reserved caveat CLOSED for `label-intent-lens.ts`
  specifically (the sibling `card-hygiene-lens.ts` remains skill-invoked only, a named open
  follow-up).

## [0.155.0] - 2026-08-08

### Changed

- **`wt-queue-not-empty-gate-hook.mjs` is now REGISTERED as a Stop hook, alongside
  `wt-actionable-gate-hook.mjs` — resolving the register-or-retire decision the previous
  release (`0.154.0`) left open.** A side-by-side comparison of the two hooks' predicates
  refuted the "superseded" claim this file's own header used to carry: `wt-actionable-gate-hook.mjs`
  is Planka-only, only produces its snapshot from specific unfiltered board reads, requires a
  project-local `depends-on-parser.mjs`, and gives up unconditionally after `BLOCK_MAX=3`
  consecutive blocks; `wt-queue-not-empty-gate-hook.mjs` is tracker-agnostic (any adopter can
  wire a marker writer, on any tracker or none), has no give-up cap, and structurally reaches
  cases the registered hook cannot — no tracker wired, a filtered last board read, a missing
  dependency parser, or a registered-hook snapshot stale past its own give-up ceiling. Ground
  truth on this project's own disk state showed the gap open: the registered hook's snapshot
  was ~29 hours stale (past its 2h staleness window and past its 3-block give-up cap) while 58
  tracked items remained open.

  Removed the corresponding entry from `hook-registration-exclusions.mjs` (it named this as
  "NOT a deliberate exclusion — a register-or-retire decision pending", which is now resolved).
  Both hooks can refuse the same stop when both markers exist for a project — deliberate, not
  a bug, and each throttles independently; their emitted messages were already distinguishable
  before this change (`"Actionability gate: …"` vs `"open work remains, nothing running · N
  open …"`), so no message-text change was needed to tell them apart.

  New test asserts the registration directly against `plugin.json`'s `Stop` array, not merely
  the exclusions map shrinking (`hook-registration-coverage.test.ts`); updated the manifest-shape
  assertions in `actionability-gate.test.ts` and flipped `queue-not-empty-gate.test.ts`'s own
  "does NOT register" test to assert registration.

## [0.154.0] - 2026-08-08

### Added

- **A mechanical gate closes the OTHER arrow of hook registration drift: a shipped
  `plugin/bin/*-hook.mjs` script that `plugin.json` never declares.** The existing
  registration-drift checks (`wt-hook-registration-drift-hook.mjs`,
  `plugin-hook-registration-drift.test.ts`) verify that every DECLARED path resolves to a real
  file — that direction fails loudly, at load time. The opposite direction fails silently: a
  file can exist, carry its own tests and documentation, and simply never run, because nothing
  is broken. That is exactly how `wt-lesson-harvest-hook.mjs` shipped unregistered in `0.134.0`
  (fixed in `0.151.0`) and how `wt-lesson-harvest-hook.mjs`'s sibling audit found a second
  instance, `wt-queue-not-empty-gate-hook.mjs`.

  New: `hook-registration-coverage-core.mjs` derives the shipped hook set from the
  `plugin/bin/` directory (never a hand-maintained list) and compares it against the manifest's
  declared set plus a new exclusions map, `hook-registration-exclusions.mjs` — same shape as
  the existing `docs-provenance.ts` decision list, one entry per deliberately-unregistered
  script with its reason. The gate (`hook-registration-coverage.test.ts`) also refuses a STALE
  exclusion (naming a script that no longer ships) and a REDUNDANT one (naming a script that
  IS declared), so the map itself cannot silently drift from what it claims.

  Two entries are excluded today: `wt-adopt-rules-check-hook.mjs` (a deliberate deprecation
  shim, invoked directly by name rather than through the manifest) and
  `wt-queue-not-empty-gate-hook.mjs` (NOT a deliberate exclusion — a register-or-retire
  decision against `wt-actionable-gate-hook.mjs`, a second Stop hook answering an overlapping
  question, left to the maintainer rather than resolved by this gate).

## [0.153.0] - 2026-08-08

### Added

- **Two brief-quality clauses added to `wt-delegation-ladder.md`'s "Briefing an executor"
  section, ported from a private rule after they proved durable and environment-free.**
  The first: quote a task's definition of done as an unedited block in every brief — a brief
  written from the briefer's own reading, rather than the task's text, can invert a closure
  criterion, and the executor has only the brief to obey. The second: an example shown to
  illustrate a register in a brief gets pasted into the delivered artifact verbatim, because
  the executor cannot tell a demonstrated style from real content — show the shape in a form
  that would be wrong to paste instead.

## [0.152.0] - 2026-08-08

### Fixed

- **`wt-lesson-harvest-hook.mjs` is now actually registered as a Stop hook.** It shipped in
  0.134.0 with its own tests, its own crash-safety coverage, and a known-issues.md entry and
  CHANGELOG line both describing it as already firing "at each turn end" — and
  `plugin/.claude-plugin/plugin.json` never listed it under `hooks.Stop`. Nothing in the harness
  invoked it; the file existing and being tested was not the same fact as it being wired, and
  the shipped prose asserted the latter without checking it.

  Caught the same way the card that reported it was framed: `declaredHookPaths()` against the
  real manifest returned no `/bin/wt-lesson-harvest-hook.mjs` entry under `Stop`, for any event.
  A new test in `hook-registration-guards.test.ts` locks it — RED before this fix (asserted the
  entry, got the three unrelated Stop scripts back), GREEN after.

  ⚠ **Two more `*-hook.mjs` files under `plugin/bin/` are unregistered the same way** —
  `wt-adopt-rules-check-hook.mjs` is a deliberate deprecation shim (documented in its own header,
  invoked directly by name for sessions that snapshotted the old path, never through the
  manifest) and is correctly excluded. `wt-queue-not-empty-gate-hook.mjs` is not: it is actively
  maintained, documented in `known-issues.md` as a Stop hook, and absent from `plugin.json`
  exactly like this one was. Left unfixed here — it is a different mechanism from
  `wt-actionable-gate-hook.mjs` (which IS registered and may or may not supersede it), and
  deciding that needs its own card rather than riding this one's fix.

## [0.151.0] - 2026-08-08

### Added

- **Three private-machine guards ported to the shipped set, warn-only, from an inventory
  that first ruled out most private hooks as machine calibrations.** All three read as
  pure prose/shape heuristics with no machine-specific string:
  - `wt-isolated-spawn-report-path-hook.mjs` (PreToolUse on `Agent`) — warns when an
    isolated spawn's brief names an absolute write/report target that is not already
    inside a worktree, so the spawner is told BEFORE the tree gets reaped that the
    delivery will not land where it looks like it should.
  - `wt-pgrep-env-dump-guard-hook.mjs` (PreToolUse on `Bash`) — warns on a full-listing
    `pgrep`/`ps` (`-a`/`-l`/`-af`/`-ef`/`aux`/`-o args=` without a `-p` filter), which can
    dump an entire wrapped shell's exported environment into the transcript. Its flag
    matcher was hardened during the port: the original regex read any hyphenated
    argument word (`pgrep my-pattern`) as if it contained a flag — fixed to require the
    dash be preceded by whitespace or the string start.
  - `wt-propagation-reminder-hook.mjs` (PostToolUse on `Write`/`Edit`/`MultiEdit`) — asks
    the propagation question (who/when/what/shipped-twin) the moment a shipped or
    machine-tooling path is edited; deliberately silent on `<config-dir>/rules/*.md`,
    already covered by `wt-rule-edit-horizon-hook.mjs`.

  All three are journalled via the shared `recordGuardEvent()` and test-locked in BOTH
  directions (fires on the real case, silent on correct work), proven by a mutation in
  each direction on a copy outside the repo.

### Fixed

- **`capability-scout` (a shipped, `whenToUse`-advertised example workflow) failed
  immediately with `agent type 'code-scout' not found`, on both the Workflow tool and a
  minimal single-stage control run.** Its one agentType (`code-scout`) is a hand-authored
  capability-registry stand-in, resolved ONLY by `wt-observe launch` from the sidecar
  `capability-scout.capabilities.json` — the Workflow tool (Path A) has no capability-
  resolution hook, so an adopter following the workflow's own invitation to "launch it"
  through the ordinary Workflow tool met a hard, unexplained failure on first contact with
  the capability-registry example. Its `whenToUse` now states the `wt-observe launch`
  requirement as its first sentence, in REQUIRES language, instead of a plain suggestion.
  The custom agentType itself is kept — it is the point of the example — rather than
  silently swapped for a stock type, which would have removed the very mechanism the
  workflow exists to demonstrate.
- **New mechanical gate,
  `toolkit/packages/build/test/workflow-agent-resolvability.test.ts`**: every workflow
  under `toolkit/examples/*.workflow.ts` (derived from the directory, never a hardcoded
  list) is checked for a literal, hardcoded `agentType` a stock install cannot resolve.
  A workflow may deliberately require one, named in the test's own
  `JUSTIFIED_NONSTOCK_AGENT_TYPES` map with a reason (mirrors the existing
  `guard-journal-family.test.ts` justified-exclusions shape) — but only when its own
  `whenToUse` states the requirement in its first sentence, checked by the same gate. A
  survey of every shipped example confirmed `capability-scout` was the ONLY one hardcoding
  a non-stock agentType with no user opt-in; every other custom-routing knob in this repo
  (`agentTypes.review`, `agentTypes.verify`, `agentTypes.inventory`, …) is optional,
  probe-gated, and falls back to a stock Claude type by construction.

## [0.150.0] - 2026-08-08

### Added

- **`wt-missing-package-script-guard-hook.mjs` — warns when a `pnpm`/`npm run`/`yarn` command
  invokes a script that isn't defined where it will actually run.** In a workspace, running a
  workspace-root gate (`pnpm test`, `pnpm lint`) from inside a sub-package that doesn't define
  that script fails with a package-manager error and a non-zero exit — and that failure reads,
  most often right after a merge, as a real regression rather than the wrong-directory mistake
  it actually is.

  It tracks `cd`/`&&` chains across the command instead of reading the Bash tool's own reported
  cwd once, so `cd toolkit && pnpm test` resolves against `toolkit`. This tracking exists
  because an earlier, untracked version of this guard (in a private precursor) warned on that
  exact correct command within minutes of shipping — the dominant real shape, missed by a
  verification set written alongside the code it was verifying. Ships **warn-only**: it never
  refuses a command, only names the script, the directory that doesn't define it, and — when an
  ancestor package.json does — where to run it from instead.

  See `docs/public/known-issues.md` for the full contract, including what it deliberately does
  not cover.

## [0.149.0] - 2026-08-08

### Fixed

- **`--help` and `-h` now work on every operator-facing `wt-*` CLI in `plugin/bin/`, instead
  of being refused as an unknown flag.** Eighteen binaries — `wt-arc-watch.mjs`,
  `wt-autonomy-arm.mjs`, `wt-autonomy-watch.mjs`, `wt-check-commit-signatures.mjs`,
  `wt-check-observer-pairing.mjs`, `wt-command-repeat-check.mjs`, `wt-guard-journal-scan.mjs`,
  `wt-lane-activity.mjs`, `wt-lane-consent-check.mjs`, `wt-lane-probe.mjs`,
  `wt-memory-index-check.mjs`, `wt-pilot-card-reconcile.mjs`, `wt-push-scope-check.mjs`,
  `wt-quota-watch.mjs`, `wt-run-gate.mjs`, `wt-spawn-registry-scan.mjs`,
  `wt-stale-date-guard.mjs`, `wt-verdict-cap-check.mjs` — used to exit non-zero on `--help`,
  the same as any typo'd flag; a script probing one of them for availability would read that as
  "broken". They now print their own usage (most of it already existed as a header comment
  nobody saw) and exit 0, while an actually-unknown flag still refuses with a non-zero exit —
  the parser was not made permissive to get there. `wt-debug.mjs`, `wt-observe.mjs`,
  `wt-lane-consent.mjs`, `wt-lane-postdiff-check.mjs`, and `wt-service-watch.mjs` already
  behaved this way and needed no change. `wt-quota-probe.mjs` is the one deliberate exclusion —
  it takes no arguments at all. A new gate, `cli-help.test.ts`, globs `plugin/bin/*.mjs` (minus
  hooks and a named-and-justified exclusion list) so a CLI added later ships this by
  construction, not by remembering to add it.

## [0.148.0] - 2026-08-08

### Fixed

- **`wt-autonomy-arm.mjs --status` no longer says `armed` about a mandate the watcher has
  already refused to fire on.** 0.147.0 keyed the mandate marker on the project so a restart
  can inherit it, but shipped the freshness check TWICE — once in the watcher's own poll and
  banner, once in `--status`'s own report. They drifted immediately: given the same 9-hour-old
  marker at the same instant, the watcher correctly printed `mandate=stale(540min) · CANNOT
  FIRE`, while `--status` still printed `AUTONOMY MANDATE: armed`, because it only ever checked
  whether the file existed, never its age. A person asking "do I still have a mandate?" got a
  confident, wrong answer at the one moment they thought to check. Both readouts now call one
  shared classifier (`plugin/bin/lib/autonomy-mandate.mjs`), so there is no second copy left to
  disagree. `--status` reports exactly one of three states, each with its own exit code: `0`
  armed and live, `3` present but **expired** — past the freshness window, will not fire, named
  with its age and told to re-arm — and `1` no marker at all. `3` is new and distinct from `1`
  on purpose: "no mandate" and "a mandate that will not fire" are different facts a caller may
  need to branch on differently.

## [0.147.0] - 2026-08-08

### Fixed

- **A restart no longer kills your autonomy mandate.** `wt-autonomy-arm.mjs` used to key its
  marker on `CLAUDE_CODE_SESSION_ID` — a restart mints a new session id, so the marker the old
  session wrote became permanently unreachable, and `wt-autonomy-watch.mjs` read
  `mandate=absent` for a session that still believed it held one. Silent, and it never
  recovered on its own; the reported case was three restarts in one day, each one needing a
  manual re-arm nobody remembered to do. The marker is now keyed on the **project**, not the
  session: a restarted session inherits whatever mandate is still fresh for that project, with
  no gesture required. Inheritance is bounded by an 8-hour freshness window
  (`WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES`), read from the marker's own timestamp rather
  than its file mtime, so a mandate declared this afternoon does not still count tonight — and
  when a session picks up a mandate it did not itself declare, the wake and the arming banner
  both say so explicitly (`mandate=present(inherited)`, `inherited from session <id>, mandate
  declared NNmin ago`), rather than waking anyone silently. `wt-autonomy-arm.mjs` gained a
  `--project <dir>` option (defaults to `cwd`) to target a project explicitly.

## [0.146.0] - 2026-08-08

### Fixed

- **A STALE span could look complete while quietly skipping most of what actually shipped —
  the span now says so.** 0.145.0's changelog span (below) guarded only the file's own
  boundary: whether the installed version predated the OLDEST heading in the whole file. That
  misses the sharper case: this repo's own changelog has a real, permanent gap INSIDE its
  recorded span, not only at its edge — 61 of the minor versions between 0.68 and 0.144 never
  got a `## [x.y.z]` heading (a mechanical gate now forces every new release to carry one, but
  history is what it is). Measured: a stale copy at v0.70.0 got a confident, well-formatted
  17-entry span presented as the record for a range that actually spans roughly 75 versions of
  movement — a partial span dressed as a complete one, which is worse than an empty span
  because it doesn't even look suspicious. Every recorded span now reports its own coverage,
  computed only from the two requested versions — never from the file's oldest or newest
  heading, which is exactly the comparison that missed this: `COVERAGE: complete` when every
  version between them has an entry, `COVERAGE: INCOMPLETE — approx. N version(s) … have NO
  changelog entry at all` when some don't, `null` when the two versions don't share a major
  (the arithmetic doesn't apply across a major bump, and this reports "cannot determine" rather
  than guess).

## [0.145.0] - 2026-08-08

### Added

- **A session on a project with a STALE adopted rule now sees what it actually missed, not
  just that it missed something.** `adopt --check` used to report `STALE (installed v0.112.0
  < v0.125.2)` and stop there — a version number moved, nothing said what changed, and a
  session with no way to weigh the delta rationally ignores it, which is how a stale copy
  stays stale. It now prints the real `plugin/CHANGELOG.md` entries for that exact span,
  newest first, so a session reading "0.127.0 ships an always-on autonomy watcher" can decide
  for itself: *I have a hand-rolled equivalent at project level — I can adopt this and delete
  mine.* Capped at 10 entries with an explicit omitted-count on a very large span, so the
  section stays readable without ever dropping a count silently. Report-only: it never writes
  or acts, and every other `--check`/`--install` status (ABSENT, UP-TO-DATE, EDITED, …) is
  unchanged. Pure logic lives in `plugin/skills/adopt/scripts/changelog-span.mjs`, with a
  byte-identical inlined copy in `install.mjs` itself (which must stay a single relocatable
  script — its own tests copy it alone into a synthetic plugin root) kept honest by a
  drift-lock test rather than an import.

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
