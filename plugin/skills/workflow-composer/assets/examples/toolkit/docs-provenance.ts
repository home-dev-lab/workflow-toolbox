// docs-provenance.ts — the committed doc ↔ source provenance map (Tier 2 of the
// doc-alignment defence; Tier 1 is packages/build/test/docs-contract.test.ts).
//
// Each entry says: "these SOURCE modules are DESCRIBED BY these doc surfaces".
// pr-review consumes it mechanically: when the reviewed diff touches a mapped
// source (prefix match on the Route stage's changedFiles), it appends a
// `docs-alignment` reviewer lens scoped to the mapped surfaces — LLM judgment
// for the prose the mechanical Tier 1 anchors cannot check.
//
// Maintenance contract:
// - Paths are repo-relative (repo root, not toolkit/). `sources` entries are
//   PREFIXES (a directory prefix maps the whole subtree).
// - The manifest is validated by examples/test/docs-provenance.test.ts: a
//   source prefix matching zero files, or a doc path that no longer exists,
//   fails the suite LOUDLY — fix the manifest in the same change that moved
//   the file.
// - When you add a doc surface that explains a module's behavior, add the pair
//   here in the same commit. Over-mapping is cheap (one extra reviewer prompt
//   line); under-mapping silently skips the lens.

export interface ProvenanceEntry {
  /** Repo-relative path prefixes of the implementation this entry covers. */
  readonly sources: readonly string[]
  /** Repo-relative doc surfaces that describe those sources. */
  readonly docs: readonly string[]
}

export interface PluginBinDocDecision {
  /** Repo-relative shipped executable path under plugin/bin/. */
  readonly script: `plugin/bin/${string}.mjs`
  /** How this shipped executable is accounted for in the doc inventory. */
  readonly status: 'mapped' | 'exempt' | 'missing-doc-surface'
  /** One-line reason for the recorded outcome. */
  readonly reason: string
}

export interface PluginBinCoverageAudit {
  /** Shipped plugin/bin scripts with neither a manifest mapping nor a recorded outcome. */
  readonly unclassified: readonly string[]
  /** Recorded decisions whose script path is not a shipped plugin/bin executable. */
  readonly unknownRecordedScripts: readonly string[]
  /** Duplicate decision entries for the same shipped script. */
  readonly duplicateRecordedScripts: readonly string[]
  /** Scripts recorded as mapped but absent from the docs-provenance manifest. */
  readonly mappedWithoutManifest: readonly string[]
  /** Scripts recorded as exempt/missing but ALSO mapped in the manifest. */
  readonly nonMappedDecisionsWithManifestEntry: readonly string[]
  /** Exact plugin/bin manifest entries lacking a matching `mapped` decision. */
  readonly manifestScriptsWithoutMappedDecision: readonly string[]
}

