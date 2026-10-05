This reference belongs to the upgrade-canary skill; all paths are relative to the skill directory (the parent of references/).

## How it works (for maintenance)

The mechanism lives in the toolkit (it shares the SDK dependency + the tested
message-parsing helpers), not in this skill:

- `version.ts` — pure marker (de)serialization, the gate (`decideRun`), and
  `diffSnapshot` (the change report). Unit-tested.
- `agent-schema.ts` — pure `AgentDefinition` / `Options` schema-drift detection:
  `extractTypeFields` (TypeScript-AST field extraction from the SDK `.d.ts` — never a
  regex, so an inline-object field can't corrupt the set), the committed
  `AGENT_DEFINITION_BASELINE` / `OPTIONS_LEAST_PRIV_BASELINE` / `SCAFFOLD_HANDLED_AGENT_FIELDS`,
  `diffSchema`, and `formatSchemaDrift` (the report wording). Unit-tested. The impure
  reader (`readLiveSchema` in `canary-all.ts`, fed by `runtimes.getSdkTypesPath`) locates
  and reads the installed SDK's `sdk.d.ts`; a missing source degrades to "unavailable",
  never a throw or a gate.
- `edge.ts` — pure negative-case generators, `judgeRejection`, and
  `canonicalizeReason` (strips volatile taskIds so wording-drift detection is
  signal, not noise). Unit-tested.
- `lib.ts` — pure SDK message readers incl. `readInitVersion` (the measured CC
  version of whatever binary a run drove). Also `resumePrompt(scriptPath, runId, args?)`
  — the RESUME counterpart to `launchPrompt`: embeds `scriptPath` +
  `resumeFromRunId: runId` (+ `args` when given) as one exact JSON literal so a live
  runner can re-invoke the Workflow tool against an existing run and have completed
  `agent()` calls replay from the journal cache instead of re-running. Used by a caller
  that drives a resume round-trip (the resume-parity canary pins that an UNFORKED resume
  of the original SDK session preserves this cache across a process kill). Unit-tested.
- `changelog.ts` — pure changelog inspection: parse `## x.y.z` sections, extract the
  `(from, to]` range (numeric compare, gap-version-safe), highlight toolbox-relevant
  lines, and a single `buildChangelogReport` decision table. Unit-tested.
- `changelog-source.ts` — resolves the offline changelog mirror text (impure, held
  out of `pnpm test`); offline-graceful (absent → null, never gates).
- `runtimes.ts` — resolves the targets, the SDK version, the latest SDK on npm, and
  `getSdkTypesPath` (the installed SDK's `sdk.d.ts`, for the schema-drift check).
- `run.ts` / `edge-canaries.ts` — the live runners (`runSmokeChecks` / `runEdgeChecks`),
  also runnable standalone as `pnpm smoke` / `pnpm canary:edge` against the bundled runtime.
- `canary-all.ts` — the `pnpm canary` orchestrator: matrix → diff → report → record.
- `observer.ts` — pure message-shape readers (`readObserverSignals`), the immutable
  tally fold (`foldObserverSignal`), and the three-state verdict logic
  (`classifyAttachment`, `observerReportAssertion`, `sendMessageRefusalAssertion`)
  behind `pnpm canary:observer`. Unit-tested. `observer-canaries.ts` is the live
  runner (`runObserverCanaries`, standalone — not part of the `pnpm canary` matrix
  loop; see its own module header for why).

The pure halves are covered by `pnpm test`; the live runners are held out (they
spend launches and need auth), exactly like `pnpm smoke`. The headless launch
mechanism is the same one the smoke harness proved.
