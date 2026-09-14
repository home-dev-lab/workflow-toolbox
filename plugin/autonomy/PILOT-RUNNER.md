# SDK pilot runner

`node plugin/bin/wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <card.md>` runs the pilot with `query()`,
`permissionMode: 'default'`, and `settingSources: []`. The SDK routes every tool request through
`canUseTool`: it allows Read, Glob, and Grep only inside the worktree after real-path confinement,
the three lifecycle tools, and the six Planka tools below, and denies everything else. Supplying the
callback makes the SDK use its stdio permission-prompt transport, so the callback response resolves
requests headlessly rather than opening an interactive prompt. The remaining surface is the local
`pilot-guard` plugin, the Planka HTTP MCP, and the
in-process `sdk-pilot-lifecycle` MCP server. The lifecycle server exposes `transition`,
`write_artifact`, and `run`; it owns phases, artifacts, lanes, gates, and the report-edge commit.
The only admitted Planka tools are `mcp__planka__get_card`, `mcp__planka__get_comments`,
`mcp__planka__add_comment`, `mcp__planka__update_card`, `mcp__planka__move_card`, and
`mcp__planka__add_label_to_card`; every other Planka operation is denied. Owner input arrives only
through the runner mailbox and owner-facing output only through the pilot report.

## Route and phases

The runner resolves `KNOWLEDGE_BASE_INDEX` from `--knowledge-base-index`, then
`WT_KNOWLEDGE_BASE_INDEX`, then `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<slug>/memory/MEMORY.md`,
where the slug replaces every character outside `[A-Za-z0-9-]` in the absolute project root with
`-`. The prompt names the existing index or explicitly says none exists. The pilot and orchestrator
may Read that external index and the Markdown files under its directory (real-path contained) in
addition to their normal confined trees.

The runner derives and freezes the route from the card before `query()`. An exact `Route: LITE` or
`Route: FULL` line wins, including a `- Route:` bullet. Otherwise effort M or greater, type
`feature`, a risk word, more than three named files, or a missing `DoD:` / `Definition of done:`
field selects FULL; all signals clear selects LITE. The reasons are recorded with the route.
`.lane/route.json` is an audit record, not an input to routing.

The installed plugin's version-1 `rules-manifest.json` maps exact sections under `plugin/rules`; an
optional `<project>/.claude/wt-rules-manifest.json` uses the same schema and adds project-root sources.
The runner validates every role, lifecycle trigger, source path, and exact heading before composition.
It appends standing pilot sections to the contract system prompt, returns phase sections in the
transition result for the new phase, and composes role sections into lane briefs before pilot context.
Missing files/headings and malformed manifests fail closed. Manifest paths use `/` as a portable stored
form and Node path APIs for resolution and real-path containment on each host.

| Edge | Required evidence |
| --- | --- |
| discovery -> tdd (LITE) or plan (FULL) | Frozen runner route and the server-written `discovery.md` intake record. |
| plan -> critic | `plan.md` has `## ADR` with a decision and rejected alternative, `## Tasks` top-level tasks each with inline or following DoD, `## Gates`, and `## Acceptance` quoting every card Definition-of-done bullet byte-identically with a following `Proof:` naming a task, test, or e2e. A missing/reworded bullet or a card without that section is refused. |
| critic -> tdd, plan, or report | Attested critic lane receipt and report with `VERDICT:` / `FINDINGS:`; an approved report includes the plan SHA-256. A fourth changes-requested verdict after three plan rounds reaches a partial report. |
| tdd or harden -> verify | Attested lane receipt and non-empty report. On FULL, `tdd-brief.md` has the plan `## Tasks` block byte-identically. |
| verify -> report (LITE) or review (FULL) | `typecheck`, `lint`, and `test` receipts end `EXIT=0`, are newer than the latest lane receipt, match the current tree signature, and become a digest snapshot. |
| review -> refutation, harden, or report | Attested lane receipt and report verdict. `clear` reaches refutation; `changes-requested` requires findings and reaches harden. A fourth changes-requested review/refutation round reaches a partial report. |
| refutation -> report or harden | Attested lane receipt and report verdict. `clear` reaches report; `changes-requested` requires findings and reaches harden. A fourth changes-requested review/refutation round reaches a partial report. |
| report -> awaiting_fidelity | Pilot report with valid `## E2E` and `## Acceptance` quoting every card DoD bullet with `Outcome: proven`, `Outcome: not done: <reason>`, or `Outcome: deferred: <reason>`, plus `## Independent Review` on FULL; unchanged lifecycle snapshot; runner commit; and archive under `.claude/reports/<card>-<stamp>/` with a manifest. A partial report must contain `Partial: <reason>`; a full report must not contain `Partial:`. |

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
server retains each lane phase's pilot context in memory and, immediately before launch, refuses an
unwritten phase or exclusively recreates its brief from that context, re-deriving independent inputs.
The server names the plan/card/discovery record or the prospective working-tree patch against the construction base plus
gate receipts, writes review/refutation patches to `.lane/<phase>-input.diff`, names that path and base
in the brief, and fences pilot prose afterward as untrusted context. The patch includes staged and
unstaged tracked changes, deletions, modes, symlinks, renames, binary changes, and non-ignored
untracked files without changing the real index. Discovery bytes are fenced as untrusted in the critic
brief, just like pilot context. If Git cannot construct that patch, the total patch
output (header, tracked diff, and all untracked-file diffs) exceeds the bounded buffer, or a dirty tree
produces no substantive hunk, the lifecycle refuses the review/refutation brief and cannot launch
that lane. Glob and Grep
patterns with separators are confined by real-path checking their non-glob prefix, including through
relative symlinks. The `measures wildcard-first Glob and Grep matches through an in-worktree symlink with a real SDK query` lock (`WT_REAL_SDK_LOCKS=1`) measured wildcard-first matches not to escape the worktree through an in-worktree symlink. Lifecycle implementation, receipts/launch, and report-edge transaction code live
in separate modules behind the unchanged public server export.