export const PLUGIN_BIN_DOC_DECISIONS: readonly PluginBinDocDecision[] = [
  {
    script: 'plugin/bin/wt-actionable-gate-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the shipped Stop gate and its snapshot contract.',
  },
  {
    script: 'plugin/bin/wt-adopt-rules-check-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The SessionStart adoption-state notice is user-facing but no durable doc surface describes this hook.',
  },
  {
    script: 'plugin/bin/wt-arc-watch.mjs',
    status: 'missing-doc-surface',
    reason: 'Shipped monitor with its own CLI/output contract, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-check-commit-signatures-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The PostToolUse commit-signature notice is user-facing, but no durable doc surface describes this hook.',
  },
  {
    script: 'plugin/bin/wt-check-commit-signatures.mjs',
    status: 'missing-doc-surface',
    reason: 'Standalone CLI with a remediation contract, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-check-observer-pairing.mjs',
    status: 'mapped',
    reason: 'Wave-fidelity checker docs tell operators to run and interpret this CLI.',
  },
  {
    script: 'plugin/bin/wt-debug.mjs',
    status: 'mapped',
    reason: 'Public debugger CLI described in the README, architecture, toolkit docs, and debugger skill docs.',
  },
  {
    script: 'plugin/bin/wt-delegation-ladder-hook.mjs',
    status: 'mapped',
    reason: 'README and plugin docs describe the shipped SessionStart delegation-ladder injection.',
  },
  {
    script: 'plugin/bin/wt-lane-probe.mjs',
    status: 'mapped',
    reason: 'Pilot orchestrator docs tell operators to run this probe to verify executor routing.',
  },
  {
    script: 'plugin/bin/wt-memory-index-check-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The SessionStart knowledge-base warning is user-facing, but no durable doc surface describes this hook.',
  },
  {
    script: 'plugin/bin/wt-memory-index-check.mjs',
    status: 'mapped',
    reason: 'Fidelity-checker docs instruct operators to run and consume this CLI/report.',
  },
  {
    script: 'plugin/bin/wt-observe.mjs',
    status: 'mapped',
    reason: 'Public launcher CLI with durable docs across the README, toolkit docs, and debugger docs.',
  },
  {
    script: 'plugin/bin/wt-outbound-guard-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The shipped spawn-registry writer/nudge hook is user-facing, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-probe-claim-guard-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The shipped SendMessage probe-claim refusal is user-facing, but no durable doc surface describes this hook yet.',
  },
  {
    script: 'plugin/bin/wt-pilot-card-reconcile.mjs',
    status: 'mapped',
    reason: 'Pilot orchestrator docs tell operators to run this reconciliation CLI on claimed cards.',
  },
  {
    script: 'plugin/bin/wt-pilot-guard-hook.mjs',
    status: 'mapped',
    reason: 'Pilot docs explicitly describe this shipped guard and the verbs it refuses.',
  },
  {
    script: 'plugin/bin/wt-push-scope-check.mjs',
    status: 'mapped',
    reason: 'Pilot docs instruct operators to run this push-scope guard before escalation/push.',
  },
  {
    script: 'plugin/bin/wt-queue-not-empty-gate-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'Shipped tracker-agnostic Stop gate with a marker contract, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-quota-probe.mjs',
    status: 'mapped',
    reason: 'README, privacy, and security docs describe this bundled public quota probe.',
  },
  {
    script: 'plugin/bin/wt-quota-watch.mjs',
    status: 'mapped',
    reason: 'README, privacy, and security docs describe the bundled quota monitor and probe pairing.',
  },
  {
    script: 'plugin/bin/wt-registry-heartbeat-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the shipped Stop heartbeat and its repeated-block semantics.',
  },
  {
    script: 'plugin/bin/wt-run-gate.mjs',
    status: 'mapped',
    reason: 'Pilot docs instruct operators to use this non-bypassable gate runner for repo gates.',
  },
  {
    script: 'plugin/bin/wt-observer-pairing-guard-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'Shipped PostToolUse observer-pairing notice delegates to the checker, but no durable doc surface describes this hook.',
  },
  {
    script: 'plugin/bin/wt-service-watch.mjs',
    status: 'missing-doc-surface',
    reason: 'Shipped service monitor with its own output/flag contract, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-session-start-registry-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The SessionStart unfinished-agent notice is user-facing, but no durable doc surface describes this hook.',
  },
  {
    script: 'plugin/bin/wt-spawn-capability-guard-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'Shipped PreToolUse guard with direct deny behavior, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-spawn-registry-scan.mjs',
    status: 'missing-doc-surface',
    reason: 'Standalone scan/ack CLI for unfinished agent arcs, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-spawn-shape-guard-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'Shipped PreToolUse spawn-shape guard with user-visible deny output, but no durable doc surface describes it.',
  },
  {
    script: 'plugin/bin/wt-stale-date-guard-hook.mjs',
    status: 'missing-doc-surface',
    reason: 'The PostToolUse stale-deadline notice is user-facing, but no durable doc surface describes this hook.',
  },
  {
    script: 'plugin/bin/wt-stale-date-guard.mjs',
    status: 'missing-doc-surface',
    reason: 'Standalone stale-deadline CLI exists, but only changelog prose mentions it today.',
  },
  {
    script: 'plugin/bin/wt-stop-hook.mjs',
    status: 'mapped',
    reason: 'README, architecture, privacy, security, and toolkit docs describe this shipped Stop hook.',
  },
  {
    script: 'plugin/bin/wt-command-repeat-check.mjs',
    status: 'missing-doc-surface',
    reason: 'Standalone repeat-discrimination CLI exists, but this pass intentionally does not register or document it beyond code/test/report surfaces.',
  },
  {
    script: 'plugin/bin/wt-verdict-cap-check.mjs',
    status: 'mapped',
    reason: 'Fidelity-checker docs tell operators to run this CLI on verifier reports.',
  },
  {
    script: 'plugin/bin/wt-verifier-cli-guard-hook.mjs',
    status: 'mapped',
    reason: 'Opencode-verifier and routing docs describe the shipped mechanical verifier guard.',
  },
]

