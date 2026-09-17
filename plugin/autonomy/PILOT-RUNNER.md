# SDK pilot runner

> **Status: EXPERIMENTAL.** The runner's phases and exit codes are locked by unit and real-runner tests, but as of 2026-09-16 no FULL run has completed a whole cycle on a real card (the three observed runs ended at the plan gate), the no-GPT profile has no real end-to-end run, and the cross-OS CI matrix is not green. Treat a green exit as evidence about the run it reports, not as approval of the runner.

`node plugin/bin/wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <card.md>` runs the pilot with `query()`,
`permissionMode: 'default'`, and `settingSources: []`. The SDK routes every tool request through
`canUseTool`, which applies real-path confinement to filesystem tools and denies tools outside the
pilot role profile. Supplying the callback makes the SDK use its stdio permission-prompt transport,
so the callback response resolves requests headlessly rather than opening an interactive prompt.
The lifecycle surface is the Planka HTTP MCP and the in-process `sdk-pilot-lifecycle` MCP server. The lifecycle server exposes `transition`,
`write_artifact`, `route_finding`, and `run`; it owns phases, artifacts, lanes, gates, and the report-edge commit.
The only admitted Planka tools are `mcp__planka__get_card`, `mcp__planka__get_comments`,
`mcp__planka__add_comment`, `mcp__planka__update_card`, `mcp__planka__move_card`, and
`mcp__planka__add_label_to_card`; every other Planka operation is denied. Owner input arrives only
through the runner mailbox and owner-facing output only through the pilot report.

## What an SDK session receives

Every Claude SDK query uses the table in `plugin/bin/lib/sdk-role-profile.mjs`; GPT lanes and
`lane_skills` are unchanged. `LSP` is listed for every role and becomes available only when the
generated role plugin has a resolved language server. Context-mode 1.0.177 is loaded from the active
profile's `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` cache. Readers use `disallowedTools` so the plugin's
other nine MCP tools do not enter their receipt.

| Role | Tools | LSP | Selected workflow-toolbox skills | Shipped command guards |
| --- | --- | --- | --- | --- |
| pilot | Read, Glob, Grep, LSP, all ten context-mode MCP tools — no Edit, Write or Bash: every increment goes through the lifecycle `run` tool | optional, visible | stale-card-sweep, lesson-harvest, deep-grounding | none beyond the confinement; nothing to guard without a shell |
| tdd, harden | Read, Glob, Grep, LSP, Edit, Write, Bash, all ten context-mode MCP tools | optional, visible | changelog | writer set |
| judge, critic, review, refutation | Read, Glob, Grep, LSP, `ctx_search` only | optional, visible | none | none; no Bash |

The initial implementation detects TypeScript and JavaScript from a root `tsconfig.json` or
`package.json`, or a `.ts`, `.js`, `.mjs`, or `.cjs` file in the worktree. It resolves
`typescript-language-server` on `PATH`; an absolute `WT_LSP_TYPESCRIPT_SERVER` overrides PATH only
when set. The generated `.lsp.json` carries the resolved absolute command and only the detected
language mappings. Missing binaries never refuse a session: the init log and `lifecycle.json` state
`LSP absent: typescript-language-server not found on PATH`, and the closing report states
`LSP navigation: absent (...)`; availability is stated with the command and the report says
`LSP navigation: available`. When available, omission of `LSP` from the SDK init receipt refuses the
incomplete receipt; when absent, the SDK is expected to omit it.

The writer set is the fifteen guards named in `sdk-role-profile.mjs`: shell correctness guards for
unquoted globs, merge chains, concurrent tests, piped gate status, process-environment dumps,
commit backticks, zsh colon modifiers, `find -newermt`, `PIPESTATUS`, and absent package scripts;
plus main, gate-evidence, stale-date, rule-convention, and shipped-twin checks. Each SDK callback
spawns the original shipped script with the native hook payload unchanged and returns its JSON
decision unchanged. A non-zero exit or invalid JSON is logged and produces no decision, never an
unreported allow. The `pilot-guard` function plugin remains loaded for confinement, and
context-mode supplies the read bound. Spawn guards are excluded because these sessions have no
Agent tool; Stop and SessionStart workflow-toolbox hooks are excluded because lifecycle servers own
transitions; Planka producers are excluded because executors do not write the board.

Only selected skills are copied into generated `.lane/sdk-plugins/<role>/` directories; the full
workflow-toolbox plugin, its workflows, monitors, statusline, and unrelated skills are never loaded.
The initialization receipt must contain the confinement plugin, context-mode plugin, generated skill
plugin where applicable, every role tool, and every selected skill. Callback registration is not a
receipt field, so startup proves every script exists and registers one callback per selected table
entry; the refusal probe proves that callback execution works. A missing guard, skill, confinement
plugin, or context-mode 1.0.177 path refuses startup and names the path.

