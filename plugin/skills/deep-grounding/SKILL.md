---
name: deep-grounding
description: >-
  Run a deep-grounding pass BEFORE asserting or analyzing — do not answer from
  priors on the first source or angle that comes to mind. Ask "where could the
  evidence for this be?", gather the relevant available sources (project memory,
  READMEs/docs, the actual code/config, tests, logs/telemetry, tickets, git
  history, the web — whatever fits the question), and follow the leads they
  reveal RECURSIVELY, even low-odds ones, until the trail runs dry; THEN reason,
  grounded, tagging each conclusion with its evidence tier and stating what could
  not be verified. Use this PROACTIVELY whenever you are about to assert a
  checkable claim, start a non-trivial analysis / design / diagnosis /
  recommendation, or answer from "what you already know" — ESPECIALLY when you
  notice yourself reaching for a conclusion from a single source or a single
  angle. This is the collect-and-verify-evidence-first reflex; it is the cheapest
  correction for a wrong prior, because evidence (not more reasoning) is what
  escapes priors.
---

# deep-grounding

A standing reflex to counter the driving model's deepest single-context failure mode:
**asserting from priors on the first source or angle that comes to mind**, instead of
first going to find out. Reasoning harder does not escape a wrong prior — reading the
real source does. So before you commit, you ground.

This is the complement of `independent-analysis`: that one diversifies the **framing**
(many lenses on one subject); this one diversifies the **evidence** (many sources
grounding one analysis) — *verify before you assume, in breadth and in depth.*

## The reflex (what it instills)

Before a non-trivial analysis, or before asserting a checkable claim, run a grounding
pass FIRST — do not answer yet:

1. **Ask "where could the evidence for this be?"** Generate the candidate sources from
   the question itself, open-endedly. There is **no fixed checklist** — the right
   sources depend entirely on what you are after. (Kinds you might generate, never a
   required menu: project memory, READMEs / design docs, the actual code & config,
   tests, logs & telemetry — Loki/Grafana/CI, tickets/Confluence, git history, the web.
   Pick what fits THIS question; invent kinds the list doesn't name.)
2. **Explore them.** Read or query the relevant, available ones — in parallel where you
   can.
3. **Follow the leads they reveal — recursively, at a LOW threshold.** When a source
   points to another that *could plausibly* bear on what you're after, follow it — **even
   when the odds it adds anything are low**. Sources point to sources; chase the trail
   rather than pruning it because a lead "probably won't help."
4. **Stay bounded so the crawl converges.** Gate every new lead on **relevance to the
   actual question** (an off-topic lead is still pruned — "low threshold" lowers the
   *payoff-odds* bar, never the *relevance* bar); **dedup** against a growing `seen` set;
   stop at a sensible depth / effort budget; and **log what you chose not to chase**
   rather than dropping it silently.
5. **Loop until dry — and treat every contradiction or surprise as a NEW thread, not an
   endpoint.** Keep going until no new relevant source surfaces *and* no unresolved
   discrepancy remains worth chasing. A disagreement between sources, or a result that
   surprises you, is **not** a finding to report flatly — it is a fresh "*why?*"
   sub-question that **re-enters the crawl** (same relevance-gate, dedup, and budget
   bound). Dig into the root cause — an override? a stale doc? a different code path?
   config drift? a measurement artefact? — until that trail too runs dry.
6. **Only THEN report — as your grounded conclusion, not raw observations.** When the
   whole tree (the original question *and* every "why?" thread it spawned) is exhausted —
   or you've hit the depth/budget bound — state what you conclude ("what you assume",
   having chased the evidence as far as it goes), tag each conclusion with its **evidence
   tier** (below), and **name the residual unknowns**: what you could not verify, and any
   thread you stopped chasing because the bound cut it (be honest about
   cap-vs-true-exhaustion).

## Evidence tiers — corroborated ≠ verified

Not all sources are equal proof. Keep three things distinct, and never launder the
weaker as the stronger:

- **Verified** — a ground-truth / observational source *directly bears* on the claim:
  you ran the code, queried the real telemetry, executed the test. This is proof.
- **Corroborated** — multiple *assertions* agree (docs, web, runbooks). At best "several
  sources say so" — not proof, especially if they may share an upstream origin.
- **Single-tier / single-source agreement** — weakest; flag it as such.

When sources **disagree**, do not average it away — and do not stop at reporting the
discrepancy either. A contradiction is a **trigger to dig deeper**: chase *why* they
disagree (an override, a stale doc, a different code path, config drift, a measurement
artefact), gathering evidence on the root cause until that trail runs dry, and only then
report your grounded conclusion (step 5). The unexplained discrepancy is a half-finding;
the explained one is the finding. And note that heterogeneous sources are often
**incommensurable** — "documented intent" vs "implemented value" vs "observed behaviour"
can all share a number and still describe a broken system; agreement on a token is not
agreement on a proposition.

## When to reach for it

- You are about to **assert a checkable claim** or commit to a conclusion.
- Starting a **non-trivial analysis, design, diagnosis, or recommendation**.
- You catch yourself **answering from "what you know"** on a single source / single angle.
- Before a **high-stakes / irreversible / outward-facing** statement.

**When NOT to:** a trivial lookup you confirm in one read; work you *just* grounded
(you already read the sources this turn); pure preference/opinion with no checkable
surface. The reflex is for "could this be wrong, and is the truth findable?", not for
everything.

