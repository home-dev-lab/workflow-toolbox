# SDK pilot runner

> **Status: EXPERIMENTAL.** The runner's phases and exit codes are locked by unit and real-runner tests, but as of 2026-09-16 no FULL run has completed a whole cycle on a real card (the three observed runs ended at the plan gate), the no-GPT profile has no real end-to-end run, and the cross-OS CI matrix is not green. Treat a green exit as evidence about the run it reports, not as approval of the runner.

`node plugin/bin/wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <card.md>` runs the pilot with `query()`,
`permissionMode: 'default'`, and `settingSources: []`. The SDK routes every tool request through
`canUseTool`, which applies real-path confinement to filesystem tools and denies tools outside the
pilot role profile. Every role excludes and explicitly disallows context-mode tools outside its
declared subset, including `ctx_doctor`, `ctx_purge`, and the `ctx_execute` family. The invariant is:
no role runs model-authored code or commands outside its declared, guarded path. Supplying the callback makes the SDK use its stdio permission-prompt transport,
so the callback response resolves requests headlessly rather than opening an interactive prompt.
The lifecycle surface is the Planka HTTP MCP and the in-process `sdk-pilot-lifecycle` MCP server. The lifecycle server exposes `transition`,
`write_artifact`, `route_finding`, and `run`; it owns phases, artifacts, lanes, gates, and the report-edge commit.
The only admitted Planka tools are `mcp__planka__get_card`, `mcp__planka__get_comments`,
`mcp__planka__add_comment`, `mcp__planka__update_card`, `mcp__planka__move_card`, and
`mcp__planka__add_label_to_card`; every other Planka operation is denied. Owner input arrives only
through the runner mailbox and owner-facing output only through the pilot report.

## What an SDK session receives

Every Claude SDK query uses the table in `plugin/bin/lib/sdk-role-profile.mjs`; GPT lanes and
`lane_skills` are unchanged. `LSP` is absent from every SDK role. Context-mode is loaded from the active
profile's `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` cache. Readers use `disallowedTools` so the plugin's
other nine MCP tools do not enter their receipt.

With `settingSources: []` still in force, the pilot's first prompt and each Claude executor lane prompt carry a "Repository
contributor instructions" section built only from the repository's own committed files. It never reads
the user's `~/.claude` rules nor the session's project rules (`.claude/rules`); the runner as a whole is
not machine-independent, because it still reads the knowledge-base index and the optional project rules
manifest.

- **Source.** A pinned commit, read through `git ls-tree` and `git cat-file` with the hardened git flags,
  never the working tree. The pilot's first prompt reads `HEAD` before any lane runs. Each Claude executor
  lane is launched with `--repo-commit <sha>` (7 to 64 hex characters, anything else is refused), the
  commit the run was constructed from, so a lane that rewrites its worktree's `.git` or `CLAUDE.md`
  cannot change what the next lane receives; the plan-phase checks use the same commit. No symlink,
  FIFO or device on disk can be followed.
- **Root guides.** `CLAUDE.md`, then `AGENTS.md`, injected as content between `BEGIN`/`END repository
  guide <nonce>` markers under their absolute paths. The nonce is the first 12 hex characters of the
  SHA-256 of the guide's content, so guide text cannot forge its own closing marker. A symlink guide is resolved once, only when it is a relative
  path that stays inside the tree and names a regular file; its target is injected once under the
  target's path. Any other symlink is reported as not followed, and its target is never read.
- **Folder guides.** Nested `CLAUDE.md` and `AGENTS.md` regular files (symlinks and submodule entries are
  skipped) are listed as paths only (at most 20, then
  a remainder count) with the instruction to read the one for a folder before changing files there.
- **Declared gates.** The `test`, `typecheck`, `lint`, `quality`, `check`, `validate`, `verify` and
  `build` scripts of the root `package.json` and of each depth-1 `<dir>/package.json`, with the package
  manager (the `packageManager` field, else the lockfile, else npm) and the source file. Capped at 40
  lines; an unparseable `package.json` is named. The runner lists these commands; it does not run them.
- **Plugin validation.** One `claude plugin validate <dir> --strict` line per directory (at most 20)
  holding a `.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json`, at any depth.
- **Budget.** The whole section, markers and notices included, is capped at 40,000 characters. The lists
  are reserved first (notes at most 20 lines, then a remainder count); the guides share the rest in order,
  and a guide over its share is cut at a line boundary and ends with a
  `[truncated at N of M characters; read the rest with `git show <sha>:<path>`]` marker.
- **Repository text is data.** Every repository value placed in the section (gate name, working
  directory, command, folder and script names, paths, symlink targets) is cut at 200 characters, and CR,
  LF, NUL and other control characters in it become spaces, so repository text cannot start a line or a
  heading of its own. A `package.json` whose JSON is not an object is reported like invalid JSON.
- **Declared gate file.** The gates of a root `.wt-gates.json` are listed first, with their working
  directory and the file as source.