TDD and harden briefs, and independent critic/review/refutation briefs, put mapped exact rule sections
under `## Rules that apply to this role (authoritative)`. Both executor families receive a
runner-owned snapshot brief; its knowledge-base availability line reflects the selected launcher.
The independent brief names the runner's once-resolved knowledge-base index and states that fiches are
claims to verify against current code rather than evidence. For Claude SDK independent roles only, the
lifecycle passes `--knowledge-base-index` to `wt-claude-executor.mjs`; its `canUseTool` permits Read of
the index and real-path-contained regular Markdown fiches while Glob/Grep remain worktree-confined.
OpenCode runs with `--dir` and `cwd` set to the worktree and `--auto` in `wt-lane.mjs`; `--auto` approves an
`external_directory` read the user's OpenCode config leaves on `ask`, so the brief names the index and tells
the lane to report a refused read (a config that denies it wins) rather than rely on the knowledge base.
TDD and harden briefs also carry the frontmatter-stripped body of the shipped changelog skill in a
server-written authoritative section; a missing skill source refuses brief composition.

Tree signature v3 is a filesystem signature over names from HEAD, the index, and non-ignored
untracked files. It includes entry type, mode, contents, or symlink target. Staging a deletion or
rename does not change it; recorded v2 signatures do not compare.

TDD and harden lanes use `openai/gpt-5.6-terra`; critic, review, and refutation use
`openai/gpt-5.6-sol`. Lane timeouts are capped at 5400 seconds. `run { kind: 'gate' }` runs the
toolkit's `pnpm typecheck`, `pnpm lint`, or `pnpm test`.
A lane must not rely on background processes surviving its receipt: the reported process group contains
the launcher worker, `opencode`, and its ordinary descendants, and the server terminates that group. A
process that creates its own session escapes the lane process group and remains outside this contract.

## Completion and CLI

### SDK installation

The runner and orchestrator resolve `@anthropic-ai/claude-agent-sdk` in this order: the plugin's
sibling `toolkit/` install when running from a development checkout; the runner's `--dir` project or
the orchestrator's process cwd; `CLAUDE_PLUGIN_DATA`; then the global npm root reported by one
`npm root -g` call. A failed global-root probe is ignored. An installed plugin does not contain the
development `toolkit/` tree, so install the SDK in the target project, globally with
`npm install -g @anthropic-ai/claude-agent-sdk`, or in plugin data with
`npm install --prefix "<plugin data dir>" @anthropic-ai/claude-agent-sdk`. The refusal prints the
resolved plugin-data path in quotes on every platform, because `CLAUDE_PLUGIN_DATA` is set for the
plugin's own processes and not in the terminal where the command is pasted. A `CLAUDE_PLUGIN_DATA` whose directory is not named `workflow-toolbox-<marketplace>` belongs to another plugin and is ignored. All
candidate paths and separators use Node's platform-native path APIs.

