# Orchestrator intake triage: three routes per card (inline, lane-direct, pilot), signals first, one batched call, Route line on the card

Frederic, wt-suite #1514/#1516 (2026-09-09): « le pilote doit piloter simplement, pas faire le boulot … une carte avec deux lignes à changer, pas besoin d'un orchestrateur ni d'un pilote » and « si on donne une mission à l'orchestrateur … il a aucun moyen de savoir s'il doit le faire ou pas ». Today `pilot-orchestrator.md` spawns ONE pilot per card, whatever the card. Proposed and not contradicted (#1517): a triage at intake.

## Definition of done
- In `plugin/agent-templates/pilot-orchestrator.md` (the wave loop, after the mechanical stop test): for each candidate card, deterministic signals first — effort label (S/M/L), files named in the description, a definition of done present with no open question, a `Route:` line already written — then ONE batched call (the profile's strong model per card 1860368721042737013) over the whole worklist classifying each card into three routes: **inline** (the orchestrator does it itself: two lines, docs), **lane-direct** (settled design: brief an executor lane, no pilot — rule 1bis), **pilot** (in-flight arbitration needed). Doubt → one route UP, never down.
- The chosen route and its one-line reason are written on the card (`Route: lane-direct — DoD complete, no open question`) before any work; a human-written `Route:` line is honoured as a force and never overwritten.
- The wave report names, per card, the route taken and the tier that carried implementation and review (the report-time check the cost rules require).
- Lock: a fixture wave with three cards (a two-line docs card, a settled S card, an ambiguous M card) yields inline / lane-direct / pilot; a forced `Route:` line wins; an unlabelled card is refused from triage until labelled (existing stop-test invariant).
- CHANGELOG Unreleased; `adopt --set agents` carries it; the project copy `.claude/agents/pilot-orchestrator.md` re-adopted.

Labels: P1 · feature · effort:M · process.

<!-- sr-meta v1 -->
Last-worked: 2026-09-09
Next: after the SDK-pilot spike — the template edit is independent of the SDK runner
<!-- /sr-meta -->

Depends-on: none

## Arbiter scope (main session, 2026-09-11)
- Route: you decide at discovery from the signals; this card names one template file, one fixture lock and a CHANGELOG line, with a settled design (Frederic's words quoted above) — state LITE or FULL with the reason.
- Worktree: this directory only; branch card/1860394456-triage off develop db4a1649. Commit on this branch only in the report phase; no merge, no push, no publish, no adoption into any project directory (main re-adopts after merge).
- Lane: the executor lane launcher and model are fixed by the lifecycle (gpt-5.6-terra); the brief quotes the definition of done verbatim and names the gates: from toolkit/, pnpm test, pnpm typecheck, pnpm lint, each detached with an EXIT= marker in .lane/<gate>.log.
- The fixture lock is the deliverable that proves the template: three cards → inline / lane-direct / pilot; a forced Route: line wins; an unlabelled card is refused. A regex-only lock on the template prose is not enough.
- Report: .lane/pilot-report.md through the lifecycle artifact tool at awaiting_fidelity, five sections plus ## Lessons for the memory.
