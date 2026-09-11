# SDK pilot runner

`node plugin/bin/wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <card.md>` runs the pilot with `query()`
and `settingSources: []`. Its SDK surface is Read, Glob, and Grep, confined to the worktree by
real-path `canUseTool`, plus the local `pilot-guard` plugin, the Planka HTTP MCP, and the
in-process `sdk-pilot-lifecycle` MCP server. The lifecycle server exposes `transition`,
`write_artifact`, and `run`; it owns phases, artifacts, lanes, gates, and the report-edge commit.
The only admitted Planka tools are `mcp__planka__get_card`, `mcp__planka__get_comments`,
`mcp__planka__add_comment`, `mcp__planka__update_card`, `mcp__planka__move_card`, and
`mcp__planka__add_label_to_card`; every other Planka operation is denied. Owner input arrives only
through the runner mailbox and owner-facing output only through the pilot report.

## Route and phases

The runner derives and freezes the route from the card before `query()`. An exact `Route: LITE` or
`Route: FULL` line wins, including a `- Route:` bullet. Otherwise effort M or greater, type
`feature`, a risk word, more than three named files, or a missing `DoD:` / `Definition of done:`
field selects FULL; all signals clear selects LITE. The reasons are recorded with the route.
`.lane/route.json` is an audit record, not an input to routing.

| Edge | Required evidence |
| --- | --- |
| discovery -> tdd (LITE) or plan (FULL) | Frozen runner route. |
| plan -> critic | `plan.md` has `## ADR` with a decision and rejected alternative, `## Tasks` top-level tasks each with inline or following DoD, and `## Gates`. |
| critic -> tdd or plan | Attested critic lane receipt and report with `VERDICT:` / `FINDINGS:`; an approved report includes the plan SHA-256. At most three changes-requested plan rounds. |
| tdd or harden -> verify | Attested lane receipt and non-empty report. On FULL, `tdd-brief.md` has the plan `## Tasks` block byte-identically. |
| verify -> report (LITE) or review (FULL) | `typecheck`, `lint`, and `test` receipts end `EXIT=0`, are newer than the latest lane receipt, match the current tree signature, and become a digest snapshot. |
| review -> refutation or harden | Attested lane receipt and report verdict. `clear` reaches refutation; `changes-requested` requires findings and reaches harden. |
| refutation -> report or harden | Attested lane receipt and report verdict. `clear` reaches report; `changes-requested` requires findings and reaches harden. No more than three review/refutation changes-requested rounds. |
| report -> awaiting_fidelity | Pilot report, unchanged verify snapshot, runner commit, and archive under `.claude/reports/<card>-<stamp>/` with a manifest. |

Refusals name the edge, missing item, and path. Outcomes are parsed from the lane report, not
declared by the pilot.

## Evidence and identity

A lane launch pre-creates `.lane/<phase>-run.<nonce>.log` with `LANE_NONCE=` and names
`.lane/<phase>-report.<nonce>.md` in the brief. After the nonce log's terminal receipt and nonce
report both exist as regular files, the server exclusively publishes and attests the canonical
`.lane/<phase>-run.log` and `.lane/<phase>-report.md` pair. Stale shared reports are never attested.
Attestations are held in memory and re-hashed at each edge; `evidence.json` is audit-only.
Symlinks are refused and `.lane` ancestors are re-checked before operations. `.lane` is git-ignored
and excluded from the tree signature.

Critic, review, and refutation briefs begin with server-owned independent-review instructions. The
server names the plan/card or the prospective working-tree patch against the construction base plus
gate receipts, writes review/refutation patches to `.lane/<phase>-input.diff`, names that path and base
in the brief, and fences pilot prose afterward as untrusted context. The patch includes staged and
unstaged tracked changes, deletions, modes, symlinks, renames, binary changes, and non-ignored
untracked files without changing the real index. If Git cannot construct that patch, the total patch
output (header, tracked diff, and all untracked-file diffs) exceeds the bounded buffer, or a dirty tree
produces no substantive hunk, the lifecycle refuses the review/refutation brief and cannot launch
that lane. Glob and Grep
patterns with separators are confined by real-path checking their non-glob prefix, including through
relative symlinks. Lifecycle implementation, receipts/launch, and report-edge transaction code live
in separate modules behind the unchanged public server export.

Tree signature v3 is a filesystem signature over names from HEAD, the index, and non-ignored
untracked files. It includes entry type, mode, contents, or symlink target. Staging a deletion or
rename does not change it; recorded v2 signatures do not compare.

TDD and harden lanes use `openai/gpt-5.6-terra`; critic, review, and refutation use
`openai/gpt-5.6-sol`. Lane timeouts are capped at 5400 seconds. `run { kind: 'gate' }` runs the
toolkit's `pnpm typecheck`, `pnpm lint`, or `pnpm test`.

## Completion and CLI

The runner completes only after the trimmed correlated lifecycle result equals
`accepted phase=awaiting_fidelity` and
`.lane/pilot-report.md` both exist. A stream ending first exits 1 and writes
`summary.completed=false`. `.lane/usage.json`, `.lane/summary.json`, and
`.lane/sdk-transcript.json` record the run.

`--card`, `--dir`, and `--card-file` are required. Optional flags are `--profile-env`, `--contract`,
`--hard`, `--mailbox`, and `--timeout`; `--lane-silence` is not accepted. The runner uses Node path semantics on
Linux and macOS, resolves `--dir` to an absolute path, and applies real-path containment before
authorizing reads.

## Fidelity review

Main freezes and verifies evidence with `wt-pilot-fidelity.mjs`. Run `freeze` with the worktree,
bundle directory, card, session, base, head, and lane files; then run `verify --require-same-tree
--require-head`. The v2 manifest has typed entries, a snapshot id, and a length-prefixed signature;
freeze and verify admit only `typecheck`, `lint`, and `test` gate logs, lifecycle-enum lane/report
phases, and integer `EXIT=` values; they also reject unknown kinds, malformed top-level scalars,
extra fields, duplicate names, incoherent commit heads, unsafe containment, and malformed evidence.
Every unmatched file, including another `.lane/*.log`, requires explicit `--other-file` input.
This also applies to symlinks: recognized lifecycle names remain typed symlink entries with their
evidence classification and recorded target, while unmatched names retain their explicit `other`
classification for verification.
`--require-clean-tree` remains a deprecated alias. Verification proves frozen bytes and requested
tree/HEAD identity only, never authorship or prose truth.