The runner completes only after the trimmed correlated lifecycle result equals
`accepted phase=awaiting_fidelity` and
`.lane/pilot-report.md` both exist; the report edge accepts only the pilot report registered by
`write_artifact` in this run, re-hashed on the bytes committed, with the `Partial:` contract re-checked
there. When a pilot turn ends first, the runner reads the current phase
from the in-process lifecycle server and injects a continuation prompt naming that phase and its next
required work. A new successful lifecycle result resets the budget; after three consecutive
unproductive end turns the prompt stream closes, the runner exits 1, and `summary.json` records
`completed:false`, `injected_turns` counting every injection (the three continuations plus any owner
message or earlier continuation that was followed by progress), and reason
`pilot ended its turn 3 times without progress`. Any other stream ending first exits 1 and writes
`summary.completed=false`. A completed full run exits 0. A completed partial run exits 2 with
`summary.completed=true` and the lifecycle's non-null `partial` object; full-run summaries carry
`partial:null`. `.lane/usage.json`, `.lane/summary.json`, and
`.lane/sdk-transcript.json` record the run. The summary records `requested_model` with its resolver
source/effective model, plus `served_model` from the SDK `system:init` receipt and
`served_model_first_turn` from the first assistant message. `served_model_agreement` is `true` when the
two SDK readings agree with each other (a remapped profile serves a different id than the requested
alias on purpose, so the request is recorded beside them, never compared); it otherwise lists the
differing values, or reports why the SDK evidence is absent. This is SDK-reported evidence, not a proxy-trace attestation.

`--card`, `--dir`, and `--card-file` are required. Optional flags are `--knowledge-base-index`, repeatable
`--plugin-dir <absolute-path>`, `--profile-env`, `--contract`,
`--hard`, `--mailbox`, and `--timeout`; `--lane-silence` is not accepted. The runner uses Node path semantics on
Linux, macOS, and Windows, resolves `--dir` to an absolute path, and applies real-path containment before
authorizing reads. It never enables `allowDangerouslySkipPermissions`.
Configured plugin directories are passed as local SDK plugins beside `pilot-guard`; the initialization
receipt must name every one or the pilot run is refused. No plugin name or host path is built in.

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

## Orchestrator

Launch a wave with `setsid nohup bash -c 'node plugin/bin/wt-run-orchestrator.mjs --cards
<id,id> --base develop --worktrees-dir <repo-dir> --report <report.md> > <wave.log> 2>&1; echo
EXIT=$? >> <wave.log>' > /dev/null 2>&1 < /dev/null &`, or replace `--cards` with
`--mission-list <list>` plus repeatable `--mission-label`, `--max-cards`, and
optional `--max-minutes`. `--hard <id,id>` selects the hard pilot model per card;
`--profile-env <settings.json>` supplies model remaps to pilots and the orchestrator session. Repeatable
`--plugin-dir <absolute-path>` loads the named local plugins in both card pilots and the SDK judge.

An explicit card is eligible only in Backlog, Next, or In Progress. A mission card must also carry
one priority label (`P0|P1|P2`), one type label (`feature|chore|bug|research`), one effort label
(`effort:S|effort:M|effort:L`), every requested mission label, and only parseable `Depends-on:`
entries whose referenced cards are Done. The driver snapshots each eligible card, creates its
wave-qualified worktree and push/merge fence, runs its pilot, reruns typecheck/lint/test, checks the
clean tree and pilot report, freezes and verifies fidelity, and archives the diff and receipts.
Each worktree redirects every configured remote's push URL to a non-repository file, so ordinary
pushes, including `--no-verify`, fail at transport. A push that supplies an explicit URL bypasses
configured remotes and remains outside ordinary lane behavior. `merge.ff=false` makes ordinary
fast-forwardable merges create a merge commit so the merge hook can refuse them; a merge commit
explicitly requested with `--no-verify` remains a residual. An additional ref-transaction fence
refuses explicit `--ff-only` merges. The driver refuses to launch the judge if any symlink exists
under the wave directory.

One SDK orchestrator session reads each snapshot, pilot report, and diff through the wave lifecycle
server. It records `accept`, `escalate`, or `reject` against the card's definition of done; it cannot
merge, push, edit files, or move cards. The driver renders `Implemented`, `Verification`, the
session's verbatim `Independent Review` and `Decisions`, `Remaining Risks`, `Escalations for main`,
and `Findings`. Exit 0 means every card was accepted, exit 2 means every card was decided but at
least one was escalated or rejected, and exit 1 means the wave did not complete.
The judge reads the evidence copy retained under the real-path-confined wave directory. On every
report emit, the driver also copies available receipts to `<report-dir>/cards/<id>/` and prints that
path in the per-card table.

Main reads the seam warnings and evidence, reviews each accepted branch, performs the merges,
reruns gates on the merged tree, and only then moves delivered cards to Done. The runner leaves all
merge, push, publish, and final board transitions as explicit escalations for main.