- **At the plan phase.** Entering `plan` (first round and every revision), the transition result also
  carries "Repository-declared checks for your plan (authoritative)": the gate and plugin-validation
  lines above, and the instruction to assign every check outside the repository's lifecycle gate set to
  the tdd lane in the plan's Gates. A check the guide makes mandatory for the kind of change is never marked
  not applicable, and when the guide and the declared gate file name different commands for one gate, the
  plan runs both; only a check the guide does not mandate may be left out, with a one-line reason.
  Lifecycle gates are typecheck, lint and test, plus quality when the current `toolkit/package.json`
  declares a non-empty `scripts.quality`.
- **Failure.** When git cannot answer (not a repository, no commit, unknown pinned commit) or anything
  unexpected is thrown while collecting or formatting, the prompt says `Repository instructions
  unavailable: <reason>.` and falls back to the earlier pointer lines to the root guides; the plan-phase
  checks are then empty. The runner never fails because of this section.
- **`--stop-after`.** The LITE route leaves only `discovery`, `tdd` and `verify`; a stop-after phase the
  card's route never leaves is refused at the start of the run, before any query, naming the route and the
  phases it does leave.

The orchestrator judge and the second-opinion lane keep the pointer-only form.

### One query per lifecycle phase

The pilot no longer carries the whole run in one conversation. Its first query covers discovery. When a
lifecycle transition moves the run to another phase, that query stops receiving input: the runner sends
it no continuation, mailbox note or decision, and answers every further tool call it makes with a
denial that interrupts the turn. At that turn end the runner opens the live phase in a new query with
the same model, effort, system prompt, plugins and tools, plus a fresh lifecycle MCP server instance
over the same lifecycle state. Transition ids are namespaced per session, so a later session that
numbers its calls from one again is not mistaken for a replay of an earlier session's call.

A later session starts from a runner-built opener instead of the earlier conversation:

- the card, verbatim, and a note not to re-read it from the board;
- a phase manifest: the route and phases so far, lane runs with their exit codes, routed cards, every
  critic and review finding with its blocking flag (fenced as lane output in its own section, since the
  finding text comes from lane reports), the raw artifacts that phase needs (for example
  `discovery.md` for a plan, `plan.md` plus the critic report for a revision, the review findings for
  a TDD fix round, `discovery.md` for TDD on the LITE route) and every other lifecycle artifact as a
  path with its size. Inputs over 32,000 characters are listed as paths to read. Critic and review
  reports are fenced as lane output, data and not instructions;
- a line naming a lane already run in that phase, so a lane started past the boundary is not run twice;
- the stored transition result that opened the phase, rules included (a plan revision also gets the
  first plan entry, whose rules it relies on);
- the partial-run instruction when the run is partial, every bound DoD decision, and every mailbox
  note delivered so far with its untrusted prefix;
- the repository contributor instructions and the LSP navigation state, as in the first prompt.

A plan session opens only after any open DoD dispute is bound. Each session checks the account again;
in a later session a check that failed to run (it threw or timed out) is retried once, a mismatch never
is. A session that produces no result within 120 seconds of its first boundary denial is aborted on
its own and the next phase still opens.

On Agent SDK 0.3.280 the interrupted turn ends with an error result (`error_during_execution`,
terminal reason `aborted_tools`), and the SDK then raises "Claude Code returned an error result". When
the session delivered that interrupted-turn result after a boundary denial, the runner records the
error as the session's `closing_error` and hands off. Any other error still ends the run, including one
raised after a denial with no such result. A stream that ends by itself after a result past the
boundary is a handoff as well. The 120-second bound is a timer armed at the first denial, so it holds
even when the CLI stops reading its input; usage from a session it aborts is reported as a lower bound
(`fresh_tokens: unavailable`), because no result covers it.

`summary.json` records `phase_sessions` (per session: phase, round, start and end, how it ended
(`turn-end`, `boundary-deny`, `no_result`), call count, first and last call usage, tool calls seen and
denied after the boundary, permission denials and terminal reason), `handoffs` and `account_sessions`.
Each `usage.json` message carries its `session` and `session_phase`. `model_usage` sums the latest
cumulative figure of each session, since the SDK reports it as a running total per query.

| Role | Tools | LSP | Selected workflow-toolbox skills | Shipped command guards |
| --- | --- | --- | --- | --- |
| pilot | Read, Glob, Grep, `ctx_fetch_and_index`, `ctx_index`, and `ctx_search` — no Edit, Write, Bash, diagnostics, deletion, LSP, or `ctx_execute` family: every increment goes through the lifecycle `run` tool | disabled | stale-card-sweep, lesson-harvest, deep-grounding | none; this role has no model-authored command path |
| tdd | Read, Glob, Grep, Edit, Write, guarded Bash, `ctx_fetch_and_index`, `ctx_index`, and `ctx_search` | disabled | changelog | writer set; model-authored commands run only through guarded, mandatory-sandbox Bash |
| judge, critic, review, refutation | Read, Glob, Grep, `ctx_search` only | disabled | none | none; no Bash |

