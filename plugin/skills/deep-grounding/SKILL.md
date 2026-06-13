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

## Scaling up (the engine)

For a handful of sources, run this reflex **inline** — just do it. When breadth is large
(many files/areas/sources to read, sources that must be read in isolation so one can't
contaminate another's extraction, or contradictions worth tabulating deterministically),
escalate to the **`deep-grounding` workflow** — the same recursive crawl fanned out across
fresh per-source agents, keeping the source bodies out of your context and deduping /
triangulating in deterministic code. *(Workflow engine: build pending — see
`docs/internal/source-triangulator-design.md`.)*
