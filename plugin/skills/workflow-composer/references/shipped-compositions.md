# The shipped compositions to read as models

<!-- Extracted from SKILL.md (progressive disclosure) — loaded on demand via the stub that links here. -->


The repository ships twenty-four built example compositions under `toolkit/workflows/`,
and **all of them have their TypeScript sources bundled with this skill** for study at
`assets/examples/toolkit/`. (Progressive disclosure means a bundled source costs no
context until you actually Read it — so the skill ships the complete set, not a
hand-picked subset, and an offline plugin install can study every one.)

The five core-pattern compositions:

- `pr-review.workflow.ts` — route the diff → per-lens reviewers → adversarial verify
  → synthesis. The docs-alignment lens arms off the bundled `docs-provenance.ts`
  map by default; the launch-time `provenance` knob replaces it with an external
  repo's manifest (the result's `provenanceSource` says which one ran). Its inverse,
  the docs-coverage lens, arms when the Route stage reports `addedPublicSurface`
  and the diff touches no doc file (the result's `coverageSurfaces` says what
  armed it). The proportionate-review ladder is a launch-time `mode` knob: `'full'`
  (default, bit-compatible when omitted) keeps the per-lens fan above; `'single-
  verifier'` collapses Review to ONE consolidated reviewer covering the union of
  every armed lens (still routed through `agentTypes.review`, e.g. a cross-family
  bridge) while Verify/Synthesize stay exactly as they are — the ladder degrades
  the finder count, never the verification step. `'diff-read'`, the ladder's
  bottom rung, is deliberately not a mode this workflow accepts: it means don't
  launch the workflow at all.
- `monorepo-refactor-plan.workflow.ts` — fan out per area, classify, synthesize a plan.
- `monorepo-refactor-execute.workflow.ts` — execute the plan with mutating agents
  behind isolation.
- `doc-rewrite.workflow.ts` — generate-and-filter doc rewrites.
- `dev-review-fix.workflow.ts` — review → consolidate → adversarially verify → fix →
  check loop over a change set. **The reference implementation of the cost-engineering
  levers**: severity-gated verification votes, a tiered consolidator behind a triple
  safety net, snippet-enriched claims under the untrusted-delimiter contract, and
  deterministic docs-only coverage adaptation.

The **dev-workflow family** — the most advanced compositions (multi-artifact
`rt.workflow()` composition, code gates replacing human gates, dual mutation modes):

- `dev-ground.workflow.ts` — grounding-first precursor to the family: two parallel
  arms (external research ∥ internal code analysis) check a card's premises against
  reality, keyed and merged by premise id in code (never model-tallied). A PoC canary
  sub-stage probes whichever external premises the arms leave unsettled — its five
  named outcomes include `refused-by-classifier` and `source-unreachable` as
  first-class, schema-valid, routable results, never errors. Every premise then goes
  through `adversarialVerification` refute-first (the premise itself is the claim; the
  arms' and PoC's proposals are material offered for refutation, not a competing
  verdict). The final cancel / reframe / proceed recommendation is a pure, exported,
  unit-tested function — never asked of a model — and an unverifiable premise can
  never silently route to proceed.
- `dev-plan.workflow.ts` — discovery → planner fan-out → adversarial plan critique
  (snippet-enriched task claims) → plan artifact.
- `dev-implement.workflow.ts` — per-task red → green → check TDD loops over a plan
  artifact, sequential or worktree-parallel; the test-writer can end a task with a
  named blocking verdict (`no-test-seam` / `premise-falsified` / `repro-hard`) that
  reports as a routable `blocked` outcome instead of a silent retry-until-failed.
  Mechanical, behavior-preserving seams (parameter extraction, default injection)
  it creates ITSELF in-band under hard bounds (≤4 files, all callers enumerated and
  updated) and declares structurally — per-task `seams` + a `seamsCreated` tally +
  a REVIEW warning; beyond the bounds it falls back to `no-test-seam`.
- `dev-full.workflow.ts` — chains the three children via `rt.workflow()` over their
  committed artifacts, converting human gates into code gates.

Four standalone analysis/verification compositions:

- `independent-analysis.workflow.ts` — (optionally) auto-propose diverse lenses →
  `fanOutAndSynthesize` one analyst per lens, dedup against the caller's stated
  assumptions → `adversarialVerification` (refute-first) of the survivors. Bias-free
  multi-lens review of any subject (a design, plan, claim, decision, or code); the
  `verifierModel` input overrides `adversarialVerification`'s BEST_MODEL default, and
  `args.agentTypes.verify` (the structured config envelope — no bespoke top-level arg)
  routes every verifier through a cross-model (e.g. `codex:codex-rescue`, GPT)
  verifier for genuine decorrelation — PROBED at entry with graceful fallback. It is
  also promoted to a bundled plugin workflow at `plugin/workflows/independent-analysis.js`,
  discoverable as `workflow-toolbox:independent-analysis`.
