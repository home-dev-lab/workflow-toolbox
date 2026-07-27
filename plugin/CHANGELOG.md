# Changelog

All notable changes to the `workflow-toolbox` Claude Code plugin are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.46.0] - 2026-07-27

### Removed

- **BREAKING — the `workflow-toolbox:pilot` / `workflow-toolbox:pilot-orchestrator` agent
  types no longer exist.** The pilot suite now ships as unregistered templates under
  `plugin/agent-templates/` and reaches a session only as an adopted project copy under its
  bare name (`pilot`, `pilot-orchestrator`), installed by `adopt-rules --set agents --install`.
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

- `adopt-rules`: `--global` targets the config directory, resolving `CLAUDE_CONFIG_DIR`
  itself (falling back to `~/.claude` only when unset) instead of requiring the caller to
  build that path and pass it via `--dir`. A hand-built `~/.claude` is correct on a default
  machine and silently wrong on one running a second config profile, where the report then
  describes a directory nobody meant. Composes with `--set all`; mutually exclusive with
  `--dir`.

### Changed

- `adopt-rules`: `STALE` now tracks CONTENT, not the version number. Previously every
  release marked every adopted copy stale, including copies byte-identical to the shipped
  file — so a release touching one skill's prose made a dozen untouched rules announce
  themselves as out of date. A warning that cries wolf on each release is not read on the
  release that matters. `AHEAD` is still reported first and is never short-circuited by
  matching content: a copy claiming a version the plugin does not have is an install
  anomaly, which identical text does not explain away.

## [0.45.1] - 2026-07-26

### Fixed

- `adopt-rules`: the skill described the bundled rules as already injected ambiently by the
  `SessionStart` hook, presenting adoption as the "persistent, editable alternative". That
  reading is wrong and consequential — a plugin's `rules/` directory is inert, and the hook
  emits only a six-line digest of the delegation ladder. Every other bundled rule reaches a
  session ONLY once adopted. The skill now states plainly that adopting is what puts the
  rules in force, not merely what makes them editable.
- `adopt-rules`: `--check` on a directory whose entries are symlinks (a supported setup —
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

- `adopt-rules --audit-overlap --set agents`: a coherence gate for adopted pilot-suite
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

- `adopt-rules` skill: an opt-in installer that writes editable, versioned, fingerprinted
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
- `adopt-rules --install` no longer overwrites a user's own edits to an adopted copy (a
  content-fingerprint check, with `--force` to override deliberately); the fingerprint's
  known blind spot (an edit glued directly onto the banner line) is documented.
- A pilot spawned from a plugin install now resolves its **project-local** copy correctly
  when one has been adopted (workaround composability with `adopt-rules`), and the
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