SDK roles do not receive LSP. Pinning the `typescript-language-server` launcher is insufficient:
that server can select and fork a workspace `node_modules/typescript/lib/tsserver.js`, turning
workspace content into host-executed code. The init log and `lifecycle.json` record this explicit
disabled state, and an initialization receipt that exposes `LSP` is refused.

Context-mode's fetch/index/search service processes are run by the plugin, not from model-authored
source. Their library-controlled persistent context storage outside the worktree is a known exception
to worktree confinement.
The writer's model-authored shell work gets done through `Bash`, where sandbox availability is
mandatory, per-command sandbox escape is disabled and denied by authorization, and the writer guards
apply. The writer set is the fifteen guards named in `sdk-role-profile.mjs`: shell correctness guards for
unquoted globs, merge chains, concurrent tests, piped gate status, process-environment dumps,
commit backticks, zsh colon modifiers, `find -newermt`, `PIPESTATUS`, and absent package scripts;
plus main, gate-evidence, stale-date, rule-convention, and shipped-twin checks. Each SDK callback
spawns the original shipped script with the native hook payload unchanged and returns its JSON
decision unchanged. A role-launched guard forces its otherwise fail-open wrapper to exit non-zero on
an internal crash; a launch failure, non-zero exit, or invalid JSON is logged and returns an explicit
denial. Ordinary host hook callers retain the documented fail-open default. The active plugin roots,
generated role plugin, and selected guard scripts are derived from the prepared role and supplied to
both the authorization callback and sandbox `denyWrite`, so Write, Edit, and Bash cannot replace code
the host will execute. The `pilot-guard` function plugin matches `Bash` only, so it never protects the
pilot role, which has no Bash tool; process execution is instead absent from that role. Context-mode
supplies the read bound. Spawn guards are excluded because these sessions have no
Agent tool; Stop and SessionStart workflow-toolbox hooks are excluded because lifecycle servers own
transitions; Planka producers are excluded because executors do not write the board.

Only selected skills are copied into generated `.lane/sdk-plugins/<role>/` directories; the full
workflow-toolbox plugin, its workflows, monitors, statusline, and unrelated skills are never loaded.
The initialization receipt must contain the confinement plugin, context-mode plugin, generated skill
plugin where applicable, every role tool, and every selected skill. Any receipt tool outside the role
profile and the role's exact lifecycle tools refuses startup. Callback registration is not a
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

The route also selects the runner timeout when `--timeout` is omitted: LITE keeps 5,400 seconds
(90 minutes), while FULL uses 21,600 seconds (6 hours). The FULL default deliberately sits well
above the longest measured FULL run, 3 hours 11 minutes, which ended on the lifecycle's own review
bound. An explicit `--timeout` always wins. When it is shorter than the route reference (90 minutes
for LITE, or the measured 3 hours 11 minutes for FULL), the runner prints one warning naming the
route, supplied seconds, and reference, then proceeds.

The installed plugin's version-1 `rules-manifest.json` maps exact sections under `plugin/rules`; an
optional `<project>/.claude/wt-rules-manifest.json` uses the same schema and adds project-root sources.
The runner validates every role, lifecycle trigger, source path, and exact heading before composition.
It appends standing pilot sections to the contract system prompt, returns phase sections in the
transition result for the new phase, and composes role sections into lane briefs before pilot context.
On a critic-to-plan revision round, only `critic->plan` sections fire: `phase:plan` sections were
already delivered at the first plan entry.
Missing files/headings and malformed manifests fail closed. Manifest paths use `/` as a portable stored
form and Node path APIs for resolution and real-path containment on each host.

