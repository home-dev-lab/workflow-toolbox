# Changelog

All notable changes to the `workflow-toolbox` Claude Code plugin are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