Resolution uses Node's native path APIs and the active `CLAUDE_CONFIG_DIR`, including Windows paths
such as a profile beneath `%APPDATA%`; generated files are copies, not symlinks. If that profile does
not have context-mode 1.0.177, the session refuses to start rather than degrading to an unguarded run.
LSP PATH lookup uses `.cmd` and `.exe` shims on Windows. On macOS it searches the PATH actually
provided to the runner, so `/usr/local/bin` and Homebrew locations are considered only when present
there; no install prefix is guessed. Linux likewise uses the supplied PATH. On every platform an
absent binary produces the same visible absent receipt and never a startup refusal.

## Route and phases

The runner resolves `KNOWLEDGE_BASE_INDEX` from `--knowledge-base-index`, then
`WT_KNOWLEDGE_BASE_INDEX`, then `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<slug>/memory/MEMORY.md`,
where the slug replaces every character outside `[A-Za-z0-9-]` in the absolute project root with
`-`. The prompt names the existing index or explicitly says none exists. The pilot and orchestrator
may Read that external index and the Markdown files under its directory (real-path contained) in
addition to their normal confined trees.

The runner derives and freezes the route from the card before `query()`. An exact `Route: LITE` or
`Route: FULL` line wins, including a `- Route:` bullet. Otherwise effort M or greater, type
`feature`, a risk word, more than three named files, or no Definition-of-done criterion selects FULL;
all signals clear selects LITE. A criterion is an item under `## DoD` / `## Definition of done` or the
value of an inline `DoD:` / `Definition of done:` field. No criterion makes both runners refuse before
starting the SDK query. The reasons are recorded with the route.
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
| plan -> critic | `plan.md` has `## ADR` with a decision and rejected alternative, `## Tasks` top-level tasks each with inline or following DoD, `## Gates`, and `## Acceptance` quoting every folded card Definition-of-done criterion exactly with a following `Proof:` naming a task, test, e2e, test file, or gate. A missing/reworded criterion is refused with an example. |
| critic -> tdd, plan, or report | Attested critic lane receipt and report with `VERDICT:` / `FINDINGS:`; an approved report includes the plan SHA-256. `CONTEST routed card <id>:` gets exactly one plan round; a repeated maintained scope disagreement proceeds and is reported. A fourth other changes-requested verdict after three plan rounds reaches a partial report. |
| tdd or harden -> verify | Attested lane receipt and non-empty report. On FULL, `tdd-brief.md` has the plan `## Tasks` block byte-identically. |
| verify -> report (LITE) or review (FULL) | `typecheck`, `lint`, and `test` receipts end `EXIT=0`, are newer than the latest lane receipt, match the current tree signature, and become a digest snapshot. |
| review -> refutation, harden, or report | Attested lane receipt and report verdict. `clear` reaches refutation; `changes-requested` requires findings and reaches harden. A fourth changes-requested review/refutation round reaches a partial report. |
| refutation -> report or harden | Attested lane receipt and report verdict. `clear` reaches report; `changes-requested` requires findings and reaches harden. A fourth changes-requested review/refutation round reaches a partial report. |
| report -> awaiting_fidelity | Pilot report with valid `## E2E` and `## Acceptance` quoting every folded card DoD criterion with `Outcome: proven`, `Outcome: not done: <reason>`, or `Outcome: deferred: card <id> — <L4 reason>` naming an id in `routed_cards`, plus mechanically appended `## Routed cards` and `## Independent Review` on FULL; unchanged lifecycle snapshot; runner commit; and external archive manifest. Any non-proven outcome or `e2e not run` classifies the delivery as partial before archive. A partial report must contain `Partial: <reason>`; a full report must not contain `Partial:`. |

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
`summary.completed=false`. Runner timeout, repeated no-progress turns, and initialized SDK stream errors
also record a lifecycle partial with the specific reason and publish the standard external archive; final
summary, usage, transcript, and cost receipts are refreshed there. A completed run exits 0 only when every DoD outcome is proven and E2E has a real procedure and output. A completed partial run exits 2 with
`summary.completed=true` and the lifecycle's non-null `partial` object; full-run summaries carry
`partial:null`. `.lane/usage.json`, `.lane/summary.json`, `.lane/cost.json`, and
`.lane/sdk-transcript.json` record the run. The summary records `requested_model` with its resolver
source/effective model, plus `served_model` from the SDK `system:init` receipt and
`served_model_first_turn` from the first assistant message. `served_model_agreement` is `true` when the
two SDK readings agree with each other (a remapped profile serves a different id than the requested
alias on purpose, so the request is recorded beside them, never compared); it otherwise lists the
differing values, or reports why the SDK evidence is absent. This is SDK-reported evidence, not a proxy-trace attestation.