| Edge | Required evidence |
| --- | --- |
| discovery -> tdd (LITE) or plan (FULL) | Frozen runner route and the server-written `discovery.md` intake record. |
| plan -> critic | `plan.md` has `## ADR` with a decision and rejected alternative, `## Tasks` top-level tasks each with inline or following DoD, non-empty `## Gates`, `## Quality coverage` with non-empty `Changed artefacts:` and `Seams:` lines (`Seams: none: <reason>` is allowed), and `## State and recovery` with non-empty `Ownership:`, `Writers:`, `Terminal paths:` and `Published data:` lines (`Published data: N/A: <reason>` is allowed), or only `N/A: <reason>` when no state or data boundary is touched. When card Definition-of-done criteria are present, it also requires `## Card terms: reading chosen` (one `- <term>: <reading>` line per ambiguous card term, or the documented `none` line) and `## Acceptance` quoting every folded criterion exactly with a following `Proof:` naming a task, test, e2e, test file, or gate. Checked headings are exact, case-insensitive, with optional trailing colon/spaces; labels may be bulleted or bold. Missing or empty sections/labels, bare `N/A`, and missing/reworded criteria are refused with a named diagnostic and example. The critic checks the truth of each answer, including reasoned exemptions. |
| critic -> tdd, plan, or report | Attested critic lane receipt and report with `VERDICT:` / `FINDINGS:`; an approved report includes the plan SHA-256. `CONTEST routed card <id>:` gets exactly one plan round; a repeated maintained scope disagreement proceeds and is reported. A fourth other changes-requested verdict after three plan rounds reaches a partial report. |
| tdd -> verify | Attested lane receipt and non-empty report. The initial FULL `tdd-brief.md` has the plan `## Tasks` block byte-identically; later TDD fix briefs carry runner-owned review findings and focused-gate instructions. |
| verify -> report (LITE) or review (FULL) | `typecheck`, `lint`, and `test`, plus `quality` when the current `toolkit/package.json` declares a non-empty string `scripts.quality`, have receipts ending `EXIT=0`, newer than the latest lane receipt, matching the current tree signature, and become a digest snapshot. |
| verify -> tdd (or partial report on recurrence) | Run **all** currently required gates. Every receipt must be present, parseable, attested, digest-verified, current-tree-bound and newer than the latest lane, with at least one nonzero exit. Findings are canonical `gate <name> EXIT=<actual exit>` markers for required red gates or exact extracted failed-test names. Passing/undeclared gates, mismatched exits and invented names are refused. Every red gate and available extracted name is carried into `.lane/review-findings.md` with actual gate identity and log path. Absent/ambiguous adapters or empty extraction permit attested `gate test EXIT=<actual exit>` recovery; they never permit invented names. Existing non-convergence accounting applies. |

When exact failed-test names are available, the test gate marker remains receipt context in the
snapshot and TDD findings, while convergence counts the exact names. This avoids treating a common
`gate test EXIT=1` summary as a recurring defect when distinct failed names shrink across fixes.
Without extracted names the attested test marker is itself the blocking finding; non-test gate
markers remain blocking. The pilot submits plain canonical markers, and the runner records those
same markers without diagnostic fingerprints. Runner-derived blocking markers carry an explicit
recurrence exemption: they count toward blocking-count convergence but do not trigger the "same
finding returned" identity check. Two consecutive failed rounds can return to TDD; a third round
with blocking count 1 stops for failing to set a new minimum. Extracted test names and critic,
review, and refutation findings retain identity recurrence safeguards. A marker-shaped finding
that does not identify an actual red gate is accepted only if it is an exact extracted name from
the red test receipt; otherwise it is refused.
| review -> refutation, tdd, or report | Attested lane receipt and report verdict. `clear` reaches refutation; blocking `changes-requested` writes `review-findings.md` and reaches a TDD fix. Mechanical non-convergence reaches a partial report. |
| refutation -> report, tdd, or partial report | Attested lane receipt and report verdict. `clear` reaches report; blocking `changes-requested` reaches a TDD fix unless non-convergence fires. |
| report -> awaiting_fidelity | Pilot report with valid `## E2E` and `## Acceptance` quoting every folded card DoD criterion as a `- ` bullet with `Outcome: proven`, `Outcome: not done: <reason>`, or `Outcome: deferred: card <id> — <L4 reason>` naming an id in `routed_cards`, plus mechanically appended `## Routed cards` and `## Independent Review` on FULL; unchanged lifecycle snapshot; runner commit; and external archive manifest. Any non-proven outcome or `e2e not run` classifies the delivery as partial before archive. That classification is re-derived from each draft this edge judges: a refused draft never leaves a partial the corrected draft must carry, and a criterion the parser cannot find is a schema refusal, never an unmet criterion. A partial report must contain `Partial: <reason>`; a full report must not contain `Partial:`. |

Refusals name the edge, missing item, and path. Outcomes are parsed from the lane report, not
declared by the pilot.

The runner preflight refuses staged changes or tracked modifications: commit them or move them
aside, then relaunch. Pre-existing untracked files are allowed. At lifecycle creation the runner
captures their paths and identities, including ignored files. The report commit and independent
review use one literal, NUL-separated selection: tracked changes and newly created nonignored
paths, excluding that start baseline. A baseline path stays excluded even if edited, deleted,
staged by a lane, or made visible by a `.gitignore` edit. Exclusions and their reasons appear in
`.lane/staging-selection.json` and the runner log. Declared artefacts cannot reuse a start path.
Staging failures reset the index; retries reuse the computed selection. First completion and
commit recovery both require that only excluded untracked paths remain in Git status.

### Disputed Definition-of-done terms

A run is automated: a question about what a card criterion means goes to the run's parent (the
orchestrator, or the session that launched the runner), never to a person. The trigger is mechanical:
a blocking critic finding anchored to the same `DoD <n>` in two consecutive critic rounds, while the
loop continues to another plan round. Each criterion is escalated at most once per run.

