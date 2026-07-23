# Schemas, model tiering, and agent routing

<!-- Extracted from SKILL.md (progressive disclosure) — loaded on demand via the stub that links here. -->


- **Schema at every consumed boundary.** Put a `schema` (JSON Schema) on any
  `agent()` whose result a later line reads a field off. Without it the agent returns
  free text and `r.field` is silently `undefined`. Free text is fine only when the
  whole string is passed into the next prompt. See `references/api-reference.md` for
  the structured-output contract.
- **Model tiering.** Mechanical, high-volume leaf work → `model: 'haiku'`. Judgment
  work → inherit the session model (omit `model`). **Verifiers default to the strong
  model** (`BEST_MODEL`) — verification quality is model-sensitive, and a downgraded
  verifier is the one place a cheap model costs you correctness.
  - **⚠ Top-tier alias availability is environment- and time-dependent — never
    hard-pin a verifier to an alias you have not verified is callable where the
    workflow will RUN.** Aliases come and go with plans, access windows, and provider
    policy; an alias that is not callable in the consumer's environment errors at
    runtime. The toolkit's `BEST_MODEL` tracks the strongest *reliably-callable* tier
    (currently `'opus'`), so the default is safe; the trap is only a hand-override.
    Note `BEST_MODEL` is a VALUE inlined into bundled artifacts at build time —
    changing it re-emits every committed artifact (the artifact-identity gate
    enforces the regeneration).
  - **Validating a model-selection INPUT** (e.g. a `verifierModel` arg): check it
    against the runtime's exported `MODEL_ALIASES` allowlist — the closed set of
    user-passable aliases (deliberately stricter than the open `ModelAlias` type;
    `'inherit'` and raw model ids are excluded).
- **Effort tiering (the second axis — pick it WITH the model, per stage).** Subagents
  inherit the session's reasoning effort unless a stage passes an explicit override
  (`effort` on `agent()`, or the per-role `<role>Effort` knobs every pattern exposes).
  Floors by stage class: classify/extract/mechanical → `'low'`; review/implement →
  `'high'`; verify/judge → `'high'` MINIMUM (never below — the cost lever is votes,
  not weaker verification); synthesize → `'medium'`; reserve `'xhigh'` for a genuine
  final-arbitration stage. Floors are minimums: pinning above them is fine. Pure
  render/e2e fixtures may pin everything `'low'` — state that intent in the file
  header so a later pass doesn't "fix" it.
- **The composition envelope (`envelope.trail` — attach it, or your run is unauditable).**
  Each pattern returns its own `trail` (per-stage records carrying explicit `model`/
  `effort` overrides + control decisions), but readers — the audit report's Decisions
  enrichment and the observe agent panel's per-agent effort chip — read ONE place:
  `result.envelope.trail` on the composition's RETURN VALUE. Attach it with the
  helper: `return { …yourPayload, envelope: { trail: collectTrail(a, b, c) } }`
  (`collectTrail` from `@workflow-toolbox/patterns` — concatenates trails in call
  order, skips null/undefined results from skipped stages). A composition that omits
  it still runs, but its effort tiering and decisions are invisible to every audit
  surface. Skip it only when the composition spawns no patterns at all — never attach
  a fabricated empty envelope.
  - **PLAIN `rt.agent()` stages write NO trail record** (only patterns do): their
    explicit `model`/`effort` are applied at runtime yet invisible to the audit
    surfaces. Hand-record them: give the call an explicit `label`, build a matching
    record with `makeRecord(label, ok, { model, effort })`, and pass it to
    `collectTrail(..., { trail: [record] })` — the record's stage and the agent's
    label must match EXACTLY (that string equality is the join every reader uses).