export const DOCS_PROVENANCE: readonly ProvenanceEntry[] = [
  {
    // AgentType probing + the leaf fence + lean routing (availability gates,
    // probe prompts, graceful degradation semantics).
    sources: [
      'toolkit/packages/patterns/src/probe-agent-type.ts',
      'toolkit/packages/patterns/src/leaf-fence.ts',
      'toolkit/packages/patterns/src/lean-routing.ts',
      'plugin/agents/',
    ],
    docs: [
      'plugin/skills/workflow-composer/references/model-and-agent-routing.md',
      'plugin/skills/workflow-composer/SKILL.md',
    ],
  },
  {
    // The pilot delegation suite (dev-loop drivers) is DESCRIBED BY its composer
    // skill, which also documents the environment-brief contract. The whole
    // plugin/agents/ subtree is mapped above to the routing docs (accurate for
    // the leaf/lean/opencode-verifier agentTypes); this narrower entry adds the
    // pilot-wave surface for the three pilot definitions specifically. The pilot
    // suite lives in plugin/agent-templates/, not plugin/agents/ — Claude Code
    // silently ignores `observer:` on a plugin-registered agent, so the pilots stay
    // unregistered templates, adopted as project copies (see adopt-rules).
    sources: [
      'plugin/agent-templates/pilot.md',
      'plugin/agent-templates/pilot-orchestrator.md',
      'plugin/agent-templates/pilot-watchdog.md',
    ],
    docs: ['plugin/skills/pilot-wave/SKILL.md'],
  },
  {
    // The adopt-rules opt-in installer (writes editable, versioned rule copies of
    // the cross-cutting guardrails) is described by its own skill.
    sources: ['plugin/skills/adopt-rules/scripts/'],
    docs: ['plugin/skills/adopt-rules/SKILL.md', 'README.md'],
  },
  {
    // The bundled cross-cutting rule files (the delegation ladder + companions)
    // that adopt-rules installs; described by their own README and the repo README.
    sources: ['plugin/rules/'],
    docs: ['plugin/rules/README.md', 'README.md'],
  },
  {
    // The nine patterns + the result envelope (options, caps, envelope shape,
    // pattern count claims).
    sources: ['toolkit/packages/patterns/src/'],
    docs: [
      'plugin/skills/workflow-composer/references/patterns.md',
      'toolkit/README.md',
      'README.md',
    ],
  },
  {
    // Digest + prompt-tag wire protocols (what the observatory parses; the
    // reload-only semantics known-issues documents).
    sources: [
      'toolkit/packages/runtime/src/digest.ts',
      'toolkit/packages/runtime/src/prompt-tag.ts',
    ],
    docs: [
      'docs/public/known-issues.md',
      'plugin/skills/workflow-composer/references/observing-runs.md',
    ],
  },
  {
    // Observed-role wt-comm brief auto-injection: tolerant observer extraction,
    // prompt suffixing, defineWorkflow wiring, and scaffold/docs caveats.
    sources: [
      'toolkit/packages/runtime/src/observed-role-brief.ts',
      'toolkit/packages/runtime/src/prompt-tag.ts',
      'toolkit/packages/build/src/define-workflow.ts',
      'toolkit/packages/scaffold/src/scaffold.ts',
    ],
    docs: [
      'docs/public/known-issues.md',
      'plugin/skills/workflow-composer/references/api-reference.md',
      'plugin/skills/workflow-composer/references/observer-definitions.md',
      'toolkit/packages/comm/README.md',
    ],
  },
  {
    // Runtime contract: sandbox typings, model/effort aliases, BEST_MODEL.
    sources: [
      'toolkit/packages/runtime/src/types.ts',
      'toolkit/packages/runtime/src/constants.ts',
      'toolkit/packages/runtime/src/with-agent-defaults.ts',
    ],
    docs: [
      'plugin/skills/workflow-composer/references/model-and-agent-routing.md',
      'plugin/skills/workflow-composer/references/api-reference.md',
    ],
  },
  {
    // Workflow linter rules + size cap (what "compliant artifact" means).
    sources: ['toolkit/packages/build/src/lint.ts'],
    docs: [
      'plugin/skills/workflow-composer/references/api-reference.md',
      'CLAUDE.md',
    ],
  },
  {
    // defineWorkflow / bundler / CLI (the authoring pipeline and its contract).
    sources: [
      'toolkit/packages/build/src/define-workflow.ts',
      'toolkit/packages/build/src/bundle.ts',
      'toolkit/packages/build/src/cli.ts',
    ],
    docs: [
      'plugin/skills/workflow-composer/SKILL.md',
      'toolkit/README.md',
      'README.md',
    ],
  },
  {
    // Orchestrator pipelines (definePipeline / bundlePipeline / PipelineSpec).
    sources: [
      'toolkit/packages/build/src/define-pipeline.ts',
      'toolkit/packages/build/src/bundle-pipeline.ts',
      'toolkit/packages/pipeline-spec/',
    ],
    docs: ['plugin/skills/workflow-composer/references/orchestrator-pipelines.md'],
  },
  {
    // Scaffold emitter (what `wt:scaffold` generates: workflow / agent / observer /
    // capabilities-sidecar artifacts).
    sources: ['toolkit/packages/scaffold/src/'],
    docs: [
      'plugin/skills/toolkit-scaffold/SKILL.md',
      'plugin/skills/workflow-composer/SKILL.md',
      'plugin/skills/workflow-composer/references/capability-needs.md',
    ],
  },
  {
    // Run forensics (journal/transcript parsing, tool-denial detection).
    sources: ['toolkit/packages/debugger/src/'],
    docs: [
      'plugin/skills/workflow-debugger/SKILL.md',
      'docs/public/known-issues.md',
    ],
  },
  {
    // Capability registry + sidecar resolver + launcher glue (machine registry
    // format/location/WT_CAPABILITY_REGISTRY, $cap: expansion, named degradations,
    // fail-loud launch refusal). The operator-facing registry doc + the author-facing
    // needs/sidecar doc together describe this surface.
    sources: [
      'toolkit/packages/debugger/src/capability-registry.ts',
      'toolkit/packages/debugger/src/launch-capabilities.ts',
    ],
    docs: [
      'docs/public/capability-registry.md',
      'plugin/skills/workflow-composer/references/capability-needs.md',
    ],
  },
  {
    // Smoke / canaries (the upgrade re-verification story).
    sources: ['toolkit/packages/smoke/src/'],
    docs: ['plugin/skills/upgrade-canary/SKILL.md'],
  },
  {
    // The pr-review composition itself (its worked example + the shipped list).
    sources: ['toolkit/examples/pr-review.workflow.ts'],
    docs: [
      'plugin/skills/workflow-composer/references/worked-example-pr-review.md',
      'plugin/skills/workflow-composer/references/shipped-compositions.md',
    ],
  },
  {
    // Every other shipped composition (the catalog doc + the dev-workflow story
    // + the bundled examples README, which now names per-workflow usage intent).
    sources: ['toolkit/examples/'],
    docs: [
      'plugin/skills/workflow-composer/references/shipped-compositions.md',
      'docs/public/dev-workflow.md',
      'plugin/skills/workflow-composer/assets/examples/README.md',
    ],
  },
  {
    // wt-comm: the file-message protocol between escalating agents, the pilot, and
    // the observer/relay (hint producer since v0.2).
    sources: ['toolkit/packages/comm/src/'],
    docs: [
      'toolkit/packages/comm/README.md',
      'toolkit/packages/comm/teaching/wt-comm-participant.md',
      'toolkit/packages/comm/teaching/wt-comm-observer-consumer.md',
    ],
  },
  {
    // Public debugger/observability executables shipped under plugin/bin/.
    sources: [
      'plugin/bin/wt-debug.mjs',
      'plugin/bin/wt-observe.mjs',
      'plugin/bin/wt-stop-hook.mjs',
    ],
    docs: [
      'README.md',
      'toolkit/README.md',
      'docs/public/architecture.md',
      'plugin/skills/workflow-debugger/SKILL.md',
      'plugin/skills/workflow-composer/references/observing-runs.md',
      'PRIVACY.md',
      'SECURITY.md',
    ],
  },
  {
    // Bundled quota monitor/probe pair.
    sources: ['plugin/bin/wt-quota-probe.mjs', 'plugin/bin/wt-quota-watch.mjs'],
    docs: ['README.md', 'PRIVACY.md', 'SECURITY.md'],
  },
  {
    // Pilot operators are instructed to run these helper CLIs/guards directly.
    sources: [
      'plugin/bin/wt-run-gate.mjs',
      'plugin/bin/wt-push-scope-check.mjs',
      'plugin/bin/wt-pilot-guard-hook.mjs',
      'plugin/bin/wt-pilot-card-reconcile.mjs',
      'plugin/bin/wt-lane-probe.mjs',
    ],
    docs: [
      'plugin/agent-templates/pilot.md',
      'plugin/agent-templates/pilot-orchestrator.md',
      'plugin/launch-agents/agents/pilot.md',
      'plugin/launch-agents/agents/pilot-orchestrator.md',
    ],
  },
  {
    // The verifier backstop is part of the shipped opencode-verifier contract.
    sources: ['plugin/bin/wt-verifier-cli-guard-hook.mjs'],
    docs: [
      'plugin/agents/opencode-verifier.md',
      'plugin/launch-agents/agents/opencode-verifier.md',
      'plugin/skills/workflow-composer/references/model-and-agent-routing.md',
    ],
  },
  {
    // Knowledge-base/report verification helper CLIs used by fidelity checking.
    sources: ['plugin/bin/wt-memory-index-check.mjs', 'plugin/bin/wt-verdict-cap-check.mjs'],
    docs: ['plugin/agents/fidelity-checker.md', 'plugin/launch-agents/agents/fidelity-checker.md'],
  },
  {
    // Observer pairing verification CLI used by the wave fidelity checker.
    sources: ['plugin/bin/wt-check-observer-pairing.mjs'],
    docs: ['plugin/agents/wave-fidelity-checker.md', 'plugin/launch-agents/agents/wave-fidelity-checker.md'],
  },
  {
    // Shipped SessionStart delegation-ladder injection.
    sources: ['plugin/bin/wt-delegation-ladder-hook.mjs'],
    docs: ['README.md', 'plugin/skills/adopt-rules/SKILL.md'],
  },
  {
    // Shipped Stop hooks whose operator-facing semantics are documented as known issues/contracts.
    sources: [
      'plugin/bin/wt-actionable-gate-hook.mjs',
      'plugin/bin/wt-registry-heartbeat-hook.mjs',
    ],
    docs: ['docs/public/known-issues.md'],
  },
]

