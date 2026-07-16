# Premise quality — what you feed your agents caps what they can return

A workflow's leaf agents are only as good as the brief you hand them. Every `agent()`
call runs a fresh-context model against the exact prompt, `context`, `assumptions`,
and `sourceRefs` you wrote — nothing more. A weak premise cannot be rescued by more
agents, more votes, or a stronger verifier: **premise quality caps the result**
(garbage in, garbage out). The single prompt you author is a single-pass, possibly
biased act that every blind agent inherits at once. This reference is the discipline
that keeps that ceiling high.

Read it when you are writing the prompts, schemas, or `sourceRefs` for any fan-out —
especially an analysis, audit, verification, or decision workflow, where a plausible
wrong answer is worse than none.

## Ground factual sub-questions in real sources — and hand over COMPLETE listings

An agent that READS the source is not the same as an agent guessing from priors. For
any factual or checkable sub-question, pass the real files through `sourceRefs` (or
instruct the agent to look them up) and tell it to cite specifics. Never let an agent
answer a factual question from priors — that just launders your own guess through a
fresh context and hands it back looking verified.

The source LIST is itself a premise, and the most common way a coverage task quietly
fails. For enumeration or coverage work, give the **complete listing** of the relevant
directories or source families and let the agents pick within them — never a
hand-picked subset. A curated list transfers your blind spot verbatim: real items get
missed for the sole reason that the file documenting them was not in the list you
provided. When you catch yourself selecting "the relevant files", stop and pass the
whole directory instead.

## Ask open questions, framed neutrally

- **Open enumeration, not a closed menu.** Ask "enumerate ALL the mechanisms X
  supports" rather than "pick among these three". A closed menu hands every agent your
  own blind spot; an open one lets them find the option you did not list.
- **Neutral framing.** Ask "what breaks X?" not "is X sound?". A leading prompt biases
  every agent in the fan-out identically, so the fan-out's apparent agreement measures
  your framing, not the truth.

## Make "I could not verify this" a first-class, routable outcome

Require every agent to **state what it could not verify**. A hollow pass on an
under-specified prompt is otherwise invisible — it looks exactly like a real one.

Then give the agent a *named* way to say it. Do not force a binary verdict: put an
explicit "could-not-verify" branch in the result `schema` — a status enum value, not
an overloaded confidence number — that the orchestrator routes on downstream (re-ask
with more evidence, escalate, or drop with the gap recorded). An agent with no honest
out capitulates to a plausible guess to satisfy the schema, and that guess then
propagates as if it were grounded. A named out turns "unknown" into an actionable
signal instead of a coerced yes/no.

## Inject knowledge through the prompt — it does not arrive ambiently

A workflow subagent is blind to the conversation, and a delegated run additionally
strips the ambient project context to save cost, so the agent does **not**
automatically inherit your rules, memory, or the conventions you take for granted. The
only reliable channel is what you put in the prompt: the task brief, `context`,
`assumptions`, and `sourceRefs`. If a convention, invariant, or gotcha is load-bearing
for the agent's correctness, **write it into the prompt or pass the file** — never
assume the agent "already knows" it.

## Failure modes that silently degrade agent output

These are environment-independent and bite every fan-out. Defend against each by
construction, not by hoping.

1. **Bound every structured-output field.** An agent emitting a long free-text field
   can run into the model's hard output-token ceiling and die mid-emission — a fatal,
   unrecoverable truncation, not an error the orchestrator can catch. Put `maxLength`
   on every prose field and `maxItems` on every array in a result `schema`, plus a
   `minLength` so a one-word capitulation does not validate. Bounds convert a fatal
   runaway into an actionable "too long" rejection that the model simply retries
   shorter. Order the fields short/required-first in your `Return {…}` template, too:
   generation order, not schema order, decides which field starves when the budget
   runs low, so a long field generated first can starve a required sibling into a
   "missing property" rejection. (Resumable runs: bound only the FINAL schema —
   editing a schema shared with earlier cached calls invalidates the `resumeFromRunId`
   cache prefix.)

2. **Give bridged or cross-family agentTypes a stall budget that matches their
   latency.** An external or CLI-bridged `agentType` streams on a different cadence
   than a native subagent; if its `stallMs` is tighter than the bridge's real
   think-time, the runtime reaps it mid-work and the result is lost silently. Size the
   stall budget to the bridge's observed cadence, not the default tuned for a local
   model.

3. **Refute-first, and watch the refutation rate.** A verifier stage must default to
   *refuted unless the evidence survives*, and re-derive each claim from the actual
   source — never from the producer's own summary (a mid-reasoning death arrives as a
   normal-looking completion). Then treat the **refutation rate as a health metric**:
   a panel that confirms everything, every time, is measuring agreement, not
   correctness. If your verifiers never overturn a finding, the stage is theatre — fix
   the framing (see neutral framing above) or drop it.

## Why premises matter more than agent count

Adding agents diversifies *framing*, not *priors*. On a reasoning error rooted in the
model's training, every agent in a same-model fan-out misses it in lockstep, and a
clean "no issues" panel just measures shared agreement. The only real decorrelation is
**external evidence** — agents that read real sources — or a **genuinely different
model family** as the verifier (a different family for *diversity*, not a stronger tier
for strength). Reasoning harder does not escape shared priors; evidence does. That is
the whole reason this reference is about what you *feed* the agents, not how many you
spawn.

See `references/model-and-agent-routing.md` for model/effort/agentType routing and the
cross-family verifier protocol, and `references/patterns.md` for the refute-first
verification and fan-out-then-synthesize shapes these principles apply to.