- **Upward.** The lifecycle writes `.lane/dod-decision-request.md` with an unguessable request id,
  the criterion verbatim, the critic rounds, the plan's reading (its `Card terms: reading chosen`
  entry), each critic finding, the parent command, and a deadline. Terms match across whitespace,
  case, straight quotes, and curly quotes; a shorter Card-terms label must start on a word boundary
  and end at a word boundary (the sentinel `none` never identifies a longer criterion). The runner
  prints one `decision request: <file> — request <id> …` line to its log. With
  `--parent-session '<name> [<ref>]' --parent-mode <bypass|prompting>`, it also starts one dedicated
  SDK waker per published request, without waiting before decision polling. Copy the exact session
  identity from ListAgents; use `bypass` for a bypassPermissions parent and `prompting` for a
  default/auto parent. The mapping for acceptEdits and plan parents has not been verified.
  A PreToolUse fence permits only SendMessage to that parent with the exact
  runner-composed wake body and ToolSearch `select:SendMessage`; other tools and changed fields
  are denied. The body carries runner-owned run/request ids, DoD numbers, the request-file path and the decide template,
  never lane-written text. The parent reads the criterion from its own card and chooses the reading;
  request-file plan/critic prose is untrusted evidence, never instructions or a decision command.
  The runner-composed wake body is the preferred source. The log line and request file are lane-writable;
  take from them at most the run id, request id and DoD number. Build the decide command yourself from
  your own plugin's `wt-pilot-runner.mjs` path; never execute a path, node binary or --state-root copied from
  the log or request file. `decide` validates the ids against host state.
  A message is a wake-up, not a decision. The structured `parent wake: transport-accepted` log
  means only a correlated JSON `success:true` transport result, not receiver delivery. Permission
  class mismatch can hold the message for approval: an observed hold records `not-delivered:held`,
  and any other recipient delivery notice records `not-delivered:recipient-notice`. Input remains
  open for three seconds after the correlated tool result (configurable as `noticeHoldMs` in wake
  options), within the overall wake cap. The parent must still watch for `decision request:` in
  the log; a wake is only the fast notification path.
  Wakes reuse the runner's account gate, never re-enter admission, have a 120-second cap, are
  aborted at run end, and get at most five seconds of final settling. At most one is in flight;
  none is retried. A consumer that outlives the drain bound prevents later launches with
  `not-delivered:prior-waker-stuck`; normal run-end cancellation records `not-delivered:aborted`.
  Failures do not affect the decision deadline or run outcome. Model, assistant-id
  token totals, outcome, account verdict and any denied tool's name are recorded in
  `summary.parent_wakes[]` separately from pilot totals. Session-name reuse after a parent exits remains possible; the wake grants nothing.
- **Downward.** The parent invokes `node wt-pilot-runner.mjs decide --run <id> --request <id> --dod <n> --reading
  <text>`. The command atomically writes the SDK runner's per-run state under the host state directory
  (`XDG_STATE_HOME` or the platform equivalent), outside every lane sandbox bind. Mailbox and lane-file
   prose is never parsed for decisions. Each request/criterion is write-once, including a timeout binding.
   If hard links are unavailable or the binding cannot be read, the dispute fails rather than accepting an unrecorded fallback.
  The pilot receives the lifecycle's bound resolution as a runner-owned
  decision, and the next critic brief carries it under
  `## Binding decisions on disputed Definition-of-done terms (runner-owned, trusted)`.
- **Bounded wait.** Before the pilot revises the plan and before the next critic launch, the run waits up to 15 minutes from the request for the decision.
  With no answer the runner binds the card criterion's literal words verbatim, without selecting an
  interpretation from model output, and records the hard rule that the critic may not block again on
  that criterion for the rest of the run. The wait is zero when no decision reader exists or a stop
  was already requested. A timeout binding is final.
  On unsandboxed Linux (`WT_LANE_SANDBOX=off`), macOS, and Windows, another process under the
  runner's OS user can invoke `decide`: OS user identity cannot distinguish the parent from a lane.
  The sandbox is the authority boundary; the runner warns at startup when it is unsandboxed.
- **Record.** The pilot report gains `## Disputed Definition-of-done terms` with one line per
  criterion quoting the verbatim binding and no-reblock rule. The run summary carries the same record under
  `dod_disputes`.

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

TDD and independent critic/review/refutation briefs put mapped exact rule sections
under `## Rules that apply to this role (authoritative)`. Both executor families receive a
runner-owned snapshot brief; its knowledge-base availability line reflects the selected launcher.
The independent brief names the runner's once-resolved knowledge-base index and states that fiches are
claims to verify against current code rather than evidence. For Claude SDK independent roles only, the
lifecycle passes `--knowledge-base-index` to `wt-claude-executor.mjs`; its `canUseTool` permits Read of
the index and real-path-contained regular Markdown fiches while Glob/Grep remain worktree-confined.
OpenCode runs with `--dir` and `cwd` set to the worktree and `--auto` in `wt-lane.mjs`; `--auto` approves an
`external_directory` read the user's OpenCode config leaves on `ask`, so the brief names the index and tells
the lane to report a refused read (a config that denies it wins) rather than rely on the knowledge base.
TDD briefs also carry the frontmatter-stripped body of the shipped changelog skill in a
server-written authoritative section; a missing skill source refuses brief composition.

