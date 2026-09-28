---
name: second-opinion
description: >
  Get one independent, read-only second opinion from another model family for
  difficult, ambiguous, high-risk, or stuck coding and reasoning problems.
  Uses GPT-6 Astra when GPT-lane consent and its runtime are available;
  otherwise it refuses and the second opinion is to be asked of the user,
  never a same-family Claude consult. The main session keeps the task, edits,
  verification, and final decision.
when_to_use: >
  Use for a difficult, ambiguous, high-risk, or stuck question that needs one
  independent challenge from outside the session's own model family. Force
  Opus only when the user explicitly asks for a Claude Opus consult.
---

# Second opinion

Use this skill for a non-obvious failure, contradictory evidence, a consequential
architecture choice, repeated failed attempts, or an explicit request for an
independent challenge. Do not use it for routine edits or as an implementation
lane. Make exactly one advisor call for the question; consult again only when new
evidence changes the question.

A second opinion is worth asking for because it does not share the session's
blind spots: a model of the same family tends to continue the reasoning it is
shown and to leave the same routes unexplored. Ask the advisor to counter that
bias and to name the routes nobody tried. When no consented external lane is
available, the second opinion is the user: put the question to them instead.

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
cross-system behavior, or an expensive-to-reverse decision. Expect `--effort`
to drive the Astra route only: the Opus route always runs at `xhigh`, whatever
effort you pass.

Choose `auto` by default: it runs GPT-6 Astra when GPT-lane consent and the
Codex runtime are available. Without consent, `auto` refuses with `EXIT=1`,
never falls back to a Claude model, and names the remedy
(`wt-lane-consent --on`); ask the user for the second opinion instead. Choose `astra` to require
Astra explicitly. Choose `opus` only when the user explicitly asks for a Claude
Opus consult; the CLI starts a fresh SDK context for it, and it does not
decorrelate the session's own model-family biases.

## Launch detached

Run from the repository the question concerns. Use absolute paths for the
request and output files.

```bash
setsid nohup node "${CLAUDE_PLUGIN_ROOT}/bin/wt-second-opinion.mjs" \
  --request <request-file> --out <out-file> --effort <low|medium|high> \
  --route <auto|astra|opus> \
  --repo <repository> >/dev/null 2>&1 < /dev/null &
```

On Windows, launch the same `node` command with `Start-Process` instead of
`setsid nohup`; the CLI itself owns the output file and completion marker.

Poll the output file until its final line is `EXIT=<code>`. Read the **whole
file**, never only the final line: the first line identifies the selected route
(`ROUTE=gpt-astra` or `ROUTE=claude-opus`), the body is the complete answer or
refusal, and the last line is completion status. A refusal names the unavailable
lane, runtime or quota condition and its remedy; never bypass it by silently
choosing another model. A refusal of `auto` for lack of lane consent means the
second opinion is the user's to give.

Treat the answer as evidence, not a verdict. Check material claims against the
repository and primary sources, resolve disagreement with a new observation,
and retain the final decision in the main session.
