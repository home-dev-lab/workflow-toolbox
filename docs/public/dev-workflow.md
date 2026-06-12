# The dev-workflow family — a full development cycle as Workflow runs

The flagship composition of this toolkit: four workflows that together take a
feature request from **goal → validated plan → TDD implementation → reviewed,
fixed, green tree** — built entirely on `@workflow-toolbox` patterns, runnable
as-is from the committed artifacts in `toolkit/workflows/`.

It is not a demo. **The toolbox used this pipeline to build itself** — every
workflow below shipped real changes to this repository, and the numbers in
[§ Proven on itself](#proven-on-itself--the-numbers) come from those runs'
audit journals (`npx workflow-toolbox report <runId>`).

## Two run modes

```text
SPLIT (human-gated):
  dev-plan ──▶ [human reviews/edits the PlanArtifact]
           ──▶ dev-implement ──▶ [human reads the report]
           ──▶ dev-review-fix

FULL (autonomous):
  dev-full ──▶ dev-plan ──[code gate A]──▶ dev-implement ──[code gate B]──▶ dev-review-fix
```

Split mode puts a **human gate at each artifact boundary** — you read and edit
the JSON the previous stage produced before feeding the next. Full mode
(`dev-full`) chains the same three workflows in one run via `workflow()`
composition over their committed artifacts and converts the human gates into
**code gates**. There is no mid-run human input in either mode (the sandbox has
no interactive prompt); drift is mitigated by re-running with corrections
appended to the goal.

## The four workflows

| Workflow | Phases | What the gates guarantee |
|---|---|---|
| `dev-plan` | Discover → Plan → Critique → Synthesize | Every task claim is **adversarially verified against the actual code** (files exist, contracts match real signatures, criteria checkable); refuted tasks are dropped with the refuting *reasons*; the dependency graph is validated deterministically in code (unique ids, resolvable `dependsOn`, no cycles). |
| `dev-implement` | [Setup →] Implement+Check (per task) [→ Merge] → Report | Each task is a bounded TDD loop — failing tests first, implement against the contracts, then an **independent checker** runs the real test command and is the only source of truth; dependents of failed tasks are skipped. Two mutation modes: **sequential** (default — one task at a time in dependency order, **no git required**) and **worktree** (see below — parallel waves, git required). |
| `dev-review-fix` | Review → Verify → Fix → Report | Parallel per-dimension reviewers read the whole change set (catches cross-task drift); every finding is adversarially re-derived from the current tree — plausible-but-wrong findings get **refuted**, not fixed; one batched fix loop whose checker re-validates *all* findings each iteration (a later fix can re-break an earlier one while the suite stays green); `suiteGreen` is reported honestly. |
| `dev-full` | Plan → Implement → Review & Fix → Report | Gate A: abort on a refuted-task ratio above `maxRefutedRatio` or a degraded discovery context; Gate B: continue iff ≥ 1 task succeeded; the change-set handoff is derived in code (an operator `diffCommand` wins over the planned-files approximation); **every abort returns** a structured report preserving the completed stages' output — `parseInput` is the only throwing surface. |

## Proven on itself — the numbers

Five production runs, June 2026, all journaled (run IDs are local audit
anchors; replay the reports with `npx workflow-toolbox report <runId>` on the
machine that ran them):

| Run | Workflow | What it shipped | Agents | Tokens | Duration |
|---|---|---|---|---|---|
| `wf_fc2b2751-b33` | `dev-plan` | Planned a real patterns feature (the `ClaimVerdict` verdict vocabulary): a 3-task PlanArtifact citing real line numbers and test substrings; 1 duplicate candidate task **refuted by the critique** | 18 | 1 072 822 | 15 min |
| `wf_673b1f49-5b6` | `dev-implement` | Implemented tasks 1–2 of that artifact → `@workflow-toolbox/patterns` 0.3.0, TDD red→green→check per task | 10 | 542 437 | 16 min |
| `wf_0f95b14d-9e9` | `dev-implement` | The remaining docs task, re-run after a human gate edit | 3 | 159 957 | 6 min |
| `wf_e77b638d-e77` | `dev-review-fix` | Reviewed the diff of **its own shipping commit** and fixed 11/11 confirmed findings on itself — including adding its own `suiteGreen` honesty field | 40 | 2 016 310 | 26 min |
| `wf_dcff9070-ee0` | `dev-full` | End-to-end, zero human gates: made `loopUntilDone` count body-spawned agents — plan 3 tasks/0 refuted → implement 3/3 → review suite green, 2 findings confirmed-and-fixed + **1 refuted** by adversarial verification | 42 | 2 353 928 | 44 min |
| `wf_ecbadacb-ba3` | `dev-plan` | Planned the TSDoc `@example` documentation of all seven patterns: 7 **independent** tasks (one file each, empty `dependsOn` — explicitly shaped for parallel worktrees), 0 refuted | 33 | 1 853 922 | 14 min |
| `wf_29f82471-b7d` | `dev-implement` (worktree) | The worktree-mode proof: ONE parallel wave of 7 worktrees (`wt-task/T1..T7`, `pnpm install` each) → 7 sequential merges, integration check after every merge — **7/7 succeeded first-iteration, 0 conflicts, 0 integration failures**, all worktrees and task branches cleaned | 52 | 2 250 150 | 20 min |

Totals: **198 agents, ≈ 10.2 M tokens, ≈ 2 h 20 min** of wall-clock automation —
for one published minor feature, one behavior change, two self-review passes
whose fixes all landed, and the TSDoc documentation of all seven patterns.
Every run ended with the full gate suite green (tests, typecheck, lint)
verified outside the workflow before committing.

Three details worth pausing on:

- **Refutations are real.** The verify stages do not rubber-stamp: the critique
  dropped a duplicate planned task, and the final `dev-full` review refuted one
  of three findings after re-deriving it from the tree. A finding that survives
  has been attacked first.
- **The pipeline catches its own omissions.** The `dev-full` run's docs task
  updated two documentation surfaces but missed a third (the toolkit README);
  the review stage of the *same run* flagged it and the fix loop repaired it.
- **The human gate earns its place.** In the worktree dogfood, the (excellent)
  PlanArtifact still carried two real defects the split-mode gate caught before
  any mutation: a non-verbatim `testCommand` (`cd toolkit && …` from a
  directory already inside `toolkit/`) and **absolute file paths pointing at
  the main repository** — obedient agents would have edited the main tree
  instead of their isolated worktrees. Edit the artifact; that is what the
  gate is for. (The second defect class is now also defended in code: see the
  path contract below.)

## Worktree mode (`dev-implement`, parallel waves)

`mutation: "worktree"` trades the no-git guarantee for parallelism: **git is
required**. Independent tasks (per `dependsOn`) run their TDD loops in
parallel **waves**, each task in an isolated git worktree on its own
`wt-task/<id>` branch, then merge back sequentially:

- **Waves branch late.** A wave's worktrees are created only *after* the
  previous wave's merges, so dependent tasks branch from a HEAD that already
  contains their dependencies. Worktree creation within a wave is serialized
  (concurrent `git worktree add` race on git's locks); the TDD loops then run
  in parallel.
- **Per-merge integration check.** After *each* merge an independent checker
  runs the real test command on the main tree; red → the merge is reverted to
  its captured pre-merge sha and the task is reported `integration-failed`.
  A merge **conflict** aborts conservatively (`merge-failed`) — agents never
  resolve conflicts.
- **Failure worktrees are kept** (path and branch in the report) for forensics
  and manual resume; merged worktrees are cleaned up. In every failure mode
  the MAIN tree stays unmutated by that task — only merged work lands.
- **Machine commits are unsigned by default** (`signCommits: false`): the task
  branches and merge commits are intermediate machine commits the operator
  owns and typically squashes. Opt in to signing only when the signing agent
  is guaranteed available for the whole run.
- **Fresh worktrees lack installed dependencies** in most ecosystems — pass
  `worktreeSetupCommand` (verbatim, e.g. `"pnpm install"`) so the test command
  is runnable inside each worktree. `worktreeRoot` overrides the default
  sibling location `<projectDir>-worktrees`.

```text
args: {
  "artifact": <the approved PlanArtifact>,
  "mutation": "worktree",
  "worktreeSetupCommand": "pnpm install"
}
```

## Running it

Both modes run from the committed artifacts — no install, no build. Inputs are
plain JSON passed as the workflow `args` (the only input channel).

Split mode, first stage:

```text
Workflow tool → scriptPath: <repo>/toolkit/workflows/dev-plan.js
args: {
  "goal": "Add input validation to the CLI",
  "areas": ["src", "test"],
  "projectDir": "/abs/path/to/project"
}
```

Review/edit the returned PlanArtifact, then feed it to
`dev-implement.js` (`{"artifact": <the edited artifact>}`), then point
`dev-review-fix.js` at the change set (`diffCommand` on git projects,
`changedFiles` elsewhere — exactly one of the two).

Full mode:

```text
Workflow tool → scriptPath: <repo>/toolkit/workflows/dev-full.js
args: {
  "goal": "…the feature, self-sufficiently described…",
  "areas": ["packages/foo"],
  "projectDir": "/abs/path/to/project",
  "scriptPaths": {
    "plan":      "<repo>/toolkit/workflows/dev-plan.js",
    "implement": "<repo>/toolkit/workflows/dev-implement.js",
    "reviewFix": "<repo>/toolkit/workflows/dev-review-fix.js"
  },
  "diffCommand": "git status --short; git diff HEAD"
}
```

Optional `dev-full` knobs: `maxRefutedRatio` (default 0.5),
`maxIterationsPerTask`, `maxFixIterations`, `dimensions` — unset knobs are
omitted so each child workflow's own default stays canonical.

Note on the review child's default: with `dimensions` unset and a
`changedFiles` diff source, `dev-review-fix` adapts a **docs-only** change set
(every file has a documentation extension) down to two reviewers
(`correctness`, `conventions`) — there is no executable surface for the
`security` and `tests` reviewers on pure docs. The adaptation is deterministic
(extension allowlist, in code), loudly warned in the report (and relayed by
`dev-full`, so no-git autonomous runs surface it), and an explicit
`dimensions` array always wins.

Reviewers also quote a verbatim **snippet** with each finding (a required
schema field; empty when quoting does not apply). The snippet is embedded in
the verifier's claim inside explicit `UNTRUSTED` delimiter lines — a
navigation aid that makes the verifier's first read targeted instead of
exploratory (verifier cost follows tool-call count), truncated in code at
3000 chars. It is never treated as evidence: the verifier must still
re-derive every finding from the file on disk, and the fixer only sees the
snippet on its first iteration (the only one whose tree still matches what
the reviewer quoted) — the checker never does.

The same snippet contract runs at the planning stage: every planned task
carries a required planner-quoted snippet of the most load-bearing code it
will modify (empty only when the task creates new code), with a file +
line-range location. The plan-critique verifiers receive it under the same
untrusted-delimiter rendering — navigation, never evidence — and the task
hands it through to `dev-implement`'s task block with an explicit staleness
caveat (earlier tasks may have changed that code, so the implementer must
re-read the file) — making the implementer's first read targeted too. Task
checkers never receive it.

## Operational lessons (learned the honest way)

- **Trust boundary.** `dev-full` has *no human gate between the goal and
  autonomous tree mutations*. Only point it at goals and repositories you are
  willing to let agents modify end-to-end. The same applies to
  `dev-review-fix` alone: never aim it at an untrusted third-party change set —
  reviewers quote the reviewed code, which is a prompt-injection path into the
  fixer.
- **Agents follow the conventions they discover — including committing.** In
  the `dev-full` run above, the discovery phase picked up the repository's
  signed-conventional-commits convention, so the implement stage **created the
  commits itself** (clean, signed, well-messaged — but unreviewed at commit
  time). If you want a commit-after-human-inspection gate, say so in the goal:
  *"do NOT commit; leave changes in the working tree."*
- **Commands must be executable verbatim.** `testCommand`/`buildCommand` flow
  into agent prompts and real shells unchanged — prose like
  `pnpm test (from the toolkit dir)` breaks the loop. Give the runnable string.
- **Task file paths must be relative to `projectDir`.** `dev-plan` instructs
  its planners accordingly and normalizes its output in code; `dev-implement`
  auto-relativizes an absolute path under an *absolute* `projectDir` (with a
  warning) and **rejects** any absolute path it cannot map — in both mutation
  modes, because an agent told to edit an absolute path mutates that location
  verbatim (in worktree mode that would be the main tree, the exact defect the
  human gate once caught live).
- **Prefer `diffCommand` on git projects.** The no-git fallback approximates
  the change set from the *planned* task files; files an implementer creates
  beyond the plan are invisible to it. The real diff sees everything.
- **Aborts are reports, not crashes.** When a `dev-full` gate fires you get
  `outcome: "aborted-at-…"` with every completed stage's output preserved —
  arbitration material for falling back to split mode, not a stack trace.

## Where the pieces live

- Sources (authoring reference): `toolkit/examples/dev-{plan,implement,review-fix,full}.workflow.ts`
- Runnable artifacts: `toolkit/workflows/dev-{plan,implement,review-fix,full}.js`
- Patterns they compose: [toolkit/README.md](../../toolkit/README.md) (the
  seven patterns and the result envelope)
- Post-run forensics: `npx workflow-toolbox debug <runId>` (what went wrong) and
  `npx workflow-toolbox report <runId>` (cost rollup, decision trail, transcripts)