function mappedPluginBinScripts(manifest: readonly ProvenanceEntry[]): Set<string> {
  return new Set(
    manifest.flatMap((entry) =>
      entry.sources.filter(
        (source) => source.startsWith('plugin/bin/') && source.endsWith('.mjs'),
      ),
    ),
  )
}

/** Audit whether shipped plugin/bin executables are all either manifest-mapped or explicitly
 *  recorded with a reason. `missing-doc-surface` is SILENT here on purpose: the gap is then
 *  explicit and reportable, not invisible by omission. */
export function auditPluginBinCoverage(
  shippedScripts: readonly string[],
  manifest: readonly ProvenanceEntry[] = DOCS_PROVENANCE,
  decisions: readonly PluginBinDocDecision[] = PLUGIN_BIN_DOC_DECISIONS,
): PluginBinCoverageAudit {
  const shipped = [...new Set(shippedScripts)].sort()
  const mapped = mappedPluginBinScripts(manifest)
  const decisionCounts = new Map<string, number>()
  const decisionByScript = new Map<string, PluginBinDocDecision>()
  for (const decision of decisions) {
    decisionCounts.set(decision.script, (decisionCounts.get(decision.script) ?? 0) + 1)
    if (!decisionByScript.has(decision.script)) decisionByScript.set(decision.script, decision)
  }

  const unclassified = shipped.filter(
    (script) => !mapped.has(script) && !decisionByScript.has(script),
  )
  const unknownRecordedScripts = [...decisionByScript.keys()]
    .filter((script) => !shipped.includes(script))
    .sort()
  const duplicateRecordedScripts = [...decisionCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([script]) => script)
    .sort()
  const mappedWithoutManifest = decisions
    .filter((decision) => decision.status === 'mapped' && !mapped.has(decision.script))
    .map((decision) => decision.script)
    .sort()
  const nonMappedDecisionsWithManifestEntry = decisions
    .filter((decision) => decision.status !== 'mapped' && mapped.has(decision.script))
    .map((decision) => decision.script)
    .sort()
  const manifestScriptsWithoutMappedDecision = [...mapped]
    .filter((script) => decisionByScript.get(script)?.status !== 'mapped')
    .sort()

  return {
    unclassified,
    unknownRecordedScripts,
    duplicateRecordedScripts,
    mappedWithoutManifest,
    nonMappedDecisionsWithManifestEntry,
    manifestScriptsWithoutMappedDecision,
  }
}