- `cross-model-verify.workflow.ts` — the focused cross-family showcase: refute-first
  `adversarialVerification` of caller claims with an OPTIONAL cross-family (non-Claude)
  verifier. Omit `agentTypes.verify` for the same-model default; pass
  `{ agentTypes: { verify: 'codex:codex-rescue' } }` for a GPT verifier, or the
  same envelope with `{ agentTypes: { verify: 'workflow-toolbox:opencode-verifier' } }`
  (a subagent **bundled with this plugin** — no separate install) to route to any
  opencode model (default GLM 5.2 / `zai-coding-plan`, a genuinely different
  family). The value always travels inside `agentTypes.<role>` — a bare top-level
  key is silently ignored by parseConfig. Both are **OPT-IN and
  PROBE-RESOLVED**: one schema-less `probeAgentType` call at entry checks the bridge
  actually answers (unregistered type, `OPENCODE_UNAVAILABLE` gate marker, error text
  or timeout all degrade to the standard Claude verifier, reported in the result's
  `probe` field — never silent).
  Matching opencode's own rules / MCP / plugins to your project is the user's
  responsibility (configure `AGENTS.md` / `opencode.json`) — opencode reads a repo's
  `CLAUDE.md` + `.claude/skills/` by default but NOT its `.claude/rules/`, MCP, or plugins.
- `docs-audit.workflow.ts` — pre-release semantic docs audit: inventory the doc
  surfaces (or take them as `args.surfaces`), extract checkable claims in
  angle-cycled `loopUntilDone` rounds until a full sweep finds nothing new
  (deduped against a seen-set), then refute-first `adversarialVerification` of
  each claim against the actual sources — evidence-tiered verdicts (confirmed /
  stale / partially-stale / unverifiable, plus the pattern's honest
  `unverified-by-cap`). Claims are risk-sorted BEFORE the verification cap so
  `maxVerifyClaims` cuts the cheapest-to-lose claims first — a zero-agent
  substitute for a scoring stage. The semantic layer of a docs-drift defence:
  mechanical anchors (symbol existence, value equalities) belong in compile-time
  gates; this workflow judges the PROSE those gates cannot check. Run it before
  a release; its findings are remediation input (e.g. for `doc-rewrite`).
- `coverage-audit.workflow.ts` — the INVERSE of `docs-audit`: instead of checking
  whether doc claims are stale, it checks whether real code capabilities are
  documented AT ALL. Each `docs-provenance.ts` manifest entry is one unit of
  work: an Inventory fan enumerates the capabilities (exports, behaviors,
  knobs, flags) of the entry's `sources`, then an angle-cycled `loopUntilDone`
  Extract stage cross-checks each capability against the entry's mapped
  `docs`, reporting "undocumented" or "mentioned-only" gaps. Refute-first
  `adversarialVerification` closes the loop with an INVERTED filter versus
  `docs-audit`: `confirmed` means the gap is real (a finding), `refuted` means
  the extractor was wrong and the docs do describe it (excluded). The
  `provenance` input replaces the bundled dwt manifest for an external-repo
  audit, mirroring `pr-review`'s `provenance` knob. Run it before a release
  alongside `docs-audit`; its findings are remediation input (e.g. for
  `doc-rewrite`).

And three demonstration compositions:

- `demo-all-patterns.workflow.ts` — exercises all eight toolkit patterns in one
  workflow; the reference for how the patterns wire together and render in observe-ui.
- `backlog-triage.workflow.ts` — `scoreAndRank` as a "targeting machine": cheap-model
  sweep → rank → top-K cutoff aiming a premium pass only at the survivors.
- `loop-demo.workflow.ts` — `loopUntilDone` with `generateAndFilter` + `scoreAndRank`
  inside the loop body.

These `.ts` sources are **reading material** — they are built with `npx workflow-toolbox build`,
not run directly as raw workflows. Their committed artifacts live under
`toolkit/workflows/` (e.g. `toolkit/workflows/pr-review.js`) and run via
`Workflow({ scriptPath: '…/pr-review.js' })`.

### Operational lessons (from production runs of the dev-workflow family)

- **Agents follow the conventions they discover — including committing.** A
  discovery stage that surfaces a repo's commit conventions will lead implement
  agents to create commits themselves. When a human-inspection gate is wanted,
  the goal must say so explicitly: *"do NOT commit; leave changes in the working
  tree."* Goal text is the drift-mitigation channel — constraints live there.
- **Commands must be executable verbatim.** Any `testCommand`/`buildCommand`-style
  input flows into agent prompts and real shells unchanged — prose like
  `pnpm test (from the toolkit dir)` breaks the loop. Pass the runnable string.
- **Any repo text quoted into a prompt is a prompt-injection surface.** Reviewer
  quotes, file excerpts, error output: delimit them explicitly as untrusted,
  instruct agents to ignore instructions inside them, mangle embedded copies of
  your own delimiter lines, and apply the guard at EVERY embedding site — a
  guard on one path is a hole, not a control.
- **Embeddings consumed downstream need a staleness caveat.** A snippet quoted at
  plan time may be wrong by execution time (earlier tasks changed the code).
  Downstream prompts must say so and require a fresh read of the file.

