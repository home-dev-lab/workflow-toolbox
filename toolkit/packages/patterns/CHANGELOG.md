# Changelog

## 0.8.0

### Minor Changes

- adversarialVerification: add a `minValidVotes` confidence floor (default 2). A `confirmed`/`refuted` verdict now requires at least this many surviving VALID (non-null, provenance-passed, retry-recovered) votes; a thinner majority — e.g. a multi-vote claim reduced to one valid vote by verifier failure or provenance disqualification — is DEMOTED to `partially-confirmed` (the existing low-confidence marker; no new verdict value). Clamped per claim to `min(minValidVotes, claimVotes)`, symmetric with `refuteThreshold`, so a deliberately low-vote claim (`votesPerClaim` / `votes: 1`) stays decided by the votes it was given. Set `minValidVotes: 1` for the pre-floor behaviour.
- 4987128: `adversarialVerification` now cost-bounds an EXTERNAL cross-family verifier. When
  `verifierType` routes to a registered external CLI (opencode / codex), the wrapper is a thin
  RELAY whose own model does not drive verdict quality (the external CLI does), so the wrapper
  model now defaults to `haiku` instead of `BEST_MODEL` — a self-answer failure is then ~10×
  cheaper — and NO model-downgrade warning fires for that relay (the "quality is
  model-sensitive" premise does not hold for a relay). A plain Claude verifier is unchanged
  (BEST_MODEL default, downgrade warning on a weaker model), and a caller can still pin the
  wrapper model explicitly.

  It also emits ONE aggregated run-level `SELF-ANSWER TOLL` warning summarizing how many
  external votes returned a verdict with no credited CLI invocation (confirmed self-answer vs
  undetermined), how many were recovered on retry, and how many remain null — the control
  surface for the budget the post-hoc provenance gate nullifies but cannot refund.

- 2143b22: The external-vote provenance gate now detects an `opencode run` with a LINEAR, ReDoS-safe
  matcher instead of a single mega-regex. The old regex's `BIN=…opencode …[\s\S]*?… "$BIN" run`
  arm backtracked catastrophically (~30s) on a large `opencode`-but-no-`run` command, and a 20k
  scan cap hid a real `run` sitting past position 20k inside a long heredoc — so a legitimate
  external verifier vote whose `run` came after a big prompt heredoc was wrongly reported as
  having no provenance (a false-refuse). The embedded checker scanner now inlines the matcher's
  source verbatim and runs it over the FULL command (a head/tail window bounds the work), so a
  `run` past 20k is credited and the ReDoS is eliminated. The `commandRe` in the signature
  registry is retained for display only; the executable path is the new `matchCommand`.
- 78f109e: `adversarialVerification` now retries a verifier vote once when it was disqualified for
  missing provenance, instead of dropping it outright — a transient provenance miss no longer
  silently thins the vote pool. The effective-label provenance resolution is corrected so a
  vote is credited against the label it actually ran under, and the provenance guard is
  anchored so a disqualified-without-provenance vote can't slip through the retry path
  uncounted.
- probeAgentType: new `required` option. An explicitly user-configured agentType (e.g. `agentTypes.verify`) that fails its availability probe now throws an actionable error at launch instead of silently degrading to the standard subagent. Default (library default-routing) keeps the graceful degrade.

### Patch Changes

- adversarialVerification provenance checker: fix the Path-B false-undetermined that forced costly external-vote re-spawns. The post-burst checker could scan a vote's per-subagent transcript before it was flushed (`found=false` → `cliSeen: null` → fail-closed → a `:retry` re-spawn of an expensive external-CLI vote — 32/36 in a real census run). The embedded scanner now (a) reads the flush-immune per-subagent cli-seen marker written by the guard hook (`sha1(transcript_path + ':' + agent_id)`, byte-identical to the hook's `markerPathFor`), so a real CLI is credited even when the transcript's Bash line is not yet flushed, and (b) re-scans on a bounded poll until every label is attributed to a transcript or a deadline elapses (`WT_PROVENANCE_POLL_DEADLINE_MS` / `WT_PROVENANCE_POLL_INTERVAL_MS`, defaults 30s / 500ms). No public API or verdict change; a genuine self-answer (no marker, no CLI) is still disqualified.
- adversarialVerification/tournament cache-warm: a warm-up routed to an external CLI lane (opencode/codex) now must return CLI-derived proof (a plausible `<cli> --version`); a self-answering wrapper is retried once, then logged as SKIPPED and never counted as a warmed lane. Plain (Claude) warm-ups are unchanged.

All notable changes to `@workflow-toolbox/patterns` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.1] - 2026-07-21

### Added

- `chunkedAnalysis` — a new pattern: deterministic chunked map-analyze + synthesis over a
  large input, sized by `maxChars`.
- Per-invocation `stageKey` salting plus shared stage/label constants, so repeated calls
  to the same pattern within one run stay distinguishable in the digest/journal.
- Per-task worker-effort auto-selection (a three-tier form) for fan-out patterns.
- `untrusted()` / `renderSourceRefs()` prompt-fencing helpers, extracted for reuse across
  patterns that interpolate external content into a prompt.
- `workflow-toolbox:lean` agentType support for pure-reasoning fan-out roles (classify,
  vote/judge, score, dedup, synthesize) that never need a tool — strips the ambient
  tool/skill/MCP injection every default subagent otherwise pays for.
- A provenance gate on `adversarialVerification`'s externally-sourced verifier votes
  (a cross-family verifier's vote must carry provenance to count).
- Deterministic structured-output salvage: an agent that exhausts its StructuredOutput
  retries now gets diagnostics and a repair pass instead of silently degrading to `null`
  — including the no-StructuredOutput-tool-offered case, not just the null-degrade case.
- `TypedPhaseDigest`/digest emission now carries the caller's `phase` through (paired
  with the `@workflow-toolbox/runtime` change of the same name).

### Changed

- **Breaking:** `cacheWarm` now defaults to `true` (previously opt-in) — fan-out patterns
  stagger their first calls by default to reduce cold-cache thundering-herd latency; pass
  `cacheWarm: false` to opt back out.
- Toolkit-spawned leaf agents deny `SendMessage` by default (`workflow-toolbox:leaf`), so
  a fresh-context task executor has no inter-agent channel unless explicitly opted in.

### Fixed

- The lean/leaf agentType probe now uses a local prompt instead of one that demanded an
  external CLI, which had made every lean-routing probe fail on a machine without that
  CLI installed.
- Leaf-fence hardening: the probe now honors `perAgent` overrides and fails open loudly
  rather than silently.
- Bundle-review hardening: tournament salvage wiring, triage hardening, and a loud
  (rather than silent) degrade when the working directory can't be determined.
- A review-round fix set: numeric `stageKey` reservation, the canonical key-rule made
  consistent with its documentation, and a missed digest skip on the Fix path.

### Deprecated

- **0.7.0** (published 2026-07-21) shipped with a stale prebuilt `dist/` bundle that
  predated this version's source — notably missing the provenance gate above. Deprecated
  on the registry; use 0.7.1.

Earlier releases predate this changelog.