/** The doc surfaces mapped to any of `changedFiles` (repo-relative), deduped,
 *  in manifest order. Empty array = no mapped module touched → the caller
 *  skips the docs-alignment lens. Pure path matching — no fs access, safe
 *  inside the workflow sandbox. Matching semantics: an entry ending in '/'
 *  covers its whole subtree; any other entry is an EXACT file path — never a
 *  string prefix, so a same-stem sibling (`lint.tsx` vs the mapped `lint.ts`)
 *  cannot false-trigger the lens (review finding, run wf_0decbfe8-7e4).
 *  `manifest` defaults to the bundled DOCS_PROVENANCE (dwt paths); pr-review's
 *  launch-time `provenance` knob passes an external repo's manifest here — it
 *  REPLACES the bundled one for the whole match (never merged). */
export function docsForChangedFiles(
  changedFiles: readonly string[],
  manifest: readonly ProvenanceEntry[] = DOCS_PROVENANCE,
): string[] {
  const out: string[] = []
  for (const entry of manifest) {
    const touched = changedFiles.some((f) =>
      entry.sources.some((source) =>
        source.endsWith('/') ? f.startsWith(source) : f === source,
      ),
    )
    if (!touched) continue
    for (const doc of entry.docs) if (!out.includes(doc)) out.push(doc)
  }
  return out
}
