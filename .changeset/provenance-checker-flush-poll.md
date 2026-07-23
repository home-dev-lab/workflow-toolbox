---
"@workflow-toolbox/patterns": patch
---

adversarialVerification provenance checker: fix the Path-B false-undetermined that forced costly external-vote re-spawns. The post-burst checker could scan a vote's per-subagent transcript before it was flushed (`found=false` → `cliSeen: null` → fail-closed → a `:retry` re-spawn of an expensive external-CLI vote — 32/36 in a real census run). The embedded scanner now (a) reads the flush-immune per-subagent cli-seen marker written by the guard hook (`sha1(transcript_path + ':' + agent_id)`, byte-identical to the hook's `markerPathFor`), so a real CLI is credited even when the transcript's Bash line is not yet flushed, and (b) re-scans on a bounded poll until every label is attributed to a transcript or a deadline elapses (`WT_PROVENANCE_POLL_DEADLINE_MS` / `WT_PROVENANCE_POLL_INTERVAL_MS`, defaults 30s / 500ms). No public API or verdict change; a genuine self-answer (no marker, no CLI) is still disqualified.
