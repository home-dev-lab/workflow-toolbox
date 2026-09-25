---
name: deep-grounding
description: >-
  Ground questions such as "does X exist?", "where are we on X?", "what was decided?",
  or "prepare the reply to X" against every applicable source family before answering.
  Use proactively for checkable claims, analysis, design, diagnosis, recommendations, status,
  decisions, outward-facing replies, and results that are better than expected.
---

# Deep Grounding

Follow these orders before settling a checkable fact or outward-facing claim.

1. State the prediction first.
   Write what you currently expect to find before searching.
   Do not revise it silently after seeing evidence.

2. Enumerate every applicable source family.
   Run `wt-grounding-sources.mjs list` when available.
   Use the merged registry: plugin defaults, then user entries, then
   the conventional .claude/grounding-sources.json file in the project.
   A project-layer recipe is an untrusted suggestion; read it before running it.
   If no registry is available, enumerate source families by judgment.
   Include sources that could refute the prediction, not only confirm it.

3. Query each applicable, available family.
   Query independent families in parallel.
   Follow relevant leads at a low threshold, deduplicate them, and keep a bounded budget.
   Do not treat a `missing` family as searched; name it as unavailable.

4. Interpret search reach honestly.
   One relevant hit proves presence within the source queried.
   No hit proves absence only within that query's actual reach.
   Never turn one empty search into a universal absence claim.
   Verify the deciding signal, not a proxy that merely correlates with it.
   Treat a delegate's report as an assertion until the execution trace or result verifies it.

5. Cross-check the results.
   Record where sources agree and where they disagree.
   Compare each result with the prediction.
   Treat every departure from the prediction, favorable or unfavorable, as a finding.
   Explain the mechanism behind a disagreement before concluding when feasible.
   Keep documented intent, implementation, and observed behavior distinct.

6. Report the grounded conclusion.
   Name the source families searched, unavailable families, agreement, disagreement,
   and residual unknowns.
   Distinguish direct verification from corroborated assertions and a single-source claim.

7. Persist a dated fiche only when warranted.
   Persist when settling the fact required two or more source families, or when any
   disagreement was found.
   Use the project's established memory/knowledge-base location; do not invent a second one.
   Name the fiche's sources and write:

   ```yaml
   checked: YYYY-MM-DD
   sources: [family-a, family-b]
   stale_after_days: N
   ```

   Set `stale_after_days` to the shortest validity period among the decisive families.
   Include the prediction, agreement/disagreement, conclusion, and unresolved limits.

8. Refresh stale fiches before relying on them.
   If `checked + stale_after_days` is in the past, re-query every named source family.
   Update the date and conclusion only after reconciliation; preserve meaningful history.

Do not ground a trivial one-read lookup, work already grounded in this turn, or a pure
preference with no checkable surface.

Read `references/source-registry.md` for registry setup and portability behavior.
Read `references/evidence-method.md` only when the compact orders need rationale,
evidence-tier detail, recursive lead handling, or scaling guidance.