Tree signature v3 is a filesystem signature over names from HEAD, the index, and non-ignored
untracked files. It includes entry type, mode, contents, or symlink target. Staging a deletion or
rename does not change it; recorded v2 signatures do not compare.

GPT lanes use `openai/gpt-6.1-sol` for standard and hard code (`high`),
and `openai/gpt-6-sol` for standard critic (`max`);
hard critic, review and refutation use `openai/gpt-6-astra` (`max` / `medium` / `medium`).
Astra reviews Sol's code so the same model never judges itself. Claude SDK executors
use `opus` for critic, review and refutation at `xhigh`; standard code uses `sonnet`
at `medium`, hard code `opus` at `medium`. Explicit effort overrides take precedence.
Each executor role's selected model determines its launcher independently: a provider/model uses a GPT lane,
while a harness alias uses the Claude SDK. GPT models require lane consent even when another role runs on Claude.
Lane timeouts are capped at 5400 seconds. `run { kind: 'gate' }` runs the
toolkit's `pnpm typecheck`, `pnpm lint`, conditional `pnpm quality`, or `pnpm test`. The list is resolved
at each use from the current package scripts. Gate processes disable pnpm dependency verification
before scripts run; their receipts warn about paths changed during a gate without deleting or excluding them.
The gate, like the orchestrator's host gates, runs without the runner's own `WT_*` configuration
(`WT_AGENT_SDK_PATH`, `WT_EXECUTOR_*_MODEL`, `WT_PLANKA_MCP_URL`, ...), so how the runner was launched
cannot change the delivery's verdict; only `WT_SUITE_LOCK*`, `WT_TEST_MODE` and `WT_VITEST_MAX_WORKERS`
pass, with every non-`WT_*` variable (`gateEnvironment` in `plugin/bin/lib/gate-evidence.mjs`).
A lane must not rely on background processes surviving its receipt: the reported process group contains
the launcher worker, `opencode`, and its ordinary descendants, and the server terminates that group. A
process that creates its own session escapes the lane process group and remains outside this contract.

## Completion and CLI

### Which account the SDK child uses

The SDK child inherits the runner's environment (`pilot-runner-core.mjs`, `effectiveEnv` and
`queryOptions.env`). Without `CLAUDE_CODE_OAUTH_TOKEN`, it can authenticate using the config dir's
saved login, which may belong to a different account. Claude Code sessions started with
`CLAUDE_CODE_OAUTH_TOKEN` do not pass that variable to their Bash tool's subprocesses (observed on
Claude Code 2.1.284; undocumented). For a runner launched from an agent's Bash tool, supply the
intended account's token in the **runner launch environment** and pass
`--expect-account owner@example.com` (or set `WT_PILOT_EXPECT_ACCOUNT` in that launch environment).
Do not put the expected account or authentication variables in `--profile-env`.

The runner checks SDK `Query.accountInfo()` before sending the first user prompt, logs the account
line, and writes `summary.json` `account` with verdict, e-mail (if exposed), token source and expected
e-mail. `email_matched` means the SDK reported the expected e-mail (case-insensitive),
`apiProvider` is `firstParty`, and both `tokenSource` and `apiKeySource` are absent or `none`:
the stored login is the credential in use. `mismatch` requires the same stored-login evidence
with a different e-mail. `launcher_asserted` requires `tokenSource=CLAUDE_CODE_OAUTH_TOKEN`,
`apiProvider=firstParty`, and `apiKeySource` absent or `none`: the owner is **not independently
verified**; this verdict trusts the launcher's token-to-account mapping. An e-mail reported
alongside an environment token comes from the config and does not identify the token's owner.
`not_enforced` means no expected account was supplied; it logs the reported account or an unknown
reason and permits the run. `unverifiable` means the receipt fits neither trusted stored-login
nor launcher-token conditions; `unavailable` means `accountInfo()` could not return a receipt;
`profile_override` means `--profile-env` supplied an account or credential selector. These and
`mismatch` refuse before any user prompt and fail the run. The check is pure JavaScript over SDK account fields and
works the same way on Linux, macOS and Windows.

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
`summary.json` also records `budget` (declared seconds, 600-second boundary grace, measured seconds,
and signed measured-minus-declared delta), `longest_tool_call` with tool name, id, duration and
start/end timestamps, and `unfinished_tool_calls` measured through run end. Lifecycle `run` calls
include their kind/name and the phase at call start (and a round when the state exposes one).
When assistant usage follows the last SDK result, `fresh_tokens` and `turns` are `unavailable`;
`turns_completed` counts results and `fresh_tokens_lower_bound` sums recorded assistant input,
cache creation and output. Per-message output can undercount a terminal result, so this sum is
not a final total. The same unavailable value appears in `usage.json` and the CLI's `fresh=` line.