## Honest scope & limits

- **Grounding is the one real decorrelation lever.** More reasoning re-derives the same
  priors; reading the real source is what corrects them. That is the entire reason this
  reflex exists.
- **Relevance-gate + bound, or it runs away.** Aggressive lead-following without the
  relevance gate and a depth/budget cap crawls into the whole universe and never
  converges. The hard skill is the per-lead judgment "does this plausibly relate to what
  I'm after, even at low odds?" — make that judgment explicitly at each source.
- **Source independence is not guaranteed.** N sources echoing one upstream (a doc
  auto-generated from the code; a web result quoting the same origin) manufacture *false*
  consensus. Cross-tier agreement (telemetry + code + doc) is stronger than within-tier;
  surface the tier-spread of your support, don't just count heads.
- **It grounds; you still judge.** It improves *what your conclusion is built on*; it does
  not make the conclusion correct by itself. You remain the arbiter.

## Scaling up: inline → parallel background subagents → (rarely) teams

For a handful of sources, run the reflex **inline** — just do it. You have the full
toolset, so *acquire* each source by whatever it takes: read a file, fetch a URL, call an
MCP server (Jira / Confluence / Loki / Gmail / …), or **run a shell / node script** to
produce it. Don't restrict yourself to "read" — get the evidence by any means.

When breadth grows — many sources, or sources that must be read **in isolation** so one
can't contaminate another's extraction — escalate by **fanning out parallel subagents**:
one reader per source, each blind to the others, each returning a distilled
`{ answer, quote, locator, tier }`; you (the lead) reconcile and synthesize. This keeps
source bodies out of your context and is the pattern the Claude Code docs themselves cite
("a reviewer subagent that dispatches a verifier per finding"). **Tier the models** — a
cheap model (`haiku`) for the mechanical per-source extraction, the strong model
(inherit / `opus`) for conflict-detection and final synthesis — set `model` per subagent
(per-invocation `model`, or the subagent definition's `model:` frontmatter). A subagent
can itself fan out further; background spawning is capped at 5 levels deep.

**Run them in parallel, in the background — the mechanic (do not get this wrong).** To
actually run N readers concurrently, emit **all N `Agent` (Task) tool calls in ONE
message** — a single assistant turn carrying N tool-use blocks. They launch together in the
background and you collect each result as it notifies. The recurring failure is to *say*
"in parallel" but emit one call, await its result, then emit the next — that is **sequential**,
not parallel. The rule: if the calls are independent (and blind per-source extraction always
is — one source's read never depends on another's output), they belong in the **same**
message; never emit-await-emit. Only chain across messages when a later read genuinely needs
an earlier one's result.

**Subagents vs. agent teams — decide on one axis: do the workers need to talk to each
other?**

- **Independent reads, reconcile-at-the-end → parallel subagents.** The grounding default.
  Extraction is embarrassingly parallel, isolation is a *feature* (blind readers can't
  contaminate each other), and everything reports to one reconciler. Cheaper, simpler.
- **Workers must challenge / hand off findings mid-investigation → agent teams.** Only when
  direct teammate-to-teammate dialogue genuinely converges faster (e.g. competing-hypothesis
  diagnosis). Teams cost significantly more tokens, add coordination overhead, are
  experimental / opt-in — and their direct-communication model **undermines the
  blind-extraction isolation grounding relies on**. So for pure evidence-gathering, prefer
  subagents; reach for teams only when the investigation is a genuine multi-party debate.

**Is agent teams even available? — don't trust tool-presence; surface it to the user.**
Teams is experimental and **disabled by default**, enabled only by setting
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `settings.json` (`env`) or the environment
(Claude Code ≥ 2.1.32; takes effect on a new session). Do **not** infer availability from
whether `TeamCreate`/`SendMessage` appear in your tool set — that is **not** a reliable
signal: the tools can be listed regardless of the flag, and the official docs make no
guarantee either way. A skill can't run a probe to detect it (it can't execute code), and
you shouldn't gratuitously call `TeamCreate` just to test (it has side effects). The robust
path is **on-demand**: when the work genuinely needs the teams rung, *propose it to the
user* with the concrete enable step (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in
settings.json `env`, new session) and let the real attempt be the test — if you try a team
operation while the feature is off, it fails, and you relay that as an actionable "enable
the flag to use this" rather than having guessed up front.

Two facts from the official docs that constrain the "dedicated agent" idea: (1) a subagent
definition's **`skills:` and `mcpServers:` fields are NOT applied when it runs as a
teammate** — a teammate uses only the definition's `tools` + `model` + body, and loads
skills from project/user settings like a normal session; so you cannot "preload a skill
into a teammate" via frontmatter. (2) `SendMessage` and the task-management tools are
**always available to a teammate** even when its `tools` allowlist restricts everything
else. Net: building a teams orchestrator is a real but separate piece of work; deciding
*whether* to reach for teams is this main-loop skill's job, done by proposing it to the
user, not by detecting it.

A compiled **workflow** engine for this (deterministic dedup / triangulation across a large
source set, with a machine-readable audit trail) was prototyped and **deliberately dropped**:
for the interactive grounding this skill serves, parallel background subagents cover the same
fan-out with the full toolset and per-agent model tiering, at lower token cost and without the
build-and-maintain overhead. Background subagents are the ceiling here — there is no engine to
reach for.
