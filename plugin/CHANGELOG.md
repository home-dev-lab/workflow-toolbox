# Changelog

All notable changes to the `workflow-toolbox` Claude Code plugin are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