The runner timeout is a clean-boundary stop, not a mid-phase kill. A Node timer calls the in-process
lifecycle server's `requestStop('timeout')`; the current lane, gate, or other phase work is allowed to
finish. The next otherwise-accepted `transition` records `Partial: timeout`, `Phase reached: <phase>`,
and `Reason: timeout` in `.lane/pilot-report.md`, ends that phase without entering the next one,
refuses later lifecycle calls, and aborts the SDK stream through `AbortController`. Finalization then
publishes the ordinary partial archive and `.lane/worktree-retention.json`. The old implementation
instead yielded a user prompt from the async prompt generator while a lifecycle tool could still be
running; the SDK buffered that prompt, but no lifecycle state consumed it, so a pilot could continue
through later phases.

If a phase never returns and therefore never calls `transition`, the runner waits up to ten minutes
after the timeout request, then aborts the SDK stream. An SDK exception caused by that grace abort
keeps `reason: timeout` in the summary and lifecycle partial, preserves its message as
`sdk_stream_error`, and rejects with a `timeout:` error after publishing the receipts. An unrelated
SDK exception before the grace abort remains a stream error. Supervised executor lanes retain their
owner decision path and identity-aware abandon control for wedged lane processes.

Timeout delivery itself has no shell, signal, process-table, or filesystem-injection dependency:
`pilot-runner-core.mjs` uses the cross-platform Node timer and `AbortController`, and
`lifecycle-state-machine.mjs` receives the request in process. A phase running an executor still uses
`lifecycle-launch.mjs`; on Windows its supervision evidence is checked through the recorded
single-process identity path in `lane-supervisor-core.mjs`. An unavailable or inconclusive Windows
identity read is returned as an actionable `TIMEOUT: unknown` rather than a plausible success, while
the runner's own timeout request remains visible in its launch log as
`timeout requested; waiting up to 10 min for the <phase> phase boundary`.