- **Specialist agent types (the `agentType` lever).** Beyond the model tier, a leaf
  `agent()` can run as a *registered specialist subagent type* — e.g. a language
  code-reviewer or TDD guide whose system prompt carries discipline the generic
  subagent lacks — via the `agentType` option. Launch-time exposure comes in two
  shapes: the STRUCTURED config envelope `args.agentTypes.<role>` (pr-review's
  `agentTypes.review` AND `agentTypes.verify` — symmetric, both probe-resolved at entry
  with graceful fallback — plus cross-model-verify's / independent-analysis's own
  `agentTypes.verify`), and the
  dev-workflow family's older bespoke `*Type` knob family: `implementerType`
  (dev-implement's green), `fixerType` (dev-review-fix's fixer), `reviewerType`
  (dev-review-fix's reviewers). Four rules:
  - **Default to the standard subagent (`null` → omit `agentType`).** The knob is a
    per-workflow input, never a baked-in default. **Never hard-code a private type
    (e.g. `magic-claude:*`) as a default** — it breaks every other consumer. The type
    must exist in the *consumer's* session registry; the runtime throws (listing the
    available types) on an unknown one, so validate *shape* only, not membership.
  - **It is flexibility, not a proven quality win.** In ONE internal reviewer A/B
    (2026-06-15 — single target repo, single specialist config, already-clean code)
    the specialist surfaced extra idiomatic findings at roughly one false positive per
    real finding, with no high-impact win. That is a single data point, not a
    constant: the thoroughness/noise trade varies with domain, prompt, and target —
    measure it on YOUR target before treating a specialist as an upgrade.
    Directionally, expect *more thorough AND noisier*; it is a knob the consumer opts
    into for their own agents, not a default upgrade.
  - **Exploit the verify synergy — specialize the producer, not the skeptic.** Route a
    specialist *reviewer/finder* into a composition that already *verifies* its output
    (the `adversarialVerification` Verify stage): the refute-first verifiers filter the
    specialist's extra false positives, so you keep the thoroughness without the noise
    reaching downstream. A refute-first *verifier* itself gains little from domain
    specialization.
  - **Cross-family routing: the composer PROPOSES — never silently applies, never
    silently skips.** When you are composing (or configuring the launch of) a workflow
    with verify/review roles, CHECK at authoring time whether a cross-family bridge is
    actually available on this machine (the `codex` plugin's `codex:codex-rescue`;
    `workflow-toolbox:opencode-verifier` — gate with `opencode providers list`, which
    shows auth without spending a run). If one is, SURFACE the option to the user as a
    per-role proposal with the real trade-off — genuine prior-decorrelation (the one
    lever a same-model panel lacks) vs. the external plan's cost/latency — and let them
    decide. The absolute default stays the standard Claude subagent. Rules of the
    proposal:
    - **The benefit is task-dependent — validate it empirically per workflow.**
      Cross-family decorrelation pays most on checkable/refutable claims (code reads,
      reproducible facts) and least on judgment/convention calls — and it always costs
      extra latency, setup complexity, and external-plan spend. If a claim set comes
      back with identical verdicts across families, the run bought latency, not
      quality. A cheap A/B (the same claims through the standard verifier and through
      the bridge — `cross-model-verify` runs this as-is) tells you what YOUR workflow
      actually gains before you make external routing standing config. The cost side
      lives on the consumer's external plan — pricing and limits only the user knows
      (they are not discoverable from the machine) — which is exactly why this is a
      PROPOSAL, never a silent default.
    - **Ask the plan tier — it is NOT discoverable.** `providers list` shows *auth*, not
      the plan (e.g. a provider's Lite vs Max tiers, Plus vs Pro). Small plan → propose
      external routing only on NARROW roles (a 1–3-vote verifier, a judge, a synthesis)
      and keep wide fan-out roles (`taskType`, `attemptType`, reviewer fans) on Claude;
      big plan / token pricing → wide roles become proposable. Existing width knobs
      (`votes`, `votesPerClaim`, `maxItems`, `sizing`) are the throttle — there is
      deliberately no toolkit-side concurrency limiter (one dated measurement, 2026-07-09,
      on one small plan tier: 16 concurrent calls all succeeded, the rate-limit wall
      absorbed by the CLI's own retry at a 5–8× latency cost; your tier's wall and
      latency multiplier WILL differ — re-measure on your plan; the bridge's hard ceiling
      is its 570 s CLI timeout).
    - **Decorrelate by FAMILY, per role-pair.** The value is a producer and its verifier
      on UNRELATED model families. Fixed families: `codex:codex-rescue` = GPT/OpenAI;
      the standard subagent = Claude/Anthropic. The opencode bridge's family is
      *configured, not fixed* — it runs whatever `OPENCODE_MODEL:` selects (default GLM
      5.2 / `zai-coding-plan`; discover with `opencode models`) — so state WHICH model
      the proposal assumes. Routing producer AND verifier to the SAME external family
      buys nothing.
    - **The user can PRE-DECIDE via config — then don't re-ask.** A standing
      `agentTypes.<role>` entry in the user's launch config / project instructions is
      the structured, deterministic pre-decision channel; respect it silently (the
      entry IS the decision). Availability still resolves at run time: every migrated
      workflow probes the requested type once (`probeAgentType`) and degrades to the
      standard subagent with the reason reported in the result's `probe` field.
    - **The probe validates AVAILABILITY, not per-call COMPLIANCE.** A bridge whose
      no-self-answer discipline lives only in prompt/skill text can be overridden by the
      routed task's own instructions — a verification prompt that says "READ these files
      to ground the verdict" invites the WRAPPER to answer directly, and the run then
      reports the wrapper's (same-family) verdicts as if they were external. Prefer
      bridges whose agent DEFINITION carries an output CONTRACT ("your final text may
      come from exactly these sources: gate marker / CLI stdout / CLI error — never your
      own knowledge") over a behavioral "do not inspect the repo". When the external
      verdict actually matters, verify compliance from the run's agent transcripts —
      the external CLI must appear as a real tool invocation (`tool_use` evidence), not
      just in the injected instructions. The toolbox runs this check automatically: the
      audit report (`wt:report`, and the plugin's Stop hook) carries an
      `## External delegation` section that scans each routed agent's transcript for
      real external-CLI `tool_use` and flags agents that show none, and the observe-ui
      agent panel shows the same signal live (« delegated → CLI seen ✓ / NO CLI call ⚠ »).
    - **Check plugin-agent availability on headless launches.** A raw headless-SDK
      launch does not load plugin agents unless the embedding passes them explicitly
      (the SDK `plugins` option) — a cross-family request in that path falls back to
      Claude. `wt-observe launch` closes this for its delegated runs: the launcher
      hands the server an agents-only plugin bundle (`plugin/launch-agents/`) to load
      into each delegated session, so plugin agentTypes resolve there — this needs a
      current launcher AND server; on an older pair the fences degrade gracefully to
      the Claude fallback. The probe makes either outcome safe and visible; when the
      user WANTS the external verdict, verify the launch path provides it (an
      in-session Workflow tool launch always does).
    - **Brief the bridge like any other agent — it gets NO ambient context by
      default, only what your prompt carries.** `codex:codex-rescue` is a thin
      forwarding wrapper (`tools: Bash` only, explicitly instructed not to inspect the
      repository itself) that shells out to the Codex companion runtime with your task
      text passed through near-verbatim — it does not read `CLAUDE.md`, the rules
      corpus, or the memory index, and neither the wrapper nor the companion script
      injects any of that on your behalf. `workflow-toolbox:opencode-verifier` is the
      same shape and already does this right: its own procedure inlines every
      referenced file's full content into the task before invoking the CLI, because a
      pointer the bridge "should go read" is unreliable (its own sandboxed CLI agent
      cannot always reach an arbitrary repo path). So the *same* `sourceRefs` /
      `context` / `assumptions` channel this reference already tells you to use for
      any `agent()` call is the one and only lever here too — there is no
      codex/opencode-specific injection mechanism to reach for beyond it.
      **Resolve the decorrelation-vs-context tension at the CONTENT level, not the
      routing level:** forward the narrow, task-load-bearing facts the bridge cannot
      do the job without (the specific files/diff under review, the specific
      invariant or spec the task must satisfy) — the exact "factual sub-question"
      material this reference already tells you to ground via `sourceRefs` for any
      agent. Do NOT bulk-forward the ambient project frame (the full `CLAUDE.md`,
      the rules corpus, the memory index) — that re-correlates the bridge's judgment
      with the launching session's own priors and erases the reason to route there
      in the first place. A repo-root `AGENTS.md` that the external `codex` CLI would
      discover natively (independent of any per-call prompt, the same way it reads
      `CLAUDE.md`) is a separate, so-far-undecided lever — no such file exists in this
      repo today, and deciding how much of the ambient frame it should mirror is a
      standing scope call, not something a single call's brief resolves.
    - **`opencode-verifier` LISTS paths instead of inlining whenever opencode can
      reach them — prefer the `OPENCODE_WORKDIR` redirect (no config needed).** The
      inlining described just above is the PORTABLE fallback (the wrapper reads each
      file and pastes its content, so opencode never has to reach a repo path). But
      opencode reads any file UNDER its working directory NATIVELY, with NO permission
      config — so the wrapper prefers to LIST a path (relative) and let opencode read it
      whenever it can. Three ways, in order of preference:
      - **`OPENCODE_WORKDIR: <absolute path>` (recommended).** Pass this line through the
        SAME trusted channel as `OPENCODE_MODEL:` (`hints` for
        `docs-audit`/`coverage-audit`, a `sourceRefs` entry for `cross-model-verify`);
        the wrapper `cd`s into that directory before running opencode, so files under it
        are listed RELATIVE and read natively — this divides the wrapper's token cost and
        shrinks the task file with ZERO opencode config. A git WORKTREE path works too
        (opencode reads the worktree as its project root) — this closes the old "the
        bridge can't reach an isolated worktree" gap. For the audits set it to the
        `repoRoot` you already pass; for `cross-model-verify`, the repo under review.
      - **AUTO (no signal).** With NO `OPENCODE_WORKDIR`, any referenced file already
        under the wrapper's own `$PWD` is listed relative automatically — no line needed.
        (An explicit `OPENCODE_WORKDIR` SUPERSEDES `$PWD` as the SOLE effective directory,
        so AUTO applies only when no workdir is given.) In Path B the wrapper's `$PWD` is
        the server's cwd, usually NOT the audited repo, which is exactly why
        `OPENCODE_WORKDIR` exists.
      - **`OPENCODE_DIRECT_READS: yes` (secondary, config-dependent).** Only for files
        not covered by one working directory AND when the user's `opencode` config grants
        `permission.external_directory` for them — a per-project
        `~/.config/opencode/opencode.jsonc` with e.g.
        `permission: { external_directory: { "*": "ask", "/abs/repo/**": "allow" } }`
        (⚠ the LAST matching rule wins, so the `"*"` catch-all must come FIRST or it
        overrides the allow). Then the wrapper lists ABSOLUTE paths. Prefer
        `OPENCODE_WORKDIR` (no config) over this whenever possible.
      All three are safe by construction: if opencode is refused a listed read (an
      `external_directory … auto-rejecting` line in its output), the wrapper falls back
      ONCE to full inlining for that call, so a machine without the setup simply runs the
      portable default. Nothing beyond the sub-`$PWD` AUTO case is ever automatic — pass
      the line to opt in.
- **`agentType` is ALSO a capability FENCE — and capability denial beats instruction.** A
  leaf `agent()` receives the FULL ambient context as injected TEXT (every rule + the memory
  index + the skill listing — verified), so a leaf that HAS `Write`/`Edit`/`Bash`/an MCP can
  act on a rule it merely *read* ("save memory after every task", "auto-commit when green")
  and mutate your memory, the board, or the repo when you wanted a read-only pass. Guard by
  REMOVING the capability, not by instructing it away:
  - **Capability first.** Define a registered agentType `.md` whose frontmatter withholds
    exactly what the leaf must not do — `tools` (allowlist) / `disallowedTools` (denylist) /
    `skills`: no `Write`/`Edit` → can't touch memory files; no `Bash` → can't `git commit`;
    no board MCP → can't move cards; omit the save-memory skill → can't run it. A tool the
    leaf lacks cannot be misused — a mechanical guarantee an instruction is not.
  - **Instruction is only the backstop, for what you can't cleanly deny.** `Bash` is the
    escape hatch (an agent that needs it can still commit / write / curl, and you can't drop
    git without dropping Bash) — THERE, add an explicit non-goals line to the agentType's own
    prompt ("do NOT commit, push, write memory, or modify the board"). Instruction ALONE, on
    a capable leaf that also has "auto-commit" in its injected context, is the unreliable case.
  - **Harness vs SDK.** On the Workflow-tool (`agent()`) path this frontmatter fence is the
    ONLY capability lever — no per-call `tools`, and the ambient text can't be shed. On the SDK
    path we own `query()`, so `settingSources: []` sheds the ambient rules text too and
    `@workflow-toolbox/smoke`'s `leastPrivilegeOptions()` bakes the safe defaults (no
    tools/skills/mcp/ambient, `strictMcpConfig` on) — proven by `pnpm canary:agents`.
  - **The inter-agent messaging channel is part of what the fence controls.** When a workflow
    runs inside an interactive session, the harness may give each leaf agent a session-level
    messaging tool (e.g. `SendMessage`) AND advertise the session's addressable agents to it —
    so a default-type leaf has an OUTBOUND channel to the launching conversation and to any
    named live agent, and under-specified prompts have been observed using it spontaneously
    (e.g. asking the main conversation for missing context). Verified control facts:
    - The advertisement FOLLOWS the capability: an agentType whose `tools:` allowlist omits the
      messaging tool gets neither the tool NOR the teammates advertisement — denying the
      capability removes the knowledge with it. This is the one clean off-switch.
    - Sibling agents within the same run are NOT addressable by their `label` — there is no
      practicable intra-run lateral channel; anything cross-agent must relay through the
      launching conversation.
    - Headless-launched runs (a server/SDK session) still carry the messaging tool but have no
      session teammates to address — no leakage into other sessions by construction.
    - Consequence for briefs: a read-only or fixture leaf should run under a fenced agentType
      (no messaging tool) rather than being instructed not to message; for capable leaves,
      remember their output channel is not limited to their return value.
  - **The agentType registry is read at session start.** An agent `.md` added mid-session is
    not visible to `agent({agentType})` until a fresh session; the runtime errors listing the
    available types, so the failure is loud, not silent.
  - **The toolkit ships this fence as the DEFAULT — `withLeafFence`, from
    `@workflow-toolbox/patterns`.** Call it ONCE, as the very FIRST line of `run()`, before any
    other `withAgentDefaults` wrap:
    ```ts
    run: async (rt0, input) => {
      const { rt, report: leafFence } = await withLeafFence(rt0, { phase: 'Fence' })
      // ... use `rt` for every agent()/pattern call below; optionally return `leafFence`
    }
    ```
    It probes the toolkit's own `workflow-toolbox:leaf` agentType (`disallowedTools:
    SendMessage`, ships as `plugin/agents/leaf.md`) via `probeAgentType` and applies it as the
    LOWEST-priority `withAgentDefaults` default — an explicit per-role `<role>Type` (e.g.
    `verifierType`) or an outer blanket `perAgent.agentType` still wins on conflict, and an
    environment where the agentType isn't registered (plugin not installed) degrades
    gracefully to the standard subagent, exactly like every other `probeAgentType` consumer.
    The returned `report` (`LeafFenceReport`; mirrored by `withLeanRouting`'s
    `LeanRoutingReport`) carries `resolvedAgentType` — null when routing was disabled or
    the probe found the type unavailable and the run degraded — plus the raw probe
    outcome: surface it in the workflow's result rather than assuming the fence held
    (degradation is fail-open by design, the report is what keeps it loud). Both wrappers
    also accept `agentType` (probe a differently-named minimal type, e.g. a private
    plugin's own) and `perAgent` (so their internal probe call respects the workflow's
    blanket model/effort defaults).
    Pass `{ disabled: true }` only when a workflow genuinely needs its leaves to coordinate —
    thread it from a launch-time `messaging: true` arg via the shared `parseConfig` (a
    recognized top-level slice, parsed to `WorkflowConfig.messaging`) so a LAUNCHER, not just
    the author, can opt out per run. `workflow-toolbox scaffold` wires this in by default for
    every new workflow; `pr-review` and `independent-analysis` are retrofitted as the
    reference examples — the remaining bundled `toolkit/examples/*.workflow.ts` compositions
    have not been retrofitted yet (adopt the same one-line wrap when you touch them).
  - **Ambient-context cost is a SEPARATE axis from capability — `lean` addresses it, `leaf`
    doesn't.** Every agent a toolkit workflow spawns is injected with the FULL ambient
    context of the launching session (every rule, the memory index, the whole skill/MCP
    tool listing) as text on every single spawn, paid as a cache-write per agent — even a
    `leaf`-fenced agent still pays this, since `disallowedTools` only removes SendMessage,
    not the rest of the injected text. A role whose entire task is inline in its prompt (it
    never reads a file, runs a command, or calls any tool) gains nothing from that
    injection; it only pays for it.
- **Which agentType for which role — standard / leaf / lean / cross-family verifier.**
  - **Standard subagent (no `agentType`)** — the default. Use for any role that genuinely
    needs tools (reading the repo, running git, calling an MCP) or inter-agent messaging.
    Most reviewer/verifier roles that re-derive findings from the actual diff belong here
    (or on `leaf`, below) — NOT on `lean`.
  - **`workflow-toolbox:leaf`** (`disallowedTools: SendMessage`) — the toolkit's blanket
    default fence (`withLeafFence`, above). Denies SendMessage only; keeps every other
    tool. Applied to EVERY agent a workflow spawns, unconditionally, unless a role
    overrides it or the run opts out via `messaging: true`. When wiring the name by hand,
    import the `LEAF_AGENT_TYPE` / `LEAN_AGENT_TYPE` constants from
    `@workflow-toolbox/patterns` instead of retyping the strings.
  - **`workflow-toolbox:lean`** (empty `tools` allowlist + `disallowedTools: SendMessage`,
    ships as `plugin/agents/lean.md`) — a minimal-ambient-context agentType for provably
    PURE-REASONING roles: classify / vote / judge / score / dedup / synthesize calls whose
    entire task content already arrives inline in the prompt. Route via `withLeanRouting`
    from `@workflow-toolbox/patterns` (mirrors `withLeafFence`'s exact probe/graceful-
    fallback mechanics — `probeAgentType` once, degrade loudly to the wrapped runtime's own
    default if unavailable). **Unlike `withLeafFence`, this is SELECTIVE, not blanket**: call
    it once to obtain a separate lean-defaulting runtime, then route ONLY the call sites you
    have verified are pure through it — every other call keeps using the workflow's normal
    (tool-capable) runtime. Purity is a per-CALL-SITE judgment, not a per-pattern one: the
    same pattern (e.g. `adversarialVerification`) can be pure in one composition and impure
    in another, because purity depends on what the caller's `renderClaim`/prompt actually
    asks the agent to do. **Never route a call whose prompt contains an "inspect the repo" /
    "read the diff" / "run git" instruction** — that call needs real tool access and would
    silently break if fenced to zero tools. `pr-review`'s Synthesize stage is the reference
    example: its prompt is 100% inline (the change summary + a JSON-stringified findings
    array), so it is the one stage in that composition routed to `lean`; Classify, Review,
    and Verify all explicitly instruct their agents to re-derive from the actual diff
    (the fresh-evidence defence), so they stay on `leaf`/standard instead.
  - **Probing a LOCAL agentType directly? Pass the LOCAL probe prompt.** `probeAgentType`'s
    DEFAULT prompt is written for external-CLI bridges — it demands "run the task through
    your external CLI — do NOT answer from your own knowledge", which a bridge must honor
    end-to-end (the anti-shortcut defence: a wrapper that self-answers the probe would turn
    it into a false positive). A locally-registered type must do the OPPOSITE: a tool-less
    `lean` agent honestly refuses that instruction, so under the bridge prompt the probe
    reads a perfectly available type as unavailable. `withLeafFence` and `withLeanRouting`
    already pass the right prompt internally; if you call `probeAgentType` yourself for a
    locally-registered type (e.g. your own fenced `.md`), pass
    `{ probePrompt: LOCAL_AGENT_PROBE_PROMPT }` (exported by `@workflow-toolbox/patterns`)
    and keep the default only for external bridges.
  - **Cross-family verifier** (`codex:codex-rescue`, `workflow-toolbox:opencode-verifier`) —
    opt-in decorrelation for a review/verify role, covered in its own bullets above. Not a
    default; a per-workflow proposal.
- **When to define an `.md` vs inline the prompt.** Inline when the leaf is a generic worker
  the default subagent's capabilities already fit. Define a registered agentType `.md` when you
  need a capability fence (above), reusable discipline across workflows, or a specific
  model/effort/skills preload the frontmatter carries that a per-call prompt can't. Generate a
  starting fence with `workflow-toolbox scaffold agent <spec.json>` — it emits the frontmatter
  (tools/disallowedTools/skills/model/effort) + a "Do NOT …" non-goals backstop from a
  capability spec, so you don't hand-write it.

