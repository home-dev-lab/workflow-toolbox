---
name: second-opinion
description: >
  Get one independent, read-only second opinion for difficult, ambiguous,
  high-risk, or stuck coding and reasoning problems. Automatically uses GPT-6
  Astra when GPT-lane consent and its runtime are available, otherwise Claude
  Fable when its scoped quota permits. The main session keeps the task, edits,
  verification, and final decision.
when_to_use: >
  Use for a difficult, ambiguous, high-risk, or stuck question that needs one
  independent challenge. Force Fable when the session is not on Fable and the
  question is ours to arbitrate, such as grounding a card or confirming a
  verdict. Force Astra when a decorrelated model family is wanted.
---

# Second opinion

Use this skill for a non-obvious failure, contradictory evidence, a consequential
architecture choice, repeated failed attempts, or an explicit request for an
independent challenge. Do not use it for routine edits or as an implementation
lane. Make exactly one advisor call for the question; consult again only when new
evidence changes the question.

The advisor is read-only. The main session remains responsible for all file
changes, commands, tests, and decisions. Never route this consultation through a
Claude sub-agent: invoke the CLI directly.

## Prepare the request

Write a focused request file containing:

- the precise questions to answer, phrased without a preferred conclusion;
- all relevant facts and raw observations, including exact numbers, units,
  timestamps, errors, paths, configuration values, and command output;
- the source of each fact and what that source or instrument can and cannot show;
- contradictory observations, actions already taken and their observed results;
- unknowns that the advisor must not silently fill with assumptions;
- a request to rank explanations, identify counterexamples and hidden
  assumptions, state uncertainty, and name what it could not verify.

Keep your current hypothesis out of the evidence. If it must be tested, label it
separately as one candidate among alternatives and ask the advisor to attack it.

Choose effort once: `low` for a scoped challenge or review, `medium` for an
unclear cause or real trade-off, and `high` for failed attempts, subtle
cross-system behavior, or an expensive-to-reverse decision.

Choose `auto` to preserve consent-based routing. Choose `fable` only when the
session is not on Fable and the question is ours to arbitrate, such as grounding
a card or confirming a verdict. Choose `astra` when a decorrelated model family
is wanted.

## Launch detached

Run from the repository the question concerns. Use absolute paths for the
request and output files.

```bash
setsid nohup node "${CLAUDE_PLUGIN_ROOT}/bin/wt-second-opinion.mjs" \
  --request <request-file> --out <out-file> --effort <low|medium|high> \
  --route <auto|astra|fable> \
  --repo <repository> >/dev/null 2>&1 < /dev/null &
```

On Windows, launch the same `node` command with `Start-Process` instead of
`setsid nohup`; the CLI itself owns the output file and completion marker.

Poll the output file until its final line is `EXIT=<code>`. Read the **whole
file**, never only the final line: the first line identifies the selected route
(`ROUTE=gpt-astra` or `ROUTE=claude-fable`), the body is the complete answer or
refusal, and the last line is completion status. A refusal names the unavailable
runtime or quota condition and its remedy; never bypass it by silently choosing
another model.

Treat the answer as evidence, not a verdict. Check material claims against the
repository and primary sources, resolve disagreement with a new observation,
and retain the final decision in the main session.
