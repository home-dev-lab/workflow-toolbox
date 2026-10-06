This reference belongs to the workflow-debugger skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## How it works (for maintenance)

The logic is a tested package in the toolkit; the plugin ships only the bundled artifact.

- `@workflow-toolbox/debugger` `journal.ts` — tolerant journal types + `parseJournal` (never throws) +
  agent accessors (`doneAgents`/`incompleteAgents`/`retriedAgents`). Unit-tested.
- `diagnose.ts` — the pure decision table `diagnoseRun` + `recommendResume`. Unit-tested.
- `format.ts` — the pure text report. Unit-tested.
- `tool-denial.ts` — the pure denial scanner (`classifyDenial` / `parseTranscriptDenials` /
  `buildToolDenialReport`); a closed allow-list of denial signatures. Unit-tested. Fed into the
  audit report by `audit-folder.ts`'s `scanTranscripts({withDenials})` and surfaced by the Stop hook.
- `source.ts` — impure journal resolution (filters `wf_*` before the mtime sort so a sibling
  `agent-*.meta.json` never wins "latest"). Held out of `pnpm test`.
- `cli.ts` — the entry esbuild bundles into `plugin/bin/wt-debug.mjs` (node ESM, zero npm
  deps). `pnpm debugger:build` re-freezes it byte-identically into both `toolkit/bin/` and
  `plugin/bin/`; a byte-identity test guards against drift.

Related: **workflow-composer** authors/repairs the script itself; **upgrade-canary** checks
whether a Claude Code upgrade moved the runtime surface this debugger reads. **`npx workflow-toolbox report
[runId|latest|<journal-path>]`** is the sibling read of the same journal for a different question — not "why
did it fail?" but "what did it cost, what did it decide, where are the transcripts?": a per-agent
token rollup (reconciled to the run total), a per-agent **token breakdown** (input / output /
cache-read / cache-write, read from each agent's transcript), the decision trail, and best-effort
transcript links. When a run *has* agents (e.g. an `agent-died` you are diagnosing), `workflow-toolbox report`
is where you drill into that agent's cost and open its transcript. The breakdown is a separate
section from the journal cost rollup — the transcript sum (per-turn billed tokens) and the journal
`tokens` aggregate are different measures and are not reconciled.