When critic, review, or refutation exhausts its round bound, the runner also writes the ignored
`.lane/worktree-retention.json` file. Version 1 records `cardId`, the canonical absolute `worktree`,
`retainedAt`, the bounded-run `reason`, the stopping `phase`, and `expiry` with the board id and the
condition `card is absent or in Done or NotDoing`. Readers of v1 tolerate additional fields.
`node "${CLAUDE_PLUGIN_ROOT:-${WT_PLUGIN_ROOT:-$(node -e 'const fs=require("fs");const dir=process.env.CLAUDE_CONFIG_DIR||(process.env.HOME+"/.claude");const j=JSON.parse(fs.readFileSync(dir+"/plugins/installed_plugins.json","utf8"));const p=j.plugins||j;const k=Object.keys(p).find(x=>x.startsWith("workflow-toolbox@"));console.log(p[k][0].installPath)' 2>/dev/null)}}/bin/wt-worktree-remove.mjs" --dir <worktree>`
(the same three-fallback plugin-root resolution `plugin/agents/opencode-envelope.md` ships) reads that
marker before every removal, resolves the card's current list, and refuses while the card is open or
the board cannot be reached. It also refuses a marker copied from a different worktree; `--force`
changes Git's removal mode only and never bypasses these checks.
When `expiry.boardId` is null or blank, pass `--board-id <id>` or place a
`.claude/planka.json` pointer above the worktree (or the invocation directory). The remover
looks above the canonical worktree first, then above the current directory. A marker's own
board id takes precedence; a conflicting flag or board adapter refuses removal. A found card on a different
board, or one whose board cannot be verified when using a flag or pointer, also refuses.
An unreadable or unusable nearest pointer refuses rather than falling back to a higher one.
When a flag or pointer supplies the board and the card is absent, absence cannot be tied to
that board: retention stands until the owner removes the worktree. A marker with its own
recorded board still expires when the card is absent. The marker is read again after the board
answers, before any Git call, and just before `git worktree remove`; a changed card or board id there, or a marker copied from
another worktree, refuses. A writer racing the Git removal itself is not coordinated. Refusals give the remedy or owner
action, without asking an operator to edit the retention marker.
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
`$XDG_DATA_HOME/opencode/opencode.db` on Linux (defaulting to
`~/.local/share/opencode/opencode.db`). macOS and Windows store locations are not asserted without
`--db` or `WT_OPENCODE_DB`. An absent CLI, unreadable database, unsupported default, or unmatched lane is
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
Its `coverage` separates lifecycle-attributed USD, inferred USD (`unknown`, `reconciled`,
`unattributed`), and unmatched-session USD; it counts missing-token sources, priced sources
outside an attributed lane/phase, and models with no price. Missing sources or prices mark the
total incomplete and the report labels it a lower bound; a last pilot turn with no terminal SDK result
counts as one missing source, because its output can exceed the per-message usage. Every priced
phase other than the synthetic rows counts as attributed, so the three amounts add up to the total.
Reconciled terminal output by itself
does not mark coverage incomplete. The same coverage appears beside `cost.total_usd` in
`summary.json` and in the run's cost-index record.
Prices are resolved fresh for every completed run by exact provider and model. The primary source is
OpenCode's models.dev cache: `$XDG_CACHE_HOME/opencode/models.json` (otherwise
`~/.cache/opencode/models.json`) on Linux, `~/Library/Caches/opencode/models.json` on macOS, and
`%LOCALAPPDATA%\opencode\models.json` on Windows. `cost.json.price_table` records that path, its mtime,
and a reason whenever it was unavailable. Missing catalogue rows fall back to the shipped
`pricing/model-prices.json`. A `model-prices.override.json` in the resolved plugin data directory wins
over both and is only read, never written. Its schema is `{ "models": { "provider/model": { "input":
..., "output": ..., "cache_read": ..., "cache_write": ... } } }` with rates per million tokens.
Context-tier selection measures the reported input plus cache-read plus measured cache-write tokens in
the priced model row. Zero-price catalogue routes display `subscription`; OpenAI routes display their
catalogue amount as `API price equivalent`; missing rows display `price unknown`; sources over 60 days
old display `price not verified since YYYY-MM-DD`.
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
`--plugin-dir <absolute-path>`, `--profile-env`, `--expect-account <email>`, `--contract`,
`--hard`, `--mailbox`, `--parent-session <name>`, `--parent-mode <bypass|prompting>`, `--timeout <seconds>`, and `--stop-after <phase>`; the parent flags must be paired; `--lane-silence` is not accepted.
`--stop-after` is a piece-test option: `discovery`, `plan`, `critic`, `tdd`, `verify`, `review` or
`refutation` ends the run at the boundary leaving that phase, with the usual partial report (reason
`stop-after <phase>`), so one changed phase can be replayed without a whole run. The runner uses Node path semantics on
Linux, macOS, and Windows, resolves `--dir` to an absolute path, and applies real-path containment before
authorizing reads. Phase sessions never enable `allowDangerouslySkipPermissions`. The sole scoped
exception is the dedicated waker for a `--parent-mode bypass` parent: only SendMessage and
ToolSearch are exposed, with the exact-destination/body PreToolUse fence still enforced. A prompting
waker uses default permissions and the same fence in `canUseTool`. Wakers have no plugins,
`settingSources: []`, no MCP servers, ClaudeAI MCP disabled, and `persistSession: false`.
The board contract is `{ boardId, listId, labels: { priority: {P0,P1,P2}, type:
{bug,chore,feature,research}, effort: {S,M,L}, category } }`. `route_finding` is the only card-creation
surface: the runner makes one `create_card` MCP call with `dependsOn: 'none'` and exactly one canonical
`Depends-on: none` description line. Origin card is provenance only. All interpolated provenance
values (origin, session, L4 reason, timestamp) are losslessly quoted as JSON strings on individual
physical lines, escaping CR/LF and U+2028/U+2029; identifier fields use the existing identifier contract.
Before creation the assembled description must have exactly one canonical none declaration and the
shipped dependency parser must return no IDs or malformed declarations; local refusal makes zero
create calls. The returned description, or a `get_card` read-back if absent, is independently checked.
A failed read-back/declaration check preserves the created card ID; creation is not retried and origin
dependencies are not mutated. After creation the three selected label IDs and category are applied
with four separate `add_label_to_card` calls even when dependency verification fails. Each card is
recorded in `routed_cards` in `lifecycle.json` and the archive manifest with `dependencyVerified`
and, when false, `dependencyVerificationReason`. The tool result names the card and explicitly
reports unverified dependencies. A contested item
completed in-run gets a runner comment and move to `NotDoing`; maintained disagreement stays named.
Configured plugin directories are passed as local SDK plugins beside `pilot-guard`; the initialization
receipt must name every one or the pilot run is refused. No plugin name or host path is built in.

## Fidelity review

Main freezes and verifies evidence with `wt-pilot-fidelity.mjs`. Run `freeze` with the worktree,
bundle directory, card, session, base, head, and lane files; then run `verify --require-same-tree
--require-head`. The v2 manifest has typed entries, a snapshot id, and a length-prefixed signature;
freeze and verify admit `typecheck`, `lint`, `quality`, and `test` gate log formats, lifecycle-enum lane/report
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
(`effort:S|effort:M|effort:L`), every requested mission label, and a `Depends-on:` line
(`Depends-on: none` included) read by the plugin's shipped dependency parser, every referenced card
being Done. A card with no such line is skipped as not checked, an unreadable line skips the card
and the report quotes it, and a referenced card the board reports as not found (404) skips that card only
(the rest of the wave runs), as does an id beyond the board's 64-bit id range; any other board
failure, an unreadable `get_card` answer included, stops the wave. Explicit `--cards` are
the caller's selection and are not checked against `Depends-on:`. The driver snapshots each eligible card, creates its
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