When critic, review, or refutation exhausts its round bound, the runner also writes the ignored
`.lane/worktree-retention.json` file. Version 1 records `cardId`, the canonical absolute `worktree`,
`retainedAt`, the bounded-run `reason`, the stopping `phase`, and `expiry` with the board id and the
condition `card is absent or in Done or NotDoing`. Readers of v1 tolerate additional fields.
`node "$CLAUDE_PLUGIN_ROOT/bin/wt-worktree-remove.mjs" --dir <worktree>` reads that
marker before every removal, resolves the card's current list, and refuses while the card is open or
the board cannot be reached. It also refuses a marker copied from a different worktree; `--force`
changes Git's removal mode only and never bypasses these checks.
An absent marker preserves ordinary removal behavior. A direct `git worktree remove`, manual recursive
deletion, or other tooling that does not call this remover remains outside this guard.

`lifecycle.json` timestamps the runner start/end, each accepted phase interval, and each lane launch.
Each streamed pilot assistant message records its arrival time and SDK usage and is attributed to the
containing interval; repeated critics retain their round number. The final SDK result total is retained
only as a cross-check, with every per-column difference reported. Claude executor lanes write SDK usage
beside the nonce log. GPT lane cost is read-only
from OpenCode `session` rows whose `directory` exactly matches the worktree and whose timestamps
overlap that lane's launch window. The reader invokes the external `sqlite3` CLI because the plugin's
Node floor is 20; `WT_OPENCODE_DB` overrides the default
`~/.local/share/opencode/opencode.db`. An absent CLI, unreadable database, or unmatched lane is
`unknown` with its reason, never zero, and cost failure never changes the runner exit.

For a legacy archive without `lifecycle.json`, each nonce log gets its own window from its first and
last embedded ISO timestamp, or its mtime when the log has no timestamps. Sessions outside every lane
are retained under `unmatched`; lanes with no session remain `unknown`. Run wall time comes from runner
lifecycle records, then archived SDK transcript timestamps, then archive record mtimes (using recorded
summary minutes only when those mtimes collapse to one copied instant). Every fallback is marked
`inferred` with its basis. `--started-at` and `--ended-at` are paired forensic overrides, not defaults.

`cost.json` records card/run identity, route (`HARD` when `--hard` selected it),
complete/partial/unknown outcome, wall time,
and per phase/model raw `input`, `cache_write`, `cache_read`, `output`, and `reasoning` columns.
Unsupported provider fields say `not measured`; `first_pass_input` is input plus measured cache write.
Anthropic `fresh_tokens` adds output, while OpenAI `fresh_tokens` adds output and reasoning because
OpenCode records reasoning separately from output. At run end the runner replaces only its delimited
`<!-- run-cost -->` report block and refreshes both files in the lifecycle archive. The pilot's own
headings and trailing text are preserved. The orchestrator evidence copy also retains `cost.json`.

`node plugin/bin/wt-run-cost.mjs <reports-directory>` recursively reads archived `cost.json` files
and prints LITE/FULL/HARD totals split into Anthropic and OpenAI rows, preserving family-specific raw
columns. Every run lists its unknown count; a route containing any unknown is marked incomplete. Only
complete runs enter totals by default; partial and unknown-outcome runs are always listed separately
and enter totals only with `--include-partial`. Mirrored receipts deduplicate by card id plus runner
start, never by archive path. Malformed usage exits 2.

`--card`, `--dir`, and `--card-file` are required. Optional flags are `--board-contract <json file>`, `--knowledge-base-index`, repeatable
`--plugin-dir <absolute-path>`, `--profile-env`, `--contract`,
`--hard`, `--mailbox`, and `--timeout`; `--lane-silence` is not accepted. The runner uses Node path semantics on
Linux, macOS, and Windows, resolves `--dir` to an absolute path, and applies real-path containment before
authorizing reads. It never enables `allowDangerouslySkipPermissions`.
The board contract is `{ boardId, listId, labels: { priority: {P0,P1,P2}, type:
{bug,chore,feature,research}, effort: {S,M,L}, category } }`. `route_finding` is the only card-creation
surface: the runner makes one `create_card` MCP call with the three selected label ids, category,
`dependsOn: {cardId: <origin>}`, and a `## Provenance` line containing origin, session, L4 reason, and
timestamp. It records `routed_cards` in `lifecycle.json` and the archive manifest. A contested item
completed in-run gets a runner comment and move to `NotDoing`; maintained disagreement stays named.
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
session's verbatim `Independent Review` and `Decisions`, `Routed cards`, `Remaining Risks`,
`Escalations for main`, and `Findings`. Static waves list each lifecycle record; mission waves re-read
each routed card against mission eligibility. Exit 0 means every card was accepted, exit 2 means every card was decided but at
least one was partial, escalated, or rejected, and exit 1 means the wave did not complete. Pilot exit 2 is always rendered as partial and cannot be accepted.
The judge reads the evidence copy retained under the real-path-confined wave directory. On every
report emit, the driver also copies available receipts to `<report-dir>/cards/<id>/` and prints that
path in the per-card table.

Main reads the seam warnings and evidence, reviews each accepted branch, performs the merges,
reruns gates on the merged tree, and only then moves delivered cards to Done. The runner leaves all
merge, push, publish, and final board transitions as explicit escalations for main.
